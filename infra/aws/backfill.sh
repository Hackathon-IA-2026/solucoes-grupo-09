#!/usr/bin/env bash
# Fill the instance's database from the sources, in the background.
#
#   infra/aws/backfill.sh            start it (a second start is refused)
#   infra/aws/backfill.sh --status   the last lines of its log
#   infra/aws/backfill.sh --weather  fill the weather history's holes, slowly
#
# `--weather` is paced, not a sprint. The first weather mode (removed in
# ecc10e5) ran tasks back to back and would have spent the free allowance the
# hourly live sweep needs. This one asks one slot (a target day and a cycle,
# at most 138 weighted units) every WATTSTEER_WEATHER_PACE_S seconds (default
# 2400: about 5,000 units a day, half the free 10,000; the live sweep uses
# about 3,300), waits an hour on a 429, and moves to the next window when a
# task reports `complete`. The windows are the holes measured on 26/09 in the
# history state-2026-09-26 brought, the fold the gate decides on first: July
# 2026 had no weather at all and August eight days.
#
# It runs on the instance as a detached container of the worker image,
# `wattsteer-backfill`, and drives the ingestion the worker already has
# (apps/api/src/scripts/ingest.ts) — no second ingestion path:
#
#   1. the holiday calendar, once (load-calendar.ts);
#   2. one `live` sweep, which brings the plant registry and SIGA the weather
#      weights are cut from, and one `recent` sweep: live covers the last two
#      months and history stops five months back, so without it the three in
#      between are never fetched (the first run left May-July 2026 empty);
#   3. `history` sweeps, one slice each, newest slice first because the folds
#      the gate decides on are the recent ones. A slice is 90 days of weather
#      and one year of load; every other dataset is fetched whole on the first
#      pass and costs one HEAD after that.
#
# ONS is minutes (the live sweep took 870 s). Weather is not: on the free tier
# each weather task stops at 138 weighted units, which is one target day and
# cycle, and the whole history is about 1,800 of them against 10,000 units a
# day, weeks rather than hours (measured 26/09, see the commit that removed the
# --weather mode). So this fills ONS completely and weather only for the slice
# each history pass asks for; the weather history comes from a dump of a
# database that already holds it.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="${AWS_CLI:-$HERE/scripts/aws.sh}"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"

run() {
  local params id status
  params="$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]], "executionTimeout": ["600"]}))' "$1")"
  id="$("$AWS" ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
    --parameters "$params" --query Command.CommandId --output text)"
  status=Pending
  while [[ "$status" =~ ^(Pending|InProgress|Delayed)$ ]]; do
    sleep 5
    status="$("$AWS" ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
      --query Status --output text 2>/dev/null || echo Pending)"
  done
  "$AWS" ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
    --query StandardOutputContent --output text
}

if [ "${1:-}" = --status ]; then
  for name in wattsteer-backfill wattsteer-backfill-weather; do
    run "echo == $name; docker logs --tail 12 $name 2>&1 | grep -v '… [0-9]*/'; docker inspect -f 'state: {{.State.Status}} since {{.State.StartedAt}}' $name 2>&1"
  done
  exit 0
fi

# The loop that runs inside the container. Rounds, because a slice the weather
# quota refused is only worth asking again after the quota's hour turns.
read -r -d '' LOOP <<'EOF' || true
set -u
log() { echo "$(date -u +%FT%TZ) $*"; }
log "calendar"; bun run src/scripts/load-calendar.ts || log "calendar failed"
log "live sweep"; bun run src/scripts/ingest.ts sweep live || log "live sweep had failures"
log "recent sweep"; bun run src/scripts/ingest.ts sweep recent || log "recent sweep had failures"
for round in 1 2 3 4 5 6; do
  failed=0
  for slice in $(seq 12 -1 0); do
    log "round $round history slice $slice"
    bun run src/scripts/ingest.ts sweep history --history-slice "$slice" || failed=$((failed + 1))
  done
  log "round $round done, $failed slices with failures"
  [ "$failed" -eq 0 ] && break
  sleep 3600
done
log "backfill finished"
EOF

NAME=wattsteer-backfill
if [ "${1:-}" = --weather ]; then
  NAME=wattsteer-backfill-weather
  PACE="${WATTSTEER_WEATHER_PACE_S:-2400}"
  read -r -d '' LOOP <<EOF || true
set -u
log() { echo "\$(date -u +%FT%TZ) \$*"; }
for window in 2026-07-01:2026-09-12 2026-06-01:2026-06-30 2025-11-01:2026-03-31 2025-06-01:2025-10-31 2024-03-15:2025-05-31; do
  from="\${window%%:*}"; to="\${window##*:}"
  while :; do
    out="\$(bun run src/scripts/ingest.ts task "{\\"kind\\":\\"weather\\",\\"payload\\":{\\"from\\":\\"\$from\\",\\"to\\":\\"\$to\\",\\"runCycles\\":[\\"00Z\\",\\"12Z\\"]}}" 2>&1)"
    why="\$(printf '%s' "\$out" | grep -o '"stoppedBecause": "[a-z_]*"' | tail -1 | cut -d'"' -f4)"
    units="\$(printf '%s' "\$out" | grep -o '"weightedUnitsSpent": [0-9]*' | tail -1 | grep -o '[0-9]*$')"
    log "weather \$from..\$to: \${why:-error} (\${units:-?} units)"
    case "\$why" in
      complete) break ;;
      rate_limited|"") sleep 3600 ;;
      *) sleep $PACE ;;
    esac
  done
done
log "weather backfill finished"
EOF
fi

C="docker compose --project-name wattsteer --env-file /opt/wattsteer/.env -f /opt/wattsteer/compose.yml"
encoded="$(printf '%s' "$LOOP" | base64 | tr -d '\n')"
run "if docker inspect $NAME >/dev/null 2>&1 && [ \"\$(docker inspect -f '{{.State.Running}}' $NAME)\" = true ]; then echo 'already running'; exit 0; fi; docker rm -f $NAME >/dev/null 2>&1; $C run -d --no-deps --name $NAME worker sh -c \"echo $encoded | base64 -d > /tmp/loop.sh && sh /tmp/loop.sh\" && echo started"

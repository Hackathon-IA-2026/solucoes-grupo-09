#!/usr/bin/env bash
# Fill the instance's database from the sources, in the background.
#
#   infra/aws/backfill.sh            start it (a second start is refused)
#   infra/aws/backfill.sh --status   the last lines of its log
#   infra/aws/backfill.sh --weather  weather only, in its own container, beside it
#
# `--weather` exists because the first history pass spends an hour or more
# fetching ONS's whole archive, and weather waits behind it although it is
# bounded by a different thing (Open-Meteo's quota, not this machine). It asks
# the same weather task the history sweep would, 90 days at a time, newest
# first, one request stream at a time; a window the quota cut short is asked
# again half an hour later. What either container fetched is not fetched twice.
#
# It runs on the instance as a detached container of the worker image,
# `wattsteer-backfill`, and drives the ingestion the worker already has
# (apps/api/src/scripts/ingest.ts) — no second ingestion path:
#
#   1. the holiday calendar, once (load-calendar.ts);
#   2. one `live` sweep, which brings the plant registry and SIGA the weather
#      weights are cut from;
#   3. `history` sweeps, one slice each, newest slice first because the folds
#      the gate decides on are the recent ones. A slice is 90 days of weather
#      and one year of load; every other dataset is fetched whole on the first
#      pass and costs one HEAD after that.
#
# ONS is minutes. Weather is bounded by Open-Meteo's free quota, measured at
# 10 to 35 hours for the whole window from one address, and it is left to take
# them: a slice the quota cut short is simply asked again on the next round,
# and what was already fetched is not fetched twice. Nothing here goes around
# the quota.
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
    run "echo == $name; docker logs --tail 20 $name 2>&1 | grep -v '… [0-9]*/'; docker inspect -f 'state: {{.State.Status}} since {{.State.StartedAt}}' $name 2>&1"
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
  # Newest window first, from the weather model's coverage start (2024-03-15,
  # single-runs.ts) to two weeks ago; the live sweep holds the last two weeks.
  windows="$(python3 -c '
from datetime import date, timedelta
start, end = date(2024, 3, 15), date.today() - timedelta(days=15)
out, to = [], end
while to >= start:
    frm = max(start, to - timedelta(days=89))
    out.append(f"{frm}:{to}")
    to = frm - timedelta(days=1)
print(" ".join(out))')"
  LOOP="set -u
log() { echo \"\$(date -u +%FT%TZ) \$*\"; }
for window in $windows; do
  from=\"\${window%%:*}\"; to=\"\${window##*:}\"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    log \"weather \$from..\$to attempt \$attempt\"
    bun run src/scripts/ingest.ts task \"{\\\"kind\\\":\\\"weather\\\",\\\"payload\\\":{\\\"from\\\":\\\"\$from\\\",\\\"to\\\":\\\"\$to\\\",\\\"runCycles\\\":[\\\"00Z\\\",\\\"12Z\\\"]}}\" && break
    sleep 1800
  done
done
log \"weather backfill finished\""
fi

C="docker compose --project-name wattsteer --env-file /opt/wattsteer/.env -f /opt/wattsteer/compose.yml"
encoded="$(printf '%s' "$LOOP" | base64 | tr -d '\n')"
run "if docker inspect $NAME >/dev/null 2>&1 && [ \"\$(docker inspect -f '{{.State.Running}}' $NAME)\" = true ]; then echo 'already running'; exit 0; fi; docker rm -f $NAME >/dev/null 2>&1; $C run -d --no-deps --name $NAME worker sh -c \"echo $encoded | base64 -d > /tmp/loop.sh && sh /tmp/loop.sh\" && echo started"

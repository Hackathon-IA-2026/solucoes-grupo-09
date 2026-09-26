#!/usr/bin/env bash
# Fill the instance's database from the sources, in the background.
#
#   infra/aws/backfill.sh            start it (a second start is refused)
#   infra/aws/backfill.sh --status   the last lines of its log
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
  run "docker logs --tail 40 wattsteer-backfill 2>&1; docker inspect -f 'state: {{.State.Status}} since {{.State.StartedAt}}' wattsteer-backfill 2>&1"
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

C="docker compose --project-name wattsteer --env-file /opt/wattsteer/.env -f /opt/wattsteer/compose.yml"
encoded="$(printf '%s' "$LOOP" | base64 | tr -d '\n')"
run "if docker inspect wattsteer-backfill >/dev/null 2>&1 && [ \"\$(docker inspect -f '{{.State.Running}}' wattsteer-backfill)\" = true ]; then echo 'already running'; exit 0; fi; docker rm -f wattsteer-backfill >/dev/null 2>&1; $C run -d --no-deps --name wattsteer-backfill worker sh -c \"echo $encoded | base64 -d > /tmp/loop.sh && sh /tmp/loop.sh\" && echo started"

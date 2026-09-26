#!/usr/bin/env bash
# Retrain on the instance itself, against the database it already has, into
# the directory the ml service serves from.
#
#   infra/aws/retrain-here.sh [--lane <lane>] [--no-ladder] [--config <version>]
#
# The CodeBuild path (train.sh) restores a 5 GB dump first (565 s measured),
# queues for a machine (2-3 min) and leaves the artifacts in the bucket for
# install-models.sh. None of that is training. For a run whose only purpose is
# the gate's decision on today's data, the instance has the data, the ml image
# and the artifact directory, so the run goes there: a promoted candidate is
# serving the moment the ml service is restarted, and a refused one leaves the
# incumbent exactly as it was.
#
# One lane by default, the morning one, because it is the one that serves and
# because it halves the run; --no-ladder is on for the same reason (the card
# then has no baseline ladder). A full run is `train.sh` or the weekly job.
#
# It runs detached in a container of the ml image, `wattsteer-retrain`, with
# the same root the service reads; --status shows the log, --wait follows it.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="${AWS_CLI:-$HERE/scripts/aws.sh}"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"

lane_args="--lane dessem_free_v1__gate_early__thr5"
ladder="--no-ladder"
config=""
wait_for=no
while [ $# -gt 0 ]; do
  case "$1" in
    --lane) lane_args="--lane $2"; shift 2 ;;
    --all-lanes) lane_args=""; shift ;;
    --ladder) ladder=""; shift ;;
    --no-ladder) ladder="--no-ladder"; shift ;;
    --config) config="$2"; shift 2 ;;
    --wait) wait_for=yes; shift ;;
    --status) wait_for=status; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

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

if [ "$wait_for" = status ]; then
  run "docker logs --tail 30 wattsteer-retrain 2>&1; docker inspect -f 'state: {{.State.Status}} exit={{.State.ExitCode}} since {{.State.StartedAt}}' wattsteer-retrain 2>&1"
  exit 0
fi

C="docker compose --project-name wattsteer --env-file /opt/wattsteer/.env -f /opt/wattsteer/compose.yml"
env_args=""
[ -z "$config" ] || env_args="-e WATTSTEER_MODEL_CONFIG=$config"
run_id="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# `--user root`, because the service's own uid may not own a directory a
# restore created; the artifacts it writes are then chowned back below.
run "if docker inspect wattsteer-retrain >/dev/null 2>&1 && [ \"\$(docker inspect -f '{{.State.Running}}' wattsteer-retrain)\" = true ]; then echo 'already running'; exit 0; fi; docker rm -f wattsteer-retrain >/dev/null 2>&1; $C run -d --no-deps --name wattsteer-retrain --user root $env_args --entrypoint sh ml -c 'python -m wattsteer_ml.retrain --run-id $run_id --root /data/models $lane_args $ladder > /data/models/retrain-$run_id.json 2> /data/models/retrain-$run_id.err; echo exit \$? >> /data/models/retrain-$run_id.err; chown -R 10001:10001 /data/models; cat /data/models/retrain-$run_id.err' && echo \"started $run_id ($lane_args $ladder $config)\""

[ "$wait_for" = yes ] || exit 0
echo "== following; a full two-lane run took 39 min on 72 vCPU, one lane without the ladder is expected to be shorter"
while :; do
  sleep 60
  state="$(run "docker inspect -f '{{.State.Status}}' wattsteer-retrain 2>/dev/null")"
  echo "   $(date -u +%H:%M) $state"
  [ "$(echo "$state" | tr -d '[:space:]')" = running ] || break
done
run "tail -3 /opt/wattsteer/data/ml-models/retrain-$run_id.err; python3 - <<'PY'
import json
d = json.load(open('/opt/wattsteer/data/ml-models/retrain-$run_id.json'))
print('resources', d.get('resources'))
for lane in d.get('lanes', []):
    print(lane.get('lane'), '->', lane.get('status'), '|', str(lane.get('reason') or lane.get('error') or '')[:400])
print('PROMOTED' if d.get('promoted') else 'NOTHING PROMOTED')
PY"
# A promoted lane is on the volume; the service reads the volume at start.
if run "grep -q '\"promoted\": \[\"' /opt/wattsteer/data/ml-models/retrain-$run_id.json && echo yes" | grep -q yes; then
  run "$C restart ml >/dev/null && sleep 25 && $C exec -T ml python -c \"import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health').read().decode())\""
  echo "== ml restarted; which lane serves: $SITE_URL/v1/meta"
fi

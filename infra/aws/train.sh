#!/usr/bin/env bash
# Run one training or evaluation job on the 72-vCPU CodeBuild machine, inside
# the team's budget of machine time.
#
#   infra/aws/train.sh --usage
#   infra/aws/train.sh --run-id f6-v3 --timeout 90 -- python -m wattsteer_ml.retrain ...
#
# Options: --timeout <minutes> (default 120), --db <s3 key> (default
# state/db.sql.gz), --models <s3 key|none> (default state/models.tgz).
#
# The event's account does not show its spending limit to participants, so the
# team keeps its own: WATTSTEER_TRAIN_BUDGET_MINUTES (default 480) of this
# machine, counted from every build of the project. A job whose timeout would
# take the total past it is refused before it starts; the timeout is what makes
# the count an upper bound rather than a hope.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="${AWS_CLI:-$HERE/scripts/aws.sh}"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"
BUDGET="${WATTSTEER_TRAIN_BUDGET_MINUTES:-480}"

# Minutes of this machine spent so far: finished builds by their duration,
# running ones by their timeout, since that is what they may still spend.
used_minutes() {
  local ids
  ids="$("$AWS" codebuild list-builds-for-project --project-name "$TRAIN_PROJECT" \
    --query 'ids' --output text)"
  [ -z "$ids" ] || [ "$ids" = None ] && { echo 0; return; }
  # shellcheck disable=SC2086 # the ids are one word each, and the CLI takes a list
  "$AWS" codebuild batch-get-builds --ids $ids --output json |
    python3 -c '
import json, sys
from datetime import datetime
total = 0.0
for b in json.load(sys.stdin)["builds"]:
    start = datetime.fromisoformat(b["startTime"])
    if b.get("endTime"):
        total += (datetime.fromisoformat(b["endTime"]) - start).total_seconds() / 60
    else:
        total += b.get("timeoutInMinutes", 0)
print(round(total))'
}

used="$(used_minutes)"
if [ "${1:-}" = --usage ]; then
  echo "machine minutes used: $used of $BUDGET"
  exit 0
fi

run_id="" timeout=120 db=state/db.sql.gz models=state/models.tgz
while [ $# -gt 0 ]; do
  case "$1" in
    --run-id) run_id="$2"; shift 2 ;;
    --timeout) timeout="$2"; shift 2 ;;
    --db) db="$2"; shift 2 ;;
    --models) models="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || { echo "give the command after --" >&2; exit 2; }
run_id="${run_id:-$(date -u +%Y%m%dT%H%M%SZ)}"
command="$*"

if [ $((used + timeout)) -gt "$BUDGET" ]; then
  echo "refused: $used minutes used, this run may take $timeout, the budget is $BUDGET." >&2
  exit 3
fi

SHA="$(git -C "$ROOT" rev-parse HEAD)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$ROOT" archive --format=zip -o "$WORK/source.zip" HEAD
AWS_WORKDIR="$WORK" "$AWS" s3 cp --quiet source.zip "s3://$BUCKET/source/$SHA.zip"

vars="$(python3 -c '
import json, sys
names = ["TRAIN_COMMAND", "RUN_ID", "DB_STATE", "MODELS_STATE"]
print(json.dumps([{"name": n, "value": v, "type": "PLAINTEXT"} for n, v in zip(names, sys.argv[1:])]))
' "$command" "$run_id" "$db" "$models")"
build="$("$AWS" codebuild start-build --project-name "$TRAIN_PROJECT" \
  --source-location-override "$BUCKET/source/$SHA.zip" \
  --timeout-in-minutes-override "$timeout" \
  --environment-variables-override "$vars" \
  --query build.id --output text)"
echo "== $build: $run_id at ${SHA:0:12}, up to $timeout min ($used of $BUDGET used before it)"

status=IN_PROGRESS
while [ "$status" = IN_PROGRESS ]; do
  sleep 60
  read -r status phase < <("$AWS" codebuild batch-get-builds --ids "$build" \
    --query 'builds[0].[buildStatus,currentPhase]' --output text)
  echo "   $(date -u +%H:%M) $status $phase"
done

"$AWS" s3 cp --quiet "s3://$BUCKET/training/$run_id/timing.json" - 2>/dev/null || true
echo "== $status. machine minutes used: $(used_minutes) of $BUDGET"
echo "   results: s3://$BUCKET/training/$run_id/"
[ "$status" = SUCCEEDED ]

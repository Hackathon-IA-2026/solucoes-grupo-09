#!/usr/bin/env bash
# Publish one day-ahead forecast on the instance now, outside the schedule.
#
#   infra/aws/publish.sh <gate_early|gate_late> [YYYY-MM-DD]
#
# The same publisher the scheduled job runs (apps/api/src/scripts/
# publish-forecast.ts), for a day the schedule missed: after a model is
# installed between gates, the product otherwise has no forecast until the
# next one. Re-running is safe; an unchanged publication writes nothing.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="${AWS_CLI:-$HERE/scripts/aws.sh}"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"
GATE="${1:?usage: publish.sh <gate_early|gate_late> [YYYY-MM-DD]}"
DAY="${2:-}"

command="cd /opt/wattsteer && docker compose --project-name wattsteer --env-file .env -f compose.yml exec -T worker bun run src/scripts/publish-forecast.ts $GATE $DAY 2>&1 | tail -20"
params="$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]], "executionTimeout": ["900"]}))' "$command")"
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
[ "$status" = Success ]

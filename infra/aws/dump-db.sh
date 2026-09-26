#!/usr/bin/env bash
# Dump the instance's product database into the bucket, where train.sh reads it.
#
#   infra/aws/dump-db.sh [s3 key]     (default state/db.sql.gz)
#
# The `rag` schema is left out: training never reads it and it is most of the
# bytes. The dump is plain SQL so train-job.sh can pipe it straight into psql.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="${AWS_CLI:-$HERE/scripts/aws.sh}"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"
KEY="${1:-state/db.sql.gz}"

command="cd /opt/wattsteer && docker compose --project-name wattsteer --env-file .env -f compose.yml exec -T postgres pg_dump -U wattsteer -d wattsteer -Fp --no-owner --exclude-schema=rag | gzip -1 | aws s3 cp --quiet - s3://$BUCKET/$KEY --region $AWS_REGION && aws s3 ls s3://$BUCKET/$KEY --region $AWS_REGION"
params="$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]], "executionTimeout": ["7200"]}))' "$command")"
id="$("$AWS" ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters "$params" --query Command.CommandId --output text)"
status=Pending
while [[ "$status" =~ ^(Pending|InProgress|Delayed)$ ]]; do
  sleep 15
  status="$("$AWS" ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)"
done
"$AWS" ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
  --query '[StandardOutputContent,StandardErrorContent]' --output text
echo "== $status: s3://$BUCKET/$KEY"
[ "$status" = Success ]

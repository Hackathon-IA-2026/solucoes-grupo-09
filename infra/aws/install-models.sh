#!/usr/bin/env bash
# Put one training run's artifacts on the instance and restart the ml service.
#
#   infra/aws/install-models.sh <run id> [arm]
#
# <run id> is a train.sh run (s3://…/training/<run id>/models.tgz). With an arm
# (v2, v3, dessem_ab) the artifacts are that arm's directory from a campaign;
# without one, the run's root. The instance's current artifacts are kept in a
# dated copy beside them, so going back is a move, not a retrain.
#
# What the gate promoted inside that root is what the ml service serves: this
# copies a decision, it does not make one.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="${AWS_CLI:-$HERE/scripts/aws.sh}"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"
RUN="${1:?usage: install-models.sh <run id> [arm]}"
ARM="${2:-}"
SOURCE="."
[ -z "$ARM" ] || SOURCE="./arms/$ARM"

D=/opt/wattsteer/data
command="set -e; tmp=\$(mktemp -d); aws s3 cp --quiet s3://$BUCKET/training/$RUN/models.tgz - --region $AWS_REGION | tar --warning=no-unknown-keyword -xz -C \$tmp; [ -d \$tmp/$SOURCE ] || { echo 'no $SOURCE in the run'; exit 1; }; mv $D/ml-models $D/ml-models.before-\$(date -u +%Y%m%dT%H%M%SZ); mkdir -p $D/ml-models; tar -C \$tmp/$SOURCE --exclude=./arms -cf - . | tar -C $D/ml-models -xf -; rm -rf \$tmp; cd /opt/wattsteer && docker compose --project-name wattsteer --env-file .env -f compose.yml restart ml >/dev/null && sleep 20 && docker compose --project-name wattsteer --env-file .env -f compose.yml exec -T ml python -c \"import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health').read().decode())\"; ls $D/ml-models"
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
  --query '[StandardOutputContent,StandardErrorContent]' --output text
echo "== $status. /v1/meta says which lane is promoted: $SITE_URL/v1/meta"
[ "$status" = Success ]

#!/usr/bin/env bash
# Put a state release on the running instance: its model artifacts and its
# scored forecast rows, replacing what is there.
#
#   infra/aws/restore-state.sh <release tag> [--with-rag]
#
# remote.sh seeds a *fresh* instance from state/ once; this is the other case,
# a release newer than what the instance holds (state-2026-09-26 brought the
# promoted artifact and 729 more replayable days). The previous artifacts are
# kept as ml-models.before-<utc stamp>. forecasts.sql.gz is one transaction
# that truncates the three forecast tables first, so a failed restore leaves
# what was there. The RAG corpus is replaced only with --with-rag.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="${AWS_CLI:-$HERE/scripts/aws.sh}"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"
TAG="${1:?usage: restore-state.sh <release tag> [--with-rag]}"
RAG="${2:-}"

"$HERE/seed-state.sh" "$TAG"

D=/opt/wattsteer/data
read -r -d '' REMOTE <<EOS || true
set -e
cd /opt/wattsteer
C="docker compose --project-name wattsteer --env-file .env -f compose.yml"
restore() { aws s3 cp --quiet s3://$BUCKET/state/\$1 - --region $AWS_REGION | gunzip | sed '/^SET transaction_timeout/d' | \$C exec -T postgres psql -U wattsteer -d wattsteer -q -v ON_ERROR_STOP=1 "\${@:2}"; }
tmp=\$(mktemp -d)
aws s3 cp --quiet s3://$BUCKET/state/models.tgz - --region $AWS_REGION | tar --warning=no-unknown-keyword -xz -C \$tmp
mv $D/ml-models $D/ml-models.before-\$(date -u +%Y%m%dT%H%M%SZ)
chmod 755 \$tmp
mv \$tmp $D/ml-models
echo "artifacts: \$(find $D/ml-models -name '*.joblib' | wc -l)"
restore forecasts.sql.gz
echo "forecast days: \$(\$C exec -T postgres psql -U wattsteer -d wattsteer -Atc 'select count(*) from curtailment_forecast_day')"
if [ "$RAG" = --with-rag ]; then
  \$C stop rag >/dev/null
  \$C exec -T postgres psql -U wattsteer -d wattsteer -q -c "CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS rag CASCADE; DROP TABLE IF EXISTS public.rag_migration;"
  restore rag.sql.gz
  \$C start rag >/dev/null
  echo "rag chunks: \$(\$C exec -T postgres psql -U wattsteer -d wattsteer -Atc 'select count(*) from rag.chunk')"
fi
\$C restart ml >/dev/null
sleep 25
\$C exec -T ml python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health').read().decode())"
EOS

params="$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]], "executionTimeout": ["1800"]}))' "$REMOTE")"
id="$("$AWS" ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters "$params" --query Command.CommandId --output text)"
status=Pending
while [[ "$status" =~ ^(Pending|InProgress|Delayed)$ ]]; do
  sleep 10
  status="$("$AWS" ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)"
done
"$AWS" ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
  --query '[StandardOutputContent,StandardErrorContent]' --output text
echo "== $status. Which lane serves: $SITE_URL/v1/meta"
[ "$status" = Success ]

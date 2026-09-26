#!/usr/bin/env bash
# Put a state release on the running instance: its model artifacts and its
# scored forecast rows, **added to** what is there.
#
#   infra/aws/restore-state.sh <release tag> [--forecasts-only] [--with-rag]
#
# remote.sh seeds a *fresh* instance from state/ once; this is the other case,
# a release newer than what the instance holds.
#
# Added, not replaced, because a release is not a superset of its
# predecessors. state-2026-09-26's forecasts.sql.gz opens with TRUNCATE and
# holds April-June 2026; restoring it as a replacement on 26/09 deleted the
# July-September holdout days state-2026-09-23 had put there, the months the
# Time Machine was showing. So the rows are loaded into a staging schema and
# inserted ON CONFLICT DO NOTHING, and the artifacts are unpacked over the
# current ones: the release wins for every file it carries, and a file it does
# not carry (an artifact an older stored forecast is scored against) stays.
# The directory as it was is kept as ml-models.before-<utc stamp>.
#
# --forecasts-only leaves the artifacts alone; --with-rag also replaces the
# RAG corpus (that one is a replacement: a corpus is one indexing).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="${AWS_CLI:-$HERE/scripts/aws.sh}"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"
TAG="${1:?usage: restore-state.sh <release tag> [--forecasts-only] [--with-rag]}"
shift
MODELS=yes RAG=no
for option in "$@"; do
  case "$option" in
    --forecasts-only) MODELS=no ;;
    --with-rag) RAG=yes ;;
    *) echo "unknown option $option" >&2; exit 2 ;;
  esac
done

"$HERE/seed-state.sh" "$TAG"

D=/opt/wattsteer/data
read -r -d '' REMOTE <<EOS || true
set -e
cd /opt/wattsteer
C="docker compose --project-name wattsteer --env-file .env -f compose.yml"
restore() { aws s3 cp --quiet s3://$BUCKET/state/\$1 - --region $AWS_REGION | gunzip | sed '/^SET transaction_timeout/d' | \$C exec -T postgres psql -U wattsteer -d wattsteer -q -v ON_ERROR_STOP=1 "\${@:2}"; }
if [ "$MODELS" = yes ]; then
  tmp=\$(mktemp -d)
  aws s3 cp --quiet s3://$BUCKET/state/models.tgz - --region $AWS_REGION | tar --warning=no-unknown-keyword -xz -C \$tmp
  cp -a $D/ml-models $D/ml-models.before-\$(date -u +%Y%m%dT%H%M%SZ)
  cp -rn $D/ml-models/. \$tmp/
  chmod 755 \$tmp
  rm -rf $D/ml-models
  mv \$tmp $D/ml-models
  echo "artifacts: \$(find $D/ml-models -name '*.joblib' | wc -l)"
fi
stage=restore_\$(date -u +%s)
T="curtailment_forecast_day curtailment_forecast_hour curtailment_forecast_national_day"
\$C exec -T postgres psql -U wattsteer -d wattsteer -q -v ON_ERROR_STOP=1 -c "create schema \$stage"
for t in \$T; do
  \$C exec -T postgres psql -U wattsteer -d wattsteer -q -v ON_ERROR_STOP=1 -c "create table \$stage.\$t (like public.\$t including all)"
done
aws s3 cp --quiet s3://$BUCKET/state/forecasts.sql.gz - --region $AWS_REGION | gunzip |
  sed -e '/^SET transaction_timeout/d' -e '/^TRUNCATE /d' -e '/TRIGGER ALL;\$/d' -e "s/public\\.curtailment_forecast_/\$stage.curtailment_forecast_/g" |
  \$C exec -T postgres psql -U wattsteer -d wattsteer -q -v ON_ERROR_STOP=1
for t in \$T; do
  echo "\$t: \$(\$C exec -T postgres psql -U wattsteer -d wattsteer -At -v ON_ERROR_STOP=1 -c "set session_replication_role = replica" -c "with added as (insert into public.\$t select * from \$stage.\$t on conflict do nothing returning 1) select count(*) || ' added' from added" | tail -1)"
done
\$C exec -T postgres psql -U wattsteer -d wattsteer -q -c "drop schema \$stage cascade"
echo "forecast days: \$(\$C exec -T postgres psql -U wattsteer -d wattsteer -Atc 'select count(*) from curtailment_forecast_day')"
if [ "$RAG" = yes ]; then
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

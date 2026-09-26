#!/bin/bash
# Runs on the instance, as root, through SSM: bring the stack to one image tag.
# ship.sh uploads this file and calls it.
#
#   remote.sh <image tag> <bucket> <deploy prefix> <public url> [region]
#
# Everything lives in /opt/wattsteer (compose project "wattsteer"): the data
# under data/, the generated secrets in .env. Safe to run twice: compose only
# replaces containers whose image or settings changed, and nothing here
# overwrites data/. What is missing from data/ is seeded once from the
# bucket's state/ prefix (seed-state.sh puts it there).
set -euo pipefail
exec 2>&1

TAG="${1:?usage: remote.sh <tag> <bucket> <prefix> <public url> [region]}"
BUCKET="${2:?}"
PREFIX="${3:?}"
PUBLIC_URL="${4:?}"
REGION="${5:-us-west-2}"
DIR=/opt/wattsteer
export AWS_DEFAULT_REGION="$REGION"

# Swap, once: the compose limits leave the host its memory and the swap is the
# margin under them. The event's first instance froze without one.
if [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -d -m 700 "$DIR"
cd "$DIR"
for file in images.tar.gz compose.yml Caddyfile.template; do
  aws s3 cp --quiet "s3://$BUCKET/$PREFIX/$file" "$file"
done
docker load -i images.tar.gz | tail -5
rm -f images.tar.gz

umask 077
touch .env
# Set KEY to VALUE in .env, replacing any earlier line for it.
set_env() {
  sed -i "/^$1=/d" .env
  printf '%s=%s\n' "$1" "$2" >> .env
}
# Only when absent: generated once, and they must survive every deploy.
keep_env() {
  grep -q "^$1=" .env || printf '%s=%s\n' "$1" "$2" >> .env
}
keep_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
keep_env WATTSTEER_RAG_ACCESS_TOKEN "$(openssl rand -hex 24)"
keep_env DATA_DIR "$DIR/data"
# The corpus arrives as a dump (state/rag.sql.gz); indexing here would spend
# the provider quota for hours.
keep_env WATTSTEER_RAG_INDEX_ON_BOOT 0
set_env PUBLIC_URL "$PUBLIC_URL"
set_env REGISTRY local
set_env NAME wattsteer
set_env IMAGE_TAG "$TAG"
# Port 80 is open to CloudFront only (stack.yaml's security group), which
# terminates TLS; nothing listens on 443.
set_env HTTP_PORT 80
set_env HTTPS_PORT 127.0.0.1:8443
set_env TRUSTED_PROXY_DEPTH 1

# Provider keys, from Parameter Store (set-keys.sh writes them): never in an
# image, a bucket or a build log.
aws ssm get-parameters-by-path --path /wattsteer/keys --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text |
  while IFS=$'\t' read -r name value; do
    key="${name##*/}"
    case "$key" in
      NVIDIA_API_KEYS|GROQ_API_KEYS|GEMINI_API_KEYS|XAI_API_KEY) [ -n "$value" ] && set_env "$key" "$value" ;;
    esac
  done
umask 022

# The site password lives in Parameter Store, so whoever runs the account can
# read it without opening the instance. Generated on the first deploy.
if ! password="$(aws ssm get-parameter --name /wattsteer/site-password --with-decryption \
  --query Parameter.Value --output text 2>/dev/null)"; then
  password="$(openssl rand -base64 15 | tr -d '/+=')"
  aws ssm put-parameter --name /wattsteer/site-password --type SecureString \
    --value "$password" >/dev/null
  echo "New site password stored at /wattsteer/site-password (user wattsteer)."
fi
HASH="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$password")"
sed -e "s|__SITE_USER__|wattsteer|" -e "s|__SITE_HASH__|$HASH|" Caddyfile.template > Caddyfile

C="docker compose --project-name wattsteer --env-file $DIR/.env -f $DIR/compose.yml"
psql_in() { $C exec -T postgres psql -U wattsteer -d wattsteer "$@"; }
# A dump taken on Postgres 17 carries settings 16 does not know.
restore() { aws s3 cp --quiet "s3://$BUCKET/state/$1" - | gunzip | sed '/^SET transaction_timeout/d' | psql_in -v ON_ERROR_STOP=1 -q "${@:2}"; }
has_state() { aws s3 ls "s3://$BUCKET/state/$1" >/dev/null 2>&1; }

$C up -d postgres redis
$C up -d --wait postgres redis
$C --profile tools run --rm migrate 2>&1 | tail -1

# Seed what a fresh instance lacks, once each, from the bucket.
mkdir -p "$DIR/data/ml-models"
if [ -z "$(ls -A "$DIR/data/ml-models")" ] && has_state models.tgz; then
  aws s3 cp --quiet "s3://$BUCKET/state/models.tgz" - | tar -xz -C "$DIR/data/ml-models"
  echo "Seeded model artifacts: $(find "$DIR/data/ml-models" -name '*.joblib' | wc -l) files"
fi
chunks="$(psql_in -Atc "select count(*) from rag.chunk" 2>/dev/null || echo 0)"
if [ "${chunks:-0}" -eq 0 ] && has_state rag.sql.gz; then
  $C stop rag >/dev/null 2>&1 || true
  psql_in -q -c "CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS rag CASCADE; DROP TABLE IF EXISTS public.rag_migration;"
  restore rag.sql.gz
  echo "Seeded the RAG corpus"
fi
forecast_days="$(psql_in -Atc "select count(*) from curtailment_forecast_day" 2>/dev/null || echo 0)"
if [ "${forecast_days:-0}" -eq 0 ] && has_state forecasts.sql.gz; then
  restore forecasts.sql.gz
  echo "Seeded the forecast rows"
fi

# Fail the deploy when a service does not become healthy, rather than report
# success over a stack that is not answering. The worker has no healthcheck on
# purpose (it opens no port), so it is left out of --wait and only has to run.
status=0
$C up -d --remove-orphans
$C up -d --wait --wait-timeout 300 postgres redis api ml rag web caddy || status=$?
[ "$(docker inspect -f '{{.State.Running}}' wattsteer-worker-1 2>/dev/null)" = true ] || status=1
$C ps --format '{{.Service}} {{.Image}} {{.Status}}'
echo "RAG corpus: $(psql_in -Atc "select count(*) from rag.chunk" 2>/dev/null || echo 0) chunks"

# Keep only the images this tag runs.
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^local/wattsteer/' | grep -v ":$TAG\$" \
  | xargs -r docker image rm >/dev/null 2>&1 || true
exit "$status"

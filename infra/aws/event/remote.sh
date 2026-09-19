#!/bin/bash
# Runs on the event's Code Editor instance, as root, through SSM: bring the
# stack to one image tag. deploy.sh uploads this file and calls it.
#
#   remote.sh <image tag> <transfer bucket> [region]
#
# Everything lives in /opt/wsdemo (compose project "wsdemo"): the data under
# data/, the generated secrets in .env, the site password in .site-password.
# Safe to run twice: compose only replaces containers whose image or settings
# changed, and nothing here touches data/.
set -euo pipefail
exec 2>&1

TAG="${1:?usage: remote.sh <image tag> <bucket>}"
BUCKET="${2:?usage: remote.sh <image tag> <bucket>}"
DIR=/opt/wsdemo
REGION="${3:-us-east-1}"

# Swap, once: the stack's limits leave the host its memory, and the swap is the
# margin under them (see compose.aws.yml and ../compose/up.sh).
if [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# The instance ships Docker without the compose plugin.
if ! docker compose version >/dev/null 2>&1; then
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fsSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-aarch64 \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

install -d -m 700 "$DIR"
cd "$DIR"
for file in images.tar.gz compose.yml Caddyfile.template; do
  aws s3 cp --quiet "s3://$BUCKET/$file" "$file" --region "$REGION"
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
# Only when absent: these are generated once and must survive every deploy.
keep_env() {
  grep -q "^$1=" .env || printf '%s=%s\n' "$1" "$2" >> .env
}
keep_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
keep_env WATTSTEER_RAG_ACCESS_TOKEN "$(openssl rand -hex 24)"
keep_env DATA_DIR "$DIR/data"
# The corpus is indexed locally and restored here; indexing on this host
# would spend the provider quota and hours of its one CPU.
keep_env WATTSTEER_RAG_INDEX_ON_BOOT 0
set_env PUBLIC_URL "$(aws s3 cp --quiet "s3://$BUCKET/public-url" - --region "$REGION")"
set_env REGISTRY local
set_env NAME wattsteer
set_env IMAGE_TAG "$TAG"
# Caddy is reached only through the instance's proxy on 127.0.0.1.
set_env HTTP_PORT 127.0.0.1:8081
set_env HTTPS_PORT 127.0.0.1:8443
# CloudFront and nginx both append to X-Forwarded-For before Caddy.
set_env TRUSTED_PROXY_DEPTH 2

# Provider keys, only when the deploy sent some: each replaces its own line.
if aws s3 cp --quiet "s3://$BUCKET/keys.env" keys.env --region "$REGION" 2>/dev/null; then
  while IFS='=' read -r key value; do
    case "$key" in
      NVIDIA_API_KEYS|GROQ_API_KEYS|XAI_API_KEY) [ -n "$value" ] && set_env "$key" "$value" ;;
    esac
  done < keys.env
  rm -f keys.env
fi
umask 022

# The site password: generated on the first deploy, then kept.
if [ ! -s .site-password ]; then
  (umask 077; openssl rand -base64 15 | tr -d '/+=' > .site-password)
  echo "New site password (user wattsteer): $(cat .site-password)"
fi
HASH="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$(cat .site-password)")"
sed -e "s|__SITE_USER__|wattsteer|" -e "s|__SITE_HASH__|$HASH|" Caddyfile.template > Caddyfile

C="docker compose --project-name wsdemo --env-file $DIR/.env -f $DIR/compose.yml"
$C up -d postgres redis
$C --profile tools run --rm migrate 2>&1 | tail -1
# Fail the deploy when a service does not become healthy, rather than report
# success over a stack that is not answering. The worker is left out of
# --wait because compose counts "no healthcheck" as a failure and the worker
# has none on purpose (it opens no port); it only has to be running.
status=0
$C up -d --remove-orphans
$C up -d --wait --wait-timeout 300 postgres redis api ml rag web caddy || status=$?
[ "$(docker inspect -f '{{.State.Running}}' wsdemo-worker-1 2>/dev/null)" = true ] || status=1
$C ps --format '{{.Service}} {{.Image}} {{.Status}}'

# The RAG corpus is not in the images: a fresh instance starts with none.
chunks="$($C exec -T postgres psql -U wattsteer -d wattsteer -Atc \
  "select count(*) from rag.chunk" 2>/dev/null || echo 0)"
echo "RAG corpus: ${chunks:-0} chunks"
[ "${chunks:-0}" -gt 0 ] || echo "WARNING: the RAG has no corpus here; restore it (README: The RAG corpus)."

# Keep only the images this tag runs.
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^local/wattsteer/' | grep -v ":$TAG\$" \
  | xargs -r docker image rm >/dev/null 2>&1 || true
exit "$status"

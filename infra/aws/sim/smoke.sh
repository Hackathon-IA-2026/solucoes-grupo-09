#!/usr/bin/env bash
# Run the EC2 option's stack on this machine, from what Terraform uploaded.
#
# Does what up.sh does on the instance, minus the parts only an instance has:
# reads compose.yml, Caddyfile and settings.env from the simulated S3 bucket,
# the secrets from the simulated SSM, runs the migration, starts everything,
# and checks the site and the API through Caddy — the same path split as the
# ECS option's load balancer.
#
# The images are the ones deploy.sh just built, already tagged with the
# registry address the compose file names, so nothing is pulled.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AWS="$HERE/../scripts/aws.sh"
TAG="${1:?usage: smoke.sh <image tag>}"
WORK="$(mktemp -d)"
PORT="${SMOKE_PORT:-18080}"
bucket="wattsteer-archive-123456789012"

for file in compose.yml Caddyfile settings.env; do
  "$AWS" s3 cp "s3://$bucket/deploy/$file" - > "$WORK/$file"
done

"$AWS" ssm get-parameters-by-path --path /wattsteer/ --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text |
  while IFS=$'\t' read -r name value; do
    [ "$value" = "unset" ] && continue
    printf '%s=%s\n' "${name##*/}" "$value"
  done > "$WORK/secrets.env"
# Only the simulation: fake provider keys must not reach the providers.
printf 'WATTSTEER_RAG_INDEX_ON_BOOT=0\nDATA_DIR=%s/data\nHTTP_PORT=%s\nHTTPS_PORT=18443\n' "$WORK" "$PORT" >> "$WORK/secrets.env"

export IMAGE_TAG="$TAG"
compose=(docker compose --project-name wattsteer-ec2-sim --env-file "$WORK/settings.env"
  --env-file "$WORK/secrets.env" -f "$WORK/compose.yml")
cleanup() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"; }
[ "${KEEP:-0}" = "1" ] || trap cleanup EXIT

"${compose[@]}" up -d postgres redis >/dev/null 2>&1
"${compose[@]}" run --rm migrate 2>&1 | grep -q "migrations applied successfully" ||
  { echo "FAIL migration"; exit 1; }
echo "  ok   migrations applied"
"${compose[@]}" up -d >/dev/null 2>&1

check() { # <label> <path>
  for _ in $(seq 1 36); do
    if body="$(curl -fsS -m 5 "http://localhost:$PORT$2" 2>/dev/null)"; then
      echo "  ok   $1  $2  ${body:0:90}"
      return 0
    fi
    sleep 5
  done
  echo "  FAIL $1 $2"
  "${compose[@]}" ps
  "${compose[@]}" logs --tail 30
  exit 1
}
check "web via caddy" /healthz
check "site page    " /pt/
check "api via caddy" /v1/meta
check "api ready    " /ready
for service in ml rag worker; do
  state="$("${compose[@]}" ps --format '{{.Service}} {{.State}} {{.Health}}' | awk -v s="$service" '$1 == s')"
  case "$state" in *running*) echo "  ok   $state" ;; *) echo "  FAIL $service: $state"; exit 1 ;; esac
done
echo "EC2 compose stack: every service started and answered through Caddy"

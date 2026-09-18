#!/bin/bash
# Runs on the EC2 instance: bring the stack to the given image tag.
#
#   /opt/wattsteer/up.sh <image tag> <deploy bucket>
#
# Reads the compose file and settings the Terraform apply uploaded to
# s3://<bucket>/deploy/, the secrets from SSM under /<name>/, logs in to ECR,
# runs the migration, then `docker compose up -d`. Safe to run twice: compose
# only replaces containers whose image or settings changed, and the data lives
# on /data.
set -euo pipefail

TAG="${1:?usage: up.sh <image tag> <deploy bucket>}"
BUCKET="${2:?usage: up.sh <image tag> <deploy bucket>}"
DIR=/opt/wattsteer
TOKEN="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
REGION="$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)"

cd "$DIR"
# Not up.sh itself: bash reads a script as it runs, and overwriting the file
# mid-run corrupts it. scripts/deploy.sh fetches up.sh before calling it.
for file in compose.yml Caddyfile settings.env; do
  aws s3 cp --quiet "s3://$BUCKET/deploy/$file" "$DIR/$file" --region "$REGION"
done

# NAME and REGISTRY below come from this file, which Terraform writes.
set -a
# shellcheck disable=SC1091
. "$DIR/settings.env"
set +a

# Secrets: one SSM parameter per variable, named after it. Written to a file
# only root can read, and never echoed.
umask 077
# shellcheck disable=SC2153
aws ssm get-parameters-by-path --region "$REGION" --path "/$NAME/" --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text |
  while IFS=$'\t' read -r name value; do
    key="${name##*/}"
    [ "$value" = "unset" ] && continue
    printf '%s=%s\n' "$key" "$value"
  done > "$DIR/secrets.env"
umask 022

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

export IMAGE_TAG="$TAG"
compose=(docker compose --project-name "$NAME" --env-file "$DIR/settings.env" --env-file "$DIR/secrets.env" -f "$DIR/compose.yml")
"${compose[@]}" pull
"${compose[@]}" up -d postgres redis
"${compose[@]}" run --rm migrate
"${compose[@]}" up -d --remove-orphans
docker image prune -f >/dev/null
"${compose[@]}" ps

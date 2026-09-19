#!/usr/bin/env bash
# Deploy the committed HEAD to the event's Code Editor instance. See README.md.
#
#   EVENT_PUBLIC_URL=https://<id>.cloudfront.net/app/8081 infra/aws/event/deploy.sh
#
# Needs Docker (with buildx) and the Workshop Studio credentials exported
# (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN). Optional:
#   EVENT_KEYS_FILE   a file with NVIDIA_API_KEYS=, GROQ_API_KEYS=, XAI_API_KEY=
#                     lines; only those three are read, and only non-empty ones
#                     replace what the instance has
#   EVENT_INSTANCE_ID when the account has more than one running instance
#
# What leaves this machine: built images, the compose file, the Caddyfile
# template, remote.sh, and the keys file if given. Never the source tree or a
# .env. They travel through a private bucket that is deleted on the way out.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws/event"
AWS="$ROOT/infra/aws/scripts/aws.sh"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
URL="${EVENT_PUBLIC_URL:?set EVENT_PUBLIC_URL, e.g. https://<id>.cloudfront.net/app/8081}"
URL="${URL%/}"
BASE_PATH="/${URL#https://*/}"
TAG="$(git -C "$ROOT" rev-parse --short HEAD)"

if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
  echo "deploy.sh ships the committed HEAD ($TAG); uncommitted changes would not be in it." >&2
fi

# Through SSM, not EC2: the participant role may not call ec2:Describe*.
# shellcheck disable=SC2016 # the backticks are a JMESPath literal, not a shell expansion
INSTANCE="${EVENT_INSTANCE_ID:-$("$AWS" ssm describe-instance-information \
  --query 'InstanceInformationList[?PingStatus==`Online`].InstanceId' --output text)}"
if [ -z "$INSTANCE" ] || [ "$(wc -w <<<"$INSTANCE")" -ne 1 ]; then
  echo "Found instances: '${INSTANCE}'. Set EVENT_INSTANCE_ID to the Code Editor one." >&2
  exit 1
fi

WORK="$(mktemp -d)"
BUCKET="wattsteer-event-deploy-$(openssl rand -hex 4)"
cleanup() {
  "$AWS" s3 rb --force "s3://$BUCKET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== building $TAG for $URL (arm64: the instance is Graviton)"
git -C "$ROOT" archive HEAD | tar -x -C "$WORK"
mkdir -p "$WORK/out"
build() {
  local name="$1" dockerfile="$2" context="$3"
  shift 3
  echo "   $name"
  docker buildx build --platform linux/arm64 --load -q \
    -t "local/wattsteer/$name:$TAG" -f "$WORK/$dockerfile" "$@" "$WORK/$context" >/dev/null
}
build api apps/api/Dockerfile .
build ml apps/ml/Dockerfile apps/ml
build rag apps/rag/Dockerfile .
build migrate infra/aws/docker/migrate.Dockerfile .
build web apps/web/Dockerfile . \
  --build-arg "EXPO_PUBLIC_API_URL=$URL" \
  --build-arg "EXPO_PUBLIC_SITE_URL=$URL" \
  --build-arg "EXPO_PUBLIC_BASE_PATH=$BASE_PATH"
images=()
for name in api ml rag migrate web; do images+=("local/wattsteer/$name:$TAG"); done
docker save "${images[@]}" | gzip -1 > "$WORK/out/images.tar.gz"

echo "== uploading to s3://$BUCKET"
"$AWS" s3 mb "s3://$BUCKET" >/dev/null
put() { "$AWS" s3 cp --quiet - "s3://$BUCKET/$2" < "$1"; }
put "$WORK/out/images.tar.gz" images.tar.gz
put "$ROOT/infra/aws/compose/compose.aws.yml" compose.yml
put "$HERE/Caddyfile" Caddyfile.template
put "$HERE/remote.sh" remote.sh
# The gateway's PUBLIC_URL is its CORS origin, and an origin has no path.
printf 'https://%s' "$(cut -d/ -f3 <<<"$URL")" > "$WORK/out/public-url"
put "$WORK/out/public-url" public-url
if [ -n "${EVENT_KEYS_FILE:-}" ]; then
  # Filtered here, so nothing else in the file reaches the bucket.
  grep -E '^(NVIDIA_API_KEYS|GROQ_API_KEYS|XAI_API_KEY)=.' "$EVENT_KEYS_FILE" > "$WORK/out/keys.env" || true
  put "$WORK/out/keys.env" keys.env
fi

echo "== deploying on $INSTANCE"
command="aws s3 cp --quiet s3://$BUCKET/remote.sh /tmp/wattsteer-remote.sh --region $AWS_DEFAULT_REGION && bash /tmp/wattsteer-remote.sh $TAG $BUCKET $AWS_DEFAULT_REGION; status=\$?; rm -f /tmp/wattsteer-remote.sh; exit \$status"
params="$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]], "executionTimeout": ["1800"]}))' "$command")"
id="$("$AWS" ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "$params" --query Command.CommandId --output text)"
status=Pending
while [[ "$status" =~ ^(Pending|InProgress|Delayed)$ ]]; do
  sleep 10
  status="$("$AWS" ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE" \
    --query Status --output text 2>/dev/null || echo Pending)"
done
"$AWS" ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE" \
  --query StandardOutputContent --output text
echo "== $status: $URL/"
[ "$status" = Success ]

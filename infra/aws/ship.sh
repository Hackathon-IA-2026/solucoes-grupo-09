#!/usr/bin/env bash
# Runs inside CodeBuild (buildspec.yml): build the five images of one commit,
# put them in the bucket, and run remote.sh on the instance through SSM.
#
# arm64 end to end: CodeBuild's ARM container and the Graviton instance, so no
# image is emulated. Only images, the compose file, the Caddyfile and remote.sh
# reach the instance; the source tree stays in this build.
set -euo pipefail

: "${BUCKET:?}" "${INSTANCE_ID:?}" "${PUBLIC_URL:?}"
TAG="${GIT_SHA:-$(date -u +%Y%m%d%H%M%S)}"
TAG="${TAG:0:12}"
PREFIX="deploy/$TAG"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"

echo "== building $TAG for $PUBLIC_URL"
build() {
  local name="$1" dockerfile="$2" context="$3"
  shift 3
  echo "   $name"
  docker build -q -t "local/wattsteer/$name:$TAG" -f "$dockerfile" "$@" "$context" >/dev/null
}
build api apps/api/Dockerfile .
build ml apps/ml/Dockerfile apps/ml
build rag apps/rag/Dockerfile .
build migrate infra/aws/docker/migrate.Dockerfile .
# Same origin for the site and the API: Caddy sends /v1 to the gateway.
build web apps/web/Dockerfile . \
  --build-arg "EXPO_PUBLIC_API_URL=$PUBLIC_URL" \
  --build-arg "EXPO_PUBLIC_SITE_URL=$PUBLIC_URL"

echo "== uploading to s3://$BUCKET/$PREFIX"
images=()
for name in api ml rag migrate web; do images+=("local/wattsteer/$name:$TAG"); done
docker save "${images[@]}" | gzip -1 | aws s3 cp --quiet - "s3://$BUCKET/$PREFIX/images.tar.gz"
aws s3 cp --quiet infra/aws/compose/compose.aws.yml "s3://$BUCKET/$PREFIX/compose.yml"
aws s3 cp --quiet infra/aws/Caddyfile "s3://$BUCKET/$PREFIX/Caddyfile.template"
aws s3 cp --quiet infra/aws/remote.sh "s3://$BUCKET/$PREFIX/remote.sh"

echo "== deploying on $INSTANCE_ID"
command="aws s3 cp --quiet s3://$BUCKET/$PREFIX/remote.sh /tmp/wattsteer-remote.sh --region $REGION && bash /tmp/wattsteer-remote.sh $TAG $BUCKET $PREFIX $PUBLIC_URL $REGION; status=\$?; rm -f /tmp/wattsteer-remote.sh; exit \$status"
params="$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]], "executionTimeout": ["3600"]}))' "$command")"
id="$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters "$params" --query Command.CommandId --output text)"
status=Pending
while [[ "$status" =~ ^(Pending|InProgress|Delayed)$ ]]; do
  sleep 10
  status="$(aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)"
done
aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
  --query '[StandardOutputContent,StandardErrorContent]' --output text
echo "== $status: $PUBLIC_URL/"
[ "$status" = Success ]

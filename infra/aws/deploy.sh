#!/usr/bin/env bash
# Deploy the committed HEAD to the AWS stack: the same command GitHub Actions
# runs on every push to main (.github/workflows/deploy-aws.yml).
#
#   infra/aws/deploy.sh
#
# Needs AWS credentials for the account (the Workshop Studio ones on a laptop,
# the OIDC role in CI). It archives HEAD into the bucket and starts the
# CodeBuild project, which builds on arm64 and ships to the instance
# (ship.sh, remote.sh). Nothing is built on this machine.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="${AWS_CLI:-$HERE/scripts/aws.sh}"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="${AWS_REGION:?stack.env names the region}"

SHA="$(git -C "$ROOT" rev-parse HEAD)"
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
  echo "deploy.sh ships the committed HEAD (${SHA:0:12}); uncommitted changes are not in it." >&2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$ROOT" archive --format=zip -o "$WORK/source.zip" HEAD
# From inside $WORK, so "source.zip" resolves for both the Docker wrapper
# (which mounts it at /work) and a native CLI in CI.
(cd "$WORK" && AWS_WORKDIR="$WORK" "$AWS" s3 cp --quiet source.zip "s3://$BUCKET/source/$SHA.zip")

build="$("$AWS" codebuild start-build --project-name "$DEPLOY_PROJECT" \
  --source-location-override "$BUCKET/source/$SHA.zip" \
  --environment-variables-override "name=GIT_SHA,value=$SHA,type=PLAINTEXT" \
  --query build.id --output text)"
echo "== $build started for ${SHA:0:12}"

status=IN_PROGRESS
while [ "$status" = IN_PROGRESS ]; do
  sleep 20
  read -r status phase < <("$AWS" codebuild batch-get-builds --ids "$build" \
    --query 'builds[0].[buildStatus,currentPhase]' --output text)
  echo "   $status $phase"
done

# The last lines of the build log: the compose status table and the verdict.
stream="${build#*:}"
"$AWS" logs get-log-events --log-group-name "/aws/codebuild/$DEPLOY_PROJECT" \
  --log-stream-name "$stream" --limit 40 --query 'events[].message' --output text |
  tr '\t' '\n' | grep -v '^$' || true
echo "== $status: $SITE_URL/"
[ "$status" = SUCCEEDED ]

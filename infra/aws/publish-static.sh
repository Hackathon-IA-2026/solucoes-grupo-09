#!/usr/bin/env bash
# Put a directory of static files on the instance, served at /<name>/ behind
# the site password (the Caddyfile names the paths it serves; add one there).
#
#   infra/aws/publish-static.sh <local dir> <name>
#
# For pages the team reviews beside the product, such as a UI proposal, that
# should not ride a deploy of main: the files travel through the bucket and
# land in /opt/wattsteer/data/static/<name>/, which Caddy mounts read-only.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="${AWS_CLI:-$HERE/scripts/aws.sh}"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"
DIR="${1:?usage: publish-static.sh <local dir> <name>}"
NAME="${2:?usage: publish-static.sh <local dir> <name>}"
[ -f "$DIR/index.html" ] || { echo "$DIR has no index.html" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -C "$DIR" -czf "$WORK/static.tgz" .
(cd "$WORK" && AWS_WORKDIR="$WORK" "$AWS" s3 cp --quiet static.tgz "s3://$BUCKET/static/$NAME.tgz")

command="set -e; d=/opt/wattsteer/data/static/$NAME; mkdir -p \$d.new; aws s3 cp --quiet s3://$BUCKET/static/$NAME.tgz - --region $AWS_REGION | tar --warning=no-unknown-keyword -xz -C \$d.new; rm -rf \$d; mv \$d.new \$d; chmod -R a+rX /opt/wattsteer/data/static; find \$d -type f | wc -l"
params="$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]], "executionTimeout": ["300"]}))' "$command")"
id="$("$AWS" ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters "$params" --query Command.CommandId --output text)"
status=Pending
while [[ "$status" =~ ^(Pending|InProgress|Delayed)$ ]]; do
  sleep 5
  status="$("$AWS" ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)"
done
echo "files: $("$AWS" ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text | tr -d '\n')"
echo "== $status: $SITE_URL/$NAME/"
[ "$status" = Success ]

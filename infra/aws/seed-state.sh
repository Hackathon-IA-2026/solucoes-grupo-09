#!/usr/bin/env bash
# Copy a state release into the bucket's state/ prefix, where remote.sh seeds a
# fresh instance from: the model artifacts (models.tgz), the scored forecast
# rows (forecasts.sql.gz) and the indexed RAG corpus (rag.sql.gz).
#
#   infra/aws/seed-state.sh [release tag]     (default: state-2026-09-23)
#
# Seeding happens once per piece: remote.sh only restores into an empty
# directory or table, so re-running this never overwrites live data.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="$HERE/scripts/aws.sh"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"
TAG="${1:-state-2026-09-23}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "== fetching $TAG"
gh release download "$TAG" --repo vtorres/WattSteer --dir "$WORK" \
  --pattern models.tgz --pattern forecasts.sql.gz --pattern rag.sql.gz
for file in models.tgz forecasts.sql.gz rag.sql.gz; do
  [ -s "$WORK/$file" ] || continue
  (cd "$WORK" && AWS_WORKDIR="$WORK" "$AWS" s3 cp --quiet "$file" "s3://$BUCKET/state/$file")
  echo "   state/$file"
done

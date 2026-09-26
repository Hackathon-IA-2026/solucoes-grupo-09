#!/usr/bin/env bash
# Put a weather history on a deployment that does not have one.
#
#   infra/railway/ship-weather.sh <directory holding weather.sql.gz>
#   infra/railway/ship-weather.sh --from-release state-2026-09-26
#
# `weather_forecast_hour` and `weather_run_request` — two and a half years of
# hourly weather per centroid, which is a feature input and not a forecast of
# ours.
#
# ## Why this travels at all
#
# Because it cannot be refetched. `ecc10e5` measured it: each weather task stops
# at the free tier's 138 weighted units, so the history since 2024-03-15 is
# about 1,800 such slots — on the order of 200,000 units against an allowance of
# 10,000 a day. That is about three weeks, and it would spend the allowance the
# hourly live sweep needs for tomorrow's forecast. That commit removed
# `backfill.sh --weather` and named the alternative in as many words: "a
# database that already holds it (a dump of the standing deployment's)".
#
# ## Why this is a third script and not a flag on ship-state.sh
#
# Because it is a different *kind* of write. `ship-state.sh` truncates and
# reloads three forecast tables, which is safe because only a backfill ever
# writes them. The receiving deployment writes `weather_forecast_hour` itself,
# every hour, so replacing it wholesale would discard rows it fetched and this
# script must never be the reason a deployment lost weather.
#
# So the load is **idempotent**: the dump carries its rows into a temp table and
# inserts them `ON CONFLICT DO NOTHING` against the real ones. Both tables are
# keyed — `(centroid_id, valid_time, data_version)` and `(id)` — so a row that
# is already there is the same row. Running it twice is running it once, and
# running it on a deployment that has a newer history than the dump adds only
# what that deployment lacks.
#
# That shape lives in the dump, not here: see `make-state-bundle.sh`. This
# script fetches it, runs it in one transaction, and prints the count.
set -euo pipefail

if [ "${1:-}" = "--from-release" ]; then
  TAG="${2:?usage: ship-weather.sh --from-release <tag> [directory]}"
  BUNDLE="${3:-$(mktemp -d)}"
  mkdir -p "$BUNDLE"
  echo "== fetching $TAG into $BUNDLE"
  gh release download "$TAG" --repo vtorres/WattSteer --clobber \
    --pattern 'weather.sql.gz' --dir "$BUNDLE"
fi

BUNDLE="${BUNDLE:-${1:?usage: ship-weather.sh <directory> | --from-release <tag>}}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"

[ -s "$BUNDLE/weather.sql.gz" ] || { echo "missing $BUNDLE/weather.sql.gz" >&2; exit 1; }

echo "== who am I to Railway"
railway whoami

echo "== what is there before"
# Printed on both sides of the load, because the number this script moves is the
# only evidence it did anything: an idempotent load against a deployment that
# already has the history is a successful no-op, and that must be legible rather
# than look like a failure.
# shellcheck disable=SC2016 # the variable must expand in Railway's shell, not here
railway run --environment "$ENVIRONMENT" -- sh -c 'psql "$DATABASE_URL" -At \
  -c "select '\''weather hours: '\''||count(*) from weather_forecast_hour"'

gunzip -c "$BUNDLE/weather.sql.gz" > "$BUNDLE/.weather.sql"
trap 'rm -f "$BUNDLE/.weather.sql"' EXIT

echo "== loading, in one transaction"
# `ON_ERROR_STOP=1` with the dump's own BEGIN/COMMIT: a failure half way leaves
# the table exactly as it was rather than a partial history nobody can date.
# shellcheck disable=SC2016 # same: the injected variable belongs to the other shell
railway run --environment "$ENVIRONMENT" -- \
  sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f '"$BUNDLE/.weather.sql"

echo "== what is there now"
# shellcheck disable=SC2016 # same
railway run --environment "$ENVIRONMENT" -- sh -c 'psql "$DATABASE_URL" -At \
  -c "select '\''weather hours: '\''||count(*)||'\'', from '\''||min(valid_time)::date||'\'' to '\''||max(valid_time)::date from weather_forecast_hour"'
echo "== done. An unchanged count means the deployment already had this history."

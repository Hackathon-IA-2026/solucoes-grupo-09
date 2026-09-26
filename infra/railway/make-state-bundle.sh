#!/usr/bin/env bash
# Take the trained state off a local stack and put it in one directory.
#
#   infra/railway/make-state-bundle.sh <output directory>
#
# Three files come out, and they are the three things a deployment cannot
# rebuild from the repository: the artifact files a retrain wrote, the forecast
# rows a holdout backfill scored, and the weather history.
#
# **Weather is here because `ecc10e5` measured that it cannot be refetched.**
# Each weather task stops at the free tier's 138 weighted units, so the history
# since 2024-03-15 is about 1,800 such slots — on the order of 200,000 units
# against an allowance of 10,000 a day, which is about three weeks, and it would
# spend the allowance the hourly live sweep needs for tomorrow's forecast. That
# commit removed `backfill.sh --weather` and said where the history has to come
# from instead: "a database that already holds it (a dump of the standing
# deployment's)". This is that dump. It was missing from this script for two
# days after the finding, and a bundle cut in between shipped without it.
#
# The RAG corpus is the fourth and is not produced here — see `ship-rag.sh`,
# which carries the two `pg_dump` invocations it needs in its own header.
#
# `ship-state.sh` sends the result. They are separate because the machine that
# trains and the machine that deploys need not be the same one, and because a
# bundle is worth keeping: it is what a later run is compared against.
#
# ## Where it reads from
#
# A local Compose stack — by default the one `scratchpad/memtest` runs as
# project `wsmem`. Override with `PG_CONTAINER` and `MODELS_DIR`.
set -euo pipefail

OUT="${1:?usage: make-state-bundle.sh <output directory>}"
PG_CONTAINER="${PG_CONTAINER:-wsmem-postgres-1}"
MODELS_DIR="${MODELS_DIR:-}"
mkdir -p "$OUT"

if [ -z "$MODELS_DIR" ]; then
  echo "set MODELS_DIR to the ml volume's directory (it holds the lane folders)" >&2
  exit 1
fi

echo "== artifacts from $MODELS_DIR"
# The whole volume: the `.joblib` is what serves, and the `.card.json` beside it
# is what the Time Machine checks a replay's windows against. One without the
# other is a lane that loads and cannot be replayed.
tar -C "$MODELS_DIR" -czf "$OUT/models.tgz" .

echo "== forecast rows from $PG_CONTAINER"
# Data only, and only the three tables a replay reads. `--disable-triggers` for
# the reason every restore here uses it: the rows reference an artifact id that
# no table on the receiving side has to know about first.
docker exec "$PG_CONTAINER" pg_dump -U wattsteer -d wattsteer \
  --data-only --disable-triggers --no-owner \
  -t public.curtailment_forecast_hour \
  -t public.curtailment_forecast_day \
  -t public.curtailment_forecast_national_day \
  | grep -v -E '^\\(un)?restrict |^SET transaction_timeout' \
  | { echo "BEGIN;"; \
      echo "TRUNCATE public.curtailment_forecast_hour, public.curtailment_forecast_day, public.curtailment_forecast_national_day CASCADE;"; \
      cat; echo "COMMIT;"; } \
  | gzip -1 > "$OUT/forecasts.sql.gz"

echo "== weather history from $PG_CONTAINER"
# Idempotent, and deliberately not the truncate-and-load the forecast rows get.
# Those three tables are written only by a backfill, so replacing them wholesale
# is safe; `weather_forecast_hour` is written by the hourly live sweep on the
# *receiving* side as well, and both tables are keyed — (centroid_id,
# valid_time, data_version) and (id) — so a row that is already there is the
# same row. Loading through a temp table and inserting `ON CONFLICT DO NOTHING`
# adds the history the target lacks and discards nothing it fetched itself.
#
# No `--disable-triggers`: nothing is written to a real table until the final
# INSERTs, and those run as the ordinary user.
{
  echo "BEGIN;"
  echo "CREATE TEMP TABLE t_weather_forecast_hour (LIKE public.weather_forecast_hour) ON COMMIT DROP;"
  echo "CREATE TEMP TABLE t_weather_run_request (LIKE public.weather_run_request) ON COMMIT DROP;"
  docker exec "$PG_CONTAINER" pg_dump -U wattsteer -d wattsteer \
    --data-only --no-owner \
    -t public.weather_forecast_hour \
    -t public.weather_run_request \
    | grep -v -E '^\\(un)?restrict |^SET transaction_timeout' \
    | sed -e 's/^COPY public\.weather_forecast_hour /COPY t_weather_forecast_hour /' \
          -e 's/^COPY public\.weather_run_request /COPY t_weather_run_request /'
  echo "INSERT INTO public.weather_forecast_hour SELECT * FROM t_weather_forecast_hour ON CONFLICT DO NOTHING;"
  echo "INSERT INTO public.weather_run_request SELECT * FROM t_weather_run_request ON CONFLICT DO NOTHING;"
  echo "COMMIT;"
} | gzip -6 > "$OUT/weather.sql.gz"

for file in "$OUT"/models.tgz "$OUT"/forecasts.sql.gz "$OUT"/weather.sql.gz; do
  printf '%.1f MB  %s\n' "$(echo "scale=2; $(wc -c < "$file") / 1048576" | bc)" "$(basename "$file")"
done
echo "== bundle ready. Ship it with infra/railway/ship-state.sh $OUT"

#!/usr/bin/env bash
# Take the trained state off a local stack and put it in one directory.
#
#   infra/railway/make-state-bundle.sh <output directory>
#
# Two files come out, and they are the two things a deployment cannot rebuild
# from the repository: the artifact files a retrain wrote, and the forecast rows
# a holdout backfill scored. Everything else Railway needs is code, an image or
# an ingestion it runs itself.
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

for file in "$OUT"/models.tgz "$OUT"/forecasts.sql.gz; do
  printf '%.1f MB  %s\n' "$(echo "scale=2; $(wc -c < "$file") / 1048576" | bc)" "$(basename "$file")"
done
echo "== bundle ready. Ship it with infra/railway/ship-state.sh $OUT"

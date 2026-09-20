#!/usr/bin/env bash
# Ship one machine's trained state to Railway: the artifact files the modelling
# service reads, and the forecast rows the Time Machine replays.
#
#   infra/railway/ship-state.sh <bundle directory>
#
# The bundle is what `make-state-bundle.sh` writes: `models.tgz` and
# `forecasts.sql.gz`. Both are *state*, not code — the code goes to Railway with
# `railway up`, which this script deliberately does not do, because a deploy and
# a data restore failing together is two problems wearing one hat.
#
# ## What it needs, and who has it
#
# A Railway session with **deploy rights on the `wattsteer` project**:
# `railway login`, or `RAILWAY_TOKEN` set to a project token. Nothing here is
# specific to one person's account — whoever holds that can run it.
#
# ## What it does not do
#
# It does not touch `main`, it does not restart a service, and it writes no
# table other than the three forecast tables it names. The RAG corpus has its
# own recipe (`infra/aws/event/README.md`) and is not state this script owns.
set -euo pipefail

BUNDLE="${1:?usage: ship-state.sh <bundle directory>}"
SERVICE_ML="${RAILWAY_ML_SERVICE:-ml}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"

for file in models.tgz forecasts.sql.gz; do
  [ -s "$BUNDLE/$file" ] || { echo "missing $BUNDLE/$file" >&2; exit 1; }
done

echo "== who am I to Railway"
railway whoami

echo "== the artifacts, into the ml service's volume"
# `railway ssh` runs a command inside the deployed container, which is the only
# way into a Railway volume: it is mounted there and nowhere else. The tar
# arrives on stdin so nothing is written to the image or to a bucket on the way.
railway ssh --service "$SERVICE_ML" --environment "$ENVIRONMENT" \
  'mkdir -p /data/models && tar -C /data/models -xzf - && ls /data/models' < "$BUNDLE/models.tgz"

echo "== the forecast rows, into Postgres"
# Through `railway run`, which injects the project's own DATABASE_URL: the
# connection string is never printed, never copied into a file, and never
# leaves the shell it was injected into.
gunzip -c "$BUNDLE/forecasts.sql.gz" > "$BUNDLE/.forecasts.sql"
trap 'rm -f "$BUNDLE/.forecasts.sql"' EXIT
# shellcheck disable=SC2016 # DATABASE_URL must expand in the remote shell, not here
railway run --environment "$ENVIRONMENT" -- \
  sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f '"$BUNDLE/.forecasts.sql"

echo "== what is there now"
# shellcheck disable=SC2016 # same: the injected variable belongs to the other shell
railway run --environment "$ENVIRONMENT" -- sh -c 'psql "$DATABASE_URL" -At \
  -c "select '\''forecast days: '\''||count(*)||'\'', '\''||min(target_date)||'\'' to '\''||max(target_date) from curtailment_forecast_day"'
echo "== done. The Time Machine reads these rows; nothing was restarted."

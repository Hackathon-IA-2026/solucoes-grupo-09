#!/usr/bin/env bash
# Runs inside CodeBuild (buildspec-train.yml): restore a database dump into a
# throwaway Postgres, build the ml image from this commit, run TRAIN_COMMAND in
# it, and put the artifacts, the log and the timings in the bucket.
#
#   TRAIN_COMMAND  what to run inside the ml image, e.g.
#                  "python -m wattsteer_ml.retrain --root /data/models ..."
#   RUN_ID         where the results go: s3://$BUCKET/training/$RUN_ID/
#   DB_STATE       the dump to restore (default state/db.sql.gz)
#   MODELS_STATE   the artifacts to start from, so the gate has an incumbent
#                  (default state/models.tgz; "none" to start empty)
#
# Everything is timed separately, because "how much faster is this machine"
# is a question about the training, not about the restore in front of it.
set -euo pipefail

: "${BUCKET:?}" "${TRAIN_COMMAND:?}" "${RUN_ID:?}"
DB_STATE="${DB_STATE:-state/db.sql.gz}"
MODELS_STATE="${MODELS_STATE:-state/models.tgz}"
OUT="s3://$BUCKET/training/$RUN_ID"
WORK=/tmp/wattsteer-train
mkdir -p "$WORK/models"
now() { date +%s; }
declare -A took

echo "== machine: $(nproc) vCPU, $(free -g | awk '/Mem:/{print $2}') GB"

start=$(now)
# A scratch database: durability buys nothing here and costs the restore.
docker run -d --name pg --network host --shm-size=8g -e POSTGRES_USER=wattsteer \
  -e POSTGRES_PASSWORD=wattsteer -e POSTGRES_DB=wattsteer pgvector/pgvector:pg16 \
  -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
  -c shared_buffers=16GB -c work_mem=256MB -c maintenance_work_mem=4GB \
  -c max_connections=300 >/dev/null
until docker exec pg pg_isready -U wattsteer -d wattsteer >/dev/null 2>&1; do sleep 1; done
aws s3 cp --quiet "s3://$BUCKET/$DB_STATE" - | gunzip | sed '/^SET transaction_timeout/d' |
  docker exec -i pg psql -U wattsteer -d wattsteer -q -v ON_ERROR_STOP=1 >/dev/null
took[restore]=$(($(now) - start))
echo "== restored $DB_STATE in ${took[restore]} s"

start=$(now)
docker build -q -t local/wattsteer-ml apps/ml >/dev/null
took[build]=$(($(now) - start))
if [ "$MODELS_STATE" != none ]; then
  aws s3 cp --quiet "s3://$BUCKET/$MODELS_STATE" - | tar -xz -C "$WORK/models"
fi
echo "== ml image in ${took[build]} s; artifacts: $(find "$WORK/models" -name '*.joblib' | wc -l)"

start=$(now)
status=0
docker run --rm --network host --user root \
  -e DATABASE_URL=postgres://wattsteer:wattsteer@127.0.0.1:5432/wattsteer \
  -e WATTSTEER_ML_ARTIFACT_DIR=/data/models \
  -v "$WORK/models:/data/models" --entrypoint sh local/wattsteer-ml -c "$TRAIN_COMMAND" \
  2>&1 | tee "$WORK/train.log" || status=$?
took[train]=$(($(now) - start))
echo "== TRAIN_COMMAND exited $status after ${took[train]} s"

tar -czf "$WORK/models.tgz" -C "$WORK/models" .
aws s3 cp --quiet "$WORK/models.tgz" "$OUT/models.tgz"
aws s3 cp --quiet "$WORK/train.log" "$OUT/train.log"
printf '{"vcpu": %s, "restore_s": %s, "build_s": %s, "train_s": %s, "exit": %s}\n' \
  "$(nproc)" "${took[restore]}" "${took[build]}" "${took[train]}" "$status" |
  tee /dev/stderr | aws s3 cp --quiet - "$OUT/timing.json"
echo "== results in $OUT/"
exit "$status"

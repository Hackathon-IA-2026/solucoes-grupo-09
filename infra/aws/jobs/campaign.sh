#!/bin/sh
# One training campaign, run inside the ml image by train-job.sh:
#
#   infra/aws/train.sh --run-id <id> --timeout <min> -- sh /jobs/campaign.sh
#
# Arms run as separate processes because every booster is single-threaded
# (num_threads = 1 is part of the model configuration): a 72-vCPU machine is
# about as fast as a laptop at one fit and far faster at many, so the
# campaign's arms are what it parallelises. Measured with jobs/fit_speed.py:
# 110 parallel fits a minute on CodeBuild's 2XLARGE against 8.2 on an M3.
#
# Each arm gets its own copy of the seeded artifacts, so each gate compares
# its candidate against the same incumbent. Results land under
# /data/models/arms/<arm>/ (tarred into the run's models.tgz) with the arm's
# JSON report beside it.
#
#   ARMS  which arms to run (default "v2 v3 dessem_ab")
set -u
RUN="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ARMS="${ARMS:-v2 v3 dessem_ab}"
OUT=/data/models/arms
mkdir -p "$OUT"

copy_seed() {
  mkdir -p "$OUT/$1"
  tar -C /data/models --exclude=./arms -cf - . | tar -C "$OUT/$1" -xf -
}

arm() {
  name="$1"
  shift
  copy_seed "$name"
  echo "$(date -u +%H:%M:%S) start $name"
  # The report goes to its file; progress (stderr) goes to both the arm's
  # .err and the build log, prefixed, so a run cut off by its timeout still
  # says how far each arm got.
  { "$@" 2>&1 >"$OUT/$name.json"; echo "exit $?" >"$OUT/$name.status"; } |
    tee "$OUT/$name.err" | sed -u "s/^/[$name] /"
  echo "$(date -u +%H:%M:%S) end $name $(cat "$OUT/$name.status")"
}

for name in $ARMS; do
  case "$name" in
    v2) arm v2 python -m wattsteer_ml.retrain --run-id "$RUN" --root "$OUT/v2" \
          --database-url "$DATABASE_URL" & ;;
    v3) arm v3 env WATTSTEER_MODEL_CONFIG=lgbm_conservative_v3 python -m wattsteer_ml.retrain \
          --run-id "$RUN" --root "$OUT/v3" --database-url "$DATABASE_URL" & ;;
    dessem_ab) arm dessem_ab python -m wattsteer_ml.dessem_ab_run --root "$OUT/dessem_ab" \
          --database-url "$DATABASE_URL" --as-of "$RUN" & ;;
    *) echo "unknown arm $name" ;;
  esac
done
wait
for name in $ARMS; do
  echo "== $name"
  tail -c 3000 "$OUT/$name.json" 2>/dev/null
  tail -5 "$OUT/$name.err" 2>/dev/null
done

#!/bin/sh
set -e

# The volume arrives owned by root, which would make every download fail with a
# permission error long after the image was built. Same lesson as apps/ml.
if [ -n "${WATTSTEER_RAG_STORE_DIR}" ]; then
  mkdir -p "${WATTSTEER_RAG_STORE_DIR}"
  chown -R wattsteer:wattsteer "${WATTSTEER_RAG_STORE_DIR}" || true
fi

if [ "${WATTSTEER_RAG_MIGRATE_ON_BOOT:-1}" = "1" ]; then
  setpriv --reuid=wattsteer --regid=wattsteer --init-groups wattsteer-rag migrate || \
    echo "migration failed; /ready will say why"
fi

exec setpriv --reuid=wattsteer --regid=wattsteer --init-groups "$@"

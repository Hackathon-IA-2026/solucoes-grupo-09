#!/bin/sh
set -e

# `setpriv` changes the uid and nothing else, so HOME stays whatever the image
# had — `/root`. libpq then looks for client certificates under
# `/root/.postgresql/`, which the unprivileged user cannot read, and every
# connection fails with `PermissionError: /root/.postgresql/postgresql.key`
# before it has even reached the server. Same lesson as the volume ownership
# below: dropping privileges means bringing the environment down with them.
export HOME=/home/wattsteer

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

# A container that comes up with an empty corpus is a container nobody can use,
# so it builds one where it runs. Off by default in production, where a job or a
# packed corpus is the better answer; on for a machine that has nothing yet.
if [ "${WATTSTEER_RAG_INDEX_ON_BOOT:-0}" = "1" ]; then
  setpriv --reuid=wattsteer --regid=wattsteer --init-groups sh -c \
    'wattsteer-rag seed load || true; wattsteer-rag crawl instructions; wattsteer-rag crawl procedures; wattsteer-rag ingest --limit 400' || \
    echo "index on boot failed; /internal/rag/status will show what is there"
fi

exec setpriv --reuid=wattsteer --regid=wattsteer --init-groups "$@"

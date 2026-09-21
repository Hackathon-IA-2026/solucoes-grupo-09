#!/usr/bin/env bash
# Put an already-indexed evidence corpus on Railway.
#
#   infra/railway/ship-rag.sh <directory holding rag.sql.gz>
#   infra/railway/ship-rag.sh --from-release state-2026-09-20
#
# The corpus is documents, pages and chunks **with their embeddings**. Nothing
# about it is in an image and no deploy rebuilds it: indexing 293 documents took
# hours of one machine's CPU and a provider quota, so it travels as a dump the
# way the artifacts travel as a tar.
#
# ## Why this is a second script and not a flag on ship-state.sh
#
# Because it is a different decision. `ship-state.sh` replaces three forecast
# tables that only a backfill ever writes; this replaces the whole `rag` schema,
# and a Railway that is already indexing has a corpus of its own that may be
# newer. Run this only when the target's corpus is empty or behind — the last
# line prints the count so the next person can tell.
#
# ## Where the dump comes from
#
# Whichever Postgres the corpus was built against. The 2026-09-20 asset was
# taken off the event instance, which had indexed further than the laptop
# (18,063 chunks against 3,160), with past answers left out:
#
#   { pg_dump -Fp --no-owner -n rag \
#       --exclude-table-data=rag.evidence --exclude-table-data=rag.llm_call \
#       --exclude-table-data=rag.retrieval_log --exclude-table-data=rag.job
#     pg_dump -Fp --no-owner -t public.rag_migration; } | gzip -1 > rag.sql.gz
#
# Two invocations rather than one, because `-t` makes pg_dump ignore `-n`: a
# single call naming both would have dumped the schema without the ledger the
# service reads at boot to decide whether to migrate.
set -euo pipefail

if [ "${1:-}" = "--from-release" ]; then
  TAG="${2:?usage: ship-rag.sh --from-release <tag> [directory]}"
  BUNDLE="${3:-$(mktemp -d)}"
  mkdir -p "$BUNDLE"
  echo "== fetching $TAG into $BUNDLE"
  gh release download "$TAG" --repo vtorres/WattSteer --clobber \
    --pattern 'rag.sql.gz' --dir "$BUNDLE"
fi

BUNDLE="${BUNDLE:-${1:?usage: ship-rag.sh <directory> | --from-release <tag>}}"
SERVICE_RAG="${RAILWAY_RAG_SERVICE:-rag}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"

[ -s "$BUNDLE/rag.sql.gz" ] || { echo "missing $BUNDLE/rag.sql.gz" >&2; exit 1; }

echo "== who am I to Railway"
railway whoami

# Through the `rag` service, so the connection string is the one that service
# reads — `WATTSTEER_RAG_DATABASE_URL`. It is its own database in the local
# stack and a schema beside the product tables on the event instance, and this
# script does not need to know which: it asks the service that owns it.
gunzip -c "$BUNDLE/rag.sql.gz" > "$BUNDLE/.rag.sql"
trap 'rm -f "$BUNDLE/.rag.sql"' EXIT

echo "== replacing the rag schema"
# `DROP SCHEMA ... CASCADE` before the restore, in the same psql invocation, so
# a corpus that half-loaded leaves nothing readable rather than a mixture of two
# indexings. `vector` is created first because the dump's columns are typed
# against it and the extension lives in `public`, which is not dropped.
# shellcheck disable=SC2016 # the variable must expand in Railway's shell, not here
railway run --service "$SERVICE_RAG" --environment "$ENVIRONMENT" -- \
  sh -c 'psql "$WATTSTEER_RAG_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
    -c "CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS rag CASCADE; DROP TABLE IF EXISTS public.rag_migration;" \
    -f '"$BUNDLE/.rag.sql"

echo "== what is there now"
# shellcheck disable=SC2016 # same: the injected variable belongs to the other shell
railway run --service "$SERVICE_RAG" --environment "$ENVIRONMENT" -- sh -c 'psql "$WATTSTEER_RAG_DATABASE_URL" -At \
  -c "select '\''chunks: '\''||count(*) from rag.chunk"'
echo "== done. A count of zero means the restore did not land; anything else is the corpus."

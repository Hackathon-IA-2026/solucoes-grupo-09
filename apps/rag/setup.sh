#!/usr/bin/env bash
# From a fresh checkout to a working evidence service, in one command.
#
#   ./setup.sh            install, database, schema, and the normative corpus
#   ./setup.sh --full     the above plus ten days of daily bulletins, the
#                         archived preliminary reports and a disturbance report
#   ./setup.sh --no-index install and database only, index later
#
# The corpus is built where it is installed: on a laptop it fills that laptop's
# database, on a server it fills the server's. Nothing large is carried in the
# repository, and the whole thing is resumable, so running it twice is safe and
# the second run only does what the first one did not finish.
#
# Cost of a full build, measured on 15/09/2026: 281 documents, 816 pages and
# 2786 chunks. Only 28 of those pages needed the vision model, because the rest
# carry a text layer; the rest of the time is embedding, about five minutes
# inside the free tier.
set -euo pipefail

cd "$(dirname "$0")"
MODE="normative"
for arg in "$@"; do
  case "$arg" in
    --full) MODE="full" ;;
    --no-index) MODE="none" ;;
    --help|-h) sed -n '2,14p' "$0"; exit 0 ;;
  esac
done

PG_CONTAINER="${PG_CONTAINER:-wattsteer-rag-pg}"
PG_PORT="${PG_PORT:-5439}"
export WATTSTEER_RAG_DATABASE_URL="${WATTSTEER_RAG_DATABASE_URL:-postgres://wattsteer:wattsteer@localhost:${PG_PORT}/wattsteer_rag}"
RAG=./.venv/bin/wattsteer-rag

say() { printf '\n== %s\n' "$1"; }

# The key is the one thing nobody can do for the person running this, so it is
# checked before anything else and said plainly.
if [ -f ../../.env ]; then set -a; . ../../.env; set +a; fi
if [ -z "${NVIDIA_API_KEYS:-}${NVIDIA_API_KEY:-}${GROQ_API_KEYS:-}${GROQ_API_KEY:-}" ]; then
  cat <<'MSG'

  MISSING: an API key. Without one the index cannot be built.

  Get a free one, it takes two minutes and asks for no card:
    NVIDIA   https://build.nvidia.com     sign in, "Get API Key", starts with nvapi-
    Groq     https://console.groq.com     "API Keys", starts with gsk_

  Write it in WattSteer/.env (git already ignores that file):
    NVIDIA_API_KEYS=nvapi-...
    GROQ_API_KEYS=gsk_...

  Several keys separated by commas add their quotas up. One alone works the
  same. Then run ./setup.sh again: it continues where it stopped.

MSG
  if [ "${MODE}" != "none" ]; then
    printf 'Continue anyway, installing and creating the database without indexing? [y/N] '
    read -r answer </dev/tty 2>/dev/null || answer="y"
    case "$answer" in [yY]*) MODE="none" ;; *) exit 1 ;; esac
  fi
fi

say "Python"
python3 -m venv .venv 2>/dev/null || true
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -e ".[dev]"

say "Postgres with pgvector on port ${PG_PORT}"
if command -v docker >/dev/null 2>&1; then
  if ! docker ps --format '{{.Names}}' | grep -qx "${PG_CONTAINER}"; then
    docker start "${PG_CONTAINER}" >/dev/null 2>&1 || docker run -d \
      --name "${PG_CONTAINER}" \
      -e POSTGRES_USER=wattsteer -e POSTGRES_PASSWORD=wattsteer -e POSTGRES_DB=wattsteer_rag \
      -p "${PG_PORT}:5432" pgvector/pgvector:pg17 >/dev/null
  fi
  until docker exec "${PG_CONTAINER}" pg_isready -U wattsteer -d wattsteer_rag >/dev/null 2>&1; do sleep 1; done
else
  echo "docker not found; using WATTSTEER_RAG_DATABASE_URL as it is"
fi

say "Schema"
$RAG migrate | tail -n 8

# Keys are read from the repository's .env, which git ignores.
if [ "$MODE" = "none" ]; then
  say "Index skipped: run ./setup.sh again with a key in WattSteer/.env"
else
  say "Corpus: fetching the documents the curtailment records cite"
  $RAG crawl instructions | tail -n 3
  $RAG crawl procedures | tail -n 3
  if [ "$MODE" = "full" ]; then
    $RAG crawl bdo --days 10 | tail -n 3
    $RAG crawl ipdo --days 2 | tail -n 3
    $RAG crawl ipdo-archive --limit 20 | tail -n 3
    $RAG crawl rap | tail -n 3
  fi

  say "Reading and indexing (resumable: interrupt it and run again)"
  $RAG ingest --limit 400 --max-pages 60
  # Embedding is rate limited, not slow: keep asking until nothing is pending.
  for _ in $(seq 1 20); do
    out=$($RAG embed | tr -d '\n ')
    echo "$out"
    case "$out" in *'"waiting_quota_until":null'*) break;; esac
    sleep 30
  done
fi

say "State"
$RAG doctor | tail -n 8

cat <<'MSG'

Ready. Try:

  ./.venv/bin/wattsteer-rag search "limitação do fluxo Senhor do Bonfim"
  ./.venv/bin/wattsteer-rag evidence NE 2026-09-14 --gate-at 2026-09-13T22:00:00Z \
    --reason CNF --description "Controle de inequação: LIMITAÇÃO DO FLUXO SENHOR DO BONFIM II - IO-ON.NE.2SO"

Moving a built corpus to another machine, instead of building it again:

  ./.venv/bin/wattsteer-rag seed dump     # writes seed/corpus.jsonl.gz
  ./.venv/bin/wattsteer-rag seed load     # on the other machine
MSG

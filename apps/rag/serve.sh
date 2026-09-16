#!/usr/bin/env bash
# The service, with the page for trying it by hand, on this machine only.
#
#   cd apps/rag && ./serve.sh        -> http://127.0.0.1:8082
#
# Binds to the loopback address on purpose: the routes are internal and carry no
# authentication, so nothing here should be reachable from the network.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8082}"

if [ ! -x .venv/bin/python ]; then
  echo "The service is not installed yet. Run ./setup.sh first." >&2
  exit 1
fi

# The keys live in the repository's .env, which git ignores.
if [ -f ../../.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ../../.env
  set +a
fi

if [ -z "${NVIDIA_API_KEYS:-}" ] && [ -z "${GROQ_API_KEYS:-}" ]; then
  echo "No API key found in WattSteer/.env. Searching still works; building evidence needs one." >&2
fi

export WATTSTEER_RAG_HOST=127.0.0.1
export WATTSTEER_RAG_PORT="$PORT"

echo
echo "  WattSteer evidence  ->  http://127.0.0.1:${PORT}"
echo "  Ctrl+C to stop."
echo
exec ./.venv/bin/python -m wattsteer_rag.app

#!/usr/bin/env bash
# The service, with the page for trying it by hand.
#
#   ./serve.sh          this machine only, http://127.0.0.1:8082
#   ./serve.sh --lan    the local network, with an access token in the URL
#
# The routes run models and read the corpus and none of them asks who is
# calling, so the default is the loopback address. --lan is for handing the page
# to someone on the same Wi-Fi: it binds to every interface and requires a
# shared token, printed once as part of the address.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8082}"
LAN=0
[ "${1:-}" = "--lan" ] && LAN=1

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

export WATTSTEER_RAG_PORT="$PORT"

if [ "$LAN" = "1" ]; then
  export WATTSTEER_RAG_HOST=0.0.0.0
  # A token per run: it lives as long as the process and is never written down.
  export WATTSTEER_RAG_ACCESS_TOKEN="${WATTSTEER_RAG_ACCESS_TOKEN:-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 18)}"
  ADDRESS="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname)"
  echo
  echo "  WattSteer evidence, for this network only. Send this whole line:"
  echo
  echo "    http://${ADDRESS}:${PORT}/?k=${WATTSTEER_RAG_ACCESS_TOKEN}"
  echo
  echo "  Without the token nothing but /health answers. Ctrl+C to stop, and the"
  echo "  address stops working."
else
  export WATTSTEER_RAG_HOST=127.0.0.1
  echo
  echo "  WattSteer evidence  ->  http://127.0.0.1:${PORT}"
  echo "  This machine only. ./serve.sh --lan opens it to the local network."
fi
echo

exec ./.venv/bin/python -m wattsteer_rag.app

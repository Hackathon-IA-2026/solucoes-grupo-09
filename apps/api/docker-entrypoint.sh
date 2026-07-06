#!/bin/sh
set -e

# Reuse the patched Chromium baked into the cloakbrowser base image instead of
# downloading a second copy. Resolve the path at runtime so a base-image
# Chromium version bump doesn't break us. Setting CLOAKBROWSER_BINARY_PATH makes
# cloakbrowser skip its own download and disables background auto-updates.
if [ -z "${CLOAKBROWSER_BINARY_PATH:-}" ]; then
  bin="$(ls -d /root/.cloakbrowser/chromium-*/chrome 2>/dev/null | head -n1 || true)"
  if [ -n "$bin" ]; then
    export CLOAKBROWSER_BINARY_PATH="$bin"
  fi
fi

exec "$@"

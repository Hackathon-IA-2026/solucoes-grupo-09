#!/bin/sh
# Take ownership of the artifact volume, then drop to the service account.
#
# Railway mounts volumes owned by root:root, and it mounts them *over* whatever
# the image put at that path — so the Dockerfile's build-time
# `chown wattsteer:wattsteer /data/models` is masked the moment a volume is
# attached, and `/v1/meta` correctly reported `writable: false`.
#
# Railway's documented answer is `RAILWAY_RUN_UID=0`: run the whole service as
# root. That would work and it is one variable, but it silently reverses the
# reason this image has a service account at all, which the Dockerfile states —
# an artifact written by root is an artifact a non-root process cannot later
# rotate. So the container starts as root, fixes exactly the one thing only root
# can fix, and hands off. The Python process is never root.
#
# `setpriv` rather than `su` or `gosu`: it is in util-linux, which is Essential
# in Debian, so this needs no extra package in a slim image — and it `exec`s,
# so PID 1 stays the service and signals still reach it.
set -eu

if [ "$(id -u)" = "0" ]; then
    chown -R wattsteer:wattsteer "${WATTSTEER_ML_ARTIFACT_DIR:-/data/models}"
    # `setpriv` changes the uid and nothing else, so HOME would stay /root.
    # asyncpg looks for a client key under $HOME/.postgresql and raises
    # PermissionError on /root instead of going on without one: on the EC2
    # compose stack (18/09/2026) every POST /v1/optimize failed with it.
    # apps/rag/docker-entrypoint.sh met the same thing first.
    export HOME=/home/wattsteer
    exec setpriv --reuid=wattsteer --regid=wattsteer --init-groups --inh-caps=-all -- "$@"
fi

# Already unprivileged — a local `docker run --user`, or a platform that starts
# the container as the image's user. Nothing to hand off.
exec "$@"

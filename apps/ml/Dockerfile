# WattSteer ML — FastAPI on uv.
#
# Unlike apps/api/Dockerfile, the build context is `apps/ml`, not the repo root:
# this service shares no lockfile with the Bun workspace, so giving it the whole
# monorepo would only slow the build and invalidate its cache on every web-app
# commit. See docker-compose.yml.
#
# Two stages so the runtime image carries no uv, no compilers and no dev group.
FROM ghcr.io/astral-sh/uv:0.9.30-python3.12-bookworm-slim AS build

LABEL org.opencontainers.image.title="wattsteer-ml" \
      org.opencontainers.image.description="The forecaster: fits, gates and serves the hurdle mixture." \
      org.opencontainers.image.source="https://github.com/vtorres/WattSteer" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Dependencies first, from the lockfile alone: this layer is cached until
# pyproject.toml or uv.lock changes, so editing service code does not re-resolve
# the world. `--frozen` fails loudly if uv.lock is stale rather than quietly
# resolving something the lockfile never recorded.
#
# The cache mount's `id=` is Railway's required shape, not a name we chose:
# its builder rejects an anonymous mount (`missing an id argument`) and then
# rejects a plain name too (`missing the cacheKey prefix from its id`). The
# documented form is `s/<service id>-<target path>`, and the service id must be
# a literal — Railway states outright that environment variables are invalid
# syntax inside a cache-mount id, so there is no way to derive it. If the `ml`
# service is ever recreated, this id goes stale and the only consequence is a
# cold cache on the next dependency change. Locally the id is arbitrary, so the
# same line builds under plain BuildKit and docker-compose.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,id=wattsteer-ml-uv,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

COPY src ./src
COPY README.md ./
RUN --mount=type=cache,id=wattsteer-ml-uv,target=/root/.cache/uv \
    uv sync --frozen --no-dev


FROM python:3.12-slim-bookworm AS runtime

ARG PORT=8000

# Not root: this service mounts a persistent volume, and an artifact written by
# root is an artifact a non-root process cannot later rotate.
RUN useradd --create-home --uid 10001 wattsteer

# LightGBM's manylinux wheel links against libgomp at load time and the slim
# image does not carry it. Without this the service imports fine and *training*
# dies on the first `import lightgbm`, which is a runtime failure a build cannot
# see. One package, no recommends, apt lists removed in the same layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build --chown=wattsteer:wattsteer /app/.venv /app/.venv
COPY --from=build --chown=wattsteer:wattsteer /app/src /app/src

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WATTSTEER_ML_ENV=production \
    WATTSTEER_ML_ARTIFACT_DIR=/data/models \
    PORT=$PORT

# The mount point for the model-artifact volume — a Railway volume in
# production, a named docker volume locally. Created and owned here so the
# container still starts (with an empty store) when nothing is mounted. When one
# *is* mounted it arrives root-owned and masks this, which is what the
# entrypoint exists to repair.
RUN mkdir -p /data/models && chown -R wattsteer:wattsteer /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# No `USER wattsteer`: the entrypoint starts as root, chowns the mounted volume
# — the one thing only root can do — and then `exec`s the service through
# `setpriv` as `wattsteer`. The Python process is unprivileged either way; what
# changes is that it can now write to its own artifact store.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE $PORT

# Liveness only, matching apps/api: the probe must not depend on Postgres, or a
# database blip restarts a service that was working. Readiness is /ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/health').read()"]

CMD ["wattsteer-ml"]

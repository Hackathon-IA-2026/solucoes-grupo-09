# WattSteer ML — FastAPI on uv.
#
# Unlike apps/api/Dockerfile, the build context is `apps/ml`, not the repo root:
# this service shares no lockfile with the Bun workspace, so giving it the whole
# monorepo would only slow the build and invalidate its cache on every web-app
# commit. See docker-compose.yml.
#
# Two stages so the runtime image carries no uv, no compilers and no dev group.
FROM ghcr.io/astral-sh/uv:0.9.30-python3.12-bookworm-slim AS build

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Dependencies first, from the lockfile alone: this layer is cached until
# pyproject.toml or uv.lock changes, so editing service code does not re-resolve
# the world. `--frozen` fails loudly if uv.lock is stale rather than quietly
# resolving something the lockfile never recorded.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

COPY src ./src
COPY README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
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
# container still starts (with an empty store) when nothing is mounted.
RUN mkdir -p /data/models && chown -R wattsteer:wattsteer /data

USER wattsteer

EXPOSE $PORT

# Liveness only, matching apps/api: the probe must not depend on Postgres, or a
# database blip restarts a service that was working. Readiness is /ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/health').read()"]

CMD ["wattsteer-ml"]

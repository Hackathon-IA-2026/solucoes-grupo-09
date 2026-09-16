# WattSteer API — Bun-native. Nothing here launches a browser, so this is a
# plain Bun base image rather than the browser image the template used.
FROM oven/bun:1.3 AS base

# Who built this, from what, and under which licence — read by registries, by
# `docker scout`, and by ECR's image scanning. An image with no provenance is one
# nobody can trace back to a commit when it misbehaves at 3am.
LABEL org.opencontainers.image.title="wattsteer-api" \
      org.opencontainers.image.description="The gateway: every published figure passes through it." \
      org.opencontainers.image.source="https://github.com/vtorres/WattSteer" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ARG PORT=3000

WORKDIR /app

# Monorepo-aware install: the build context is the repo root (see
# docker-compose.yml), where the lockfile lives. Bun needs every workspace
# manifest present to validate a frozen lockfile; filtering to the API keeps the
# web app's Expo tree out of the image. If this fails with "lockfile had
# changes, but lockfile is frozen", run `bun install` at the repo root and
# commit bun.lock.
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/ui/package.json ./packages/ui/
RUN bun install --frozen-lockfile --production --filter=wattsteer-api

# The shared package's source, not just its manifest. `@wattsteer/core` resolves
# to `packages/core/src`, so copying only the package.json installs a workspace
# link pointing at nothing and the container dies on first import.
COPY packages/core/src ./packages/core/src

WORKDIR /app/apps/api

# Application source.
COPY apps/api/tsconfig.json ./
COPY apps/api/src ./src

ENV NODE_ENV=production \
    PORT=$PORT

# **Not root.** `oven/bun` runs as root by default, and this service reaches a
# database and an object store with credentials from the environment: a process
# that does not need to write to the image should not be able to. `apps/ml` and
# `apps/rag` drop to the same uid from their entrypoints; these two had no
# equivalent, so they ran as root everywhere they were deployed.
#
# 10001 rather than a name, and the same number in all four images: AWS ECS task
# definitions and Kubernetes `runAsUser` name a uid, not a user, and a
# `runAsNonRoot` policy can only check the number.
RUN groupadd --gid 10001 wattsteer \
 && useradd --uid 10001 --gid 10001 --create-home wattsteer \
 && chown -R wattsteer:wattsteer /app
USER 10001:10001

EXPOSE $PORT

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'await fetch("http://localhost:"+(process.env.PORT??3000)+"/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'

CMD ["bun", "run", "src/api/index.ts"]

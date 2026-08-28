# WattSteer API — Bun-native. Nothing here launches a browser, so this is a
# plain Bun base image rather than the browser image the template used.
FROM oven/bun:1.3 AS base

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

WORKDIR /app/apps/api

# Application source.
COPY apps/api/tsconfig.json ./
COPY apps/api/src ./src

ENV NODE_ENV=production \
    PORT=$PORT

EXPOSE $PORT

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'await fetch("http://localhost:"+(process.env.PORT??3000)+"/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'

CMD ["bun", "run", "src/api/index.ts"]

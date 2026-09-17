# Static web deploy: export the expo-router web bundle, then serve dist/ with
# a tiny Bun static server. Two stages so the runtime image carries only the
# built assets + server, not the Expo/Metro toolchain.
#
# Build context is the repo root (see the web service's railway.json), where
# the lockfile and every workspace manifest live.

# --- build stage: produce dist/ ---
FROM oven/bun:1.3 AS build
WORKDIR /app

# Monorepo-aware install: Bun needs every workspace manifest present to
# validate the frozen lockfile. Full install (not --production): the Expo/Metro
# export toolchain lives in regular deps and its transitive dev tooling.
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY packages/core/package.json ./packages/core/
COPY packages/ui/package.json ./packages/ui/
RUN bun install --frozen-lockfile

# Source. @wattsteer/core and @wattsteer/ui are consumed as TS source (their package
# "main" is ./src/index.ts), so their src must be present for the bundler.
# Explicit copies (not the whole apps/web) keep the local node_modules/dist out.
COPY packages/core/src ./packages/core/src
COPY packages/ui/src ./packages/ui/src
# expo-env.d.ts is git-ignored (auto-generated types) and not needed for the
# Metro/babel export, so it's intentionally not copied.
# `metro.config.js` is load-bearing, not optional tooling: it restores the
# TypeScript rule that `./thing.js` inside `packages/core` means `./thing.ts`,
# which Metro does not do natively, and it declares `watchFolders` so the
# symlinked workspace package resolves at all. Without it the export dies on
# `Unable to resolve module ./causality.js` — which is exactly how this image
# failed before the file was copied. `test/metro-resolves-core.test.ts` guards
# the config's *contents*; it did not guard that the image receives it.
COPY apps/web/metro.config.js apps/web/app.json apps/web/tsconfig.json ./apps/web/
COPY apps/web/src ./apps/web/src
COPY apps/web/assets ./apps/web/assets
COPY apps/web/public ./apps/web/public
# The post-export pass that gives each locale tree its own <html lang> and PWA
# manifest — see apps/web/scripts/localize-export.ts. The build fails without
# it rather than shipping a Portuguese `lang` on the English pages.
COPY apps/web/scripts/localize-export.ts ./apps/web/scripts/
COPY apps/web/server.ts ./apps/web/
# `server.ts` imports `scripts/static-routing.ts`; without it the container
# starts and dies on "Cannot find module". `e2e/serve-dist.ts` reads the same
# module, which is the point of it — one rule, two servers.
COPY apps/web/scripts ./apps/web/scripts

# EXPO_PUBLIC_* values are inlined at build time (static export), so the API
# origin and canonical site URL must be set here. Override via Railway build
# args / service variables if the API moves.
ARG EXPO_PUBLIC_API_URL=https://api.wattsteer.com
ARG EXPO_PUBLIC_SITE_URL=https://wattsteer.com
# The CesiumJS ion key, for the console map's 3D layer. Empty by default and
# that is a supported state, not a broken one: `cesiumAvailable()` is false
# without it and the 3D control ships disabled with its reason, which is the
# right thing for a fork or a preview build that has no ion account.
ARG EXPO_PUBLIC_CESIUM_ION_TOKEN=""
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL \
    EXPO_PUBLIC_SITE_URL=$EXPO_PUBLIC_SITE_URL \
    EXPO_PUBLIC_CESIUM_ION_TOKEN=$EXPO_PUBLIC_CESIUM_ION_TOKEN

WORKDIR /app/apps/web
# `vendor-cesium.ts` first, and it is not optional tooling: CesiumJS resolves
# its Web Workers and `Assets/` by URL at runtime, so it is served as static
# files rather than bundled, and the export only picks them up if they are in
# `public/` when it runs. This image called `bunx expo export` directly, which
# is exactly how a step that lives in the package script gets skipped — the
# page would build, ship, and 404 on `Cesium.js` in production only.
RUN bun scripts/vendor-cesium.ts \
 && bunx expo export --platform web \
 && bun scripts/localize-export.ts

# --- runtime stage: serve dist/ ---
FROM oven/bun:1.3-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=build --chown=10001:10001 /app/apps/web/dist ./dist
COPY --from=build --chown=10001:10001 /app/apps/web/server.ts ./server.ts
COPY --from=build --chown=10001:10001 /app/apps/web/scripts ./scripts

# **Not root.** This server reads a directory and writes nothing, which is the
# easiest possible case for dropping privileges and therefore the least
# defensible one to skip. Same uid as the other three images so one ECS or
# Kubernetes policy covers all of them — `runAsNonRoot` checks a number.
RUN groupadd --gid 10001 wattsteer \
 && useradd --uid 10001 --gid 10001 --create-home wattsteer
USER 10001:10001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e 'await fetch("http://localhost:"+(process.env.PORT??8080)+"/healthz").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'

CMD ["bun", "run", "server.ts"]

# Who built this, from what, and under which licence — read by registries, by
# `docker scout`, and by ECR's image scanning. An image with no provenance is one
# nobody can trace back to a commit when it misbehaves at 3am.
#
# Last in the file on purpose: these args change every commit, and a LABEL high
# up would invalidate every layer beneath it — a full dependency install to write
# eight strings. Every field naming a project is set rather than inherited, or
# the base image's `revision` sends that 3am search to oven-sh/bun's history.
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="wattsteer-web" \
      org.opencontainers.image.description="The static export and the server that routes it." \
      org.opencontainers.image.source="https://github.com/vtorres/WattSteer" \
      org.opencontainers.image.url="https://github.com/vtorres/WattSteer" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${GIT_SHA}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"

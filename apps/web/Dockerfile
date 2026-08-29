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
COPY apps/web/app.json apps/web/tsconfig.json ./apps/web/
COPY apps/web/src ./apps/web/src
COPY apps/web/assets ./apps/web/assets
COPY apps/web/public ./apps/web/public
# The post-export pass that gives each locale tree its own <html lang> and PWA
# manifest — see apps/web/scripts/localize-export.ts. The build fails without
# it rather than shipping a Portuguese `lang` on the English pages.
COPY apps/web/scripts/localize-export.ts ./apps/web/scripts/
COPY apps/web/server.ts ./apps/web/

# EXPO_PUBLIC_* values are inlined at build time (static export), so the API
# origin and canonical site URL must be set here. Override via Railway build
# args / service variables if the API moves.
ARG EXPO_PUBLIC_API_URL=https://api.wattsteer.com
ARG EXPO_PUBLIC_SITE_URL=https://wattsteer.com
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL \
    EXPO_PUBLIC_SITE_URL=$EXPO_PUBLIC_SITE_URL

WORKDIR /app/apps/web
RUN bunx expo export --platform web && bun scripts/localize-export.ts

# --- runtime stage: serve dist/ ---
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/apps/web/server.ts ./server.ts
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e 'await fetch("http://localhost:"+(process.env.PORT??8080)+"/healthz").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'

CMD ["bun", "run", "server.ts"]

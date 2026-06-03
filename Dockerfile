# Base on the official cloakbrowser image: Debian 13 with the patched stealth
# Chromium, all OS libraries, fonts and Python already installed and verified by
# CloakHQ. This guarantees the browser actually runs in the container.
FROM cloakhq/cloakbrowser:latest

ARG PORT=3000

# The image ships Node, not Bun — our app is Bun-native (TS execution, bun:test,
# import.meta.main, .env autoload), so install Bun.
RUN npm install -g bun

WORKDIR /app

# Install production dependencies only (skips biome, tsx, eden, type packages)
# with a frozen lockfile for reproducible builds. If this fails with "lockfile
# had changes, but lockfile is frozen", run `bun install` and commit bun.lock.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# No Chromium download: we reuse the patched Chromium already in the base image
# (see docker-entrypoint.sh, which points CLOAKBROWSER_BINARY_PATH at it). This
# avoids baking a second ~400 MB copy into the image.

# Application source + entrypoint.
COPY tsconfig.json ./
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Production env. NOVIQ_NO_SANDBOX is required because Chromium runs as root
# here; override the rest via --env-file / compose.
ENV NODE_ENV=production \
    PORT=$PORT \
    NOVIQ_NO_SANDBOX=1 \
    CLOAKBROWSER_AUTO_UPDATE=false

EXPOSE $PORT

# Lightweight healthcheck against the API (runs directly, not via entrypoint).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'await fetch("http://localhost:"+(process.env.PORT??3000)+"/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "src/api/index.ts"]

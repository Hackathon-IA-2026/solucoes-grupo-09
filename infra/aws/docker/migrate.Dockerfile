# The migration, as an image: the repo's own `bun run db:migrate`
# (drizzle-kit) with apps/api's migration files.
#
# Its own image because the API image deliberately carries neither drizzle-kit
# (a dev dependency) nor the migration files — Railway applies migrations out
# of band, and so does this deploy: once per release, before the services move.
#
# Build from the repository root:
#   docker build -f infra/aws/docker/migrate.Dockerfile .
FROM oven/bun:1.3

WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/ui/package.json ./packages/ui/
# The postinstall hook installs git hooks and needs the scripts directory.
RUN bun install --frozen-lockfile --filter=wattsteer-api --ignore-scripts

COPY packages/core/src ./packages/core/src
WORKDIR /app/apps/api
COPY apps/api/tsconfig.json apps/api/drizzle.config.ts ./
COPY apps/api/drizzle ./drizzle
COPY apps/api/src/database ./src/database

USER 10001:10001
CMD ["bun", "run", "db:migrate"]

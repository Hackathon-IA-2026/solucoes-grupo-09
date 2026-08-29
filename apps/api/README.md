# wattsteer-api

The WattSteer gateway and ingestion service: the public HTTP API, and the
scheduled jobs that pull ONS, ANEEL and weather data into Postgres.

Runs on [Bun](https://bun.sh) — scripts and tests all use it.

## What it does

**Ingestion.** Adapters turn each upstream source's bytes into WattSteer's
canonical form — UTC instants, start-of-interval labelling, canonicalised
subsystem codes, energy in MWh — and write them append-only with both time
axes, so a revision is a new row rather than an overwrite. Nothing downstream
ever sees an upstream convention. See `docs/specs/data-platform.md` for the
contract and `docs/research/` for the evidence behind every normalisation rule.

**Gateway.** The public API. Model inference and the flexibility optimizer live
in a separate Python service that reads the same Postgres; this service proxies
to it. That service does not exist yet.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /` | Service name and docs link |
| `GET /health` | Liveness |
| `GET /ready` | Readiness — database reachable when configured |
| `GET /docs` | Swagger UI |
| `GET /ingest/health` | Ingestion freshness, runs, custody and join match rates (503 when any source is stale) |

The domain read routes arrive with the API-surface work.

## Running

```bash
bun install
bun run api          # http://localhost:3000
bun run api:dev      # watch mode
bun run worker       # BullMQ worker (requires REDIS_URL)
```

The worker owns ingestion: one handler dispatches every source, and three
repeatable jobs sweep the refresh tiers — `live` hourly, `recent` weekly,
`history` monthly (`WATTSTEER_REFRESH=off` disables them). The `history` sweep
is the one that catches ONS re-publishing a closed month years later, which it
does. Raw payloads are retained in the archive named by `WATTSTEER_ARCHIVE_*`
(an S3-compatible bucket) or `WATTSTEER_ARCHIVE_DIR` (a directory); with
neither, the worker warns loudly at boot, because a deployment that ran without
custody cannot be repaired afterwards — the vintages it did not keep are gone
from ONS too.

Configuration is read in exactly one place, `src/config.ts`. Copy
`.env.example` to `.env` and adjust. Postgres and Redis are both optional in
development: with no `DATABASE_URL` persistence is disabled and `/ready`
reports ready; with no `REDIS_URL` jobs run on the in-process runner instead of
BullMQ.

## Testing

```bash
bun run test         # default: no network, no database
bun run test:db      # as-of reads against a real Postgres
bun run test:redis   # BullMQ against a real Redis
bun run test:live    # live conformance: the real ONS, ANEEL and Open-Meteo
```

The default suite runs entirely offline against captured upstream payloads in
`test/fixtures/` — each one records where it came from and when, in
`test/fixtures/ons/FIXTURES.md`. Those fixtures are the point: they pin the
upstream traps that are invisible in the code, and expensive to rediscover.

The database and Redis suites are gated behind their own environment variables
so the default path never needs either. Both truncate the tables they use, so
point them at a throwaway instance — `docker compose up postgres redis` gives
you one.

`test/live-conformance.test.ts` is gated the same way, on
`WATTSTEER_LIVE_CONFORMANCE`, and is the one suite that is *expected to fail
eventually*: it asks the live sources whether the claims in `docs/research/`
are still true. It runs on a schedule
(`.github/workflows/live-conformance.yml`), never on a commit, and every
failure names the research note and claim that expired in prose rather than
reporting a diff.

## Layout

```
src/
  api/        Elysia app: routes plus the cross-cutting plugin stack
              (security headers, body limit, rate limit, request context,
              error mapping).
  ingest/     Source adapters, normalisation, and the bitemporal repository.
  jobs/       Job runners — in-process by default, BullMQ when Redis is set.
              Generic over payload and result.
  database/   Drizzle schema, connection and Elysia plugin.
```

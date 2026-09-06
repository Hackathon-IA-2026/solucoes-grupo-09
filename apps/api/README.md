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

## Schema and migrations

The schema lives in `src/database/schema.ts` and `src/database/canonical-views.ts`.
Everything under `drizzle/` is **applied history**: once a migration has landed on
`main` its SQL is never edited — not to fix it, not to reformat it, not to correct
a comment — because `drizzle-kit migrate` records a hash of each file and an edit
makes an already-migrated database unmigratable. A mistake in a landed migration
is corrected by a new migration. `db:push` is never used against anything that
matters; the `db:*` scripts that count are `db:generate` and `db:migrate`.

`drizzle/meta/` is different. It is **generated metadata**, not history: it is
drizzle-kit's model of what the schema looks like after each migration, and it is
the only thing `db:generate` diffs against. It must therefore be regenerated,
never hand-copied.

That distinction is the one this repo got wrong once. Because most migrations
here are hand-written — drizzle-kit emits tables and views, not the function and
composite-type DDL the feature and canonical layers need — the habit grew of
writing the SQL by hand and copying the previous snapshot forward with a fresh
`id`/`prevId`. Six migrations later the snapshots still described the schema as
it stood at `0033`, and a plain `db:generate` offered to re-create five tables
that already existed. Nothing failed, because nothing had asked. The snapshots
were correct about every column on every table that existed at `0033`, so a spot
check for a recent column said they were fine.

### Adding a migration

1. Change the schema files.
2. Run `bun run db:generate` — **plain, not `--custom`**. Drizzle writes the SQL
   it can express and, more importantly, a *correct* `meta/NNNN_snapshot.json`.
3. Hand-edit the emitted `.sql` to add what drizzle-kit cannot emit: `CREATE
   FUNCTION`, composite types, `CREATE OR REPLACE VIEW`, data backfills. Edit the
   SQL freely — it has not landed yet. **Never edit the snapshot.**
4. If the change is *only* DDL drizzle-kit cannot see, step 2 emits nothing. Use
   `bunx drizzle-kit generate --custom --name <name>` for an empty stub; the
   snapshot it copies forward is correct exactly because nothing drizzle-visible
   changed.
5. `bun run test` — `test/drizzle-snapshot.test.ts` regenerates against a
   throwaway copy of `drizzle/` and fails if the head snapshot has drifted. That
   test is the guard; do not silence it by editing a snapshot.

### Formatting

`drizzle/meta/` is excluded from Biome in `biome.json`. Commit exactly the bytes
drizzle-kit writes — two-space JSON, and no trailing newline on `_journal.json`
or on the snapshots. Reformatting them is harmless to Postgres but it means the
committed metadata is no longer byte-identical to generated metadata, which is
how a real drift hides inside formatting churn. The rule is mechanical: after
`db:generate`, `git diff` shows the schema change and nothing else.

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

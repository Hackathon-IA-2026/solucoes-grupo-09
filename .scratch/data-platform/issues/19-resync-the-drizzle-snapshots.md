# 19 — A plain `drizzle-kit generate` emits a migration that re-creates four tables

**What to build:** a generator that emits nothing when the schema has not changed.

`apps/api/drizzle/meta/` has been frozen at **33 tables since `0033`**. Verified:
`0037_snapshot.json` holds 33 tables and is missing `curtailment_forecast_day`,
`curtailment_forecast_national_day`, `replay_result` and
`forecast_attribution_day_ahead` — every table added since.

So anyone running `drizzle-kit generate` **without** `--custom` silently produces
a migration re-creating those four. Nothing has broken yet only because every
hand-written migration since `0033` has copied the snapshot forward unchanged,
which is a workaround that hides the problem rather than fixing it.

Note this is narrower than it first appears: the snapshots are correct about
*columns on tables that already existed at 0033* — which is why a spot check can
wrongly suggest they are fine.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The snapshots describe the schema `main` actually has
- [ ] A plain `drizzle-kit generate` against an unchanged schema emits **nothing**
      — demonstrated, not asserted
- [ ] Hand-written migrations still work: `bun run db:migrate` applies all of them
      to a fresh database, and `db:push` is still not used
- [ ] The snapshot formatting convention is settled — the committed ones are
      biome-formatted and generated ones are not, and `_journal.json` needs a
      trailing newline; whichever way it goes, it is written down
- [ ] Nothing about the resync changes an existing migration's SQL

# 19 — A plain `drizzle-kit generate` emits a migration that re-creates four tables

**What to build:** a generator that emits nothing when the schema has not changed.

`apps/api/drizzle/meta/` has been frozen at **33 tables since `0033`**.

**Correction, from the agent that did the work.** My original list of missing
tables named `replay_result` and `forecast_attribution_day_ahead`. **Neither
exists** — I inferred them from migration filenames rather than reading
`src/database/schema.ts`, and did not check. The head snapshot (`0038`, which is
the only one `generate` diffs against) was missing **5 tables, 5 views and 5
enums**, plus a stale view body:

- `curtailment_forecast_day`, `curtailment_forecast_hour`, the two canonical
  views over them, and `forecast_origin_kind` / `forecast_gate_profile` (`0034`)
- `diagnosis_attribution`, `diagnosis_attribution_driver`, their two views, and
  `diagnosis_attribution_grain` / `diagnosis_driver_direction` /
  `diagnosis_rule_action` (`0035`)
- `curtailment_forecast_national_day` and its view (`0037`)
- `canonical_capacity_weight`'s **body**, held at its pre-`0038` definition — a
  fifth category the ticket missed entirely: a *changed* object rather than a
  missing one, which made `generate` emit `DROP VIEW` + `CREATE VIEW`

So anyone running `drizzle-kit generate` **without** `--custom` silently produces
a migration re-creating those four. Nothing has broken yet only because every
hand-written migration since `0033` has copied the snapshot forward unchanged,
which is a workaround that hides the problem rather than fixing it.

Note this is narrower than it first appears: the snapshots are correct about
*columns on tables that already existed at 0033* — which is why a spot check can
wrongly suggest they are fine.

**Blocked by:** None — can start immediately.

**Status:** done

- [ ] The snapshots describe the schema `main` actually has
- [ ] A plain `drizzle-kit generate` against an unchanged schema emits **nothing**
      — demonstrated, not asserted
- [ ] Hand-written migrations still work: `bun run db:migrate` applies all of them
      to a fresh database, and `db:push` is still not used
- [ ] The snapshot formatting convention is settled — the committed ones are
      biome-formatted and generated ones are not, and `_journal.json` needs a
      trailing newline; whichever way it goes, it is written down
- [ ] Nothing about the resync changes an existing migration's SQL

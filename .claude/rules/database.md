# Database

Postgres, drizzle, and a **bitemporal** record: every fact carries when it was
true and when WattSteer learned it. `docs/domain-model.md` §1 defines the three
axes; `docs/contracts/canonical-reads.md` is the consumer document.

## Read the canonical views, never an ingest table

ADR-0005. `apps/api/src/database/canonical-views.ts` declares them and each one
owns the `AsOf` pick, the renames, the grain and the unit resolution.
Re-querying the base table in a product route puts a second copy of all four in
the route, which is the drift the views exist to prevent.

Everything ONS got wrong or said oddly — a padded subsystem code, an
average-power value, a national aggregate row, an end-of-interval timestamp — is
resolved at ingest and is **unrepresentable** in these views.

## Every canonical read runs inside a transaction

`applyAxes` writes the axes with `set_config(..., true)` — the `true` is
`is_local`, so the setting lives for the rest of the **transaction**. On an
autocommit connection each statement is its own transaction and the axis is gone
before the select runs; the view then raises

```
canonical read attempted with no as_of: set wattsteer.as_of first
```

which is the view working as designed. TypeScript: `readOnly(db, tx => …)`,
which opens it for you. Python: `async with conn.transaction():` then
`await apply_axes(...)` — `apps/ml/src/wattsteer_ml/canonical_reads.py` does
this around every read, and a route that skipped it shipped a 500 to production.

`asOf` is never optional. `fleetDate`, `publishedAtOrBefore`,
`weatherRunCycle` and `partialReferenceDays` are the other four, and
`apply_axes` writes **all** of them every call, absent ones as the empty string
— a read that wrote only the axes it cared about would inherit the previous
read's gate on a pooled connection, which is wrong in a way no test of that read
alone could see.

## Aggregate in Postgres, not in the process

Group by the **Brasília** civil day —
`(valid_time at time zone 'America/Sao_Paulo')::date` — for the reason
`civilDayWindow` exists on the gateway side.

Two measured lessons:

- The Overview's first call took 8.4–9.7 s deployed because a `GROUP BY` over a
  deduplicated fact view forced a sort of the whole table: the `DISTINCT ON`
  ordering had no index behind it. It is a purpose-built view that reads the
  index backwards now — 1.3 ms at 864,000 rows.
- `/v1/similar-days` timed out at the gateway's 5 s on a **thirty**-day pool as
  surely as on a hundred-and-eighty-day one, because it read `feature_rows(...)`
  — sixty-odd lagged and windowed columns per row — for six day-level
  aggregates. Cost per row, not per range. It reads two `GROUP BY` queries over
  canonical views now.

## Migrations

`bun run --cwd apps/api db:generate` then `db:migrate`. Hand-written SQL where
drizzle-kit cannot express it (function DDL, composite types) — say so in the
file header, as `0024_day_ahead_programming.sql` does.

`test/migration-ledger.test.ts` holds the applied ledger against the files, and
it scans **every markdown in the tree** for migration names — so prose that
names one is prose the guard will check. It catches the renumber class of
defect: a regeneration shifts a migration's number, every document still names
the old one, and nothing notices. A number that exists but is now held by a
different migration is reported as exactly that rather than merely as unknown.

That guard read this very file while it was being written, and was right to: a
placeholder in the `NNNN_name` shape is indistinguishable from a real reference.
Do not invent one for an example.

## The suite that needs a real Postgres

`bun run --cwd apps/api test:db` against `localhost:5434` (see
`docker-compose.yml`). The rest of `test:api` runs without one and is the part
you iterate on.

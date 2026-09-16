# ADR-0005 — a product read never touches an ingest table

**Status:** accepted · 2026-09-16 (long-standing; recorded after being
re-derived)

## Context

`apps/api` has three layers: ingest tables, canonical views, and the routes.
The rule is that a route reads a canonical view and never an ingest table,
because an ingest table is where ONS's own conventions still exist and a
product read that reaches into one is a second place that has to know them.

The rule was recorded only inside `canonical-views.ts`'s own header, which
means it is found by people already editing that file.

## Decision

When a product read needs something the canonical layer does not publish, the
answer is **a new canonical read**, not a query against the base tables from
`contract/`.

The case that produced this ADR: `GET /v1/grid/now` opened by asking which hour
ONS has settled in all four subsystems, and asked it by grouping the whole
deduplicated fact view by `valid_time`. That view's `DISTINCT ON` ordering has
no index behind it, so the deduplication sorted the entire table first —
**8.4–9.7 seconds** at origin, on the first call the Overview makes, hidden
behind a 60-second CDN cache.

The fix reads `curtailment_report_hour` in `valid_time` order and stops at the
first complete hour: **1.3 ms**. It could have been written in `contract/`; it
is a view (`canonical_latest_complete_settled_hour`, migration `0051`) because
that keeps `canonical_as_of()` applied exactly as its siblings do and keeps the
rule intact.

## The argument that licensed it, recorded so it is not re-derived

Skipping the deduplication is sound because **`DISTINCT ON` picks one row per
business key and never drops a key**. The set of (`valid_time`, `subsystem`)
pairs is therefore identical either side of it, and a `count(distinct
subsystem)` per hour cannot differ between the two formulations.

Checked, not asserted: against superseding `data_version` rows, rows ingested
out of order, a newest hour carrying only two subsystems that must not be
chosen, and three `as_of` cuts including one before any ingest. Both agreed
every time, `null` included. `database-grid-now.test.ts` pins it against a real
planner, and pins the *answer* rather than only the agreement — two
identically-broken queries would satisfy the latter.

## Consequences

Migrations are applied out of band in this repository; nothing in
`apps/api/Dockerfile` runs `db:migrate`. `/ready` therefore checks that every
canonical view the code reads exists, derived from the schema module, and names
the ones that do not. Railway's healthcheck still points at `/health`
(liveness), so a schema-behind deploy goes live and fails per-request rather
than failing its check — closing that is a service-config change.

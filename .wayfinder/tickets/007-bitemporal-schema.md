---
id: "007"
title: Bitemporal schema and ingestion contract
type: wayfinder:grilling
status: open
assignee:
blocked_by: ["001", "006", "019"]
---

> **Resolved by building, not by grilling.** The dev's call: the wide-vs-narrow
> table shape and the `data_version` derivation are better answered after one
> real adapter exists than before it, so implementation ticket
> `.scratch/data-platform/issues/01-tracer-balanco-energia.md` makes these
> decisions as it writes the tables. This ticket stays as the record of what
> must be decided; close it when 01 lands.

## Question

What is the Postgres schema, given append-only bitemporal storage is decided
but its shape is not?

- One wide fact table per grain (subsystem-hour, plant-hour), or one narrow
  observation table keyed by (series, entity, event_time)? The first is fast
  and readable; the second absorbs new ONS datasets without migrations.
- How is `data_version` derived — a hash of the source file, an ONS-published
  version, or a monotonic ingestion counter?
- What exactly does an as-of join look like in Drizzle, and is it fast enough
  without a materialised current-view?
- Are DESSEM forecasts stored in the same table as actuals with a horizon
  column, or separately? They are forecasts *from* ONS, so they have their own
  publication time — a third time axis.
- Do we archive raw ONS files byte-for-byte on every fetch? It makes revisions
  auditable and lets any past view be rebuilt, but needs a volume or bucket and
  a retention policy. (Raised during charting, deliberately left open.)
- What does the ingestion job do when a fetch reveals a revision — insert a new
  version row always, or only when values actually differ?
- Idempotency and failure semantics for the BullMQ ingestion jobs.
- **Ingestion is not uniform across datasets**, per the ONS inventory:
  constrained-off, balanço and intercâmbio are bulk files on S3, but **carga
  verificada and programada have no bulk files at all** — REST API only, with
  the spec buried in a JS bundle. The contract must cover both shapes.
- **Two silent-failure traps to defend against explicitly.** The carga API uses
  `SECO`, not `SE`; passing `SE` returns HTTP 200 with an empty array rather
  than an error. And schema varies *within* a dataset's history — `dsc_restricao`
  was backfilled into older 2025 files while `val_intercambioprogmwmed` was not
  — so columns must be read per file and never cached per month. Both failures
  produce plausible-looking empty or null data rather than an exception, which
  makes them worse than a crash.
- **Revision detection** works via S3 `HEAD` and CKAN `last_modified`; ONS
  publishes no `x-amz-version-id`. `carga verificada` carries an undocumented
  `din_atualizacao` — the only row-level vintage marker anywhere in ONS open
  data, and worth exploiting where present.

Use `/grilling`. Output: a schema document plus the Drizzle definitions.

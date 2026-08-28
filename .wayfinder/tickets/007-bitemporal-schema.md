---
id: "007"
title: Bitemporal schema and ingestion contract
type: wayfinder:grilling
status: closed
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

---

## Resolution

Resolved by building, as the dev directed. Every question above is answered by
the tracer implementation on `feat/data-platform-01-tracer-balanco-energia`, and
the two headline decisions are recorded with their reasoning in
[`docs/specs/data-platform.md`](../../docs/specs/data-platform.md) — Implementation
Decisions, "Bitemporal model" and "Raw payloads are archived with their fetch
time". Point by point:

**Wide or narrow?** **Wide, one table per grain.** The first table is
`subsystem_energy_balance_hour`. A narrow observation table absorbs new datasets
without migrations, but the six balanço measures are published, revised and read
as one row — narrow storage makes "these six values are one restatement" an
application convention rather than a row, and leaves nothing single to digest.
It also sextuples row count and as-of work, and it cannot express
`RestrictionCause`, which the domain model settled as one value object spanning
three columns that are populated and blank together. The migration cost avoided
is bounded: the ONS catalogue is enumerated at 15 datasets.

**How is `data_version` derived?** **A sha256 over the stored value tuple and
nothing else**, compared against the latest version of the same business key;
equal means no write, different means insert at `previous + 1`. A source-file
hash is file-grained and would bump every row in a rewritten year; an
ONS-published version does not exist (no `x-amz-version-id` on any object, and
prior vintages are unrecoverable); a bare counter would record WattSteer's
polling schedule, which the domain model forbids. `published_at` and
`ingested_at` are excluded from the digest on purpose.

**What does an as-of join look like, and is it fast enough?**
`DISTINCT ON (subsystem, valid_time) … ORDER BY subsystem, valid_time,
ingested_at DESC, data_version DESC`, over an index on
`(valid_time, subsystem, ingested_at)`. No materialised current-view; the wide
shape keeps this one row per key per vintage. Revisit on measurement, not on
suspicion. Drizzle expresses the write side natively and the as-of read as raw
SQL — `DISTINCT ON` is the point of the query, so hiding it would be worse.

**DESSEM in the same table as actuals?** **No** — already settled by the domain
model, which makes `Observation` and `Forecast` two table families discriminated
by shape rather than by a `horizon` column. Nothing here reopens it.

**Do we archive raw ONS files?** **Fingerprint in Postgres, bytes outside it.**
`ons_resource_version` holds one row per distinct observed state of a resource:
the S3 triple folded into a `change_key`, plus content sha256 and byte size once
fetched, plus a nullable `archive_uri`. Retention: bytes kept indefinitely for
any state that produced a written revision, 90 days otherwise; the fingerprint
row is never deleted. The archive writer is not built by the tracer — the
nullable column is what makes landing it later an insert rather than a
migration.

**Insert a version always, or only when values differ?** **Only when they
differ.** Enforced by the digest above and covered by a real-Postgres test.

**Idempotency and failure semantics.** The job is idempotent at every step: the
catalogue read is a GET, the `HEAD` is compared against the
`(resource_url, change_key)` unique index and stops the run before a download
when nothing moved, the parse is pure, and the write is a no-op when digests
match. A retry after partial failure re-does work rather than corrupting it, so
the existing BullMQ `attempts`/backoff needed no special casing. `fetchedAt` is
set only after a completed download, so a crash mid-fetch does not make the next
run believe the file is already ingested.

**Bulk files and the REST API in one contract.** The contract is the canonical
row plus `(published_at, published_at_precision)`, not the transport. Bulk files
stamp `published_at` from the S3 `Last-Modified` at precision `file`; the carga
API will stamp it from `din_atualizacao` at precision `row`. Both write through
the same repository. That is why precision is a stored enum rather than a
comment.

**The silent-failure traps.** `SECO` never enters the schema — the subsystem
enum has exactly four members and `SIN` is not one of them, so the aggregate row
is structurally unable to double-count. Per-file schema variation is handled by
reading the header on every ingest and reconciling against the required-column
list; a missing column fails the file loudly, a present-but-empty column rejects
the row with `empty_value` and is never read as zero.

**Revision detection.** Implemented as the `(Last-Modified, Content-Length,
ETag)` triple. A fixture test records the absence of `x-amz-version-id`, so if
ONS ever starts versioning its bucket the assumption breaks visibly.

Two things the research did not have turned up while building, both now recorded
in the spec's Further Notes: the Parquet rendition stores `din_instante` as
INT96 and hands back a `Date` whose UTC fields are the Brasília wall clock, and
the DST placeholder rows are not uniformly empty — one subsystem writes `0E-8`
instead, so the gap is detected from the IANA zone rather than from the values.

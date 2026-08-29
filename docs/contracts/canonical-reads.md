# The canonical read contract

> What the modelling side reads, and the reason it never reads a fact table.
>
> Vocabulary authority: [`../domain-model.md`](../domain-model.md). Every name
> below is that document's. Where the ingest layer's own field name has drifted
> from it, the contract restores the domain model's name and the drift is listed
> in [Two corrections](#two-corrections-against-the-ingest-layer).
>
> Implementation: `apps/api/src/contract/` (TypeScript), served by
> `apps/api/src/api/canonical.ts` at `/v1/canonical`. Consumer-side vocabulary:
> `apps/ml/src/wattsteer_ml/canonical.py`. Ticket:
> `.scratch/data-platform/issues/13-canonical-read-contract.md`.

## Why this exists

WattSteer is two languages against one database. The platform (Elysia, Drizzle,
BullMQ) owns ingestion, the schema and every migration; the modelling service
(FastAPI) reads. The failure that architecture invites is specific: ONS's
conventions get reimplemented on the Python side, the two implementations drift,
and nobody finds out until a chart is wrong.

So the platform resolves every one of those conventions **at ingest**, and this
contract is the surface where that resolution is guaranteed. A consumer of these
reads has never seen, and has no code for:

| ONS convention | Where it was resolved |
|---|---|
| A padded subsystem code (`` `SE ` ``) | The bulk-file adapter |
| The carga API's `SECO` dialect | That one HTTP client, and nowhere else |
| The `SIN` national aggregate row | Filtered at the boundary; not a `Subsystem` |
| End-of-interval labelling (carga, `num_patamar`) | The adapter; every instant here starts its interval |
| Brasília local time | The adapter; every instant here is UTC |
| MWmed average power | Converted with the source interval length at the boundary |
| The CEG version segment | `ceg_core`, derived at ingest |
| `0.0` vs `False` for an invalid measurement | One boolean, unified by the adapter |
| Null-island coordinates | An absent `Coordinate`, not a `(0, 0)` pair |

If a number reaching a model looks like an ONS quirk, the bug is in an adapter.
It is never something to work around on the Python side.

## The reads

`GET /v1/canonical` returns this table as JSON, so a consumer discovers the
contract rather than hard-coding it.

| Read | Kind | Grain | Key | Cause? |
|---|---|---|---|---|
| `curtailment-by-reporting-entity` | observation | reporting entity × technology × hour | `reportingEntityCode`, `technology`, `validTime` | **yes** |
| `curtailment-by-plant` | observation | plant × technology × hour | `plantOnsCode`, `technology`, `validTime` | no |
| `system-context` | observation | subsystem × hour | `subsystem`, `validTime` | no |
| `system-exchange` | observation | directed link × hour | `fromSubsystem`, `toSubsystem`, `validTime` | no |
| `day-ahead-balance` | **forecast** (`ons_dessem`) | subsystem × half hour | `subsystem`, `validTime` | no |
| `weather-forecast` | **forecast** (`open_meteo`) | centroid × hour | `centroidId`, `validTime` | no |
| `installed-capacity` | observation | subsystem × technology, at a fleet date | `subsystem`, `technology` | no |
| `conjunto-membership` | observation | plant, at a fleet date | `plantOnsCode` | no |

Plus one composition:

- `GET /v1/canonical/training-window` — every family above for one window, under
  **one** `as_of`, in one database snapshot, with **one** vintage receipt.

### Observation or forecast, decided in the contract

`docs/domain-model.md` §4 makes the distinction structural rather than a flag:
an `Observation` always has `published_at > valid_time`; a `Forecast` always has
`published_at < valid_time` and additionally carries a `ForecastOrigin`.

The contract carries that through in three places, so it is impossible to miss:

1. The manifest's `kind` and `producer` — visible **before** a single row is
   read.
2. The envelope's `kind`, restated on every answer, for a consumer holding
   deserialised JSON with no static type.
3. The rows themselves. A forecast row has `origin: {producer, run_label,
   published_at}`. An observation row has no such field and no place to put one
   — there is no run that produced an observation.

**There is no `lead_time` anywhere.** It is `valid_time − published_at`, the
consumer holds both, and a second copy on the wire could disagree with the pair
it came from.

### Reasons live at one grain only

A `RestrictionCause` is `{reason, origin, description}` — one nullable value
object, never three nullable columns, because ONS populates and blanks the pair
together on every file scanned.

**It is reachable from `curtailment-by-reporting-entity` and from nothing else.**
That is not a filter; it is an absence. `curtailment-by-plant` has no cause
field on its rows and no parameter by which one could be requested, because at
plant grain no reason is observed:

- For a **Tipo II-C** plant — 93% of wind rows, 98.6% of curtailed energy — the
  reason exists only at its conjunto's grain. Pushing it down is an
  *allocation*, and v1 computes none.
- For a **self-reporting plant** (Tipo I / II-B, 18 over the window) the plant
  *is* the reporting entity, so its reason arrives through
  `curtailment-by-reporting-entity` keyed by the plant's own ONS code. A screen
  showing it must name the grain.

The only path between the two grains is `conjunto-membership`, and it takes a
date, because a plant that joined mid-window is misattributed by any snapshot
join.

## Vintage — the part you must not skip

Every read takes `as_of` and every read returns a `vintage` receipt. Neither is
optional and neither is defaulted.

```jsonc
"vintage": {
  "as_of":     "2026-06-01T00:00:00.000Z",  // the cut you asked for
  "window":    { "from": "…", "to": "…" },  // null on a registry read
  "fleet_date": null,                        // set on a registry read
  "vintage_fidelity": "revision_optimistic",
  "go_live_at": "2026-04-01T00:00:00.000Z",
  "sources": [ { "read": "…", "vintage_fidelity": "…", "go_live_at": "…" } ]
}
```

`AsOf(t)` returns the row per business key with the greatest `ingested_at ≤ t`.
**Exactly one row per key, or none.**

`VintageFidelity` is `docs/domain-model.md` §1's, and it is the reason `as_of`
is not defaulted to "now":

- **`point_in_time`** — the window's earliest instant is at or after WattSteer's
  go-live for every contributing source, so `AsOf` returned what was genuinely
  knowable.
- **`revision_optimistic`** — some of the window predates go-live, so the "past"
  is ONS's *current* restatement of it. ONS rewrites history in place and prior
  vintages are unrecoverable: **this can never be repaired retroactively.**

Two rules worth stating because they are easy to get backwards:

1. The **window start** decides it, not the window end. One pre-go-live hour
   makes the whole answer a restatement.
2. A **composition is only as honest as its weakest source.** A training window
   assembled from a point-in-time curtailment series and a revision-optimistic
   weather series is revision-optimistic as a whole, and `go_live_at` is the
   *latest* contributing go-live — or `null` if any source has ingested nothing
   at all, because then no such instant exists.

Any surface reporting a metric over a `revision_optimistic` window must say so.
This is a product-visible term, not an internal one.

### Forecasts are cut on publication, not on ingestion

`day-ahead-balance` takes `published_at_or_before`. Use it for a gate. Over
backfilled history every row was ingested at go-live, so `as_of` alone filters
nothing, while cutting on `published_at` genuinely reproduces what was knowable.

`weather-forecast` takes an optional `run_cycle`. **Omit it for the normal
read**: the later run wins as a newer vintage of the same hours, which is the
D−1 12Z-supersedes-00Z rule falling out of the bitemporal model rather than
being special-cased. Pass it only to answer "what did the 00Z run say?".

## Reads only, and no migration rights

Two layers, and the second does not depend on the first:

1. `apps/ml` opens every pooled connection with
   `default_transaction_read_only = on`, and `/ready` asserts the guard took.
2. Every canonical read runs inside an explicit `SET TRANSACTION READ ONLY`
   (`apps/api/src/contract/read-only.ts`). A write or a DDL statement from
   inside one raises `25006 read_only_sql_transaction` — asserted in
   `apps/api/test/database-contract.test.ts`, not merely intended.

The transaction earns its round trip twice: it also gives a composed read **one
snapshot**, so a `training-window` spanning an ingest commit cannot return
curtailment from before the write and weather from after it under a single
`as_of`.

The router exposes no verb but `GET`.

## On the wire

`snake_case` throughout, per `docs/specs/api-surface.md` — the ML service is
Python, the database columns are `snake_case`, and the conversion happens in
exactly one place (`apps/api/src/contract/wire.ts`). Instants are ISO-8601 UTC.

`null` is never a zero. An absent value is absent.

Query parameters are `snake_case` too: `as_of`, `from`, `to` (half-open
`[from, to)`), `on`, `subsystem`, `technology`, `reporting_entity_code`,
`plant_ons_code`, `conjunto_code`, `centroid_ids` (comma-separated),
`run_cycle`, `published_at_or_before`, `fleet_date`.

An inverted or empty window is a **400**, not an empty result: an empty result
would read as "there was no curtailment", which is a different and much worse
statement than "your window is backwards".

## Two corrections against the ingest layer

The repositories under `apps/api/src/ingest/` name two quantities differently
from `docs/domain-model.md` §4. The contract restores the domain model's names,
and the consumer only ever sees the right-hand column.

| Ingest field | Contract field | ONS source |
|---|---|---|
| `generationMwh` | `verified_generation_mwh` | `val_geracao` |
| `availabilityMw` | `available_capacity_mw` | `val_disponibilidade` |

## How the two languages are kept from drifting

`packages/core/fixtures/canonical-contract/` holds golden vectors: the read
manifest, and the `VintageFidelity` rule case by case.
`packages/core/test/canonical-contract.test.ts` asserts the TypeScript
implementation against them; `apps/ml/tests/test_canonical_contract.py` asserts
the Python one. **Neither side compares against the other** — only against
`expected` — so a shared misunderstanding cannot cancel out, and both suites
fail if the directory holds a case they did not enumerate.

The shape is recovered from the template's deleted resolver-parity suite
(`packages/core/test/resolve.test.ts`, before commit `9b8a1fc`), which is the
prior art the ticket points at. Its cross-workspace import does not survive a
language boundary; its fixture-table-as-contract and its
assert-against-`expected` discipline do.

## What this contract does not do

- **It does not compute features.** Windows, lags and joins belong in the
  versioned SQL feature function (`docs/specs/feature-engineering.md`), which
  has its own single definition for exactly the same reason this exists.
- **It does not derive `CurtailmentEpisode`s.** Those are computed on read from
  a threshold, and persisting them would freeze a threshold into the database.
- **It does not allocate a reason to a plant.** See above.
- **It has no write surface**, and adding one would breach the ownership
  boundary this document is half of.

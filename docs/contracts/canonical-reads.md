# The canonical read contract

> What the modelling side reads, and the reason it never reads a fact table.
>
> Vocabulary authority: [`../domain-model.md`](../domain-model.md). Every name
> below is that document's, and since ticket 016 so is every name underneath it
> — see [The corrections](#the-corrections-ticket-016-made-at-the-source).
>
> Implementation: **the contract is a set of SQL views**,
> `apps/api/src/database/canonical-views.ts`, shipped as migrations `0012`
> (the read axes) and `0013` (the views). Two callers, no other:
> `apps/api/src/contract/reads.ts` for TypeScript and the `/v1/canonical` routes,
> and `apps/ml/src/wattsteer_ml/canonical_reads.py` for the modelling service,
> which reads Postgres directly on its read-only role. Shared vocabulary and the
> vintage rule: `apps/api/src/contract/{manifest,vintage}.ts` and
> `apps/ml/src/wattsteer_ml/canonical.py`. Tickets:
> `.scratch/data-platform/issues/13-canonical-read-contract.md` (the contract),
> `.scratch/data-platform/issues/16-canonical-transport.md` (the move into SQL).

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

Every row of `curtailment-by-reporting-entity` additionally carries the
reporting entity's `subsystem` and `reportingEntityKind`, both from the
`reporting_entity` join the view already makes. Neither is derivable from the
entity code, and the constrained-off label is *defined* at subsystem grain, so
without them a consumer holding the row has to go back to the registry to learn
the grain of the thing it is holding. `subsystem` is filterable, in both
languages: it is a filter and not an axis, because an entity's subsystem does
not vary between that entity's versions.

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

Both are **axes, not filters** — see the next section. Applying either yourself,
outside the view, is a different and quietly wrong query.

## How to read it: the views and their axes

Each read is one view, named from its manifest name by one rule —
`curtailment-by-plant` → `canonical_curtailment_by_plant`. The rule is applied
in both languages (`view_name` in Python, the same transform asserted in
`apps/api/test/contract.test.ts`) rather than tabulated, so a renamed view cannot
leave a stale entry behind that still parses. There is a ninth view,
`canonical_read_go_live`, which is not a read: it is the go-live instant per
read, and it is the only input the fidelity rule takes from the database.

A view cannot take an argument, so the axes travel as session settings and the
view reads them back through the functions in `drizzle/0012_canonical_read_axes.sql`:

| Setting | Required | Used by |
|---|---|---|
| `wattsteer.as_of` | **always** | every read |
| `wattsteer.fleet_date` | registry reads | `installed-capacity`, `conjunto-membership` |
| `wattsteer.published_at_or_before` | no | `day-ahead-balance` |
| `wattsteer.weather_run_cycle` | no | `weather-forecast` |

Two properties are worth stating plainly, because both are load-bearing:

1. **`canonical_as_of()` raises rather than defaulting.** There is no fallback
   to `now()`. A view that answered latest-version when the axis was forgotten
   would be indistinguishable from a correct answer, which is precisely the
   failure `AsOf` exists to prevent; SQLSTATE `22023` is the alternative.
2. **The two optional axes are applied *inside* the version pick, not after.**
   Both restrict a column that is not part of the business key, so "the latest
   version of the 00Z run" is a different query from "the latest version,
   discarded if it turned out to be 12Z" — and the day-ahead gate has exactly
   the same shape. Every filter a *caller* applies (`valid_time`, subsystem,
   technology, entity code, centroid) is on a key column, where inside and
   outside are the same question.

Set them with `set_config(..., true)` inside a transaction, so they cannot
outlive it and cannot leak onto a pooled connection. `applyAxes` /`withAxes`
(`apps/api/src/contract/scope.ts`) and `apply_axes`
(`apps/ml/src/wattsteer_ml/canonical_reads.py`) are the only two places that do.

**The `/v1/canonical/*` routes still serve**, from these same views, for the web
app and for debugging. They are no longer the modelling path: putting a ~37M-row
training read through JSON and making `ml → api → ml` a dependency cycle is what
ticket 016 removed.

## Reads only, and no migration rights

Two layers, and the second does not depend on the first:

1. `apps/ml` opens every pooled connection with
   `default_transaction_read_only = on`, and `/ready` asserts the guard took.
2. Every canonical read runs inside an explicit `SET TRANSACTION READ ONLY`
   (`apps/api/src/contract/read-only.ts`). A write or a DDL statement from
   inside one raises `25006 read_only_sql_transaction` — asserted in
   `apps/api/test/database-contract.test.ts`, not merely intended.

A view is a read-only surface by construction, and none of these is auto-updatable
in Postgres' sense — every one has a `DISTINCT ON`, an aggregate or a `UNION`. So
the boundary did not weaken when the contract moved into SQL; it acquired a third
layer. In production the ML service should additionally connect as a role granted
`SELECT` on the `canonical_*` views and nothing else, which is the layer that
survives a leaked connection string.

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

## The corrections ticket 016 made at the source

Ticket 013 corrected two drifted field names *at the contract's edge*: the
repositories under `apps/api/src/ingest/` named two quantities differently from
`docs/domain-model.md` §4, and the contract renamed them on the way past. That
made the domain model true for a consumer while leaving it false in the schema,
which is the wrong half to fix — and it is a compensating rename, which is the
kind of thing that only stays correct while someone remembers it.

The columns carry the domain model's names now, and there is no rename left
anywhere to perform:

| Was | Is, in `curtailment_report_hour` | ONS source |
|---|---|---|
| `generation_mwh` | `verified_generation_mwh` | `val_geracao` |
| `availability_mw` | `available_capacity_mw` | `val_disponibilidade` |

The same ticket made two other things true that the composing contract could not:

- **`reporting_entity_kind` is on every curtailment row** (`CONJUNTO` or
  `PLANT`). A consumer can tell a conjunto row from a self-reporting plant row
  without a second call — the first thing a screen showing a restriction cause
  has to say. The view joins `reporting_entity`; a module composing repositories
  had no place to put that join.
- **`reporting_entity_name` is on every curtailment row too**, added by
  api-surface ticket 14 for the same reason and by the same join: a reason row
  on `GET /v1/curtailment/reasons` carries an `entity_label`, and a code is not
  a name. A product read reaching into `reporting_entity` for one column would
  be a second path to a base table.
- **`canonical_curtailment_episodes(subsystem, from, to, threshold_mw,
  max_gap_hours, technology)`** is a parameterised SQL function over the same
  view — a read-time computation, never a stored grain, so a threshold is an
  argument rather than something frozen into the database. An hour is in an
  episode at or above the threshold; a sub-threshold hour and an unobserved
  hour are both gaps, because continuity across an absence cannot be asserted.
- **`vintageFidelity` has one implementation per language.** It had been written
  out identically in nine places on the TypeScript side, beside the one that was
  actually tested. The survivor is `apps/api/src/contract/vintage.ts`, and
  `apps/api/test/contract.test.ts` asserts it is the only one.

## How the two languages are kept from drifting

`packages/core/fixtures/canonical-contract/` holds golden vectors: the read
manifest, and the `VintageFidelity` rule case by case.
`packages/core/test/canonical-contract.test.ts` asserts the TypeScript
implementation against them; `apps/ml/tests/test_canonical_contract.py` asserts
the Python one. **Neither side compares against the other** — only against
`expected` — so a shared misunderstanding cannot cancel out, and both suites
fail if the directory holds a case they did not enumerate.

**`vintageFidelity` is the one thing left duplicated on purpose.** Everything
that shapes a row moved into SQL in ticket 016; an inequality between two
timestamps did not. It is bound in both languages by these vectors, and pushing
it into the database would cost the one part of this contract that is testable
without one. What the database supplies is its input — `canonical_read_go_live`
— and nothing else. The views themselves contain neither `point_in_time` nor
`revision_optimistic`, which `apps/api/test/contract.test.ts` checks.

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

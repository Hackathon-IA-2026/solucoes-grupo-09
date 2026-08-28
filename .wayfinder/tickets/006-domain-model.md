---
id: "006"
title: Domain model and ubiquitous language
type: wayfinder:grilling
status: closed
assignee: domain-agent
blocked_by: ["001"]
---

## Question

What are WattSteer's domain nouns, and what does each one mean precisely?

Candidates to pin down, and the ambiguity in each:

- **Subsystem** — the four ONS subsystems. Is it an enum or a table? Does it
  carry installed capacity over time?
- **Plant** — needed for per-plant observed curtailment. What identifies one
  across ONS datasets, and does it belong to a subsystem stably?
- **Conjunto** — promoted to a first-class entity by the ONS inventory: it is
  the *reporting entity* for 93% of wind constrained-off rows and the only grain
  at which reason codes exist. What is its relationship to Plant (the
  `usina_conjunto` bridge), is membership stable over time, and can a plant
  belong to more than one? The screens must never show a reason at plant grain.
- **Observation** vs **Forecast** — the same quantity (curtailment MW at an
  hour) exists as a measured fact and as a prediction. One table or two? This
  interacts hard with the bitemporal decision.
- **Curtailment event** — is an "event" a single hour, or a contiguous run of
  hours above threshold? IDEA.md §2 leaves the threshold open (>1 / >5 / >10 MW).
  The screens speak in events; the model predicts hours.
- **Reason code** — four codes: `REL` (indisponibilidade externa, *not*
  "relaxamento") / `CNF` / `ENE` / `PAR`. `PAR` is documented since 2024-04 but
  was observed zero times in five sampled months — is it a real class or a dead
  enum value? A property of an observation, a separate classification target, or
  both? Note it exists only at conjunto grain.
- **Flexibility asset** — the `asset_type` schema from §32. What is common to
  every type, what is type-specific, and where does it live given assets are
  user-supplied scenario inputs rather than persisted inventory?
- **Scenario** — a set of assets plus a target day. Is it persisted at all, in
  a product with no accounts? URL-encoded?
- **Optimization result** — baseline vs optimized curtailment, avoided energy,
  avoidability score (§33).
- **Replay** — a historical day re-run under D-1 information. What distinguishes
  it from an ordinary forecast, given bitemporal storage makes both possible?

Use `/domain-modeling`. Record the result as a domain model document in the
repo and link it. Every later ticket will speak this vocabulary.

## Resolution

**Done.** Ubiquitous language written to
[`docs/domain-model.md`](../../docs/domain-model.md) — glossary, relationships,
rejected names, and the calls that need dev review.

The load-bearing moves:

- **Four time names, not three.** `valid_time` (world) / `published_at`
  (upstream source) / `ingested_at` (WattSteer) / `data_version`. This
  **renames the map's `event_time`**, because "event" is needed for the product
  noun and no hour of grid data is an event. `AsOf(t)` is the only sanctioned
  read; `VintageFidelity` ∈ `point_in_time` | `revision_optimistic` is stamped
  on every backtest and replay.
- **`ReportingEntity = Conjunto | SelfReportingPlant`** — a sum type. Reasons
  hang off `ReportingEntity`, so there is no type-system path from a `Plant` to
  a reason. Sharper than the map's rule in one direction: the 18 Tipo I / II-B
  plants *are* reporting entities, so their reasons are observed at plant grain
  and may be shown, provided the screen names the grain. `ConjuntoMembership` is
  SCD2 and always resolved as-of; at most one conjunto per plant per instant,
  asserted on ingest.
- **`Observation` vs `Forecast` are two table families, discriminated by shape,
  not a flag**: an Observation has `published_at > valid_time` and no
  `ForecastOrigin`; a Forecast has `published_at < valid_time` and always one.
  `lead_time` is derived. DESSEM is `DessemBalance`, a Forecast produced by ONS.
- **`CurtailmentHour` is the atom; `CurtailmentEpisode` is a derived view** —
  a contiguous run above threshold, computed on read, never stored, carrying the
  `threshold_mw` and `max_gap_hours` that produced it. "Event" is rejected
  outright. `curtailment_threshold_mw` stays configurable but **commits a
  default**: 5 MW at subsystem grain, 1 MW at reporting-entity grain,
  `max_gap_hours = 0`. `has_curtailment` is never a stored column.
- **`RestrictionCause`** is one nullable value object (`reason` + `origin` +
  free-text `description`), because the two codes are always populated together.
  `PAR` is a live enum member, valid on ingest, not a v1 modelling class.
- **`Scenario` is a URL-encoded value object**, `FlexibilityAsset` is a sum type
  with no persisted identity, `Replay` is a read mode rather than a table, and
  `Backtest` is the separate aggregate noun.


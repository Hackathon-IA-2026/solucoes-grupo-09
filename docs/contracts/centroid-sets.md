# The centroid set contract

> Where weather enters WattSteer, how those points are produced, and what is
> allowed to happen to them afterwards — which is: nothing.
>
> Vocabulary authority: [`../domain-model.md`](../domain-model.md) §4.
> Spec: [`../specs/feature-engineering.md`](../specs/feature-engineering.md),
> "The centroid set — settled".
> Implementation: `apps/api/src/ingest/weather/centroids.ts` (the frozen v1),
> `centroid-generator.ts` (the generator), `centroid-set-repository.ts` (the
> store), `centroid-job.ts` (regeneration and the drift watch),
> `apps/api/src/scripts/generate-centroids.ts` (the script).
> Ticket: `.scratch/feature-engineering/issues/02-centroid-set-from-the-registry.md`.

## The one rule

**Points are frozen; weights are not.**

A weight is `CapacityWeight(centroid, technology, t)`, derived from
`InstalledCapacityAsOf` and therefore a function of the target date by
construction. It moves every day, and it is *supposed* to: the registry research
measured 25.8% of today's curtailed-fleet MW as commissioned after the training
window opens, and fixed 2026-08 weights as misallocating 50.4% of the SE-solar
weight mass at window start.

A **point** is the opposite. Open-Meteo snaps a query to the nearest model grid
cell and answers for the cell, so moving a query point by a few kilometres can
change the cell underneath a series that has already been ingested. The series
would change because the question changed, and **nothing in the data would say
so** — no null, no gap, no version bump, no failing test. That is the failure
this contract exists to make impossible.

So: a set's geometry is immutable once frozen, and a regeneration is a **new
centroid set version → a new feature-set version → a retrain**. Never an
in-place edit. `freezeCentroidSet` enforces it (identical geometry under an
existing version is a no-op; different geometry is `CentroidSetImmutableError`),
`regenerateCentroids` refuses the version in use by name, and `centroid_set` is
keyed by version with a digest of its own points.

## Which set is in use — and why v2 is not

| Version | Source | Points | Status |
|---|---|---|---|
| `centroid_set_v1` | hand-transcribed from `weather-sources.md` | 19 (W1–W12, S1–S7) | **in use** — `CENTROID_SET_VERSION`, every stored weather row |
| a generated set | `centroid-generator.ts` over the registry | generator's answer | cut on demand, promoted deliberately |

**The generator does not reproduce `centroid_set_v1`, and it is not supposed
to.** v1's clusters are hand-grouped municipalities ("Sento Sé + Campo
Formoso"), and two of its points — W11 (RS/SC north coast) and W12 (Maranhão
coastal) — were never computed from SIGA municipality centroids at all; the
research says so and the code carries `provisional: true` on both. A generated
set corrects exactly those two points, which is the same as saying it *differs*
from the set weather has been ingested at.

That is a live tension, and the resolution is:

1. **v1 stays the active geometry.** It is recorded in `centroid_set` as
   `source = 'hand_transcribed'`, with W11 and W12 stored as
   `origin = 'hand_transcribed'` rather than claiming a derivation that did not
   happen, and with a freeze-time drift baseline measured against the real
   fleet. No stored weather is invalidated by anything in this ticket.
2. **The generator cuts a new version** — `centroid_set_v2` by convention — when
   it is run. Both versions coexist in the store; the generated one is not
   consulted by ingest.
3. **Promotion is a separate, deliberate act**: changing `CENTROID_SET_VERSION`,
   which is a new feature-set version and a retrain, and which backfills weather
   at the new points rather than reinterpreting the old rows.

Cutting v2 *immediately and switching to it* was the alternative. It was
rejected for the reason the whole module exists: it would silently change the
grid cell under every existing series, and the correction it buys (two points
that carry ~1,000 MW of ~55 GW) does not justify invalidating the ingested
history before a retrain is scheduled anyway.

## How a set is generated

`bun run src/scripts/generate-centroids.ts --version centroid_set_v2 [--dry-run]`
from `apps/api`. The pipeline is pure, deterministic and in this order:

1. **Aggregate by municipality** — every located plant of one technology in one
   SIGA municipality collapses to one capacity-weighted point. This is what
   "centroids of ANEEL SIGA plant coordinates aggregated by municipality" means,
   and it is what makes W11 and W12 derived rather than approximate.
2. **Cluster by single linkage** at `DEFAULT_CLUSTER_RADIUS_KM` = 75 km, within
   a technology. Chosen against the set it has to be able to describe: the
   closest same-technology pair in v1 is W1/W2 at 103.5 km, so 75 km keeps every
   v1 cluster distinct with ~28 km of margin, and it is far above the 9–13 km
   grid. Single linkage, not k-means: no k to guess, no seeding, and re-running
   reproduces the partition exactly.
3. **Drop clusters below** `DEFAULT_MIN_CLUSTER_MW` = 400 MW — just under W12's
   426 MW, the smallest cluster the research kept. No megawatt is lost: the
   weighting assigns every plant to the nearest centroid of its own technology,
   so a dropped cluster's plants weight a kept one.
4. **Resolve grid-cell collisions**, using the cells Open-Meteo echoes and no
   grid this repository models. Same technology: **merge, summing the MW** —
   Open-Meteo returns the identical series for both, so one cell weighted twice
   is a silently doubled region. Different technologies: the smaller cluster
   leaves the *geometry* (its plants still weight a neighbour), because a
   centroid carries one technology and nudging a point would invent geography.
5. **Assert uniqueness and freeze.** A set whose points were never snapped comes
   back `collisionCheck: "unchecked"` and the repository refuses to freeze it.

On the current frozen nineteen **no pair collides** — measured against
`ecmwf_ifs` on 2026-08-28. Step 4 is a guard for a set that is generated, not a
fix for a live problem.

Regenerating against the same registry vintage reproduces the stored set
exactly: the second run writes nothing and reports `frozen: false`.

## The drift watch

The generator records the **capacity-weighted mean plant-to-centroid distance**
at freeze time (`centroid_set.freeze_mean_distance_km`), computed by
`computeCapacityWeights` rather than by a second distance loop, so the baseline
and the recomputation cannot drift apart.

A weekly queued job (`centroid_drift`, Mondays 06:00 UTC) recomputes it against
the **stored** geometry of the watched version and writes a
`centroid_drift_check` row every time, including the quiet ones. At
`DRIFT_TRIGGER_RATIO` = 1.25 — a 25% increase over the baseline — it records
`outcome = 'regeneration_triggered'` and warns loudly.

**It never regenerates.** Cutting a set is a decision with a retrain attached,
and a job that made it at 06:00 on a Monday with nobody watching would be
exactly the in-place edit this contract forbids, wearing a schedule.

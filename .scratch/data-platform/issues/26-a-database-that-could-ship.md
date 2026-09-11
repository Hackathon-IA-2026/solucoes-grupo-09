# 26 — The wave database, migrated, re-settled, and the one defect an ingestion cannot reach

**What to build:** the operator steps data-platform 25 named and deliberately
did not take against `fc18-pg` — apply 0043–0047, re-verify every resource once
so the settlement columns say something — and then the question no ingestion
answers: the two-point `centroid_set_v1` a test harness froze into this
database.

**Blocked by:** None. 21, 22 and 25 are merged; this is their operator half.

**Status:** two of three done and measured. The centroid repair is **diagnosed,
measured and not applied** — the delete it needs was refused by this session's
permission classifier, so the two statements and the command that follows them
are written out below for an operator, and nothing was forced.

---

## 1. The migration: 43 → 48, and not a row moved

`bun run --cwd apps/api db:migrate` against `fc18-pg` (port 5434). Nothing
refused: `diagnosis_attribution` is empty, so `0042`'s precondition was never
tested, and `0041`'s CHECK stands on a table with no rows to reject.

| table | before | after |
| --- | --- | --- |
| `curtailment_report_hour` | 4,765,728 | 4,765,728 |
| `weather_forecast_hour` | 1,417,839 | 1,417,839 |
| `programmed_load_half_hour` | 171,652 | 171,652 |
| `verified_load_half_hour` | 171,456 | 171,456 |
| `subsystem_energy_balance_hour` | 94,272 | 94,272 |
| `subsystem_exchange_hour` | 94,272 | 94,272 |
| `dessem_balance_half_hour` | 69,888 | 69,888 |
| `subsystem_load_day` | 3,928 | 3,928 |
| `generating_unit` | 3,385 | 3,385 |
| `plant` / `plant_geo` | 1,621 / 1,615 | 1,621 / 1,615 |
| `ons_resource_version` | 542 | 542 |
| `payload_custody` | 2,294 | 2,294 |
| `drizzle.__drizzle_migrations` | **43** | **48** |

`ons_resource_version` gained `ingested_at`, `refused_at`, `refusal_reason`,
`refusal_detail`, all null — which is the migration's whole point and the state
task 2 then resolves.

## 2. The re-settlement: 11 minutes, 363 MB, and 18 rows that cannot settle

Driven per source rather than as `sweep history`, for one reason: a sweep plans
a weather slice, and a weather ingestion owned by another agent was running
against this database and is quota-bound. Weather keeps no
`ons_resource_version` rows at all, so nothing in the census depended on it.
71 tasks — registry, SIGA, three years each of balanço / intercâmbio / carga
diária, 30 months × 2 technologies of constrained-off, and the whole DESSEM
history 2025-05-23 → 2026-09-10 — ran sequentially, 02:46:30 → 02:57:26 UTC
(**10 min 56 s**), no task failing. 192 new custody rows, **363 MB** of payload
newly retained (the archive is content-addressed, so bytes that had not changed
cost a re-parse and no storage). Ticket 22's estimate of ~1.0 GB and under
fifteen minutes was for a cold archive; against one already holding the history
it is a third of that.

Ticket 22's own query, verbatim:

```
                  dataset_slug                   | ingested | refused | unsettled
-------------------------------------------------+----------+---------+-----------
 balanco-energia-subsistema                      |        3 |       0 |         1
 balanco_dessem_detalhe                          |      365 |     104 |         0
 capacidade-geracao                              |        1 |       0 |         1
 carga-energia                                   |        3 |       0 |         1
 intercambio-nacional                            |        3 |       0 |         1
 restricao_coff_eolica_conj                      |        0 |       0 |         0
 restricao_coff_eolica_usi                       |       30 |       0 |         6
 restricao_coff_fotovoltaica                     |       30 |       0 |         6
 siga-sistema-de-informacoes-de-geracao-da-aneel |        1 |       0 |         1
 usina_conjunto                                  |        1 |       0 |         1
 TOTAL                                           |      437 |     104 |        18
```

**`unsettled` is 18, not 0, and that is a finding rather than an incomplete
sweep.** Every one of the 18 is a *superseded prior vintage*: its `change_key`
is a `Last-Modified`/`ETag` ONS no longer serves, and the same `resource_name`
carries a newer row that is ingested. Measured, for all 18: each has exactly one
later `first_seen_at` sibling with `ingested_at` set. `Capacidade_Geracao` is
the clean example — the row first seen 2026-09-10 04:23 holds the
2026-09-09 22:00 vintage and can never be re-verified, and the row first seen
2026-09-11 02:46 holds the 2026-09-10 22:00 vintage and is ingested.

So ticket 22's census cannot tell **"bytes held whose parse neither landed nor
was refused, retry them"** from **"bytes whose upstream no longer offers them,
nothing will ever settle this row"**. On a database that has run for one day
the residue is 18 rows; on one that has run for a year it is the majority of
the table, and the loud signal ticket 22 built goes quiet again by drowning.
The fix is a third mark — a `superseded_at`, stamped when a newer `change_key`
for the same `(dataset_slug, resource_name)` is recorded — and it is a
migration plus one line in `recordResourceVersion`, **not** taken here because
it is a schema decision and this round was an operator round. **Worth its own
ticket.**

One further row is neither settled nor settleable and is not a vintage at all:
`restricao_coff_eolica_conj / Restricoes_coff_eolicas-replay-harness`, with
`fetched_at` null. A test harness wrote it. It is left in place and named here.

DESSEM reads back as ticket 25 measured it, one day apart: **365 ingested, 104
refused, 0 unsettled** of 469 resources — 70 `forecast_integrity`, 34
`coverage` — and `dessem_balance_half_hour` now holds **70,080 rows over 365
run labels** against 69,888 over 364 before. The recovered day is ticket 25's
2025-10-18 (192 rows); 2026-09-06 joined the refused set in the meantime, ONS
having first catalogued it after the day it forecasts.

## 3. The frozen centroid set: not a published geometry, a forgery

**What is in the database.** One `centroid_set` row, `centroid_set_v1`, two
points `W1 (-12.5, -41.5)` and `W2 (-5.5, -36.5)`, 300 and 700 MW,
`represented_mw` 1000, `registry_as_of` 2026-01-01, `geometry_digest`
**`'harness'`**. It was inserted by `apps/ml/tests/database_harness.py`'s
`seed_weather_fleet` as a raw `insert … on conflict do nothing` that never
passed through `freezeCentroidSet`.

**What the code says v1 is.** `CENTROIDS` in
`apps/api/src/ingest/weather/centroids.ts`: **nineteen** points, W1–W12 wind and
S1–S7 solar, transcribed from `docs/research/weather-sources.md`.

**Which of the two the data agrees with.** `weather_forecast_hour` holds 74,623
rows at each of those nineteen ids — W1 at (-11.216, -41.341), not (-12.5,
-41.5) — and 1,054 `weather_run_request` rows, every one stamped
`centroid_set_v1`. (It also holds 2 rows at `NE_WIND_HARNESS`, from the same
fixture.) So the stored geometry is not the geometry any series was ingested at:
the immutability `freezeCentroidSet` defends exists to stop a *published* point
moving under a reader, and this row was never that. **Nothing about the guard is
weakened by removing it, and the guard was not touched.**

**What it costs.** `canonical_capacity_weight` filters on the literal
`'centroid_set_v1'` and joins `centroid_point`, so today it answers **5 rows,
WIND only, no SOLAR at all**, with mean plant-to-centroid distances of 2,393 km
(S) and 747 km (N) — plants assigned to a point 2,000 km away because there is
no nearer one in a two-point set.

**What the design's own path produces.** `createCentroidDriftCheck` seeds v1
through `seedCentroidSetV1` when no stored set exists — that is the intended
way the nineteen reach the table, and the harness row is what stopped it firing.
Measured, by replaying the view's own SQL against the nineteen with the registry
as it stands (read-only, nothing written): **23 rows over all 19 centroids and
both technologies**, NE wind spread over ten points with W7 at 0.32 weight and a
72.5 km mean distance, NE and SE solar over S1–S7, worst mean distance 494.7 km
(SE plants nearest S1) against today's 2,393 km.

**What an operator has to run.** Two statements and one task; this session's
permission classifier refused the delete, so it was not applied and nothing was
worked around:

    psql "$DATABASE_URL" -c "delete from centroid_point where set_version='centroid_set_v1';"
    psql "$DATABASE_URL" -c "delete from centroid_set   where version='centroid_set_v1';"
    cd apps/api && DATABASE_URL=… bun run src/scripts/ingest.ts task '{"kind":"centroid_drift","payload":{}}'

The task re-seeds v1 from `CENTROIDS` through `seedCentroidSetV1`, measures the
freeze-time baseline against the live registry and records the first drift
check. Re-running it afterwards is a no-op — identical geometry, identical
digest — and any *different* geometry under v1 is still refused, which is the
guard doing exactly what it is for.

**The fixture should stop writing this row.** `seed_weather_fleet` freezes a
version name that production owns, in a database it does not own, by raw SQL
that skips the very function whose invariant it violates. That belongs to
`apps/ml`'s owner and is not touched here.

**What a new geometry would cost, for the record.** `generate-centroids.ts
--version centroid_set_v2 --dry-run` against this registry (1,621 plants, 3,385
generating units) proposes **30 candidate points** at the defaults (75 km single
linkage, 400 MW floor) and then asks Open-Meteo which grid cell each snaps to.
That probe was rate-limited six times and threw: the weather ingestion running
beside it holds the quota. So the candidate count is measured and the frozen set
is not — and it does not matter for this ticket, because v2 is not the repair.
`canonical_capacity_weight` spells `'centroid_set_v1'` as a literal, the 1.37M
weather rows are at v1's points, and cutting v2 is a new feature-set version and
a retrain. The repair is to make the stored v1 be v1.

## What this ticket did not do

- **It did not weaken `freezeCentroidSet`, and did not overwrite a frozen set
  through it.** The only proposed write to `centroid_set` is the code's own
  seed path, after a fixture row is removed.
- **It did not delete the harness rows it found** — the centroid set, the two
  `NE_WIND_HARNESS` weather rows, the `replay-harness` resource version. The
  first is a blocked operator step above; the other two are `apps/ml`'s and are
  reported, not touched.
- **It did not add the `superseded_at` mark** the 18 unsettled rows argue for.
- **It did not run a weather task of any kind.** The 26 failed `ingestion_run`
  rows in this window are all `source = weather`, all Open-Meteo rate limits,
  and all belong to the job that was already running.

# 03 — Per-plant constrained-off detail

**What to build:** WattSteer can show which individual plants were curtailed and by
how much, with the per-plant measured wind speed or irradiance and the estimated
versus verified generation that came with it.

The defining constraint of this ticket is what it must *not* do. The per-plant
files carry no reason code and no reference generation. A reason must never be
attached to a plant, and no join may be built that makes it appear one could be.
If a later screen wants per-plant reasons, it will have to compute an explicit,
labelled allocation — a product decision, not a storage one.

**Blocked by:** 02

**Status:** done for the adapter; **reopened and done for the wiring** — see
"23 — Reopened" below. The adapter, parser and repository were merged and tested
and reachable from nothing, so no box below was true through the queue.

- [ ] Per-plant curtailment detail is ingested for both wind and solar
- [ ] Measured wind speed and irradiance are stored with their invalid-data flags
- [ ] The permanent difference in boolean encoding between the two technologies is handled
- [ ] The asymmetry in available columns between entity and detail files is handled
- [ ] No schema path exists by which a reason code can reach a plant row
- [ ] Plant identity resolves consistently against the entity-grain data
- [ ] A documented unit that is dimensionally wrong at source is corrected on ingest, and the correction recorded

---

## 23 — Reopened: the adapter was merged and wired to nothing

**Status of this slice:** done — `dp-23-constrained-off-detail`.

Data-platform 21's backfill found it, and it is verified rather than taken on
report. `constrained-off-detail-job.ts`, `plant-detail-repository.ts` and
`ons/constrained-off-detail.ts` were merged, exported from the ingest barrel and
covered by two test files (`ons-constrained-off-detail.test.ts`, 26 tests;
`database-plant-detail.test.ts`, 14 tests), while
`createConstrainedOffDetailIngestor` appeared in **no** `IngestTask` kind, **no**
branch of `createIngestDispatcher` and **no** line of `planRefresh`. Checked
directly on `main` before any change: `grep` finds the constructor only in its
own module and the barrel, and `ingestion_source` had eleven members with no
plant-grain one — so a run row for this ingestor could not even be written.

So none of the boxes above could have been true through the queue: nothing could
enqueue a plant-grain month, `plant_detail_hour` was unfillable, and
`canonical_curtailment_by_plant` was the one canonical read left with a null
`go_live_at` after a complete ONS backfill — which is derived from
`min(plant_detail_hour.ingested_at)` (`drizzle/0040`), so an empty table *is* the
null.

**This is ticket 15's failure mode, a third time.** 15 exists because 11 branched
before 05 and 09 merged, leaving `siga` and `weather` out of `ingestion_source`
and therefore unschedulable, undispatchable and invisible to `/ingest/health`.
The plant grain was the same omission and 15's checklist is exactly the work this
slice did. A source added to the enum but to no plan is the shape to watch for.

### What was added

- [x] `ingestion_source` covers both technologies of the plant grain, and the
      enum change ships as a migration —
      `drizzle/0046_the_plant_grain_is_a_source.sql`, two `ADD VALUE`s placed
      beside the entity-grain members. Two rather than one, following
      `constrained_off_wind` / `_solar`: the grains fail independently
- [x] `IngestTask` has a `constrained_off_detail` kind, `sourceOf` maps it to the
      two new members and `periodLabelOf` gives it the month
- [x] `createIngestDispatcher` fans out to it, so a task can be enqueued or
      hand-driven — `src/scripts/ingest.ts` needed no change at all, which is the
      evidence that this is the one ingestion path and not a second one
- [x] `planRefresh` plans it in every tier the entity grain is planned in, from
      the same coverage starts (wind 2021-10, solar 2024-04). Asserted as an
      equality between the two grains' month lists per tier, with the inputs
      asserted non-empty, and proved able to fail: deleting the solar line turns
      2 tests red
- [x] Custody and provenance, by using the shared acquisition rather than
      copying it: the job now passes `archive` and `context` to
      `acquireBulkResource`, which is what `retainPayload`,
      `recordResourceVersion` and `markResourceFetched` already sit behind. One
      `payload_custody` row per download, `ons_resource_version.archive_uri` and
      `fetched_at` set, byte-for-byte assertion on the retained object
- [x] One `ingestion_run` row per task, through `runRecordedIngestion` — nothing
      new: the `manual`-tier bookkeeping data-platform 21 extracted
- [x] `/ingest/health` watches both, so the plant grain going quiet is visible
      while the entity grain still runs (`observability.ts`, thirteen sources).
      Measured live: both rows report their real row counts, `lagHours` and last
      successful run
- [x] `canonical_curtailment_by_plant` stops being the read with a null go-live,
      and the row is **derived, not seeded**: it equals
      `min(plant_detail_hour.ingested_at)` to the microsecond, and the read
      answers 0 rows under an `as_of` before that instant and all of them after

### What the source actually served — real ONS data, not a fixture

Two months of live ONS bytes, driven through `src/scripts/ingest.ts` against a
throwaway Postgres 17 on **port 5455** (never 5434), 47 migrations applied:

| task | bytes | rows parsed | rejected | plants | inserted | wall clock |
| --- | --- | --- | --- | --- | --- | --- |
| solar detail 2026-09 | 33.8 MB | 107,520 | 0 | 560 | 107,520 | 15–17 s |
| wind detail 2026-09 | 63.1 MB | 202,560 | 0 | 1,055 | 202,560 | 31–58 s |

**310,080 real rows over 9 days** (2026-09-01 03:00Z … 2026-09-09 02:00Z),
0 rejected and 0 modality/conjunto mismatches in either file. The
technology-dependent placement holds on real data: all 202,560 wind rows carry
`measured_wind_speed_ms` and no irradiance, all 107,520 solar rows the reverse,
with 11,020 and 16,433 rows respectively flagged invalid — so both boolean
dialects (`0.0`/`1.0` and `False`/`True`) parsed, and the documented-unit
correction landed in the m/s column on live bytes.

Idempotence, measured three ways on the same real month:

- **Re-run:** `changed: false, downloaded: false, inserted: 0`, 1.1 s — the
  `package_show` and one `HEAD`, no bytes.
- **Forced re-run** (`force: true`, so the "we hold the bytes" shortcut cannot
  hide anything): 107,520 rows re-parsed, `inserted: 0, revised: 0,
  unchanged: 107,520`. That is the versioned write being idempotent, not the
  fingerprint skipping the work.
- Custody deduplicated on the digest: the second download of identical bytes
  left `payload_custody` at one row, not two.

### The cost, before anyone schedules the history tier

The `_detail` files are the largest in scope: 63 MB for **nine days** of wind
against 244 MB for a full month, roughly 6× the entity-grain file of the same
month. A history pass at 2026-09 plans 80 plant-grain months (55 wind, 25
solar) and costs one `HEAD` each while nothing moves, but a real re-publication campaign now downloads that
6× as well. That is the trade this slice takes deliberately — the grains are
revised together, and detecting a campaign at one grain and missing it at the
other is worse.

### A live defect in the path this wires into — not fixed here

`bulk-resource.ts` calls `markResourceFetched` **before** the parse, so a month
whose parse throws is `alreadySeen` on the next pass and reports
`changed: false, inserted: 0`, exit 0, permanently. Data-platform 21 measured it
on DESSEM's 2025-07-19. Nothing here depends on that behaviour, and the design
deliberately does not lean on it: the idempotence claim above is proved with
`force: true`, which is the only probe that can tell "we stored this" from "we
downloaded this and threw it away". A sibling branch
(`dp-22-a-thrown-parse-retries`) owns the fix.

### Of the original boxes, what this slice can and cannot tick

- [x] Per-plant curtailment detail is ingested for both wind and solar — through
      the queue's own handler, on live ONS bytes, both technologies
- [x] Measured wind speed and irradiance are stored with their invalid-data
      flags — counted above on 310,080 real rows
- [x] The permanent difference in boolean encoding between the two technologies
      is handled — both real files parsed with 0 rejected rows and a non-zero
      invalid count each
- [x] No schema path exists by which a reason code can reach a plant row — three
      structural tests over the real catalogue (`database-plant-detail.test.ts`),
      run green against a migrated database
- [x] A documented unit that is dimensionally wrong at source is corrected on
      ingest, and the correction recorded — `MEASURED_WIND_SPEED_UNIT_CORRECTION`,
      and 202,560 real rows in `measured_wind_speed_ms`
- [ ] The asymmetry in available columns between entity and detail files is
      handled — unit-tested in `ons-constrained-off-detail.test.ts`; not
      separately measured here, so left for whoever verifies that file's claims
- [ ] Plant identity resolves consistently against the entity-grain data —
      **not verifiable in this run and honestly reported as such.**
      `reconcilePlantIdentity` returned `identityConflicts: 0` and
      `linkedRegistryPlants: 0`, but `reporting_entity` and `plant` were empty in
      this throwaway database, so both numbers are vacuous: the reconciliation
      had no input to disagree with. Ticking it needs the registry and the
      entity grain ingested into the same database first

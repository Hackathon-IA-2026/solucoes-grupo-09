# 18 — The DESSEM A/B, priced in MWh of promised floor

**What to build:** the three-run comparison that says whether DESSEM's features
are worth an evening publication time, expressed in the number the product
actually promises rather than in pinball loss.

Three runs on the shared fold calendar: the full-history free-feature run, the
short-window free-feature run, and the short-window augmented run. A run is
decision-grade in a fold only if its base-fit block — training block minus the
90-day calibration window — is at least 180 days, which qualifies **the last two
folds only**. So the verdict rests on two test quarters, roughly 150 target
days, and that is the honest sample size; it is stated rather than footnoted
because it is the single largest reason the answer might be wrong and nothing
can be done about it.

A six-month base fit cannot contain a full annual cycle, so the augmented run is
evaluated at a structural disadvantage. **That disadvantage must not be
attributed to DESSEM's features**: the short-window free run exists to absorb
it, so the augmented-minus-short contrast is clean and the
full-minus-short contrast prices the history separately.

**The unit of comparison is `Δ recovered_floor_mwh`**, both forecasts run
through the optimizer's simulator on the same days with the same fixed published
reference fleet, scored the way the optimizer spec specifies — because the other
side of the trade is eleven hours of operator notice and nobody can convert
hours into pinball loss.

The ruling to implement: ship DESSEM iff the augmented run's floor advantage
over the short-window free run, on the decision-grade folds, is positive under
the same paired block bootstrap the hot-swap gate uses, **and** the product
accepts the later publication for the DESSEM-conditioned view. Below the bar,
keep the DESSEM features as a monitored candidate re-run each quarter as the
window lengthens.

**Blocked by:** 09, 11 (the simulator path and the reference fleet).

**Status:** done (machinery, the verdict and now the runner); the three runs
are **one command away and still unrun** — the database in this environment is
migrated and empty, and no ONS history has been ingested into it. See "The run
was attempted" below for exactly what is missing.

- [ ] All three runs are scored on identical test rows on the shared calendar
- [x] Decision-grade folds are computed from the 180-day base-fit rule, not
      hardcoded, and non-decision-grade folds are reported but excluded from the
      verdict
- [ ] `Δ recovered_floor_mwh` is reported for both contrasts, with the reference
      fleet stamped
- [ ] The verdict is evaluated by the same paired block bootstrap the gate uses,
      and the sample size in target days is printed beside it
- [ ] The block lands in the card and is re-runnable each quarter without a code
      change

**Why exactly one box moved.** Box 2 is a property of the arithmetic and it is
now verified end to end against a real calendar rather than against a fixture's
fold list: `reportable_folds` derives F4, F5, F6 at 2026-09-09 and F4, F5, F6,
F7 at 2026-12-01 from the runs' own window starts, `SegmentRow` grades each of
them against `calendar.rules.min_base_fit_days`, and a source-level assertion
holds that no fold id is written in either module. F4 is deliberately *in* the
driver's sample and *out* of the verdict — 133 base-fit days against 180 — which
is the second half of the box, and a driver that had dropped F4 would have
satisfied the box by hiding the row. Boxes 1, 3 and 4 are measurements and there
is nothing to measure. Box 5 is half done and is left unticked: the writer
lands a real block on a real card through one command (today that block is the
`NOT_RUN_YET` one) and the quarterly derivation is asserted, but the block the
box means is the measured one.

## What was built

`apps/ml/src/wattsteer_ml/evaluation/dessem_ab.py`, in the shape 16 and 17 use:
figures → rows stamped with a `FoldSegment` → a provenance that is `.measured()`
or `.fixture()` → `card_block()` → `record_dessem_delta` editing one card
through the one reader and the one writer. Sixth provenance stamp
(`dessem_source`), no seventh idiom. `tests/test_dessem_ab.py` holds the five
boxes as five groups of properties.

- **The three runs are the matrix's**, taken from `MATRIX_RUN_BY_NAME` and never
  respelt, so A-common's window start is stated in exactly one place.
- **Two contrasts, not one.** `dessem_contribution` is `B-common − A-common` and
  is the ruling's; `history_price` is `A-full − A-common` and prices the window
  separately, which is what keeps the six-month base fit's handicap off DESSEM's
  account.
- **The unit is the simulator's floor.** `score_arm(day, SHIPPED_BASIS)` →
  `ScoredBand.recovered_floor_mwh`, on `PUBLISHED_FLEET`, summed over complete
  subsystem-days. There is no floor arithmetic in the new module. Replay 09's
  `floor_coverage` per subsystem is carried beside the MWh from the same hours,
  so a floor that grew while the share of days it held fell is visible.
- **The bootstrap is the gate's, not a copy of it.** `gate.py`'s resampling was
  extracted into `resample_day_blocks` over a `DayBlock`; `paired_block_bootstrap`
  is now the `qloss_mwh` statistic laid over it (reading `left_lower`) and the
  A/B is the floor statistic laid over it (reading `left_higher`), at the same
  `BOOTSTRAP_DRAWS`, `BOOTSTRAP_SEED` and `PROMOTION_PROBABILITY`. The gate's own
  38 tests pass unchanged, which is what says the extraction moved nothing.
- **Decision-grade folds are derived.** `Fold.base_fit_days_for(window_start) >=
  calendar.rules.min_base_fit_days`, for all three runs. No fold id appears in
  the module; a calendar materialised in 2027 grades F7 on its own arithmetic,
  which is the "re-runnable each quarter without a code change" box.
- **The verdict cannot ship anything.** `ShipVerdict.evidence_bar_met` is a
  statement about the bootstrap. The ruling's second conjunct — the product
  accepting a D−1 19:00 BRT publication — has no field, and nothing in the module
  imports `promotions`. The import graph also keeps it off the weekly retrain.

## Can the arms be run? Yes — and that is the difference from 16

16 built its A/B and then found the control arm's data is deliberately not
ingested. This one is not that case, and the check was made before the arms were
built rather than after: `dessem_augmented_v1`'s twenty-two `dessem_*` columns
exist in `feature_row` (migration 0025) and are computed by
`feature_dessem_block` from `dessem_balance_half_hour`, which
`apps/api/src/ingest/dessem-job.ts` fills from ONS's `balanco_dessem_detalhe`
from its coverage start of **2025-05-23** — exactly A-common's and B-common's
window start. So the honest absent value here is `NOT_RUN_YET` ("the three runs
have not been scored"), not 16's "the control arm has no data source", and the
two are deliberately different sentences.

What is still needed is a fold sweep against a migrated, ingested database:
`DessemScorer` is the seam, exactly as `SweepScorer` is in 17, because training
needs a database and LightGBM and neither belongs to the question the module
answers.

**The seam now has a caller** — `wattsteer_ml.dessem_ab_run` — so "needs a fold
sweep" has become "needs an ingested database", which is a shorter sentence and
somebody else's ticket. See the next section.

## The run was attempted. It is one command away and it did not run

The seam finally has a caller: `apps/ml/src/wattsteer_ml/dessem_ab_run.py`, the
sibling of `holdout_backfill.py` and built out of the same four pieces —
`read_lane_inputs`, `build_pool`, `train_fold`, `scored_hours` — so nothing
about training is restated for the A/B. `DatabaseArms` **is** the
`DessemScorer` rather than something that adapts to one: it fits once per
`(arm, fold)`, hands the segment's settled hours back, and the module already
here does all the judging. Three things are its own:

- **The arm is named, not derived from the lane.** A served lane has one arm, so
  the retrain recovers it from `lane.gate_profile`; the A/B has three at one
  gate and two of them share a lane, because a lane is
  `(feature_set, gate_profile, threshold_mw)` and a *window* is not part of it.
  So `read_lane_inputs` grew one optional `arm`, and it refuses an arm that
  disagrees with the lane about the feature set or the gate. The default path is
  byte-for-byte the retrain's, and `test_weekly_retrain.py` and
  `test_holdout_backfill_driver.py` pass unchanged (27 passed, 2 skipped).
- **Nothing is saved and nothing is promoted.** Twelve experiment arms are not
  twelve candidates: there is no `save_artifact` call, no `promotions.append`,
  and the only write is `record_dessem_delta` editing a card already on the
  volume. Asserted at source level, not described.
- **There is no `--fold`.** The sample is whatever the calendar makes
  scoreable, which is the "re-runnable each quarter" box; a flag that narrowed
  the folds could drop a decision-grade quarter and leave a weaker verdict
  looking like the same verdict.

The command, and it is the whole of it:

    docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
      -e POSTGRES_DB=wattsteer postgres:17-alpine
    cd apps/api && DATABASE_URL=postgres://postgres:wattsteer@localhost:5434/wattsteer \
      bun run db:migrate
    cd ../ml && uv run python -m wattsteer_ml.dessem_ab_run \
      --database-url postgres://postgres:wattsteer@localhost:5434/wattsteer \
      --root <artifact volume> --as-of 2026-09-09T00:00:00Z

That was run. All 43 migrations apply, the driver reaches Postgres, derives
`["F4", "F5", "F6"]` from the calendar, and stops where the data is:

    {"as_of": "2026-09-09T00:00:00Z", "folds_reportable": ["F4","F5","F6"],
     "arms_fitted": [], "measured": false,
     "not_run": "TrainingError: a booster cannot be fitted on an empty block", …}

Exit code 1, `dessem_source: unmeasured`, `reason: NOT_RUN_YET` on both lanes'
cards. **No arm was fabricated and no floor was invented.** The three runs are
still unscored and the two contrasts, the bootstrap and the verdict are still
absent figures rather than small ones.

### What is missing, precisely

Not a data *source* — 18's original finding stands, and the ONS mirror still
serves `Balanco_Dessem_Detalhe` daily resources through 2026-09-09. What is
missing is **the ingestion into this environment**. A freshly migrated database
holds 43 migrations, 112 `feature_dictionary_entry` rows, 2
`feature_set_definition` rows, 3 `feature_ab_configuration` rows — and **zero
rows in every observation table**: `curtailment_report_hour`,
`dessem_balance_half_hour`, `weather_forecast_hour`, `weather_run_request`,
`verified_load_half_hour`, `programmed_load_half_hour`,
`subsystem_exchange_hour`, `subsystem_energy_balance_hour`, `plant`,
`plant_geo`, `generating_unit`, `centroid_set`, `centroid_point`,
`reporting_entity`, `ons_resource_version`. `feature_rows` therefore returns
its spine with no label and the first booster has nothing to fit, which is the
sentence the run printed.

The window the three arms need is **2024-04-01 → 2026-09-08** — A-full's
base-fit start to F6's test end, 891 target days — of which the two common arms
need 2025-05-23 onward. Every canonical view the feature blocks read has to be
non-empty over it: `canonical_curtailment_by_reporting_entity` (the label),
`canonical_weather_forecast`, `canonical_day_ahead_balance` (the twenty-two
`dessem_*` columns), `canonical_programmed_load`, `canonical_system_exchange`,
`canonical_system_context`, `canonical_installed_capacity` and
`canonical_capacity_weight`. The jobs that fill them are all nine of
`IngestTask`: `constrained_off` (wind and solar, monthly, 2024-04 onward),
`dessem_balance` (daily from `DESSEM_COVERAGE_START` = 2025-05-23, ~475 files),
`weather` (one Open-Meteo Single-Runs call per target day, ~890 of them),
`load`, `daily_load`, `interchange`, `energy_balance`, `plant_registry` and
`siga`.

**The weather backfill is the long pole and it is designed to be.** `planRefresh`
takes `WEATHER_HISTORY_SLICE_DAYS = 90` per history pass over a bounded archive
starting 2024-03-15, so the window above is roughly ten monthly passes, and the
transport's own measurement is 20 locations × 12 variables ≈ 84 KB / 10.5 s per
call. That is hours of ingestion at best and is a data-platform run, not a
change here. **It is the only thing standing between this ticket and its other
four boxes.**

### One thing found on the way, in another lane

`0041_the_gate_as_a_table_constraint.sql` (api-surface 10) added
`curtailment_forecast_hour_published_at_is_the_gate`, and
`apps/ml/tests/database_harness.py`'s `seed_publication` computes
`published_at` as local midnight − 5 h regardless of `gate_profile`. Every
`gate_early` seed now violates the constraint:
`tests/test_database_replay_reads.py::test_another_lane_is_not_this_lane_and_is_reported_as_a_candidate`
fails against a freshly migrated database. Neither file is touched by this ticket
(the branch changes three source files, none of them on that test's path) and
the constraint arrives with the base, so this belongs to the merge rather than
to the branch. Recorded rather than fixed: the harness belongs to whichever
lane owns `0041`.

## Two things in the spec that are not right

1. **"Eleven hours of operator notice" is ten.** The spec says eleven in five
   places and `+11 h` in its decision table. `gate_at` — the authority, in
   `apps/api/drizzle/0016_the_feature_gate.sql` — puts `gate_early` at D−1 09:00
   BRT and `gate_late` at D−1 19:00 BRT, which is ten. No number was written into
   Python either way: the block's `operator_notice` field names `gate_at` and its
   two instants and converts nothing, because the whole point of pricing this in
   MWh is that nobody can convert hours into floor. **The spec's prose should be
   corrected to ten, or `gate_at` moved** — they cannot both be right.
2. **The ruling names F5–F6 by id.** The fold arithmetic that produces them is
   also in the spec and is what was implemented; the ids are a derived fact and
   are already stale-able (F7 opens 2026-10-01). Nothing was hardcoded.

Also corrected: `matrix.py`'s docstring still said `dessem_augmented_v1` "has no
columns of its own yet", which stopped being true at migration 0025 and is
exactly the claim this ticket turns on.

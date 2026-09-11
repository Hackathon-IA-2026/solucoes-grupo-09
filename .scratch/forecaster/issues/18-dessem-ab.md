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

**Status:** done, and **run twice**. The ruling is unchanged and is **do not
ship DESSEM**. On the second run — a later pin of the same shared database, with
the whole A/B made tractable first — `B-common − A-common = −7,915.5 MWh` of
promised floor over **70 target days** on F6, `P(treatment better) = 0.000`
under the gate's paired block bootstrap against a bar of 0.9.

The verdict still rests on **one** decision-grade fold and not two, and the
reason **moved**: on the first pin `A-full` refused F4 and F5, and on the second
`A-full` fits F5 while **`A-common`** refuses it. Both refusals are
`derive_risk_bins`, both were reproduced through the direct read path as well as
the materialised one, and each fold that could not be scored is named with its
arm and its arithmetic rather than dropped. Every arm remains largely
weather-blind over F6's test period (8 of 70 days now carry a weather value,
against 1 on the first pin), which is recorded beside the figures rather than
around them. See "The run" and "The second run" below.

- [ ] All three runs are scored on identical test rows on the shared calendar
- [x] Decision-grade folds are computed from the 180-day base-fit rule, not
      hardcoded, and non-decision-grade folds are reported but excluded from the
      verdict
- [x] `Δ recovered_floor_mwh` is reported for both contrasts, with the reference
      fleet stamped
- [x] The verdict is evaluated by the same paired block bootstrap the gate uses,
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

**Which boxes moved on the run, and why the other two did not.** Boxes 3 and 4
are now measured and ticked: both contrasts are published with the reference
fleet's hash on them, and the verdict is `FloorBootstrap` over the gate's own
`resample_day_blocks` at its draws and its seed, with the sample size in target
days printed in the verdict's own sentence. **Box 1 stays open**, and it is the
one the run failed rather than passed: three arms were scored on identical rows
— asserted by digest and pairwise against the labels — on **one** of the three
reportable folds, because `A-full`'s calibration is refused on the other two.
The discipline held everywhere it was exercised; the completeness the box asks
for did not. **Box 5 stays open** too: the quarterly derivation is asserted and
the command is one command, but neither A/B lane has a promoted artifact on this
database — the served evening lane's own arm *is* `A-full` — so there is no card
for the block to be an edit of, and `record_dessem_delta` mints none.

## A second decision-grade fold was available all along — measured 2026-09-11

The verdict above rests on **one** decision-grade fold, and this ticket has
said so honestly. The reason turns out not to be the data.

Asked of the calendar's own arithmetic, with no run and no database:

```
min_base_fit_days = 180        arms: A-full, A-common, B-common

as_of 2026-09-11   reportable F4, F5, F6
  F4   base-fit days per arm  A-full 550 · A-common 133 · B-common 133  -> excluded
  F5                          A-full 640 · A-common 223 · B-common 223  -> DECISION-GRADE
  F6                          A-full 731 · A-common 314 · B-common 314  -> DECISION-GRADE
```

**F5 and F6 both clear the rule for all three arms, and did on the day the run
was made.** The single-fold verdict is an artefact of the run being stopped
part-way — the coordinator killed it while a further arm was still scoring,
believing it hung; it was in fact inside a single `feature_rows` call, which
forecaster 32 later measured at 58.4 s per 17,376 rows on real data. The run
committed what it had.

So `B-common − A-common = −5,845.5 MWh` at `P(treatment better) = 0.001` is a
one-fold result that **could be a two-fold result today**, with no new
ingestion, no decision and no key. That is the cheapest remaining strengthening
of any figure in this repository.

> **Correction, from the second run below.** The arithmetic here is right and
> this conclusion is wrong. F5 is decision-grade for all three arms, and being
> decision-grade is not the same as being *fittable*: the re-run scored F5 and
> `derive_risk_bins` refused it — for `A-common` this time rather than `A-full`
> — so the verdict still rests on one fold. The strengthening was cheap and was
> worth taking; what it bought was a 10-minute observable run, arms that are one
> dataset by construction, and the ruling's sign confirmed on a second pin. It
> did not buy a second fold. See "The second run".

The calendar also dates the rest: F7 becomes decision-grade around 2026-12-01,
F8 around 2027-03-01, F9 around 2027-06-01 — one per quarter, which is what the
ticket's "re-runnable each quarter without a code change" box is for.

**The re-run should materialise `feature_rows` once per window rather than once
per arm.** Three arms over one calendar currently pay for the same rows three
times, which is why the first attempt looked hung.

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
change here. **It was believed to be the only thing standing between this ticket
and the rest of its boxes.** It was not: the ONS half of the backfill was enough
to score two of the three arms and to take the ruling, and what the weather half
turned out to cost is not a box but the *meaning* of the floors — see "The run"
below.

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

---

# The run

The three arms were finally scored. Data-platform 21 backfilled the shared wave
database (`fc18-pg`, port 5434, 43 migrations) and this is what came out of it.
Everything below is measured; the arms that could not be scored are named rather
than filled in, and every figure carries the sample behind it.

## It was not scored against the shared database, and that is deliberate

The shared database **was being written while this ran**.
`weather_forecast_hour` went 667,757 rows over 275 local dates at 20:14 Z, to
826,939 over 341 at 20:32 Z, to 829,637 over 342 at 20:33 Z, with
`max(ingested_at)` twenty-three seconds before the query: data-platform 21's
weather pass is still walking forward through the window an hour of quota at a
time.

That is not a nuisance, it is a correctness problem for *this* ticket, and it is
worth stating because nothing in the code would have caught it.
`feature_as_of(target_date, gate_profile)` returns `'infinity'` — **no ingestion
cut** — whenever the gate precedes `feature_ingestion_history_from()`, which is
every target day of this window. So a feature row carries every source row
ingested up to the instant of the query. `DatabaseArms._read` opens one
connection per `(arm, fold)`, so three arms read minutes apart read three
different databases — and `assert_identical_test_rows` compares row **keys**, so
it would have passed with the three arms holding different weather. An A/B
against a database under concurrent ingestion is not reproducible, and its arms
are not one dataset.

So the arms were scored against a **pinned copy**: `pg_dump -Fc` taken
2026-09-10T20:34–20:36 Z and restored into this session's own container on port
5435. `fc18-pg` was read and never written; nothing here ran `ml:test:db`. The
pinned copy holds `curtailment_report_hour` 4,765,728; `dessem_balance_half_hour`
69,888 over 364 local dates; `weather_forecast_hour` 829,637 over 342;
`verified_load_half_hour` 171,072; `programmed_load_half_hour` 171,076;
`subsystem_energy_balance_hour` 94,272; `subsystem_exchange_hour` 94,272;
`plant` 1,621; `generating_unit` 3,385; `centroid_point` **2**; 43 migrations.

## What was scoreable, established before anything was scored

| block | days | DESSEM days | weather days |
|---|---|---|---|
| F4 base (common) 2025-05-23..2025-10-02 | 133 | 114 | 75 |
| F4 calibration 2025-10-03..2025-12-31 | 90 | 38 | 31 |
| F4 test 2026-01-01..2026-03-31 | 90 | 61 | 24 |
| F5 base (common) 2025-05-23..2025-12-31 | 223 | 152 | 106 |
| F5 calibration 2026-01-01..2026-03-31 | 90 | 61 | 24 |
| **F5 test 2026-04-01..2026-06-30** | 91 | 86 | **0** |
| F6 base (common) 2025-05-23..2026-04-01 | 314 | 214 | 130 |
| **F6 calibration 2026-04-02..2026-06-30** | 90 | 85 | **0** |
| **F6 test 2026-07-01..2026-09-08** | 70 | 64 | **1** |

The label and the day-ahead programme cover every block completely.
`feature_rows` returns 8,736 rows for F5's test period, all 8,736 labelled, and
**0 of 8,736 carry a weather value** — at `dessem_free_v1` and
`dessem_augmented_v1` alike. Prevalence at 5 MW, measured: F1 test 0.3601, F2
0.4392, F3 0.4190, F4 0.2714, F5 0.3629, F6 0.4763.

**So the decision-grade folds — the only ones a verdict may rest on — have no
weather in their test periods at all.** All three arms are
`weather_arm = "lead_matched"` and the weather block is twenty-odd of the model
inputs, so what was scored is not the arm the matrix defines. The arms are
equally blind, so the *pairing* is intact and the contrast is still a contrast;
what is not available is the claim that these floors are the floors the product
would see. It is stated here, in the Status line, and beside the figures, and it
is the first thing to re-check when the weather backfill finishes.

Two things stand behind every weather feature and belong beside that count:
`centroid_point` holds **2** rows — the harness `centroid_set_v1` data-platform
21 found frozen in this database, which is immutable by design — so
`canonical_capacity_weight` answers over two clusters instead of nineteen, and
`weather_centroid_coverage` is 0 on these rows.

## `A-full` cannot be fitted on this database, and that is a measurement

Every arm was attempted on every reportable fold. `A-full` refused on F4 and F5,
before any floor existed, from `derive_risk_bins`:

    RiskBinsUndeterminedError: no split of this pool on the 0.05 grid satisfies
    both (a) and (b)

with its own pool's arithmetic each time — on F4 "(a) low predicts 0.284 against
an observed 0.344, a gap of 0.060 above 0.05; (b) elevated and high observe
0.977 and 0.978, 0.001 apart against a combined 95% half-width of 0.062"; on F5
"0.284 against 0.340 … 0.981 and 0.991, 0.009 apart". Two pools, two different
failures, one conclusion: on this data the full-history arm's occurrence
classifier admits **no three-class risk split** that is both calibrated within
0.05 and separated beyond its own confidence intervals, and `train_fold` refuses
the artifact rather than publishing edges nobody measured. Reproduced
identically against the live database and the pinned copy.

That refusal is correct and it is not this ticket's to relax. `risk_bins` is a
published product surface — `nothing_to_explain` withholds narration below the
lowest edge — and loosening a refusal in order to obtain a floor figure is the
one trade this repository exists to refuse.

`A-full` **did** fit on F6, the newest fold and the one with the longest history
behind it, so F6 carries all three arms and is the only fold that does. Worth
recording: the same refusal is the *served* evening lane's, because `LANE_RUNS`
maps `gate_late` to `A-full` — which is why neither A/B lane has a promoted
artifact on this database, and therefore why the measured block has no card to
be an edit of.

## The figures

One three-arm segment, F6, `revision_optimistic` (this database has no
`canonical_forecast_hour` go-live, so nothing splits a fold), 6,720 rows, 280
complete subsystem-days over 70 target days, none excluded. Base fits: `A-full`
731 days, `A-common` 314, `B-common` 314 — decision-grade for all three against
the calendar's 180. Reference fleet
`sha256:119036fb1f9d198a48f3c8839f0e7a74483cad19f01dba6a9a7a2d48db295228`,
planning basis `p50`, calendar rules
`sha256:c8d615f68184e0907a352316336c0512bf21e8eb5ae3ff08912687500812e214`.

| arm | recovered_floor_mwh | floor_baseline_mwh | qloss_mwh | share_p10_forced_zero |
|---|---|---|---|---|
| `A-full` | 32,533.6 | 2,108,945.2 | 315.2 | 0.7836 |
| `A-common` | 39,416.2 | 2,865,920.4 | 323.6 | 0.7366 |
| `B-common` | 33,570.7 | 2,617,250.9 | 303.2 | 0.7899 |

- **`dessem_contribution` = B-common − A-common = −5,845.5 MWh** over **70
  target days** (280 subsystem-days). `P(treatment better) = 0.001` at 2,000
  draws, seed 20260913, against the bar of 0.9. **Not met.**
- **`history_price` = A-full − A-common = −6,882.7 MWh** over the same 70 target
  days. `P = 0.000`. **Not met** — on this database the full-history arm is
  *worse* than the fifteen-month one, which is consistent with the calibration
  trouble that refused it on the two older folds, and is exactly why this
  contrast is published rather than assumed.

**Read `share_p10_forced_zero` before the floor.** The mixture caveat the block
carries is doing real work here: `B-common` forces the composed P10 to zero in
79.0% of hours against `A-common`'s 73.7%, so much of its floor deficit is its
classifier being *less* confident rather than its magnitude head being worse —
and its `qloss_mwh` is the **best** of the three (303.2 against 323.6). The two
currencies disagree, which is precisely the situation the spec refuses to settle
in pinball loss.

### The ruling's contrast on the wider sample, as an explicit partial

The module refuses a two-arm A/B by design, and rightly: `A-common` is what
keeps the short-window handicap off DESSEM's account and `A-full` is what prices
the window. But the *ruling* names only `B-common` against `A-common`, and both
of those fit on every reportable fold. So the same contrast was computed over
the wider sample through the module's own types — `RunFloor.of`, the
row-identity digest, `assert_paired_hours`, `FloorBootstrap.of` — and it is
recorded here as a partial rather than on the card, because the card's block is
the three-arm one:

| fold | decision-grade | Δ recovered_floor_mwh | P(B better) | target days |
|---|---|---|---|---|
| F4 | no (133 base-fit days) | −2,948.5 | 0.134 | 90 |
| F5 | yes (223) | **+1,500.1** | 0.744 | 91 |
| F6 | yes (314) | −5,845.5 | 0.001 | 70 |
| **F5 + F6 pooled** | — | **−4,345.5** | **0.059** | **161** |

161 target days, 644 subsystem-days: 111.7 MWh of floor per subsystem-day for
`B-common` against 118.5 for `A-common`. F5 is the one fold where DESSEM is
ahead, and it does not clear the bar either. The two samples agree on the sign
and on the verdict, which is the useful thing about having both.

## The ruling

**Do not ship DESSEM.** The first conjunct fails on both samples — the block's
own verdict (F6, 70 target days, P = 0.001) and the wider two-arm partial
(F5+F6, 161 target days, P = 0.059) — against a bar of 0.9, with a negative
delta in each. The second conjunct, that the product accepts a D−1 19:00 BRT
publication for the DESSEM-conditioned view, was therefore never reached; it has
no field here and this block cannot record it.

So the spec's fallback applies as written: the `dessem_*` features stay a
**monitored candidate, re-run each quarter as the window lengthens**, and the
served evening view stays the free-feature run. Two things would make the next
run worth more than this one, and both are somebody else's ticket rather than a
reason to discount this one: the weather backfill finishing, so the arms are the
arms the matrix defines; and `A-full` becoming fittable, without which the
verdict rests on one quarter and `history_price` cannot be read on the wider
sample.

## Two defects the run found in this ticket's own work

**1. Every arm was unfittable, and the empty-database run stopped one step short
of finding out.** `DatabaseArms.fit` passed
`artifact_id=f"dessem-ab-{run.name}-{fold_id}"` to `train_fold`, which composes a
`ModelCard`, whose `__post_init__` refuses any id that is not an ISO-8601 UTC
instant. So **every arm whose calibration succeeded died on `BundleError`** —
which is not one of `DATA_FAILURES` and would have propagated as the fault it
was. What hid it is the loop's order: the first arm of the first fold is
`A-full`, and on this database `A-full` refuses for a data reason before the id
is ever reached. The tests around the driver never reached it either — they drive
the seam with a fixture scorer, and only a real fit composes a card. Now
`DatabaseArms.arm_artifact_id`: the run's own instant, shared by all twelve
unsaved fits, with the `(arm, fold)` identity left where it already lives. A test
asserts it against `is_artifact_id` rather than against a literal.

**2. One refusing arm-fold took the whole A/B with it.** With the id fixed, the
run still produced `NOT_RUN_YET`, because `A-full`'s refusal on F4 aborted every
fold — including F6, which was complete and decision-grade. That is
data-platform 21's DESSEM-ingestor finding in another shape: one bad day took the
whole task with it. `_scoreable_segments` now isolates `DATA_FAILURES` per
segment, and **every refusal is carried** — in
`DessemAbRunReport.segments_refused` and on the block as `folds_not_scored` —
because a verdict published beside no statement of what was excluded is the
acceptance box satisfied by hiding a row. A database that cannot answer at all
still ends the run, unchanged.

`gate.py` was not touched. Its own tests pass unchanged (39), and the full ML
suite is 1,756 passed / 93 skipped against a baseline of 1,753 / 93 — the three
new tests are the artifact id, the per-segment isolation, and
`folds_not_scored` on the block.

## What this ticket said that turned out to be wrong

1. **"The window the three arms need is 2024-04-01 → 2026-09-08, 891 days, of
   which the two common arms need 2025-05-23 onward."** The days exist; the
   DESSEM series over them does not. 475 reference days lie between 2025-05-23
   and 2026-09-09 and this database holds **364**, each with a full 48 patamares
   over four subsystems, with 111 absent. Data-platform 21's forced per-day
   census puts the loadable count at 370 — 68 files re-published after the day
   they forecast, 34 short civil days, 3 with solar in the local night — so the
   database is six days short even of its own census. The common arms' window is
   not a window but a series with holes in it: 152 of 223 days in F5's base fit,
   214 of 314 in F6's, 86 of 91 and 64 of 70 in the two decision-grade test
   periods.
2. **"There is no missing data source here and therefore no named unmeasured
   reason of ticket 16's kind."** True of DESSEM and false of weather. Weather is
   a source this environment does not have where it matters: 0 of 91 days in
   F5's test period, 0 of 90 in F6's calibration window, 1 of 70 in F6's test
   period. `NOT_RUN_YET` was the right sentence for an empty database and is not
   the right sentence for this one, and the honest reason here is neither of the
   two the module has.
3. **"The three runs are one command away."** They were two commands and a code
   fix away, twice over — see the two defects above. The ticket could not have
   known, because the arm that refuses first refuses for a data reason.
4. **"So the verdict rests on two test quarters, roughly 150 target days."** The
   arithmetic is 161 (F5's 91 plus F6's 70 at this `as_of`), and what the verdict
   actually rests on is **70** — one quarter — because `A-full` is unfittable in
   the other. The sample is smaller than the ticket's own worst case, and the
   ticket was right that it is the single largest reason the answer might be
   wrong.
5. **The spec's `P ≥ 0.9` on F5–F6 is unreachable on this database as things
   stand**, and the fold ids in the spec's ruling are stale in a second way now:
   not merely because F7 opens, but because a named fold can turn out to be
   unfittable for one arm. The derived arithmetic is still right; the ids were
   never the authority.

## How to re-run it

    docker run -d --name fc18-snap -p 5435:5432 -e POSTGRES_PASSWORD=wattsteer \
      -e POSTGRES_DB=wattsteer postgres:17-alpine
    docker exec fc18-pg pg_dump -U postgres -Fc --no-owner wattsteer > snap.dump
    docker exec -i fc18-snap pg_restore -U postgres -d wattsteer --no-owner < snap.dump
    cd apps/ml && uv run python -m wattsteer_ml.dessem_ab_run \
      --database-url postgres://postgres:wattsteer@localhost:5435/wattsteer \
      --root <artifact volume> --as-of 2026-09-09T00:00:00Z

The pinning is the point and not a detail: run it against a database being
ingested and the three arms are three datasets. It costs about an hour of wall
clock, nearly all of it in `feature_rows` — the `A-full` window measures 4m43s
per read.

---

# The second run — the cheapest strengthening, and what it actually bought

The first run's verdict rested on one decision-grade fold, and the section "A
second decision-grade fold was available all along" showed the reason was not
the data: F5 and F6 both clear the 180-day rule for all three arms, and did on
the day the first run was made. That run was stopped part-way inside a single
`feature_rows` call. So the A/B was made tractable and re-run, at the **same**
`as_of` — 2026-09-09T00:00:00Z, the first run's own instant, so F6 is a
reproduction and F5 the addition rather than a new question.

**What it bought is not a second fold.** F5 still cannot be scored with three
arms — and on this pin it cannot be scored with *two* either, because the arm
that refuses is now `A-common`, which is the **control of both contrasts**. The
ruling is unchanged and is better supported than before only in the sense that
the database underneath it is better ingested. That is the honest summary and
the rest of this section is its arithmetic.

## Made tractable first, because that is why it looked hung

`feature_rows` measures at 58.4 s per 17,376 rows on real data (forecaster 32)
and this driver called it **once per `(arm, fold)`**: nine reads, of which only
two were distinct windows, inside a loop that printed nothing.

`plan_windows` now derives, from the arms' own window starts and the folds' own
test ends, the smallest set of reads that covers every `(arm, fold)` pair. It is
**two**, and both halves of that are arithmetic rather than a guess: every fold
of one arm opens on that arm's window start and differs only in where the test
block ends, so the widest fold's span contains all of them; and `A-full` and
`A-common` differ only in *window start*, for which the feature function has no
parameter, so `A-full`'s span contains `A-common`'s and one read serves both.
`MaterialisedFeatureRows` carries the rows with the four arguments they were
read under, `read_lane_inputs` grew one optional `rows` and slices what it is
handed, and the driver's `DatabaseArms.materialise` makes both reads before any
arm is fitted. Measured on this pin:

```
dessem_augmented_v1@gate_late  2025-05-23..2026-09-08   45,504 rows   2m40s
dessem_free_v1@gate_late       2024-04-01..2026-09-08   85,536 rows   4m36s
```

131,040 rows in **7m16s**, against the 4,824 arm-fold-days — roughly 463,000
rows — the nine-read path would have asked for. Nine fits then took **2m46s**,
because the read was the whole of the cost: `A-full@F6` fits in 31 s once its
85,536 rows are already in hand. **The run took 10m03s end to end and exited 0.**
The measurement the first attempt was killed over was 93 minutes.

It is one path and not two. The materialised rows are an *argument* to the
function that otherwise reads them itself, so the arms are composed exactly as
the weekly retrain composes them, and `rows=None` is still the retrain's and the
holdout backfill's byte-for-byte behaviour (`test_weekly_retrain.py` and
`test_holdout_backfill_driver.py` pass unchanged).

**It is also the stronger discipline and not only the faster one.** The old path
opened a connection per `(arm, fold)`, so against a database under concurrent
ingestion three arms read minutes apart saw three databases — and
`assert_identical_test_rows` compares row *keys*, so it would have passed. One
read is one dataset by construction, which is the thing the first run had to
take a manual `pg_dump` to obtain.

## The equivalence was proved, not assumed

That a `feature_rows` row is a function of its own target date and **not** of
the range bounds it was asked for is a statement about SQL this service does not
own — `feature_rows` lives in the API's migration tree. So it is checked three
ways and none of them is a row count:

1. **Every run, on every window.** `MaterialisedFeatureRows.agrees_with_a_direct_read`
   re-reads the last `EQUIVALENCE_PROBE_DAYS = 14` of each span through the
   ordinary path and compares the rows **whole and in order**, values and all. A
   disagreement raises `MaterialisationError` — which is deliberately *not* one
   of `DATA_FAILURES` — before an arm is fitted. Both windows passed, and each
   window's span, row count and probe range are on the report and on the block.
2. **At full fold scale, and through the fit.** `A-common@F5`'s own window was
   read directly (`rows=None`, the nine-read path) and compared to the slice of
   the materialised free window. Identical, whole and in order, for **all three**
   of that arm's pool folds — F3 21,408 rows, F4 30,048, F5 38,784 — and both
   paths then refused `derive_risk_bins` with the byte-identical message. That
   is what says the refusal below is the database's and not this change's.
3. **As a test.** `test_the_materialised_window_is_what_a_direct_read_returns`
   does (1) against real Postgres and is skipped without a database; four
   further tests pin the slicing rule, the refusal of a window too narrow for
   the fold it is asked for, the refusal of rows read under another feature
   function, and the refusal of a probe outside the window.

The narration is a property now, not a courtesy: one timestamped line per window
and per arm per fold, on **stderr** so the one JSON report on stdout stays
parseable, flushed, and asserted —
`test_the_run_narrates_every_arm_and_fold_with_an_instant`.

## The pin, and why it is not the first run's pin

`fc18-pg` is still being written — it is the shared wave database and
data-platform's weather pass has kept walking forward. It was read and never
written, nothing here ran `ml:test:db`, and the arms were scored against a
`pg_dump -Fc` taken **2026-09-11T01:19 Z** and restored into this session's own
container on port **5450**, removed afterwards. That pin is **not** the first
run's, and the difference matters enough to tabulate:

| | first run's pin (2026-09-10T20:34 Z) | this pin (2026-09-11T01:19 Z) |
|---|---|---|
| migrations | 43 | **49** |
| `curtailment_report_hour` | 4,765,728 | 4,782,883 |
| `dessem_balance_half_hour` | 69,888 | 70,080 |
| `weather_forecast_hour` | 829,637 | **1,417,839** |
| `centroid_point` | 2 | 2 |
| weather days in F5 test | **0** of 91 | **81** of 91 |
| weather days in F6 calibration | **0** of 90 | **80** of 90 |
| weather days in F6 test | **1** of 70 | **8** of 70 |

So F6's figures are **not** expected to reproduce −5,845.5 and do not, and this
is not a second measurement of the same thing. It is the same question asked of a
materially better-ingested database, at the same `as_of`, and the two answers
agree on the sign and on the verdict.

## What was scoreable, and the refusal that moved

All three arms were attempted on all three reportable folds — `["F4","F5","F6"]`,
derived, no fold id written — and seven of the nine `(arm, fold)` pairs fitted:

```
arms_fitted  A-common@F4  A-common@F6  A-full@F5  A-full@F6
             B-common@F4  B-common@F5  B-common@F6
```

- **F4 is refused by `A-full`** — `RiskBinsUndeterminedError`, the closest split
  on the 0.05 grid being (0.5, 0.85), which fails because low predicts 0.070
  against an observed 0.121, a gap of 0.051 above 0.05. F4 decides nothing
  anyway: 133 base-fit days against 180.
- **F5 is refused by `A-common`** — the same class, closest split (0.45, 0.9),
  low predicting 0.080 against an observed 0.139, a gap of 0.060. **This is the
  finding.** On the first pin `A-common` fitted every reportable fold and
  `A-full` refused F4 and F5; on this pin `A-full` has become fittable on F5 and
  `A-common` has stopped being. The arm that refuses has swapped, and because
  `A-common` is the control of *both* contrasts, F5 is now unscoreable for the
  ruling's contrast as well as for the three-arm block — where on the first pin
  it was scoreable as a two-arm partial and gave +1,500.1 MWh.
- **F6 carries all three arms** and is the only fold that does, exactly as on the
  first pin.

The refusal is the published-surface refusal `risk_bins` is entitled to make and
it is not this ticket's to relax. It is recorded on the block as
`folds_not_scored` and in the report as `segments_refused`, each naming the arm
and carrying its own pool's arithmetic.

## The figures

One three-arm segment, F6, `revision_optimistic` (this database still has no
`canonical_forecast_hour` go-live, so nothing splits a fold), 6,720 rows, 280
complete subsystem-days over 70 target days, none excluded. Base fits `A-full`
731 days, `A-common` 314, `B-common` 314 — decision-grade for all three against
the calendar's 180. Reference fleet
`sha256:119036fb1f9d198a48f3c8839f0e7a74483cad19f01dba6a9a7a2d48db295228`,
planning basis `p50`, calendar rules
`sha256:c8d615f68184e0907a352316336c0512bf21e8eb5ae3ff08912687500812e214`, row
digest `sha256:811e405a75ec7a06e7e122ed280162268a0d1b5f52e8fa245c3d6dffbdc75ab5`.

| arm | recovered_floor_mwh | floor_baseline_mwh | qloss_mwh | share_p10_forced_zero |
|---|---|---|---|---|
| `A-full` | 37,716.6 | 4,007,837.9 | 321.3 | 0.7372 |
| `A-common` | 41,977.1 | 2,342,250.8 | 324.1 | 0.7635 |
| `B-common` | 34,061.6 | 2,851,537.6 | 305.8 | 0.7738 |

**Both contrasts, per fold and pooled**, with the sample size in target days
beside each. The three-arm block's own verdict is the F6 row, because it is the
only decision-grade fold that carries three arms; the pooled row is the ruling's
contrast over every fold that carries **its** two arms, computed through the
module's own types — `RunFloor.of`, `assert_paired_hours`, `FloorBootstrap.of` —
and recorded here as an explicit partial rather than on the card:

| fold | decision-grade | `dessem_contribution` | P(B better) | `history_price` | P(A-full better) | target days |
|---|---|---|---|---|---|---|
| F4 | no (133 base-fit days) | **+1,072.7** | 0.641 | — `A-full` refused | — | 90 |
| F5 | yes (223) | — `A-common` refused | — | — `A-common` refused | — | 91 |
| F6 | yes (314) | **−7,915.5** | **0.000** | **−4,260.5** | 0.005 | **70** |
| **F4 + F6 pooled** | — | **−6,842.8** | **0.018** | not computable | — | **160** |

- **`dessem_contribution` = B-common − A-common = −7,915.5 MWh** over **70
  target days** (280 subsystem-days), `P(treatment better) = 0.000` at 2,000
  draws, seed 20260913, against the bar of 0.9. **Not met.** 121.6 MWh of floor
  per subsystem-day for `B-common` against `A-common`'s 149.9.
- **`history_price` = A-full − A-common = −4,260.5 MWh** over the same 70 days,
  `P = 0.005`. **Not met** — the full-history arm is still *worse* than the
  fifteen-month one here, by less than on the first pin (−6,882.7), and it is
  published rather than assumed for exactly this reason.
- **The pooled partial adds 90 target days and does not change the sign.**
  F4 is where DESSEM is ahead and it clears nothing; pooled over the 160 days
  the two arms share, the contrast is −6,842.8 MWh at P = 0.018, which is
  further from the bar than the first pin's F5+F6 partial (−4,345.5 at 0.059)
  and agrees with it.

**Read `share_p10_forced_zero` before the floor**, as on the first run and for
the same reason: `B-common` forces the composed P10 to zero in 77.4% of hours
against `A-common`'s 76.3%, and its `qloss_mwh` is again the **best** of the
three (305.8 against 324.1). The two currencies still disagree, which is
precisely what the spec refuses to settle in pinball loss. `floor_coverage`
moves with the floor and not against it: `A-common` holds its promise on 58 of
70 SE days, `B-common` on 59, `A-full` on 63.

## The ruling, unchanged

**Do not ship DESSEM.** The first conjunct fails on both samples this pin can
offer — the block's own verdict (F6, 70 target days, P = 0.000) and the wider
two-arm partial (F4+F6, 160 target days, P = 0.018) — against a bar of 0.9, with
a negative delta in each. It failed on both samples the first pin could offer
too, at −5,845.5 / P = 0.001 and −4,345.5 / P = 0.059. Four samples over two
pins, one sign. The second conjunct, that the product accepts a D−1 19:00 BRT
publication, was again never reached and has no field here.

So the spec's fallback applies as written and for the second time: the `dessem_*`
features stay a **monitored candidate, re-run each quarter as the window
lengthens**, and the served evening view stays the free-feature run.

## What this attempt set out to do and did not

**The two-fold verdict is still not available, and the reason is no longer the
one this ticket named.** "A second decision-grade fold was available all along"
was right about the calendar and wrong about the conclusion it drew: F5 *is*
decision-grade for all three arms by the 180-day rule, and being decision-grade
is not the same as being fittable. On the first pin F5 lost `A-full`; on this one
it loses `A-common`. A named fold can turn out to be unfittable for one arm, and
which arm it is moves with the ingestion — so the sample the verdict rests on is
a property of the database on the day, not of the calendar, and the calendar
cannot promise it.

What the work did buy, and it is worth having:

- the run is **10 minutes and observable**, so no future attempt is killed for
  silence, and the quarterly re-run is now cheap enough to be routine;
- the arms are **one dataset by construction** rather than by a hand-taken dump;
- `A-full` fits F5 on this pin, so `history_price` is one fold from being
  readable on a wider sample — the first thing to re-check next quarter;
- the sign of the ruling's contrast has now been taken on four samples across
  two pins of the database and has not changed.

**Two things would still make the next run worth more than this one**, both
somebody else's ticket: the weather backfill finishing (F6's test period is 8 of
70 days, so these floors are still not the floors the product would see); and
whatever makes `derive_risk_bins` determinable for the common-window arms,
without which the sample is one quarter and which arm is missing is a lottery.

## Which boxes moved, and the three that did not

Boxes 3 and 4 were already measured and stay ticked: both contrasts are
published per fold and pooled with the reference fleet's hash on them, and the
verdict is `FloorBootstrap` over `gate.py`'s own `resample_day_blocks` at its
`BOOTSTRAP_DRAWS = 2000`, its `BOOTSTRAP_SEED = 20260913` and its
`PROMOTION_PROBABILITY = 0.9`, with the sample size in target days printed in
the verdict's own sentence. `gate.py` was not touched; its own tests pass
unchanged.

**Box 1 stays open**, and it is the box this attempt was for. Three arms were
scored on identical test rows — asserted by digest and pairwise against the
labels, and now also proved equal to a direct read, whole, at full fold scale —
on **one** of the three reportable folds. The discipline held everywhere it was
exercised and the completeness the box asks for still does not hold.

**Box 5 stays open.** The block did land on both lanes' cards, measured, through
one command, and the folds are still derived — but the card it landed on was
named with `--artifact-id` against a volume seeded for the run, because neither
A/B lane has a promoted artifact on this database (`LANE_RUNS` maps `gate_late`
to `A-full`, which is fittable on F5 and F6 here but was not promoted). The box
means a block that is an edit of a card the product actually served.

## How to re-run it

    docker run -d --name fc39-snap -p 5450:5432 -e POSTGRES_PASSWORD=wattsteer \
      -e POSTGRES_DB=wattsteer postgres:17-alpine
    docker exec fc18-pg pg_dump -U postgres -Fc --no-owner wattsteer > snap.dump
    docker cp snap.dump fc39-snap:/tmp/snap.dump
    docker exec fc39-snap pg_restore -U postgres -d wattsteer --no-owner -j 4 /tmp/snap.dump
    cd apps/ml && uv run python -m wattsteer_ml.dessem_ab_run \
      --database-url postgres://postgres:wattsteer@localhost:5450/wattsteer \
      --root <artifact volume> --artifact-id <a card on it> \
      --as-of 2026-09-09T00:00:00Z

Ten minutes, seven of them the two reads, and one timestamped line per step. The
pinning is still the point: run it against `fc18-pg` itself and the arms are
three datasets — except that now they are read once, so they would at least be
*one* wrong dataset rather than three.

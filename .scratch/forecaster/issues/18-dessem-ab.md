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

**Status:** done, and **run** — the three arms were scored against
data-platform 21's ingested history and the ruling is **do not ship DESSEM**.
`B-common − A-common = −5,845.5 MWh` of promised floor over **70 target days**
on F6, `P(treatment better) = 0.001` under the gate's paired block bootstrap
against a bar of 0.9. The verdict rests on **one** decision-grade fold rather
than two, because `A-full` cannot be fitted on this database at all in F4 or F5
— and every arm is weather-blind over the decision-grade test periods, which is
recorded beside the figures rather than around them. See "The run" below.

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

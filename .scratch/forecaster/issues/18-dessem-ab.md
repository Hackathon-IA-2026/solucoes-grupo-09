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

**Status:** done (machinery and the verdict); the three runs still have to be
scored against a migrated database — see below. Unlike 16, nothing is missing
but the run.

- [ ] All three runs are scored on identical test rows on the shared calendar
- [ ] Decision-grade folds are computed from the 180-day base-fit rule, not
      hardcoded, and non-decision-grade folds are reported but excluded from the
      verdict
- [ ] `Δ recovered_floor_mwh` is reported for both contrasts, with the reference
      fleet stamped
- [ ] The verdict is evaluated by the same paired block bootstrap the gate uses,
      and the sample size in target days is printed beside it
- [ ] The block lands in the card and is re-runnable each quarter without a code
      change

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

# 20 — The transformer benchmark, run once and never promoted

**What to build:** an honest comparison against a covariate-aware sequence
model, scored by the same metric through the same composition arithmetic, whose
non-promotion is enforced by the gate rather than by agreement.

**Temporal Fusion Transformer, not PatchTST.** PatchTST's strength is a long
look-back over the target series itself, and this problem's look-back is
deliberately crippled by the publication gate — the nearest usable same-hour
actual is 48 hours back and most of the vector is exogenous. TFT is the
covariate-aware architecture and is therefore the honest comparison: it is being
asked the same question LightGBM is asked.

Run once, offline, on the free feature set at the late gate profile, on the same
folds. A model that produces quantiles directly still feeds the mixture
inversion, with its own occurrence head — the ladder compares models, not model
families' conventions. Reported with training time and explainability columns
filled in honestly.

It is never served. The card carries the estimator family and the gate refuses
any candidate whose family is not on the served allow-list; changing that list
is a code change with a review, which is what "we agreed it stays a benchmark"
should mean six months from now. This ticket does not add the enforcement —
ticket 13 owns it — it is the run that proves the enforcement bites.

**Blocked by:** 09, 13.

**Status:** done (machinery); the run is blocked on a TFT implementation and
on ingested data — see below

- [ ] The benchmark trains on the shared fold calendar and is scored on
      identical test rows by `qloss_mwh` through the composition function
- [ ] Its occurrence head feeds the same mixture inversion; no bespoke band is
      published for it
- [ ] Training time and an explainability note are recorded beside the metrics
- [ ] Its card carries an estimator family outside the served allow-list, and a
      test confirms the gate refuses it
- [ ] The run happens once, offline, and is not wired into the weekly retrain

## Why this benchmark cannot be run here

Two independent blockers, and neither is a thing this ticket may paper over.

**There is no TFT implementation in the dependency set.** `apps/ml/pyproject.toml`
carries LightGBM, scikit-learn and statsmodels — the served estimator and the
ladder's rungs 2 and 3. Fitting a Temporal Fusion Transformer means adding
PyTorch (plus a forecasting wrapper), which is a heavy dependency and a decision
with a review of its own rather than a step inside a benchmark run. It was **not**
added.

**And no environment here has ingested data.** Forecaster 15 recorded it: the
read path returns the full 85,056-row spine against an empty database, and no
real fit, bootstrap or promotion has ever been observed. So the *served* arm has
no training rows either — even a LightGBM-only half of this comparison is
unmeasurable today.

The comparison, the row-identity assertion, the mixture-inversion identity, the
training-time and explainability columns and the card block are built and tested.
Today's honest output is `UnmeasuredTransformerBenchmark` carrying a named
`NO_TFT_IMPLEMENTATION` reason **written to the card**, because a card with no
block and a card saying "this arm has no data source" look identical to anyone
grepping for the figure.

**The runtime and the peak memory are not estimated.** A benchmark's training
time is a measurement and there is nothing to measure; `TrainingCost` is absent
rather than reasoned out, and a measured report that carries no training time is
refused rather than published.

## How "never promoted" is structural

- The gate's second check (ticket 13) refuses any candidate whose
  `estimator_family` is outside `ESTIMATOR_ALLOW_LIST`, and
  `tests/test_hot_swap_gate.py` now feeds that check this module's own
  `BENCHMARK_ARM` constant rather than a literal `"tft"`, so a rename cannot
  decouple the check from the thing it checks.
- `assert_no_benchmark_promoted(log, root=...)` is the same statement about a
  volume: every `promote` line is read back through the card it names, and a
  promoted family off the allow-list — or a card that cannot be read at all — is
  refused. Unverifiable is not reported as clean.
- No ordering, delta or preferred field exists, asserted over `dir()` and the
  recursive card-block keys rather than by grepping source.
- Nothing imports `promotions.append` or the gate's recorder — asserted over the
  module's own import AST — and neither `serving_lanes`, `gate` nor `retrain`
  imports this module, so "once, offline" is an import-graph property.

**The lane is the served lane, and that is why the family is the bar.** The
benchmark's triple (`dessem_free_v1`, `gate_late`, 5 MW) *is* the evening view's,
so the threshold sweep's "each arm gets a lane nobody serves" bar does not
transfer. `BENCHMARK_LANE` is `serving_lanes.LATE_LANE` imported rather than
rebuilt, so the two cannot drift.

Two shapes make a TFT artifact unproducible through the served path anyway, and
they were left alone rather than widened: `ModelBundle` refuses a family off the
allow-list and `ModelCard.to_dict` writes the served family unconditionally, and
`MetricsRow` refuses a `rung_number` above 4, so ladder rung 5 cannot enter the
metrics table the gate reads.

## Boxes

- [x] Scored by `qloss_mwh` through the composition function, on identical test
      rows asserted by digest — as machinery; the fold calendar it would run on
      is the shared one, but no fold has been evaluated.
- [x] The occurrence head feeds the same mixture inversion, and no bespoke band
      is published: checked as the identity `share_p50_zero ==
      mixture_regime.share_p50_forced_zero`, reusing ticket 17's `MixtureRegime`
      so the breakpoint comes from the mixture's own `q <= 1 - p` rather than the
      spec's prose.
- [~] Training time and an explainability note are recorded beside the metrics:
      the columns exist, are required on a measured report and are published per
      arm; the explainability note is filled in, the training time cannot be.
- [x] The card carries an estimator family outside the served allow-list and a
      test confirms the gate refuses it.
- [x] The run does not happen on the weekly retrain — an import-graph property.
      "The run happens once, offline" is the half that has not happened.

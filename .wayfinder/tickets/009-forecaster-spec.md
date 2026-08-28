---
id: "009"
title: Forecaster spec — hurdle model, quantiles, calibration, backtest protocol
type: wayfinder:grilling
status: closed
assignee: spec-agent
blocked_by: ["008"]
---

## Question

How is the day-ahead forecaster built, trained and evaluated?

- **Hurdle structure** (§13): occurrence classifier + magnitude regression on
  positives only. How are the two composed into a single expected MW, and how
  does that composition propagate uncertainty?
- **Quantiles** (§14): P10/P50/P90 per hour. Quantile regression, conformal
  prediction, or an ensemble spread? They differ in how honest the interval is.
- **Calibration** (§19): Platt vs isotonic, and where the reliability curve is
  computed and surfaced.
- **Reason-code model** (§13, Model C): ENE / CNF / REL classification — only
  if ticket 001 confirms the labels exist at usable grain. If not, this is ruled
  out of scope rather than deferred.
- **Baseline ladder** (§15): which baselines, in order — same-hour 7-day mean,
  logistic regression, random forest, LightGBM — and the metrics table format.
- **Metrics** (§18): PR-AUC, F1, recall, precision, Brier. Which is *the* number
  the gate uses.
- **Backtest protocol** (§20–21): walk-forward fold boundaries over 2023→now,
  and how the revision-optimistic label is applied to folds before ingestion
  go-live.
- **The weather lead-time A/B**, which the research left for the pipeline: train
  twice — once on archive weather, once on lead-matched Single Runs weather —
  and evaluate both on the lead-matched features, which is what serving actually
  provides. One extra training run. It settles whether the measured dispersion
  gap survives capacity-weighted aggregation, and the answer directly affects
  how honest the P10/P90 intervals are.
- **The DESSEM A/B** is a headline result, not a footnote: DESSEM-free over the
  full window versus DESSEM-augmented over 2025-05→now. The two are trained on
  different windows, so the comparison is not apples-to-apples — decide how to
  make it fair (evaluate both on the shared window) and how to report it.
- **Transformer benchmark** (§17): what gets compared, and the explicit
  agreement that it stays a benchmark and does not become the served model.
- Where the trained artifact lives, what metadata travels with it, and what the
  hot-swap gate checks.

Use `/grilling`.

## Resolution

Spec: [`docs/specs/forecaster.md`](../../docs/specs/forecaster.md).

**IDEA.md §13 and §14 do not compose, and the fix is one line.** A hurdle model
predicts a *mixture*, and `p × E[Y|Y>τ]` is an expectation — not a quantile of
anything. The two stages are composed by **inverting the mixture CDF**:

```
Q_Y(q) = 0                                  if q ≤ 1 − p(x)
         Q_pos( (q − (1 − p)) / p )         otherwise
```

Everything else in the spec follows from taking that seriously. The expectation
is published as its own field, never as the band's centre (for a mixture
`E[Y] > P50` whenever `p < 0.5`). Sub-threshold mass is a point at zero in the
quantiles — so the promise errs low by at most τ = 5 MWh — and a fitted
`μ_sub[subsystem, local_hour]` table in the expectation, because dropping it
would bias a day total low by up to 120 MWh.

**The sharpest result goes back to ticket 011.** `flex-optimizer.md` rejected
planning on P10 because a hurdle makes the hour-wise P10 zero in most hours, and
called it a falsifiable prediction. It is not falsifiable — it is arithmetic,
and it is confirmed: **P10 is exactly zero unless `p > 0.90`.** But the same
arithmetic gives **P50 = 0 unless `p > 0.50`**, which applies to the posture the
optimizer *did* choose: the plan's shape is set by the classifier's operating
region, not by the magnitude model. `share_of_days_with_no_non_zero_p50_hour` is
now a first-class backtest number so ticket 011 can see whether its own posture
collapses.

**Quantiles: quantile regression for the shape, split conformal for the
coverage.** Ensemble spread is rejected outright — it measures estimation
variance, not predictive variance, and would reproduce the exact defect the
weather research measured (intervals too narrow). Quantile regression alone is
sharp and feature-dependent but carries no coverage statement, and the product
prints its P10 as a floor in prose. So **CQR**, with **two one-sided
corrections** (`δ_lo`, `δ_hi`) rather than one symmetric one, so a misfit upper
tail cannot borrow coverage from the tail the product promises. The correction
is **global, not per hour** — conditional coverage is reported and never
corrected, because the calibration window cannot support 24 scalars.
Exchangeability is violated and is *stated* to be: the calibration set is the 90
days immediately preceding the evaluation period, the guarantee is approximate,
and empirical fold coverage is the real check. `δ_lo` drifting across folds is
itself the signal that the intervals are going narrow.

**Day grain comes from a path ensemble, because quantiles do not add.**
`dailyEnergy`, `peakPower` and day-level occurrence are **not derivable from the
24 hour bands by any arithmetic**. They are quantiles of 500 draws built by
block-bootstrapping **whole days** of randomised PIT residuals (randomised
because the point mass at zero makes the naive PIT non-uniform). Independent
hourly draws would give ~1/√24 of the true day spread — a narrower band reached
by a more sophisticated route. Day occurrence is emphatically *not*
`1 − Π(1−p_t)`. Side effect: **the temporally coherent scenario paths that
`flex-optimizer.md` names as the precondition for scenario-based dispatch now
exist**, internally, from day one.

**Calibration: isotonic, not Platt.** The calibration window is 8,640 rows (an
order of magnitude above where isotonic overfits), and the distortion is the
characteristic one — well calibrated low, over-confident in the top bins — which
a two-parameter sigmoid cannot flatten without bending the bottom. Isotonic's
cost is resolution, and the product already spent it on three wide risk classes.
Output clipped to `[1/(2n), 1 − 1/(2n)]` so no screen ever shows 0% or 100%.
**The reliability curve is computed on pooled out-of-fold predictions**, never on
the window isotonic was fitted to, stored in the model card, and served from
there. Explain shows the curve against the diagonal with bin counts encoded, the
window and its `VintageFidelity` as a label, ECE and the top-bin gap in a
sentence, and **the risk-bin edges drawn on the same axis**. The map's open item
is closed: **the 25%/60% edges become artifact metadata**, derived by a stated
rule (within-bin gap ≤ 0.05, adjacent bins separated beyond their binomial CIs,
most nearly equal hour counts, rounded to 5 points) and held stable across
retrains unless a retrain violates it.

**Reason-code model (Model C): ruled OUT of scope, not deferred — and the grain
was the wrong test.** Grain passes: reasons aggregate upward from
`ReportingEntity` legally, and the feature spec already ships the shares. It
fails on four other grounds, ranked: (1) **the dominant discriminator is in no
ingested dataset** — `REL` is line unavailability, and the feature spec says in
as many words that the export proxy "cannot see a temporary derate from a line
outage"; this is an absent-predictor problem, not a label problem; (2) the
target is a *share*, undefined on every sub-threshold hour, so it would be a
third hurdle stage; (3) `PAR` is a live enum member observed **zero** times, so
a data-derived class set can silently grow underneath a screen; (4) the product
already shows *observed* reasons at ONS's own grain, which is strictly better
than forecasting them. **Reopening trigger, all three required:** a
transmission-availability dataset is ingested (Sintegre, unexamined), `PAR` has
been observed, and the reason-share features show non-trivial importance.

**Baseline ladder** (0) prevalence — IDEA's table has no PR-AUC floor row and
needs one; (1) same-hour 7-day, **computed from the feature function** so
baseline and model cannot disagree about "last seven days"; (2) logistic +
linear quantile regression; (3) random forest; (4) LightGBM (served); (5) TFT,
benchmark only. **No imputation anywhere in the served path** — LightGBM takes
NULLs natively and the feature spec makes unavailability *meaningful*; rungs 2–3
get median imputation plus `_is_null` indicators and the table says so. One
model across subsystems with `subsystem` categorical (NE dominates the
positives; per-subsystem models would starve S and N), with a per-subsystem
PR-AUC guardrail. **Transformer stays a benchmark by enforcement, not
agreement**: the gate refuses any candidate whose `estimator_family` is outside
the `{lightgbm}` allow-list.

**The gate metric is `qloss_mwh`** — mean pinball loss of the *composed* hourly
distribution over q ∈ {0.1, 0.5, 0.9}. It is the only candidate that scores the
composition (PR-AUC and Brier score stage one alone; MAE-on-positives scores
stage two alone; F1/recall/precision need an operating point that could be
chosen to make the gate pass), it is a proper scoring rule for the interval the
product actually ships, and it is denominated in MWh.

**The gate itself carries no invented constant.** The map records the gate
threshold as unspecifiable before the first honest numbers — an argument against
an *absolute* bar, not against a gate. Promotion is a **paired block bootstrap
over whole target days** (2,000 resamples) on the shared newest fold: promote
iff `P(qloss_candidate < qloss_incumbent) ≥ 0.90`. **Cold start:** the same test
against the 7-day same-hour baseline. It is decidable on day one and gets
stricter automatically. The constants that remain are **guardrails, each of
which blocks a swap rather than choosing one** — PR-AUC −0.02 pooled and per
subsystem, P10/P90 coverage ∈ [0.85, 0.97], P50 unbiasedness ∈ [0.45, 0.55],
ECE ≤ 0.05, quantile-crossing rate ≤ 1%, recall floor.

**Backtest: six fixed quarterly test folds over 2025-04 → now**, expanding
origin, shared by *every* run in the A/B matrix so all are scored on identical
test rows. First fold starts twelve months in — the target is seasonal and a
sub-annual training block cannot contain the season it predicts. **The 90-day
calibration window is carved out of the training block and the base learners are
not refit on it**; refitting would put the calibration data in-sample and shrink
the conformal correction toward zero. It must be the *most recent* 90 days:
recency is what makes the correction valid, not a cost. No López de Prado purge
— trailing windows cross the boundary *forward*, which is honest point-in-time
information the serving path also has. **Revision-optimistic labelling:** folds
before go-live are labelled in full, a straddling fold is **split at go-live and
never averaged**, a revision-optimistic fold may not be the deciding fold once a
point-in-time fold exists, and the first fold scored both ways publishes a
**`revision_premium_qloss`** — the measured size of a caveat every earlier
number carries, which nothing else in this project measures.

**Weather lead-time A/B:** train on archive weather and on lead-matched Single
Runs, **evaluate both on lead-matched features**, plus a third labelled column
`archive→archive (not achievable)` whose gap to the second *is* the leak in the
product's own metric. It reports interval metrics first — `Δ coverage_p10`,
`Δ interval_width`, and especially **`Δ δ_lo`**, the cleanest expression of the
effect, since the correction is literally the amount by which the interval was
wrong. The research's second open experiment (recompute train↔serve `r` on the
real capacity-weighted aggregate) runs here too; `r > 0.95` shrinks the map's
claim.

**DESSEM A/B, framed for one sitting.** Fairness rule: shared fixed test folds;
a run is decision-grade only with ≥180 days of base fit, which for
`dessem_augmented_v1` (window opens 2025-05-23) means **F5 and F6 only — roughly
150 target days, and that is the honest sample size.** A-common absorbs the
short-window handicap so `B-common − A-common` is clean. **The unit of
comparison is not pinball loss**: the A/B additionally reports
**`Δ recovered_floor_mwh`** — both forecasts run through the optimizer's
simulator on the same days with the same published reference fleet — because the
other side of the trade is eleven hours of notice and nobody can convert hours
into pinball loss. **And a third option dissolves the trade: serve both.**
A-full at `gate_early` (~09:00) and the winner of (A-full, B-common) at
`gate_late` (~19:00, superseding). The bitemporal design already treats a later
run as a newer vintage of the same valid hours, so the eleven hours were only
ever a cost under the assumption that one artifact must win. That is the
recommendation; DESSEM then competes only for the evening view, and a wrong call
is recoverable rather than a product regression.

**Artifact: one directory per (feature set, gate profile, threshold) lane**,
ISO-8601-stemmed `.joblib` bundle plus a sibling `.card.json`. Two changes to
`apps/ml/src/wattsteer_ml/artifacts.py` are required and named: `inspect()` must
walk one level of lane directories, and **`current` must mean the newest
artifact named by a `promote` line in an append-only `promotions.jsonl`, not the
newest file** — a refused candidate is still written to the volume, and a
newest-file rule would serve it. Rollback is an append, never a delete. The card
carries a **`feature_hash` over the ordered feature names *and* the
`feature_rows` SQL definition**; if it disagrees with the live function the gate
refuses the swap *and* raises, because the incumbent is then invalid too. Gate
order: lane identity → estimator allow-list → feature contract → freshness →
bootstrap → guardrails → **a serving smoke test on tomorrow's real vector**
(monotone band, no NaN, no feature whose serve-time NULL rate exceeds training
by 5pp — the only check that sees an upstream dataset having gone quiet) →
record the decision either way. With no promoted artifact the service **refuses**
rather than inventing, keeping the stub's stated promise. Every served forecast
is persisted as a `Forecast` row with a `wattsteer` `ForecastOrigin` and the
`artifact_id` as `run_label`, so Replay reads "what did we say at D−1" through
`AsOf` instead of re-running a since-retrained model.

**Also settled:** the technology split gets **no band** — one hurdle on the
total plus a share head applied to the P50 and the expectation, because a band on
a share times a band on a total is this spec's own error one level down; the
threshold sweep runs at 1/5/10 MW as three artifact lanes with 5 MW promoted and
moving only on stated evidence (prevalence outside ~3–40%); hyperparameters are
fixed, published and **never searched inside a retrain**, since that would make
the gate's comparison meaningless.

**The load-bearing artifact is a test, again.** *Shuffled labels*: permute the
labels within each fold's date range, run the entire pipeline, and assert
PR-AUC ≈ prevalence and `qloss_mwh` no better than the prevalence rung. If a
shuffled-label run scores well, the harness leaks — and the test does not need to
know how. It is the model-layer twin of the feature spec's gate ablation.

**Where this is weakest, ranked:** (1) the 90-day hold-out means the served base
learners have not seen the freshest quarter, and the defence (fleet growth enters
through as-of capacity features, not recency) is sound but untested — the fix, a
decoupled cadence, is recorded; (2) the guardrail constants are judgement, and
the first three folds should confirm a gate that never fires is not being built;
(3) split conformal on non-exchangeable data is approximate and adaptive
conformal is the named next step if `δ_lo` drifts; (4) the technology split's
missing band constrains the UI and that constraint has not been agreed.

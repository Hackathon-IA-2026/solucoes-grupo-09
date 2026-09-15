# Spec — WattSteer Day-Ahead Forecaster

> From the feature vector to a P10/P50/P90 profile the optimizer can plan
> against and the product can promise from — one hurdle, one mixture, one
> ensemble, and a gate that can refuse.
>
> **Upstream spec.** [`feature-engineering.md`](feature-engineering.md) produces
> the vector and defers to here: model choice, hyperparameters, calibration, the
> quantile method, the threshold sweep and feature selection. It is the
> authority on the gate, the two feature sets and the label; nothing here
> restates it.
>
> **Downstream spec.** [`flex-optimizer.md`](flex-optimizer.md) consumes this
> spec's output as a contract — it plans on P50 and promises the P10 edge — and
> it names two preconditions this spec is obliged to answer: whether the
> hour-wise P10 collapses, and whether temporally coherent paths exist.
> Both are answered below, and one of the answers is not the one the optimizer
> assumed.
>
> **Naming authority.** [`../domain-model.md`](../domain-model.md); where it and
> this spec disagree, it wins.
>
> **Evidence base.** [`../research/weather-lead-time.md`](../research/weather-lead-time.md) ·
> [`../research/ons-datasets.md`](../research/ons-datasets.md) ·
> [`../research/plant-registry.md`](../research/plant-registry.md).
>
> Ticket: [`009-forecaster-spec.md`](../../.wayfinder/tickets/009-forecaster-spec.md).
> Map: [`.wayfinder/map.md`](../../.wayfinder/map.md).

## Problem Statement

IDEA.md §13 asks for a hurdle model and §14 asks for P10/P50/P90, and reads as
though the second is a decoration on the first. It is not. A hurdle model
predicts a **mixture**, and a mixture's quantiles are not a function anyone
reaches for by accident:

```
P(curtailment) = 87%          ← Model A
curtailment_mwh = 382         ← Model B, on positives
P10 = 240, P50 = 370, P90 = 510
```

Those five numbers cannot all be true at once. If `Model B` is fitted on
positives only — which is what "hurdle" means — then `382` is a statement
*conditional on curtailment happening*, and `P10 = 240` silently asserts that
the 13% of probability mass sitting below the threshold has no effect on the
10th percentile. It has an enormous effect: at `p = 0.87` the 10th percentile of
the unconditional distribution is not `240`, it is **zero**, because 13% of the
mass is already below the threshold before the magnitude model is consulted at
all. Multiply the two models and you get an expectation; you do not get a
quantile of anything.

So there are four problems stacked, and they are ordered by how quietly they
fail:

1. **Composition.** `p × E[Y|Y>τ]` is an expectation. The product ships an
   interval. The map of one onto the other has to be written down as
   arithmetic, or two future sessions will implement two different things and
   both will look plausible on a chart.
2. **Honesty of the interval.** Quantile regression, conformal prediction and
   ensemble spread all produce three numbers per hour and they mean different
   things. The optimizer *promises* the P10 in prose. A P10 that is merely the
   0.1-pinball-minimising output of a booster carries no coverage statement at
   all, and the weather lead-time research has already measured a specific force
   pushing intervals **too narrow** — 20–26% of the weather-driven variance a
   model learns from the archive is absent at serve time.
3. **Aggregation.** Quantiles do not add. The screens want a *day* total band
   and a peak-power band, and ticket 014 already made "nothing in the UI sums
   two bands" a test. Which means the day-grain numbers cannot come from the
   hour-grain numbers by any arithmetic, and something else has to produce them.
4. **The gate.** The map's own "Not yet specified" list says the hot-swap gate
   threshold cannot be set before the first honest numbers exist. That is true
   of any *absolute* threshold, and it is an argument for a gate that needs no
   constants rather than an argument for deferring the gate.

Underneath all four is the same failure class the feature spec exists to
prevent, one layer up: **a number that is wrong in a direction nobody can see.**
A leaky feature produces a flattering fold evaluation. A mis-composed quantile produces
a flattering *promise* — `recovered_floor_mwh` is the sentence the product
quotes, and it is computed by simulating a plan against this spec's P10.

## Solution

**One hurdle, inverted as a mixture; one ensemble for everything above hour
grain.**

Two estimators are trained: an occurrence classifier `p(x) = P(Y > τ | x)` and a
magnitude quantile regressor `Q_pos(u | x) = F⁻¹(y | y > τ, x)`. They are never
multiplied. They are composed by **inverting the mixture CDF**, which is one
line of arithmetic and settles the hour-grain band exactly:

```
Q_Y(q | x) =  0                                          if q ≤ 1 − p(x)
              Q_pos( (q − (1 − p(x))) / p(x) ) + δ(q)    otherwise
```

`δ(q)` is the conformal correction, and it is written here rather than bolted on
later because it is part of the served quantile function: see "Quantiles —
quantile regression, conformalised" for what it is and why it is applied at `q`
and not to `Q_pos`'s knots. It is zero at `q = 0.50` and never reaches the
`q ≤ 1 − p` branch, so everything the next paragraphs say about the structural
zeros holds with or without it.

**`Q_pos` is flat outside the fitted knots, not extrapolated.** The composition
asks for `Q_pos((q − (1 − p))/p)`, which equals `q` only when `p = 1`, so it
routinely needs the magnitude quantile at an `u` no alpha was fitted at. Between
knots it interpolates linearly; **outside the outermost alphas it holds flat**. A
straight line drawn past `α = 0.9` is an invented tail, and the day totals and
the 500-path ensemble would inherit it as though it had been fitted. Holding flat
understates the extreme tail, which is the direction this spec already errs in
everywhere else — the promise errs low.

Three consequences fall straight out, and each is a decision the rest of this
spec builds on:

- **P10 is exactly zero unless `p > 0.90`; P50 is exactly zero unless
  `p > 0.50`.** The optimizer predicted the first and used it to reject planning
  on P10. The second is new, applies to the posture it *did* choose, and is
  handed back to ticket 011 as a measured quantity rather than an argument.
- **The expectation is a separate field, never the band's centre.** For a
  mixture, `E[Y] > P50` whenever `p < 0.5`, and drawing an expectation inside a
  quantile band would make the band asymmetric for a reason that has nothing to
  do with uncertainty.
- **Sub-threshold mass is a point at zero for quantiles and a fitted constant
  for the expectation.** The low quantiles are therefore conservative by at most
  `τ` (5 MWh). The asymmetry is deliberate: the promise errs low, the
  expectation does not.

On top of that spine:

- **Quantile regression for the shape, split-conformal for the coverage.**
  LightGBM pinball boosters give sharp, feature-dependent intervals with no
  coverage guarantee; a one-sided conformal correction per tail, fitted on a
  temporally adjacent calibration window, supplies the guarantee. Ensemble
  spread is rejected outright: it measures model variance, not predictive
  variance, and is the method most likely to reproduce the exact defect the
  weather research measured.
- **Isotonic calibration of the occurrence probability**, fitted on the same
  window, and the reliability curve computed on **pooled out-of-fold**
  predictions — never on the window it was fitted to.
- **Every number above hour grain comes from a path ensemble.** Day total, peak
  power and day-grain occurrence are quantiles of 500 temporally coherent draws
  built by resampling whole days of PIT residuals. Nothing sums a band. This
  also, as a side effect, hands the optimizer the scenario paths its Out of
  Scope section names as the precondition for scenario-based dispatch.
- **The hot-swap gate carries no invented constant.** Promotion is a paired
  block bootstrap against the incumbent on the shared newest fold; the
  guardrails that *do* carry constants are vetoes, not the gate.

## User Stories

**Composition**

1. As a modeller, I want the occurrence and magnitude models composed by
   inverting a mixture CDF rather than multiplied, so that the published
   quantiles are quantiles of the thing being forecast.
2. As a modeller, I want the expected MW published as its own field beside the
   band, so that a mixture's expectation is never mistaken for its median.
3. As a modeller, I want sub-threshold mass represented as a point at zero in
   the quantiles and as a fitted per-hour constant in the expectation, so that
   the direction of each approximation is stated rather than discovered.
4. As the optimizer, I want the share of hours whose P50 is zero published as a
   first-class fold-evaluation number, so that my planning posture is falsifiable
   against data rather than argued.
5. As a developer, I want the composition implemented once in one function
   imported by training, serving, fold evaluation and Replay, so that four callers
   cannot hold four mixtures.

**Intervals that mean something**

6. As a user, I want the P10 to carry a coverage statement, so that "the floor"
   is a measured property and not the name of a booster's output.
7. As a modeller, I want each tail conformalised independently, so that a
   misfit in the upper tail cannot borrow coverage from the lower one the
   product actually promises.
8. As a modeller, I want the conformal calibration set to be the block of days
   immediately preceding the evaluation period, so that the correction is fitted
   to the error distribution nearest in time rather than to an exchangeable
   fiction.
9. As an analyst, I want empirical coverage reported per fold, per subsystem and
   per local hour, so that a marginal guarantee is never read as a conditional
   one.
10. As a sceptic, I want it stated in the spec, not only on the screen, that an
    hour-wise P10 profile is not a day-level confidence statement.

**Calibration**

11. As a user, I want a stated 80% chance to mean that roughly 80% of similar
    hours saw an event, so that the risk class on the overview is defensible.
12. As a modeller, I want isotonic rather than Platt calibration, so that a
    distortion concentrated in the top bins can be corrected without disturbing
    the bottom ones.
13. As a modeller, I want the reliability curve computed on pooled out-of-fold
    predictions, so that the curve is not a self-portrait of the calibration fit.
14. As a product owner, I want the risk-class bin edges derived from the
    reliability curve and stamped on the artifact, so that the 25%/60% edges the
    prototype invented stop being a styling constant.
15. As a user, I want a calibrated probability never rendered as exactly 0% or
    100%, so that the screen does not make a claim the model cannot support.

**The baseline ladder and the gate**

16. As a reviewer, I want a ladder from prevalence through the mandatory 7-day
    same-hour baseline to LightGBM, every rung evaluated on identical folds, so
    that "AI added value" is a measured delta and not a chart.
17. As a modeller, I want the mandatory baseline computed from the same feature
    function as the model, so that the baseline and the model cannot disagree
    about what "the last seven days" means.
18. As an operator, I want one number to decide the weekly hot-swap, so that a
    promotion is not a judgement call at 03:00.
19. As an operator, I want the gate to be a comparison against the incumbent
    rather than a threshold, so that it works before anyone knows what good
    looks like.
20. As an operator, I want a refused candidate written to the volume and logged
    with its reason, so that a model that failed can be inspected instead of
    vanishing.
21. As an operator, I want a rollback to be an append rather than a delete, so
    that undoing a bad promotion cannot destroy the evidence.

**Fold evaluation**

22. As a modeller, I want expanding-origin walk-forward folds with fixed
    calendar boundaries, so that every run in the A/B matrix is scored on
    identical test rows.
23. As a modeller, I want the calibration window carved out of the training
    block rather than shared with it, so that the conformal correction is not
    fitted in-sample.
24. As an analyst, I want every metric to carry the `VintageFidelity` of the
    fold that produced it, so that a revision-optimistic number is never
    averaged into a point-in-time one.
25. As an analyst, I want the gap between the revision-optimistic estimate and
    the first point-in-time fold published as its own number, so that the size
    of the vintage caveat is measured instead of asserted.
26. As a developer, I want a shuffled-label control run, so that a leak in the
    harness is detected by a property rather than by review.

**The two experiments**

27. As a modeller, I want the same model trained on archive weather and on
    lead-matched weather and both evaluated on lead-matched features, so that
    the weather decision has an acceptance test rather than an argument.
28. As a modeller, I want the lead-time A/B to report interval metrics and not
    only point metrics, so that the harm the research predicts is measured where
    it was predicted to land.
29. As a product owner, I want the DESSEM A/B expressed in MWh of promised floor
    rather than in pinball loss, so that "3% better" and "ten hours of notice"
    are comparable quantities.
30. As a product owner, I want the option of serving both an early and a late
    artifact costed, so that the ten hours are only spent if they have to be.

**The artifact**

31. As the platform, I want an artifact bound to exactly one
    (feature set, gate profile, threshold) triple, so that a swap cannot cross
    lanes.
32. As the platform, I want the artifact to carry a hash of the feature contract
    it was trained against, so that a change to the feature SQL invalidates the
    model instead of silently re-meaning it.
33. As an operator, I want `/v1/meta` to distinguish "no artifact", "artifact
    present but not promoted" and "promoted and serving", so that a stale
    forecast and an unmounted volume do not look alike.
34. As a user, I want the service to refuse rather than invent when no promoted
    artifact exists, so that the stub's promise survives the model landing.
35. As Replay, I want every served forecast persisted as a `Forecast` row with a
    `wattsteer` `ForecastOrigin`, so that "what did we say at D−1" is a query
    rather than a re-run.

**Scope**

36. As a product owner, I want the reason-code model ruled in or out now with a
    named reopening trigger, so that it is not carried as fog.
37. As a reviewer, I want the transformer benchmark's non-promotion enforced by
    the gate rather than by agreement, so that the agreement cannot be forgotten.

## Implementation Decisions

### The hurdle, composed

**Two estimators, one mixture, one place.**

| | Estimator | Trained on | Output |
|---|---|---|---|
| **Model A — occurrence** | LightGBM binary, `objective=binary` | every feature row | `p_raw(x)`, calibrated to `p(x)` |
| **Model B — magnitude** | Three LightGBM boosters, `objective=quantile`, `alpha ∈ {0.1, 0.5, 0.9}` | rows where `y_constrained_off_total_mwh > τ` | `q̂_pos^α(x)` |
| **Model S — share** | LightGBM regression on `wind_mwh / total_mwh` | the same positive rows | `ŝ(x) ∈ [0,1]` |

`τ` is `threshold_mw × 1 h`, default 5 MWh at subsystem grain, passed through
from the feature function and stamped on the artifact.

**The composition.** Let `F_Y` be the predictive CDF of the unconditional
hourly `constrained_off_mwh`. The hurdle says

```
F_Y(y | x) = (1 − p) · F_sub(y | x) + p · F_pos(y | x)
```

with `F_sub` supported on `[0, τ]` and `F_pos` on `(τ, ∞)`. Inverting:

```
Q_Y(q | x) =  0                                                if q ≤ 1 − p(x)
              Q_pos( (q − (1 − p(x))) / p(x) | x ) + δ(q)      if q >  1 − p(x)
```

and the expectation, which is *not* a quantile and is published separately:

```
E[Y | x] = p(x) · Ê[Y | Y > τ, x] + (1 − p(x)) · μ_sub(subsystem, local_hour)
```

Four decisions are folded into those three lines:

- **Sub-threshold mass is treated as a point at zero for the quantiles.** The
  true value lies in `[0, τ]`, so `Q_Y` is conservative by at most 5 MWh in any
  hour whose quantile falls in the sub-threshold regime. Modelling `F_sub`
  properly would mean a third estimator for a quantity bounded by the threshold
  the product already declares to be noise. The bound is stated; the estimator
  is not built.
- **`μ_sub` is a fitted constant, not zero.** It is the training-fold empirical
  mean of `y_constrained_off_total_mwh` over sub-threshold rows, by
  (`subsystem`, `calendar_local_hour`) — 96 numbers, stored in the artifact.
  Dropping it would bias the day's expected total low by up to 24 × 5 = 120 MWh
  against day totals of a few hundred, which is not a rounding error. Using
  `μ_sub` in the quantiles as well would push the low quantiles *up* on the
  strength of a table of means, which is exactly the direction a promise must
  not be nudged.
- **`Ê[Y | Y > τ]` is not `q̂_pos^0.5`.** The conditional mean of a right-skewed
  magnitude distribution sits above its median. It is estimated by a fourth,
  cheap LightGBM booster with `objective=l2` on the same positive rows. Reusing
  the median booster here would understate the expectation systematically, and
  the expectation is the number the narration is most likely to reach for.
- **Monotonicity is enforced after composition, not assumed.** Three
  independently-fitted quantile boosters can cross. The composed band is sorted
  (`P10 ← min`, `P90 ← max`) and the crossing rate is a published metric. A
  crossing rate above 1% of served hours is a guardrail veto — it means the
  quantile fits disagree about the shape and the interval is not describing one
  distribution.

**What falls out, and what it does to the optimizer.** Because `Q_Y(q) = 0` for
`q ≤ 1 − p`:

| Served quantile | Non-zero only when |
|---|---|
| P10 | `p > 0.90` |
| P50 | `p > 0.50` |
| P90 | `p > 0.10` |

`flex-optimizer.md` rejected planning on P10 on precisely this ground and called
it a falsifiable prediction for this ticket. **It is confirmed by construction,
not by measurement — it is arithmetic, not an empirical claim.** But the same
arithmetic applies one notch weaker to the posture the optimizer *did* choose:
a P50-planned dispatch sees zero offered energy in every hour more likely than
not to be quiet. That is defensible — the median of a day that probably has no
curtailment above threshold genuinely is "no curtailment above threshold" — but
it is a fact about the plan that nobody has written down, and it means the
plan's shape is decided by the *classifier's* operating region rather than by
the magnitude model at all.

So fold evaluation publishes, per fold and per subsystem, the distribution that
makes it decidable:

```
hours_per_day_p_ge_50, hours_per_day_p_ge_90     (mean, p25, p75)
share_of_hours_with_p50_zero, share_with_p10_zero
share_of_days_with_no_non_zero_p50_hour
```

If `share_of_days_with_no_non_zero_p50_hour` is large, the optimizer's chosen
posture collapses in the same way it argued P10 would, and ticket 011 has to
reopen. That number is the deliverable this spec owes ticket 011.

**And the alternative is measured at the same time, rather than argued about
later.** Fold evaluation scores a second planning arm — the plan built against
`E[Y]` instead of P50 — through the identical simulator, and publishes both
arms' `recovered_floor_mwh`. This costs almost nothing: the expectation is
already a served field, and the scoring path is already shared. It is worth the
almost-nothing because `E[Y] > P50` exactly when `p < 0.5`, which is to say the
expectation is non-zero in precisely the hours where the P50 plan goes blind, so
if the P50 posture does collapse, the replacement arrives already evidenced
instead of starting a fresh argument. Note the objection that killed
scenario-weighting does not apply here: that failed because the hour-wise
quantile envelope is not a physically realisable day, whereas `E[Y]` is a
genuine expectation and adds across hours legitimately.

**The technology split does not get a band.** The domain atom is
(`Subsystem`, `Technology`, `valid_time`), and the screens carry a `technology`
field, but the hurdle is trained on the **total** and the split is produced by
`ŝ(x)` applied to the P50 and to the expectation only. Publishing a wind band
and a solar band would require either two hurdles whose bands do not reconcile
with the total's band, or a band on a share times a band on a total — the
composition error this spec exists to prevent, one level down. The per-
technology figure is a **point split of a band's centre, labelled as a split**,
and the API contract types it as a scalar so no screen can render it as a band.

### Quantiles — quantile regression, conformalised

**Decision: LightGBM quantile regression for the shape, one-sided split
conformal for the coverage.** The three candidates were not equivalent:

- **Ensemble spread — rejected.** The spread of a bagged or seed-varied GBM
  measures *estimation* variance, which shrinks with data, not *predictive*
  variance, which does not. On 44,000–84,000 rows it would be a small number
  masquerading as an interval, and it would fail in exactly the direction the
  weather research already measured: too narrow. It is the only one of the three
  that has no mechanism at all for representing irreducible weather uncertainty.
- **Quantile regression alone — necessary but insufficient.** Pinball-loss
  boosters produce genuinely feature-dependent intervals: they widen where the
  covariates say the day is uncertain, which is the whole point in a domain
  where uncertainty concentrates in ramp hours. What they do not produce is any
  coverage statement. Empirical coverage of an uncalibrated 0.1 booster is
  whatever the optimisation happened to land on, and the product prints its
  output as a floor in prose.
- **Conformal alone — the wrong shape.** Split conformal on a point forecast
  gives a constant-width band, which for curtailment is nearly useless: the
  distribution is a point mass at zero for most hours and heavily skewed for the
  rest, and a fixed ± is wrong everywhere.

So: **Conformalised Quantile Regression** (Romano, Patterson & Candès 2019) —
the boosters supply the shape, conformal supplies a scalar per tail that makes
the coverage honest.

**Two one-sided corrections, not one symmetric one — and they are not ranked
over the same rows.** Let the calibration window contain positive rows `i` with
observed `y_i`. Define, on the *composed* band:

```
s_i    = max(Q_pos(0.90 | x_i) − Q_pos(0.10 | x_i), 1 MWh)   — the row's scale
E_lo,i = (Q_Y(0.10 | x_i) − y_i) / s_i   (positive when the interval was too high)
E_hi,i = y_i − Q_Y(0.90 | x_i)
δ_lo   = the ⌈(n_lo+1)(1 − 0.10)⌉-th smallest E_lo, over the n_lo rows
         where Q_Y(0.10 | x_i) > 0  — i.e. p(x_i) > 0.90
δ_hi   = the ⌈(n+1)(1 − 0.10)⌉-th smallest E_hi, over all n positive rows
```

**`δ_lo` is dimensionless and `δ_hi` is MWh**, and the asymmetry is deliberate.
The lower residual is divided by the row's own positive spread `s_i` because a
flat MWh floor correction is a rounding error on a 1,691 → 12,700 MWh band and
most of the interval on a 0 → 3,029 one, so what it delivers depends on the
magnitude mix of the period it lands on. Measured across a fleet-magnitude
sweep, the additive correction's realised coverage swung 0.8023 → 0.9504 on the
shift alone with the model unchanged; normalised it held 0.9165 everywhere. A
90% guarantee that holds only at one fleet size is not one. The upper tail was
covering on both artifacts that exposed this (`upper_correction_realised`
0.9927), and changing a tail that covers on an argument measured somewhere else
is not a move this repository makes — so `δ_hi` stays MWh until it is measured.
See `.scratch/forecaster/issues/43-the-correction-is-additive-on-heteroscedastic-bands.md`.

The scale is read off the **positive branch** rather than the composed band: the
composed width depends on `p` through the point mass, so two rows with identical
magnitude shapes and different `p` would be scaled differently and the residual
would stop being a property of the fit.

**Why the lower tail is ranked over fewer rows.** `δ` is applied inside the
positive branch, so on any row whose `Q_Y(0.10)` is the mixture's point mass at
zero — every row with `p(x) ≤ 0.90` — the shift moves nothing and the row is
covered by arithmetic, with probability one. Ranking `E_lo` over those rows
spends the miss budget on certainties. Measured on the artifacts of
2026-09-10: **1,931 of 3,000 rows inert, 1,069 moved**, and the moved set is
exactly the rows that state a floor.

Leaving them in is not merely wasteful, it is unsafe in the direction that
matters: on a window where `p` is independent of magnitude the contaminated
ranking covered the *stated* rows at **0.73** against a 0.90 target — too
narrow exactly where the floor says something. Ranking over the stated rows
alone returns that to 0.9008. See `.scratch/forecaster/issues/35-the-shift-is-inert-on-the-atoms.md`.

The upper tail keeps the whole population deliberately: its ineligible rows are
certain *misses* rather than certain hits, so dropping them would take the
marginal `coverage_p90` below nominal with nothing to make it up.

So what is aimed at 90% is `coverage_p10_where_stated` on the lower tail and
the *marginal* `coverage_p90` on the upper. The marginal `coverage_p10` comes
out above 0.90 by the share of rows whose floor is the point mass —
`coverage_p10 = (1−s)·1 + s·coverage_p10_where_stated` — and that excess is
structure, not slack. `conformal_method` on the card reads
`one_sided_split_cqr_stated_lower_spread_normalised` for this reason and for the
units above — an old card cannot be read with the new units, so the name carries
both — and the card publishes
`conformal_lower_calibration_rows` and `conformal_lower_rank` beside the
window's own `n`.

**The correction is applied to the quantity it was measured on.** The residuals
are differences of the *composed* band, so `δ` is a shift of `Q_Y`, not of
`Q_pos`. It is applied inside the positive branch, as a piecewise-linear
function of the mixture's own `q` — the same interpolate-between-knots,
hold-flat-outside rule `Q_pos` uses, over the three points where something is
known:

```
δ(0.10) = −δ_lo·s      δ(0.50) = 0        δ(0.90) = +δ_hi
δ(q)      linear between them, flat below 0.10 and above 0.90
Q_Y(q | x) ← Q_Y(q | x) + δ(q)        for q > 1 − p(x); unchanged at q ≤ 1 − p(x)
```

`δ(0.50) = 0` is the median getting no correction, made structural rather than
remembered. The exclusion of the `q ≤ 1 − p` branch is what keeps the point mass
at zero intact: at `p ≤ 0.10` the served P90 *is* zero and correcting it upward
would invent curtailment the mixture denies.

**This is a correction of the served band, not a second way to build one.** The
shift is carried on the mixture, so the path ensemble — which inverts `Q_Y` at
500 × 24 arbitrary `q` per day — inverts the corrected distribution, and the
ensemble's marginals stay the served marginals. There is still exactly one
composition. Applying `δ` to the two published quantiles *after* composition
would be simpler and would break that: the band would move and the ensemble
would keep drawing from the uncorrected marginals, so the hour band and the day
band would disagree about hour 14.

**Why not the knots** — the first implementation applied `δ` to `Q_pos`'s knots
(`Q_pos^0.10 ← q̂^0.10 − δ_lo`, `Q_pos^0.90 ← q̂^0.90 + δ_hi`) and that
under-applied the upper tail. Composition reads `Q_pos` at
`u = (q − (1 − p))/p`; `u_lo ≤ 0.10` for every `p`, where the interpolant is
flat, so the lower tail arrived in full — but `u_hi = 1 − 0.1/p` is below the
0.90 knot for every `p < 1` and at or below the 0.50 knot once `p ≤ 0.20`. The
composed P90 received 0.97 of `δ_hi` at `p = 0.9`, 0.75 at `p = 0.5`, 0.42 at
`p = 0.3` and **none of it at `p ≤ 0.20`** — a mean realised share of 0.25 on the
reference fold, with 49% of rows getting nothing. That is a P90 too *low*, which
is the flattering direction and the unsafe one for a product whose reason to
exist is letting an operator size storage against the top of the band. The
regime is stamped on every published row (`correction_regime`), so the two rules
are one `group by` apart: `conformal_v1_partial_upper` is the knot correction and
`conformal_v2_full_upper` is the one above.

Symmetric CQR would let a badly-fitted upper tail spend the correction budget
that the lower tail needs, and the lower tail is the one the product promises.
Two scalars per artifact instead of one is a trivially cheap way to keep them
independent.

**The correction is global, not per hour.** Conditional coverage is what one
would want and it is not what the data supports: a per-`local_hour` correction
would fit 24 scalars on a calibration window whose positive rows number in the
low thousands, concentrated in a handful of hours. So one scalar per tail per
artifact, with **per-hour and per-subsystem coverage reported and never
corrected**. That asymmetry — correct marginally, report conditionally — is the
honest position, and the report is what would justify a future refinement.

**The median gets no correction.** A median has no interval to cover. It is
scored by pinball loss and by median-unbiasedness (`share of observations below
P50`, target 0.5), and the latter is a guardrail.

**Exchangeability is violated and is not pretended otherwise.** Split conformal's
guarantee needs exchangeability between the calibration set and the test set;
time series are not exchangeable, and this one has a growing fleet and a
seasonal cycle. Two things follow, both recorded rather than smoothed: the
calibration window is the **90 days immediately preceding** the evaluation
period, so the two are as close in distribution as the design allows; and the
guarantee is treated as **approximate**, with empirical fold coverage as the
real check and a guardrail on it. A conformal correction that needs to be large
is itself a signal: `δ_lo` and `δ_hi` are published per fold, and a `δ_lo` that
grows across folds means the boosters' intervals are drifting narrow.

**Both `coverage_p10` and `coverage_p90` are now the same kind of statement**,
which they were not under the knot correction: each counts the fold's curtailed
hours against a served edge that received its tail's whole `δ`. What remains
asymmetric belongs to the mixture and not to the correction — the lower edge is
structurally zero for every `p ≤ 0.90` and the upper for every `p ≤ 0.10`, and
`upper_correction_realised` publishes the share of scored hours where the upper
edge is a positive number at all. It bounds `coverage_p90` from above, and a
`coverage_p90` short of nominal is read against it.

**And the two marginals disagree about what a zero edge means, which is the
whole of why they look so different.** They are counted over the same rows. A
scored hour has `y > τ > 0`, so where the mixture puts an edge on its point mass
`y ≥ P10` holds for free and `y ≤ P90` fails with certainty: the identical
structural zero is a free pass in one numerator and a guaranteed failure in the
other. A `coverage_p10` of exactly 1.0 is therefore not a floor that held — on a
fold where no scored hour has `p > 0.90` it is arithmetic over an edge that is
0 MWh on every row — and a marginal `coverage_p90` short of nominal is not, on
its own, evidence that one global `δ_hi` cannot cover a heteroscedastic upper
tail.

So each figure is published **with the rows on which its edge is a bound at
all**: `coverage_stated_rows_p10` and `coverage_stated_rows_p90`, and the two
`coverage_*_where_stated` figures over those rows alone — **absent, never 1.0**,
where there are none. The upper marginal factorises exactly,

```
coverage_p90 = upper_correction_realised × coverage_p90_where_stated
```

because a row whose P90 is zero can never be covered. The first factor is a fact
about the **classifier**; only the second is a fact about the conformal
correction's **width**. A short marginal beside a nominal `where_stated` is the
point mass and the spec's already-recorded answer — a better classifier, not a
wider band; a short `where_stated` is the correction, and is the thing per-tail
conditional conformal would be for.

**`coverage_nominal_claim` — the band is never printed as a 90% statement while
it is not one.** The card and the wire carry a boolean and a `claim_note`, both
derived from the fold's numbers and neither settable by a caller. The claim
holds only when both marginals sit inside the coverage guardrail *and* each tail
states a bound on at least one row; a coverage of 1.0 over no stated row is
arithmetic and not a guarantee. A withheld claim carries the decomposition and a
named unmeasured reason, because every fold this repository can score is
fabricated: the decomposition can say where a short marginal comes from without
claiming the share it comes from survives outside a fixture, and that
measurement needs a fold sweep against a migrated database with an ingested
window.

**The interval has two independent honesty components**, and separating them is
what makes a failure diagnosable: `p` is calibrated by isotonic and checked by
the reliability curve; `Q_pos` is corrected by conformal and checked by
coverage. A P10 that under-covers is either an over-confident classifier or a
narrow magnitude interval, and the two metrics say which.

### Day grain — one path ensemble, no addition

Quantiles do not add. Ticket 014 made that a UI invariant; here it is a
constraint on what can be computed at all. The day-grain figures the screens
need — `dailyEnergy`, `peakPower`, and the day-level `occurrenceProbability` —
are **not derivable from the 24 hour-wise bands by any arithmetic**, because
they all depend on the intra-day dependence structure that the marginals discard.

**Decision: every number above hour grain is a quantile of a 500-member path
ensemble**, built by an empirical block bootstrap over PIT residuals.

```
1. On the calibration window, for every day d and hour t, compute the
   randomised PIT of the composed predictive CDF:
       u_{d,t} = F_Y(y_{d,t})                      if y_{d,t} > τ
       u_{d,t} ~ Uniform(0, 1 − p_{d,t})           if y_{d,t} ≤ τ
2. Store the matrix U (n_days × 24) in the artifact.
3. At serve time, draw 500 whole rows of U with replacement — whole days,
   never individual hours — and map each through tomorrow's marginals:
       y*_{k,t} = Q_Y(u_{k,t} | x_t)
4. Day total  = quantiles of Σ_t y*_{k,t}
   Peak power = quantiles of max_t y*_{k,t}
   Day P(occurrence) = share of draws with at least one hour above τ
```

Why this and not the alternatives:

- **Resampling whole days is what preserves the dependence.** Curtailment is
  autocorrelated within a day by construction — it is an oversupply condition
  that lasts hours. Independent hourly draws would produce day totals with
  roughly `1/√24` of the true spread, which is a narrower band arrived at by a
  more sophisticated route.
- **The randomised PIT is required, not decorative.** With a point mass at zero,
  the naive PIT of a zero observation is not uniform and the ensemble would
  inherit a spike at `1 − p`. Randomising within `(0, 1−p)` restores uniformity,
  which is the property the whole construction rests on. A test asserts the
  stored `U` is uniform on `[0,1]` per column within a Kolmogorov–Smirnov
  tolerance — if it is not, the marginals are miscalibrated and the day band is
  meaningless.
- **No copula is fitted, so no copula parameter is invented.** A Gaussian copula
  would need a 24×24 correlation matrix estimated from a few hundred days, and
  its tail dependence would be wrong in the direction that matters. The
  bootstrap's dependence structure is whatever the calibration window actually
  had.
- **The ensemble's marginals are the marginals**, by construction. So the hour
  band and the day band cannot disagree about hour 14, which is the
  reconciliation problem a separate day-grain model would create.
- **Day-level occurrence is not `1 − Π(1 − p_t)`.** That formula assumes
  independence across hours and would overstate day-level risk badly. The
  ensemble handles it correctly and for free.

**A consequence for ticket 011.** The ensemble *is* the temporally coherent
scenario paths that `flex-optimizer.md` names as the precondition for
scenario-based optimisation ("Real scenario paths require a change to the
forecaster's output contract"). They exist, internally, from day one. Exposing
them across the API is not done in v1 — the contract stays P10/P50/P90 — but the
precondition is met and the upgrade is now a serialisation question rather than
a modelling one.

**The floor is still an hour-wise statement.** The ensemble makes a day-level
confidence statement *computable*, and the product still does not make one:
`recovered_floor_mwh` is simulated against the hour-wise P10 envelope, which is
not a member of the ensemble and is not a realisable day. Both this spec and the
screens say so.

### Calibration — isotonic, and where the curve lives

**Decision: isotonic regression, fitted on the 90-day calibration window,
clipped away from the endpoints.**

Platt scaling fits a two-parameter sigmoid in logit space. It is the right
choice when the calibration set is small (a few hundred points) and when the
distortion really is a monotone squeeze of the whole range. Neither holds here:

- **The calibration set is large.** 90 days × 24 hours × 4 subsystems = 8,640
  rows, an order of magnitude above the ~1,000 point rule of thumb below which
  isotonic overfits its steps.
- **The distortion is not sigmoidal.** The shape the prototype's fixture draws —
  and the shape a gradient-boosted classifier on an imbalanced target reliably
  produces — is well calibrated in the low bins and increasingly over-confident
  in the top ones. A sigmoid cannot flatten the top without bending the bottom,
  because it has two parameters and this needs a shape. Isotonic is
  nonparametric and monotone, so it can.
- **The cost of isotonic is resolution, and the product already spent it.** The
  output is piecewise constant, so the model can no longer distinguish 31% from
  33%. The overview screen renders three wide named bins for independent
  reasons, so the resolution isotonic destroys is resolution nothing consumes.
  Where it *would* matter is the mixture inversion, and it does not: `p` enters
  through `1 − p` as a breakpoint, and a step there moves a quantile by less
  than the magnitude model's own spread.

**Clipping.** Isotonic can and will return exactly 0 and exactly 1 at the ends.
Both are forbidden: a 0 makes `Q_Y(q)` undefined at `q = 1` and puts "0%" on a
screen as a claim about tomorrow. Output is clipped to
`[1/(2n), 1 − 1/(2n)]` where `n` is the calibration window's row count — the
standard Laplace-style bound, so the clip is a function of evidence rather than
a magic epsilon.

**Where the reliability curve is computed.** On the **pooled out-of-fold
predictions across every walk-forward test fold**, never on the calibration
window (which would be a self-portrait) and never on training data. Ten
equal-width bins of 0.1; a bin with fewer than 100 hours is merged upward into
its neighbour and the merge is recorded. The curve is a property of the *model*,
not of a day — the prototype's fixture already says so — and it is computed at
retrain time, stored in the model card, and served from there.

It carries the fields the Explain screen already types:
`reliability: ReliabilityPoint[]`, `reliabilitySampleHours`,
`reliabilityWindow`, `reliabilityFidelity`. Alongside it the card stores the
scalar summaries: **ECE** (expected calibration error, the hour-weighted mean
absolute bin gap), **MCE** (the worst bin gap), and the **top-bin gap**
(`bin 0.9–1.0`) on its own, because that is where a curtailment classifier
fails and where the product's confident statements come from.

**What the Explain screen shows.** The curve against the diagonal; bin sample
counts encoded so a bin computed from 431 hours does not look like one computed
from 4,180; the window and its `VintageFidelity` as a label, not a footnote; ECE
and the top-bin gap in a sentence; and **the risk-class bin edges drawn on the
same axis**, so a reader can see which part of the curve each named class rests
on. One sentence states that the curve describes the model over that window and
says nothing about tomorrow specifically.

**The risk-class bin edges become artifact metadata.** The map records the
25% / 60% edges as invented and asks for them to come from the calibration
curve. The rule, so that they come from data without becoming unstable:

> Choose edges from the calibrated reliability curve such that (a) within each
> bin `|mean predicted − observed frequency| ≤ 0.05`, and (b) adjacent bins'
> observed frequencies differ by more than the sum of their 95% binomial CI
> half-widths. Among the candidate edge sets satisfying both, take the one whose
> bins are most nearly equal in *hour count*, so that no named class is a rare
> curiosity. Round the chosen edges to the nearest 5 points.

The result is written to the card as `risk_bins` and the UI reads it from the
API. Edges are **held stable across retrains unless a retrain violates (a) or
(b)** — a named risk class that moves weekly is worse than one that is 3 points
off, and a change to the edges is a product-visible event.

### The baseline ladder

Every rung is evaluated on **identical folds, identical rows, the same gate,
the same threshold, and the same composition arithmetic**. A rung that cannot
produce a quantile still produces one, by the same mixture inversion — the
ladder compares models, not model families' conventions.

| # | Rung | Occurrence | Magnitude | Why it is on the ladder |
|---|---|---|---|---|
| 0 | **Prevalence** | the base rate | `μ` of positives | Gives PR-AUC its floor. PR-AUC is not comparable across datasets without it, and IDEA.md's example table has no floor row. |
| 1 | **Same-hour 7-day** (mandatory, IDEA §15) | exceedance frequency at the same local hour over the 7 available days ending at the cutoff (0…1 in 1/7 steps) | `observed_constrained_off_same_hour_mean_7d` | The baseline a domain expert would actually use. Computed **from the feature function**, per feature-spec story 50, so it and the model cannot disagree about "the last seven days". |
| 2 | **Logistic + linear quantile regression** | L2-regularised logistic | `statsmodels` quantile regression | The interpretable rung. Needs imputation, which the tree rungs do not — see below. |
| 3 | **Random forest / extra trees** | sklearn, default-ish depth | quantile forest | Non-linearity without tuning. Separates "the problem is non-linear" from "the problem needs boosting". |
| 4 | **LightGBM** | the served model | the served model | IDEA §16's choice, and the right one: tabular, dozens–hundreds of features, native NULL handling, native pinball objective, fast enough that a weekly retrain is a non-event. |
| 5 | **TFT** (benchmark only) | — | — | §17. Never served; see below. |

**Missing values are handled differently by rung, and the asymmetry is
deliberate.** LightGBM takes NULLs natively and **no imputation is performed at
any point in the served path**. This is not laziness: the feature spec makes
unavailability *meaningful* — a lag that does not clear `actuals_cutoff` is NULL
precisely because it was not knowable — and imputing it with a median would
destroy the one signal the gate encodes. Rungs 2 and 3 cannot take NaN, so they
get training-median imputation **plus an explicit `_is_null` indicator column**,
and the metrics table marks them. A ladder that quietly gave the weak rungs a
different feature vector would be measuring the imputation, not the model.

**Hyperparameters are fixed, published, and not searched during a retrain.** A
search inside the weekly retrain makes the artifact irreproducible and the
gate's comparison meaningless — the candidate would differ from the incumbent in
both data and configuration. Tuning is a separate offline pass whose output is a
new `model_config_version`; bumping it is a retrain trigger and the new config
must clear the same gate. The v1 configuration is small and conservative
(≤ 800 trees, `learning_rate` 0.05, `num_leaves` 63, `min_data_in_leaf` 100,
early stopping on the calibration window's pinball loss) and lives in the card.

**One model across subsystems, with `subsystem` as a categorical feature.** Four
per-subsystem models would starve S and N: the positives concentrate heavily in
NE, and the physics — oversupply against an export limit — is shared. Metrics are
still reported per subsystem, and a guardrail vetoes a candidate whose PR-AUC
collapses in any single subsystem even if the pooled number improves.

### The metric the gate uses

**`qloss_mwh` — the mean pinball loss of the composed hourly distribution,
averaged over the three served quantiles.**

```
qloss_mwh = (1/3) · Σ_{α ∈ {0.1,0.5,0.9}}  mean_t  ρ_α( y_t − Q_Y(α | x_t) )
        where ρ_α(u) = u·α        if u ≥ 0
                       u·(α − 1)  otherwise
```

Lower is better. Reasons it is *the* number and the alternatives are not:

- **It scores the composed prediction.** PR-AUC and Brier score stage one alone;
  MAE-on-positives scores stage two alone. A candidate that improves the
  classifier while degrading the magnitude model passes either of those and
  makes the product worse. Only a metric on `Q_Y` can see the composition.
- **It is a proper scoring rule for the thing shipped.** The product ships an
  interval. Pinball loss is minimised by the true quantile, so it cannot be
  gamed by widening or narrowing the band.
- **It is denominated in MWh.** A gate whose units are the product's own units
  is one a human can sanity-check. "0.03 better AUC" is not.
- **It needs no operating point.** F1, recall and precision all require a
  threshold on `p`, and choosing that threshold to make the gate pass is exactly
  the degree of freedom a gate should not have.

`recall` is what IDEA §18 singles out, and the reason it is not the gate is that
it is trivially maximised by a model that predicts curtailment always — while
`qloss_mwh` on a mixture is *sensitive to recall* through `1 − p` shifting the
quantile breakpoint. Recall stays in the table and gets a guardrail.

**The full metrics table**, reported for every rung, every run and every fold —
this is the IDEA §15 table, corrected for a hurdle model:

| Column | Grain | Notes |
|---|---|---|
| `prevalence` | fold | the floor for PR-AUC |
| `pr_auc` | fold, subsystem | occurrence, uncalibrated ranking |
| `brier`, `ece`, `mce`, `top_bin_gap` | fold | occurrence, calibrated |
| `f1@0.5`, `precision@0.5`, `recall@0.5` | fold | operating point **fixed at the calibrated 0.5**, stated |
| `f1@best`, `threshold@best` | fold | reported, never used by the gate |
| `mae_positives_mwh`, `smape_positives` | fold | magnitude, conditional |
| `pinball_10`, `pinball_50`, `pinball_90` | fold | the components |
| **`qloss_mwh`** | **fold** | **the gate** |
| `coverage_p10`, `coverage_p90` | fold, subsystem, local hour | target 0.90 each |
| `interval_width_mean_mwh` | fold | sharpness — a wide interval covers by cheating |
| `p50_unbiasedness` | fold | share below P50, target 0.50 |
| `crossing_rate` | fold | share of **settled** hours where the raw boosters crossed; the same rate over the fold's curtailed hours is published beside it as `coverage_crossing_rate` and is not interchangeable with it |
| `delta_lo`, `delta_hi` | fold | the conformal corrections themselves — `delta_lo` a multiple of the row's positive spread, `delta_hi` MWh |
| `day_total_coverage`, `peak_coverage` | fold | the ensemble's own calibration |
| `share_p50_zero`, `hours_per_day_p_ge_50` | fold | the deliverable to ticket 011 |
| `vintage_fidelity` | fold | never averaged across values |

### The fold-evaluation protocol

> **Naming.** What this section describes is *fold evaluation*: the
> walk-forward harness that scores model quality on held-out folds and produces
> `qloss_mwh`. It is deliberately **not** called a Backtest. `domain-model.md`
> §`Replay` and `Backtest` gives that noun to a different object — the aggregate
> of many Replays, each a full plan-and-score against the reference fleet,
> consumed by the hot-swap gate. Two harnesses, two outputs, two names.

**Expanding-origin walk-forward, fixed calendar test folds, never shuffled.**

The test-fold calendar is **fixed once and shared by every run in the A/B
matrix**, so that A-full, A-common, B-common and the archive-weather arm are all
scored on identical test rows. The training block is whatever each run's window
provides before that fold's start.

| Fold | Test period | Test days | Train block ends | Calibration window (last 90 d of train) |
|---|---|---|---|---|
| F1 | 2025-04-01 → 2025-06-30 | 91 | 2025-03-31 | 2025-01-01 → 2025-03-31 |
| F2 | 2025-07-01 → 2025-09-30 | 92 | 2025-06-30 | 2025-04-02 → 2025-06-30 |
| F3 | 2025-10-01 → 2025-12-31 | 92 | 2025-09-30 | 2025-07-03 → 2025-09-30 |
| F4 | 2026-01-01 → 2026-03-31 | 90 | 2025-12-31 | 2025-10-03 → 2025-12-31 |
| F5 | 2026-04-01 → 2026-06-30 | 91 | 2026-03-31 | 2026-01-01 → 2026-03-31 |
| F6 | 2026-07-01 → *today − 1* | growing | 2026-06-30 | 2026-04-02 → 2026-06-30 |

> **Three of these dates were wrong and are corrected.** F3, F4 and F6 spanned
> **91** days, not 90 — they had been computed as "quarter start minus three
> months", which lands on 90 days only when the months happen to sum that way.
> The 90-day rule is stated four times in prose and is the authority; the table
> is derived from it. Nothing downstream moves: F4's base fit is 133 days and
> F5's 223 either way, so the DESSEM verdict is still F5 and F6 only. The
> calendar loader now refuses a file whose pinned rows disagree with its own
> rules, so this class of drift cannot recur silently.

- **Quarterly test folds.** Short enough that six exist over the window, long
  enough that a fold contains a season rather than a weather regime. A monthly
  fold would have ~30 days and a handful of curtailment episodes, and the
  bootstrap over days would be too noisy to decide anything.
- **The first fold starts twelve months in.** The target is strongly seasonal —
  wind season in the NE, solar's annual cycle, the hydrological year — and a
  training block shorter than a year cannot contain the season it is asked to
  predict. 2024-04-01 → 2025-03-31 is exactly one year and the window opens where
  solar constrained-off begins.
- **F6 is the live edge.** It grows until it reaches a full quarter, at which
  point it freezes and F7 opens. The weekly retrain always scores against F6.
- **The calibration window is carved out of the training block, not shared with
  it.** Base learners are fitted on `train − calibration`; isotonic and the two
  conformal scalars are fitted on the calibration window; **the base learners
  are not refit afterwards.** Refitting would put the calibration data in-sample
  and shrink the conformal correction toward zero, which is the failure that
  produces a confident, narrow, wrong interval.
- **90 days, and it must be the *most recent* 90.** The usual objection —
  "you're throwing away your freshest data" — is inverted here. A conformal
  correction fitted to data far from the test period corrects for a stale error
  distribution. Recency is the property that makes the correction valid, and the
  cost is that the served model's base learners have not seen the last 90 days.
  That cost is bounded by the fact that fleet growth enters through
  `InstalledCapacityAsOf`, which is a *feature* read at the target date, not
  something the model learns from recency. Cross-conformal would recover the 90
  days at the cost of K trainings and a more strongly violated exchangeability
  assumption; it is recorded as the upgrade and not built.
- **No purge beyond the calibration split.** Trailing feature windows do cross
  the train/test boundary, but they cross it *forward* — a test row's 7-day
  aggregate is computed from labels in the training period, which is honest
  point-in-time information the serving path also has. There is no label leaking
  backward, so a López de Prado purge would remove real data to prevent a
  correlation that is not a leak. The gate-ablation test in the feature spec is
  what guards the actual direction of risk.
- **Never shuffled, and asserted.** A test asserts, per fold, that
  `max(train target_date) < min(test target_date)` and that the calibration and
  base-fit blocks are disjoint.

**The revision-optimistic label across the go-live boundary.** Let `T_go` be the
ingestion go-live date.

- A fold whose test period ends before `T_go` is **`revision_optimistic`** in
  full: features read through the gate still see a backfill in which every row
  shares one `ingested_at`, and labels are ONS's current restatement of a past
  it has rewritten in place.
- A fold whose test period starts after `T_go` is `point_in_time`.
- **A fold that straddles `T_go` is split at `T_go` and reported as two rows.**
  It is never averaged, because averaging is precisely how a caveat disappears.
- **A `revision_optimistic` fold may not be the deciding fold for the hot-swap
  gate once at least one `point_in_time` fold exists.** Until then the gate runs
  on revision-optimistic data, the card says so, and `/v1/meta` surfaces it.
- **The revision premium is published.** The first fold to exist in both forms —
  scored once against the labels as ingested at the time and once against the
  latest vintage — yields `revision_premium_qloss`, the difference between the
  two. It is the measured size of the caveat every earlier number carries, and
  it is the honest answer to "how much should I discount the
  2024–2025 evaluation". Nothing else in this project measures that.

Note the asymmetry the feature spec already established and this protocol
inherits: **labels are always read `AsOf(now)`**, in training and in evaluation
alike, so the model learns and is scored against the settled value. The
`revision_optimistic` label is about *features* and about ONS's rewriting of
history, not about which vintage of the label was used.

### The weather lead-time A/B

The lead-time research names this the acceptance test for its own
recommendation, and leaves it to the pipeline. It costs one extra training run
per fold.

| Arm | Training feature | Evaluation feature |
|---|---|---|
| **Lead-matched** (served) | Single Runs, D−1 12Z, `models=ecmwf_ifs` | Single Runs, D−1 12Z |
| **Archive** (control) | Historical Forecast archive, same variables, same centroids | **Single Runs, D−1 12Z** |

**Both arms are evaluated on the lead-matched features**, because that is what
serving provides. An archive-trained model evaluated on archive features is the
overstated number the research exists to prevent, and it is reported too — as a
third column, labelled `archive→archive (not achievable)` — because the *gap
between the two archive columns* is the size of the leak, in the product's own
metric, and that is the number worth putting in front of a human.

Run on `dessem_free_v1` at `gate_late` across all six folds, once, not on every
retrain. What it reports, and what it is expected to show:

- `Δ qloss_mwh` — the point-forecast harm. The research predicts this is the
  *smaller* effect.
- `Δ coverage_p10`, `Δ coverage_p90`, `Δ interval_width_mean_mwh` — **the harm
  the research predicts lands here**: an archive-trained model has learned that
  the weather feature is more trustworthy than it is, so its intervals should be
  too narrow and under-cover when evaluated lead-matched. If coverage does *not*
  degrade, the errors-in-variables argument did not survive the move from a
  linear model to boosted trees, and that is worth knowing.
- `Δ delta_lo` — how much extra conformal correction the archive arm needs. This
  is the cleanest single expression of the effect: the correction is literally
  the amount by which the interval was wrong.

**The second experiment the research left open** is also run here because it
needs the centroids: recompute the train↔serve correlation `r` on the **real
capacity-weighted aggregate** rather than per point. The measured `r = 0.88` is
an upper bound on the harm; aggregation will raise it. If `r > 0.95`, the map's
claim about the size of the gap should be revised downward, and this becomes a
standing model-health metric rather than a one-off. It is cheap: two series, one
correlation, no training.

**Both experiments now have an answer about whether they can be run at all**,
and the answers differ. The correlation is built and runnable —
`apps/ml/src/wattsteer_ml/weather_reads.py` reads both aggregates out of the
stored weather versions and the real weight vector, recovering the archive
series as the shortest-lead slice, one publication cut per valid hour. The A/B
itself is **not** runnable, and for a reason stronger than "the archive is not
ingested": the archive is twenty-four publication cuts inside one target day,
the gate writes one, and `feature_rows` accepts no instant at all, so no setting
of the axes yields an archive-built feature row. The block therefore carries an
`UnmeasuredLeadTime` with the reason named, and the correlation beside it. See
`feature-engineering.md` §Seam 7, which owns both.

### The DESSEM A/B — the trade, framed for one sitting

The feature spec establishes the three-run design and the fairness rule. This
spec adds the fold arithmetic, the unit of comparison, and a third option.

**Which folds are decision-grade.** `dessem_augmented_v1` starts 2025-05-23. A
run is decision-grade in a fold only if its base-fit block (training block minus
the 90-day calibration window) is at least **180 days**. For B that means
`2025-05-23 + 270 days = 2026-02-17 ≤ train_end`, which qualifies **F5 and F6**
only.

| Run | Feature set | Window | Decision-grade folds | Isolates |
|---|---|---|---|---|
| A-full | `dessem_free_v1` | 2024-04-01 → now | F1–F6 | the product's actual set-A model |
| A-common | `dessem_free_v1` | 2025-05-23 → now | F5, F6 | the short-window handicap |
| B-common | `dessem_augmented_v1` | 2025-05-23 → now | F5, F6 | **DESSEM's contribution**, vs A-common |

**So the DESSEM verdict rests on two test quarters — roughly 150 target days —
and that is the honest sample size.** It is stated here rather than in a
footnote because it is the single largest reason the answer might be wrong, and
because nothing can be done about it: DESSEM's history is what it is.

A six-month base fit cannot contain a full annual cycle, so B is evaluated at a
structural disadvantage. **That disadvantage must not be attributed to DESSEM's
features**, and A-common exists precisely to absorb it: A-common shares the
window, so the `B-common − A-common` contrast is clean and the
`A-full − A-common` contrast prices the history separately.

**The unit of comparison is not pinball loss.** `Δ qloss_mwh` is the gate's
metric and it is the wrong currency for a product decision, because the other
side of the trade is ten hours of operator notice and nobody can convert
hours into pinball loss. So the A/B additionally reports, for the same days:

> **`Δ recovered_floor_mwh`** — both forecasts run through the optimizer's
> simulator on the same days, with the same reference fleet, scoring the same
> way `flex-optimizer.md` specifies. The result is the difference in the number
> the product actually promises, per day, in MWh.

That is a quantity a human can weigh against ten hours, because ten hours
of notice is worth whatever it lets an operator do with the same fleet. The
reference fleet is a fixed, published scenario (one battery, one shiftable load,
the sizes the Mitigate default uses once its `SHIFT_EXCEEDS_BASELINE` fixture is
corrected) and is stamped on the comparison so the number is reproducible.

**The decision, framed:**

| | A-full at `gate_early` | A-full at `gate_late` | B-common at `gate_late` |
|---|---|---|---|
| Published | D−1 ~09:00 BRT | D−1 ~19:00 BRT | D−1 ~19:00 BRT |
| Weather run | 00Z (RMSE 4.76) | 12Z (RMSE 4.38) | 12Z |
| DESSEM | ✗ structurally | ✗ | ✓ |
| Training history | 29 months | 29 months | 15 months |
| Decision-grade folds | 6 | 6 | **2** |
| Operator notice | +10 h | — | — |


> **Corrected.** This document said *eleven* hours of operator notice in five
> places. The authority is `gate_at` in `0016_the_feature_gate.sql`, which puts
> `gate_early` at D−1 09:00 BRT and `gate_late` at D−1 19:00 BRT — **ten** hours
> apart. Found by forecaster 18, which deliberately wrote no number into Python
> either way: its `operator_notice` names `gate_at` and its two instants and
> converts nothing, so the figure cannot go stale in a third place.
> **Ship DESSEM iff** B-common's `recovered_floor_mwh` advantage over A-common,
> on F5–F6, is positive under the same paired block bootstrap the hot-swap gate
> uses (P ≥ 0.9), **and** the product accepts a 19:00 BRT publication for the
> DESSEM-conditioned view. Below the bootstrap bar, ship A-full and keep the
> `dessem_*` features as a monitored candidate that is re-run each quarter as
> the window lengthens.

**And the third option, which dissolves the trade.** The ten hours are only a
cost if the late artifact *replaces* the early one. It does not have to. The
bitemporal design already treats the D−1 12Z weather run as a superseding
vintage of the same valid hours, and the domain model requires every surface to
name its `ForecastOrigin`. So:

> **Serve two artifacts: A-full at `gate_early`, published ~09:00, and the
> winner of (A-full, B-common) at `gate_late`, published ~19:00 and superseding
> it.**

This is the recommendation. It costs a second artifact lane, a second model
card, a doubled retrain (seconds) and a second row in the evaluation matrix; it
costs *nothing* in operator notice, and it makes the DESSEM question a question
about the evening view alone — which is a much smaller decision, and one the two
decision folds can actually carry. The early view exists either way, so a wrong
DESSEM call is recoverable rather than a product regression.

### The transformer benchmark

**Temporal Fusion Transformer, not PatchTST.** PatchTST's strength is a long
look-back over the target series itself, and this problem's look-back is
*deliberately crippled by the gate*: the nearest usable same-hour actual is
t−48 h and most of the vector is exogenous. TFT is the covariate-aware
architecture and is therefore the honest comparison — it is being asked the same
question LightGBM is asked.

Run **once, offline**, on `dessem_free_v1` at `gate_late`, on the same folds,
scored by the same `qloss_mwh` through the same composition arithmetic (a TFT
producing quantiles directly still feeds the mixture inversion, with its own
occurrence head). Reported in IDEA §17's table shape with `training time` and
`explainability` columns filled in honestly.

**It is never promoted, and that is enforced rather than agreed.** The artifact
card carries `estimator_family`, and the hot-swap gate refuses any candidate
whose family is not in the served allow-list `{"lightgbm"}`. Changing the
allow-list is a code change with a review, which is what "we agreed it stays a
benchmark" should mean six months from now.

**The allow-list is the whole of the enforcement, and that is a consequence of
the lane.** The benchmark runs at the spec's own profile — `dessem_free_v1`,
`gate_late`, 5 MW — which is exactly the evening view's lane triple, so unlike
the threshold sweep it has no lane of its own that nobody serves. It is compared
against the served model in the served model's lane, because that is the model
it is a benchmark of. The `transformer_benchmark` block therefore lands on the
*served* artifact's card, publishes both arms' figures side by side, and carries
**no ordering, no delta and no preferred arm**: the only act this comparison
could license is a promotion, and a published Δ would be that argument written
down.

### The reason-code model — ruled out of scope, not deferred

IDEA §13's Model C wants `P(ENE) 71% / P(CNF) 24% / P(REL) 5%` on the screen.
The ticket makes it conditional on the labels existing at usable grain. They do
— and the model is still ruled out. The grain was the wrong test.

**Grain: passes.** Reasons are published per `ReportingEntity` on ONS datasets 1
and 3. Aggregating them *upward* to a subsystem is an aggregation of
observations and is legal — the feature spec already ships
`observed_reason_share_ene_7d` and its siblings on exactly that basis. Only the
downward direction is forbidden.

**Four reasons it does not ship, ranked:**

1. **The dominant discriminator is a variable in no ingested dataset.** `REL` is
   *indisponibilidade externa (elétrica)* — a line or transformer being
   unavailable. Nothing in either feature set carries transmission availability.
   The feature spec says this in as many words about the export-capability
   proxy: "it cannot see a temporary derate from a line outage — which is
   exactly the condition `REL` names." Predicting `REL` day-ahead from these
   features is predicting an unplanned outage from the weather. This is not a
   label problem; it is an absent-predictor problem, and no amount of data fixes
   it.
2. **The target is a share, and shares are undefined on most rows.** At
   subsystem-hour grain the reason target would have to be the share of curtailed
   MWh by reason. On every hour below threshold — the majority — there is no
   curtailment to apportion and the target does not exist. The model would train
   on the positive subset, i.e. a third hurdle stage, tripling the composition
   surface for the least load-bearing output.
3. **The class set and the enum disagree, and the disagreement moves.** `PAR` is
   a live domain member observed **zero times in five sampled months**. The
   domain model already rules that the classifier's class set is derived from
   observed data, not from the enum — which means the day `PAR` first appears,
   a model whose output is an enum rendered on a screen silently gains a class
   it was never trained on. Monitoring for `PAR` is already specified; training
   on a vocabulary that can grow underneath the UI is not.
4. **The product already has the honest version.** The Explain screen shows
   *observed* reasons at the grain ONS reports them, with `dsc_restricao` as
   displayable evidence. That is a fact. IDEA's mock puts a forecast where an
   observation would do, and the observation is better: it names the actual
   network element.

**The reopening trigger, so this is a ruling and not a shrug:** a
transmission-availability or outage-schedule dataset is ingested (ONS Sintegre
is the candidate, unexamined), **and** `PAR` has been observed, **and** the
reason shares already in the feature vector show non-trivial importance in the
occurrence model. All three, because the first alone would not fix the class-set
instability and the third alone is not evidence that reasons are predictable.

Until then: reasons stay as **features** (aggregated upward, trailing, already
specified) and as an **observed display**. Nothing forecasts them.

### The threshold sweep

The feature function takes `threshold_mw` as an argument, so the sweep costs
three fold-sweeps and no rebuild. It is run once, on `dessem_free_v1` at
`gate_late`, at **1 / 5 / 10 MW**, and reports per threshold: `prevalence`,
positives per local hour, `pr_auc`, `qloss_mwh`, `coverage_p10`, and the
optimizer-facing `share_p50_zero`.

**5 MW remains the default and only moves by an explicit decision.** The sweep's
job is to produce the evidence, and there are two conditions under which the
evidence would force a move: a positive-class prevalence below ~3% (too rare for
the classifier to learn a usable ranking, and the risk classes collapse into
one), or above ~40% (the threshold has stopped selecting anything and
`has_curtailment` no longer names an event). Between those, 5 MW stands on the
domain model's reasoning — 1 MW is inside the rounding noise of a subsystem sum
and 10 MW discards dispatchable events — and the sweep is published rather than
acted on.

Each threshold produces its own artifact lane, since the triple
(feature set, gate profile, threshold) is the artifact's identity. Only the
5 MW lane is promoted for serving, and
`evaluation/threshold_sweep.py`'s `assert_no_sweep_lane_promoted` is the check
that makes that a property of the volume rather than of which lanes the retrain
driver happens to walk: a sweep arm may accumulate refusals in
`promotions.jsonl` and may not accumulate a `promote`.

**Two of the six figures move with the threshold for reasons that are not about
the model, and the block has to say so.** Because `Q_Y(q) = 0` for every
`q ≤ 1 − p`, the composed P50 is zero exactly where `0.50 ≤ 1 − p`. Lowering the
threshold raises the prevalence, which raises `p`, which moves hours across that
breakpoint — so `share_p50_zero` falls at 1 MW with no change in model quality
whatever. The published block therefore carries `share_p50_forced_zero`, the
same quantity computed from `p` through the composition's own comparison, and
refuses to be built if the two disagree. `coverage_p10` carries the hazard from
the other side: it is measured over curtailed hours, and *which* hours those are
is precisely what the threshold changes, so the three arms' coverages are three
populations and the denominator travels with each. `qloss_mwh` is the one figure
that survives a change of threshold — its target is the observed MWh, which does
not move with `τ` — and it is the only one that may be read across the arms as a
difference in quality.

### The artifact, and exactly what the gate checks

**Layout.** One directory per artifact lane, so that "newest" is well-defined
within a lane and meaningless across lanes:

```
/data/models/
  promotions.jsonl                                   # append-only decision log
  dessem_free_v1__gate_late__thr5/
    2026-08-28T03:11:07Z.joblib                      # the bundle
    2026-08-28T03:11:07Z.card.json                   # model card + metrics
    2026-08-21T03:09:44Z.joblib
    2026-08-21T03:09:44Z.card.json
  dessem_free_v1__gate_early__thr5/
    …
```

ISO-8601 UTC stems sort meaningfully, so there is no `current` symlink to go
stale — the existing rationale in `apps/ml/src/wattsteer_ml/artifacts.py`
survives intact. **Two changes to that module are required and are called out
rather than assumed:** `inspect()` must walk one level of lane directories
instead of a flat `iterdir()`, and `current` must mean *the newest artifact
named by a `promote` decision in `promotions.jsonl`*, not the newest file. A
candidate that fails the gate is still written to the volume — that is the point
of writing it — and a naive newest-file rule would serve it.

**Bundle contents** (one joblib of a frozen dataclass, so a partial load fails
loudly):

- the occurrence booster, the three quantile boosters, the conditional-mean
  booster, the share booster;
- the isotonic calibrator and its clip bounds;
- `δ_lo`, `δ_hi`;
- `μ_sub[subsystem, local_hour]` (96 floats);
- the PIT residual matrix `U` (n_days × 24) for the path ensemble;
- `risk_bins`;
- the ordered feature-name list with dtypes and categorical levels.

**The model card** (`*.card.json`) — everything needed to reproduce, audit or
refuse the artifact:

| Group | Fields |
|---|---|
| Identity | `artifact_id`, `created_at`, `estimator_family`, `model_config_version`, `git_sha_api`, `git_sha_ml` |
| Lane | `feature_set`, `feature_set_version`, `gate_profile`, `threshold_mw`, `subsystems` |
| Contract | **`feature_hash`** (sha256 over the ordered feature names *and* the `feature_rows` function definition), `centroid_set_version`, `calendar_day_generator_version`, `publication_lag_hours` table, weather model pin (`ecmwf_ifs`) and run cycle |
| Data | training window, base-fit window, calibration window, row counts, positive counts, per-fold `vintage_fidelity` |
| Calibration | reliability curve points, `reliabilitySampleHours`, `reliabilityWindow`, `reliabilityFidelity`, `ece`, `mce`, `top_bin_gap`, `risk_bins` |
| Quantiles | `δ_lo`, `δ_hi`, per-fold and per-subsystem coverage, `coverage_crossing_rate` (the crossing rate over this block's curtailed hours; the settled-hour `crossing_rate` is the metrics table's) |
| Metrics | the full table above, per fold and per rung, plus the baseline ladder |
| Experiments | `lead_time_penalty` block, `dessem_delta` block, `threshold_sweep` block, `transformer_benchmark` block |
| Environment | Python, lightgbm, sklearn, numpy versions |
| Decision | `gate` result block: bootstrap statistic, guardrail values, `decision`, `reason` |

**Every figure the card declines to state is a declared constant, and the
census of them is assembled rather than listed.** The card carries named
absences as well as numbers — `ARCHIVE_FEATURES_HAVE_NO_SHAPE` on the
lead-time block, `CORRELATION_NOT_RUN_YET` beside it, `NOT_RUN_YET` on the
DESSEM block, `NO_TFT_IMPLEMENTATION` and `NO_TRAINING_COST_MEASURED` on the
transformer benchmark, `MARGINAL_COVERAGE_NOT_RUN_YET` in the band's claim note,
and the floor guardrail's `not_applicable` on the decision — because a card with
no block and a card naming what is absent look identical to anybody grepping for
the figure, and only one of them is true.

Each of those constants is a `DeclinedFigure` (`wattsteer_ml/declined.py`): a
`str`, so every card field and comparison that already reads one is unchanged,
carrying three things the sentence alone could not say — which figure is
withheld, where a caller meets it, and whether it is **`unrunnable`** or merely
**`unrun`**. That distinction is load-bearing and this spec's own history is
why: forecaster 16 says an arm cannot be built, forecaster 18 chose its constant
precisely so that it would not read like that, and forecaster 24 followed 18.

`GET /v1/meta` publishes the census, taken by walking this package for declared
constants rather than from a list — so a reason added anywhere under
`wattsteer_ml` appears on the surface with nothing else edited, and
`apps/ml/tests/test_declined_figures.py` reconciles the walk against a source
scan so that a constant it cannot see is a failure rather than a silent
omission. See `docs/specs/api-surface.md` §1 for why the census is on `/v1/meta`
and not on the card it mostly describes.

**The hot-swap gate — the checks, in order. All must pass.**

1. **Lane identity.** Candidate's `(feature_set, gate_profile, threshold_mw)`
   equals the incumbent's. A different triple is a different lane and is never a
   swap.
2. **Estimator allow-list.** `estimator_family ∈ {"lightgbm"}`. This is where
   the transformer's benchmark-only status is enforced.
3. **Feature contract.** The candidate's `feature_hash` equals the hash the
   *live* `feature_rows` function produces right now. If the SQL changed, the
   **incumbent is also invalid** — the gate refuses the swap *and* raises,
   rather than promoting into a mismatch or leaving a stale model serving a
   changed contract silently.
4. **Freshness and coverage.** The newest training target date is within 7 days
   of now; the evaluation fold has at least 60 test days; no fold used has a
   `vintage_fidelity` worse than the incumbent's deciding fold.
5. **The gate proper — a paired block bootstrap, no constant.** On the shared
   newest fold, resample **whole target days** with replacement, 2,000 times,
   and compute `qloss_mwh` for candidate and incumbent on each resample.
   Promote iff `P(qloss_candidate < qloss_incumbent) ≥ 0.90`.
   *Whole days*, because hours within a day are strongly dependent and an
   hour-wise bootstrap would report a confidence the data does not support.
   **Cold start** (no incumbent): the same test against **rung 1, the 7-day
   same-hour baseline**. A model that cannot beat the baseline a domain expert
   would use by hand does not get served, and that rule needs no prior numbers
   either.
6. **Guardrails — vetoes, each with a stated constant.** These are the only
   invented numbers in the gate, and they are vetoes rather than the decision
   precisely so that a wrong constant blocks a swap rather than silently
   choosing one:
   - `pr_auc ≥ incumbent.pr_auc − 0.02`, pooled **and** in every subsystem;
   - `coverage_p10 ∈ [0.85, 0.97]` and `coverage_p90 ∈ [0.85, 0.97]`;
   - `p50_unbiasedness ∈ [0.45, 0.55]`;
   - `ece ≤ 0.05`;
   - `crossing_rate ≤ 0.01`, the rate over every settled hour — the row's
     attribute, never a card field, and never the curtailed-subset figure;
   - `recall@0.5 ≥ incumbent.recall@0.5 − 0.05` (IDEA §18's emphasis, as a
     floor rather than as the objective).
7. **Serving smoke, on the real vector.** The candidate produces a complete
   24-hour band for every subsystem for *tomorrow*, from the live feature
   function: no NaN, `P10 ≤ P50 ≤ P90` in every hour, a finite and ordered day
   total and peak for every subsystem, and no feature whose serve-time NULL rate exceeds
   its training NULL rate by more than 5 percentage points. This is the check
   that catches an upstream dataset having gone quiet, which no historical
   metric can see.

   > **This clause used to require the day total inside `[Σ P10, Σ P90]`, and
   > that is not an invariant of this mixture.** The composed P90 is exactly
   > zero wherever `p ≤ 0.10`, so a quiet subsystem has `Σ P90 = 0` while its
   > day total does not. Measured on the shared fixture fold with a real
   > trained bundle: `N` gives `Σ P90 = 0` against a day P90 of 212.6, and `SE`
   > likewise, while `NE` and `S` do satisfy the containment. A gate enforcing
   > it would refuse every candidate. Three tickets found this independently —
   > forecaster 07 from the ensemble, api-surface 08 from the fixtures, and
   > forecaster 13 from the gate — which is what a genuine property of the
   > model looks like rather than a bug. Note also that computing the bound at
   > all trips seam 2's grep-level invariant, which fails the build on any line
   > that adds a band's quantile to anything: the containment cannot be checked
   > without writing the arithmetic the spec forbids elsewhere. The replacement
   > catches what this clause was for — a draw that failed — without asserting
   > something false.
8. **Record the decision either way.** One line appended to `promotions.jsonl`:
   `{artifact_id, lane, decision: "promote"|"refuse", reason, bootstrap_p,
   guardrails, at}`. The card is written regardless, so a refused candidate is
   inspectable. **Rollback is an append**, never a delete: a line naming an
   earlier artifact restores it, and the evidence of the bad promotion survives.

**Serving.** `current(lane)` is the artifact named by the most recent `promote`
line for that lane. When there is none, `/v1/forecast/day-ahead` **refuses** —
it keeps the stub's stated rule that it will never return invented numbers — and
`/v1/meta` distinguishes the three states the volume can be in (`no artifact`,
`artifact present, none promoted`, `promoted`) from the two it already
distinguishes about the mount.

**Every served forecast is persisted** as `Forecast` rows at
(`subsystem`, `valid_time`) grain with a `wattsteer` `ForecastOrigin` whose
`run_label` is the `artifact_id` and whose `published_at` is the gate instant —
carrying `p`, the three quantiles, `E[Y]`, and the technology split. Replay then
reads "what did we say at D−1" through `AsOf(published_at)` rather than
re-running a model that has since been retrained, which is what makes ticket
012's integrity question answerable at all.

## Testing Decisions

**What makes a good test here.** The unit tests that matter assert *properties
of distributions*, not that a function returns a float. Two of them are generic
leak detectors at the model layer, mirroring the feature spec's gate ablation
one layer down.

**Seam 1 — the composition, as arithmetic.** Fixture-driven, no model:
`Q_Y(q) = 0` for every `q ≤ 1 − p` and only then; `Q_Y` is non-decreasing in `q`;
`Q_Y(q) > τ` whenever `q > 1 − p`; `E[Y] ≥ Q_Y(0.5)` for every `p < 0.5`;
`E[Y] = p·Ê[Y|Y>τ] + (1−p)·μ_sub` exactly. Boundary cases: `p = 0` (band is all
zeros, expectation is `μ_sub`), `p = 1` (band is `Q_pos` shifted by `δ` and
nothing else), and the clipped endpoints isotonic can produce. With a `δ` two
orders of magnitude larger than the band, the `q ≤ 1 − p` branch still returns
exactly zero — the correction is applied inside the positive branch and cannot
reach the point mass.

**Seam 2 — quantiles do not add.** On a fixture where every hour's band is
known and the ensemble is seeded: assert the day-total P90 is strictly less than
`Σ_t P90_t`, and the day-total P10 strictly greater than `Σ_t P10_t`. Assert no
code path in the ML service computes a day-grain figure by summing a band — a
grep-level test in the same spirit as the UI's, because this is the invariant
most likely to be broken by a well-meaning optimisation.

**Seam 3 — the ensemble is calibrated.** The stored PIT matrix `U` is uniform on
`[0,1]` per column within a Kolmogorov–Smirnov tolerance; the ensemble's own
marginal quantiles reproduce `Q_Y` per hour within Monte-Carlo error at 500
draws; day-total coverage and peak coverage are within tolerance on the
calibration window. A non-uniform `U` means the marginals are miscalibrated and
every day-grain number is meaningless, and this is the only test that sees it.

**Seam 4 — conformal coverage, on synthetic data with a known answer.** Generate
exchangeable data with a known conditional distribution, fit deliberately
mis-scaled quantile regressors, and assert the conformalised interval's
empirical coverage reaches nominal ± ε while the uncorrected one does not.
Assert the two tail corrections are computed independently (perturbing only the
upper tail's residuals leaves `δ_lo` unchanged). Assert the **application point**
too, since that is where the first implementation was wrong: the served P10 and
P90 each move by exactly their own `δ` at every `p` whose edge is positive, and
by nothing where it is not. The knot correction is reconstructed in the test file
so its realised-share table is measured rather than remembered, and so that
"the floor did not move" is asserted as bit equality between the two rules
rather than as prose.

**Seam 5 — calibration.** Isotonic fitted on synthetic over-confident
probabilities reduces ECE and preserves monotonicity; output never equals 0 or
1; a Platt fit on the same data is *worse* in the top bin — the test that
records why isotonic was chosen, so a future session that swaps it has to
confront the evidence. The reliability curve is computed from out-of-fold
predictions only: a test asserts the row set it consumes is disjoint from the
calibration window.

**Seam 6 — the shuffled-label control, the generic detector.** Run the whole
pipeline — feature build, both stages, calibration, conformal, folds, metrics —
with the labels randomly permuted *within each fold's date range*. Assert
`pr_auc ≈ prevalence` (within a bootstrap CI) and `qloss_mwh` no better than the
prevalence rung. **If a shuffled-label run scores well, the harness leaks**, and
this test does not need to know how. It is the model-layer twin of the feature
spec's gate-ablation test, and it is the single most valuable test in this spec.

**Seam 7 — fold discipline.** Per fold: `max(train target_date) <
min(test target_date)`; calibration and base-fit blocks disjoint; the
calibration window is the 90 days immediately preceding the train end; every run
in the A/B matrix scored on an identical test-row set (assert equal row hashes,
not equal counts). A test that the fold calendar is *data*, not code, and that
changing it invalidates cached fold results.

**Seam 8 — the gate.** A candidate byte-identical to the incumbent must **not**
promote (bootstrap P ≈ 0.5). A candidate strictly better on every test day must
promote. A candidate with a mismatched `feature_hash` must refuse *and* raise. A
candidate with `estimator_family = "tft"` must refuse. Each guardrail is
exercised by a candidate that fails only that guardrail. A refusal writes a card
and a `promotions.jsonl` line; a rollback line restores the earlier artifact and
deletes nothing.

**Seam 9 — determinism and round-trip.** Same inputs, same seed → identical
`feature_hash`, identical predictions, identical `δ_lo`/`δ_hi`. Reloading the
artifact from the volume reproduces predictions bit-identically. A card whose
`feature_hash` disagrees with its bundle's stored feature list fails to load.

**Seam 10 — the serving contract.** `/v1/forecast/day-ahead` returns monotone
bands, names the `artifact_id` and the `ForecastOrigin`, stamps `threshold_mw`
and `gate_profile`, and **refuses** with a typed body when no promoted artifact
exists. The per-technology field is typed as a scalar, so a band cannot be
returned there. Persisted `Forecast` rows round-trip through `AsOf` and return
the same numbers the endpoint served.

**A lane has four states, not three.** Beyond `no_artifact`,
`present_unpromoted` and `promoted`, there is `unresolvable`: the promotion log
is truncated, unreadable, or names an artifact that is no longer on the volume.
Folding it into one of the other three would mean guessing which of them holds
at the exact moment the volume is telling us it cannot say — and the promotion
log exists to stop that guess being made. `present_unpromoted` also covers the
case where the log holds only *refusals*, whose reasons stay readable, which is
why it is a recorded decision rather than an absent file.

`packages/core`'s `LANE_STATES` carries three of the four. `promoted` is absent
there deliberately: it is not an absence, so it never reaches a
`MODEL_UNAVAILABLE` envelope.

**Serviceability is a fifth fact, not a fifth state.** `promoted` says what the
promotion log decided; it does not say the artifact will load. Check 3 marks an
incumbent's card invalid when the live `feature_rows` stops producing the hash
it was fitted against, and the loader then refuses it — so a lane can be
`promoted` and serve nothing, which is exactly what
`0039_the_gate_over_a_backfill.sql` did to both serving lanes by repairing the
feature gate's `as_of` *inside* `feature_rows` and moving `feature_hash` on
purpose. The states stay four, because a migration revokes no log line and
`LANE_STATES` is a shared vocabulary; the debt is reported beside them, by
`artifacts.LaneView` and on both `/v1/meta` endpoints, as `usable`,
`retrain_owed`, `contract_fault`, `card_error` and one `unusable_reason`
sentence.

`retrain_owed` is true in **one** situation — the promoted artifact is bound to
a departed contract — and never for the other ways a lane can be unserviceable.
Nothing trained, nothing promoted and a damaged volume are answered by training,
by waiting and by a repair, and calling those a retrain debt would make the
phrase mean "not serving". A promoted card that will not parse is therefore
`card_error` and not `contract_fault`: it makes the lane unusable, but the
volume cannot say from there whether the contract also moved, and inventing the
answer either way is the guess the promotion log exists to prevent. In particular a run of `freshness_and_coverage`
refusals is the gate working (see seam 11's paragraph on check 4's floor), so
`unusable_reason` says so in as many words during the two thirds of a quarter
when it is expected: a sentence that read as an alarm for eight weeks out of
twelve would train an operator to ignore the one that is not.

**Seam 11 — live, scheduled.** The weekly retrain runs end to end against real
Postgres, produces a card, reaches a decision, and appends exactly one line.
Wall-clock and peak memory are recorded so a retrain that starts to outgrow the
service is visible before it fails.

Built by ticket 15. The schedule is one repeatable job on the worker's existing
queue — `apps/api/src/jobs/retrain.ts`, `10 3 * * 5` UTC, registered beside the
two publications and nowhere else — and the run itself is
`wattsteer_ml.retrain`, spawned as a child interpreter by
`POST /internal/retrain` so that the peak RSS it records is the retrain's and not
the service's. **The run id is the artifact id**, which is what makes a retry
idempotent: a lane already carrying a decision line for the run appends nothing.

Two consequences of the constants above are worth stating where they can be
read together. Check 4's sixty-test-day floor and the quarterly live edge mean a
candidate can only be promoted in roughly the last third of each quarter; the
weekly runs before that write cards and refusals, which is the gate working
rather than a fault. And "the newest training target date" in check 4 is read as
the newest target date the *run's data window* reached, not the base fit's last
day — under a growing live edge those are two months apart, and the rule exists
to notice that ingestion has stopped. The card records both.

**Acceptance gate.** Default `bun test` / `pytest` pass with no network and no
database (seams 1–5, 8, 9 are fixture- and synthetic-data-driven). Seams 6, 7,
10 pass against real Postgres under the existing env-var gating. Seam 11 passes
on its schedule. The full fold sweep for all four runs completes inside the
weekly retrain's budget, and the baseline ladder table is populated for every
rung.

## Out of Scope

- **SHAP, driver grouping, domain rules and the narration.** **Diagnosis spec**
  (ticket 010). This spec owes it one thing and states it here: SHAP over a
  hurdle explains *two* models, and the composition above is what determines
  what a combined attribution would even mean. Nothing is attributed here.
- **The optimizer, the simulator and `recovered_floor_mwh`'s arithmetic.**
  **Flex optimizer spec** (ticket 011). Consumed here only as the unit for the
  DESSEM comparison.
- **Time Machine screens, Backtest aggregation for humans, and which days are
  replayable.** **Replay spec** (ticket 012). This spec supplies the per-fold
  artifacts and the persisted D−1 forecasts that make a fold-honest replay
  possible; choosing between "fold-specific model", "test folds only" and
  "label it" is ticket 012's call, and all three are now buildable.
- **API paths, response envelopes and caching.** Ticket 013. The payload's
  *content* is fixed here; its routing is not.
- **The reason-code model.** Ruled out above with a three-part reopening
  trigger. Not deferred.
- **Intraday and multi-horizon forecasting.** Ruled out by the map; IDEA §23's
  1/3/6/12 h ladder is not built.
- **Per-plant and per-reporting-entity forecasts.** The forecast grain is the
  subsystem. Observed curtailment is shown per entity; nothing is predicted there.
- **Exposing the path ensemble across the API.** It exists internally and powers
  every day-grain number. Serialising 500 × 24 paths into the contract is the
  upgrade that unblocks scenario-based optimisation, and it waits for ticket 011
  to want it.
- **Per-hour or per-subsystem conditional conformal correction.** Reported,
  never applied; the calibration window cannot support 24 or 96 scalars.
- **Correcting the served P90 where `p ≤ 0.10`.** The band is zero there because
  `0.90 ≤ 1 − p`, and that is the model stating at least a 90% chance of no
  curtailment. Lifting it would manufacture curtailment in exactly the hours the
  classifier is most confident about. The share of scored hours in that state is
  published (`upper_correction_realised`) and bounds `coverage_p90`; the answer
  to a low value is a better classifier, not a wider band.
- **Cross-conformal / jackknife+ calibration.** Recorded as the upgrade that
  would recover the 90 held-out days at the cost of K trainings.
- **Recency-weighted training samples.** A decay constant is another invented
  parameter, and the weekly retrain already re-fits. Candidate, not built.
- **Hyperparameter search inside the retrain.** Structurally excluded — it would
  make the gate's comparison meaningless. Tuning is an offline pass that bumps
  `model_config_version`.
- **Model registries (MLflow and friends), online learning, GPU, feature
  stores.** The volume plus `promotions.jsonl` is the registry; the feature
  function is the store.
- **CMO price features.** Excluded upstream by the feature spec, with the open
  question about whether the published series is DESSEM's own output. If that
  question resolves the wrong way, this spec's A/B matrix changes shape too.

## Further Notes

**The honest headline is that IDEA.md's §13 + §14 pairing does not compose, and
the fix is one line of arithmetic that changes what the product can promise.**
`p × magnitude` is an expectation; the mixture inversion is what turns two models
into a band. Everything else in this spec — the conformal correction, the path
ensemble, the gate's metric — follows from taking that one line seriously.

**The sharpest thing this spec hands back is to the optimizer, and it is not
what the optimizer expected.** `flex-optimizer.md` rejected planning on P10 on
the argument that a hurdle makes the hour-wise P10 zero in most hours, and
called it falsifiable. It is not falsifiable — it is arithmetic, and it is
confirmed: P10 is exactly zero unless `p > 0.90`. But the same arithmetic says
P50 is exactly zero unless `p > 0.50`, which applies to the posture the
optimizer *did* choose. The plan's shape is therefore set by the classifier's
operating region, not by the magnitude model. `share_of_days_with_no_non_zero_p50_hour`
is published per fold so ticket 011 can see whether its own posture collapses on
the days that matter.

**The gate needed no constants and that was the whole difficulty.** The map
records the hot-swap gate threshold as unspecifiable before the first honest
numbers. That is an argument against an *absolute* bar, not against a gate. A
paired block bootstrap against the incumbent — and, at cold start, against the
7-day same-hour baseline — is decidable on day one, gets stricter automatically
as the incumbent improves, and cannot be tuned to pass. The constants that
remain are guardrails, and every one of them blocks a swap rather than choosing
one, so a wrong constant is conservative.

**The DESSEM answer is smaller than the question.** Two decision folds and ~150
target days is a thin basis for a permanent choice, and no amount of care makes
it thicker. Which is why the recommendation is to stop treating it as permanent:
serve the early artifact *and* the late one, let DESSEM compete only for the
evening view, and re-run the comparison each quarter as its window grows. The
bitemporal design already handles a superseding forecast as a newer vintage; the
ten hours were only ever a cost under the assumption that one artifact must
win.

**Where this spec is weakest.** Four places, ranked:

1. **The 90-day calibration window is a real cost and the alternative is worse
   for a reason that is arguable rather than measured.** The served base learners
   have not seen the most recent 90 days. The defence — fleet growth enters
   through as-of capacity features rather than through recency — is sound but
   untested. If the first folds show the model degrading toward the end of each
   test quarter, the decoupled cadence (base learners monthly, calibration layer
   weekly on the trailing 60 days) is the fix and it is cheap.
2. **The guardrail constants are judgement.** `pr_auc − 0.02`, coverage
   `[0.85, 0.97]`, `ece ≤ 0.05`. They are placed where a wrong value is
   conservative, but the first three folds should be used to check that they are
   not so tight that nothing ever promotes — a gate that never fires is
   indistinguishable from no gate.
3. **Split conformal on non-exchangeable data is approximate and is stated to
   be.** The correction is fitted to the 90 days nearest the test period, which
   is the best available proxy for exchangeability and is not exchangeability. If
   `δ_lo` drifts across folds, the assumption is failing and adaptive conformal
   (online update of the target level) is the recorded next step.
4. **The technology split has no interval, and the screens currently type it as
   though it might.** The reasoning is solid — a band on a share times a band on
   a total is the very error this spec exists to prevent — but it constrains the
   UI, and the constraint has not been agreed.

**The load-bearing artifact here is the shuffled-label control, not the model.**
The models will be replaced; LightGBM is a decision with a five-year half-life
at best. The property that a pipeline trained on permuted labels must score at
chance is what makes every other number in the model card believable, and it
catches the class of harness bug that no review finds — the same role the
gate-ablation test plays one layer down. If exactly one thing from this spec
survives into the built system, it should be that test and the mixture inversion
it is protecting.

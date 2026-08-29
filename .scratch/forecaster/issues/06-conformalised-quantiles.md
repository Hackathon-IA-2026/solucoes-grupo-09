# 06 — The P10 carries a coverage statement

**What to build:** the floor the product quotes in prose is a measured property
of the interval, not the name of a booster's output.

Pinball boosters give sharp, feature-dependent intervals and no coverage
guarantee; split conformal on a point forecast gives a coverage guarantee and a
constant-width band that is wrong everywhere for a distribution that is a point
mass at zero most hours and heavily skewed the rest. So: **the boosters supply
the shape, conformal supplies a scalar per tail**. Ensemble spread is rejected
outright — it measures estimation variance, which shrinks with data, not
predictive variance, and it fails in exactly the direction the weather research
already measured.

**Two one-sided corrections, computed on the composed band, never one symmetric
one** — a badly-fitted upper tail must not spend the correction budget the lower
tail needs, and the lower tail is the one the product promises:

```
E_lo,i = q̂^0.10(x_i) − y_i        E_hi,i = y_i − q̂^0.90(x_i)
δ_lo = δ_hi = the ⌈(n+1)(1 − 0.10)⌉-th smallest value of the respective E
Q_pos^0.10 ← q̂^0.10 − δ_lo        Q_pos^0.90 ← q̂^0.90 + δ_hi
```

**The correction is global, not per hour.** A per-local-hour correction would
fit 24 scalars on a window whose positive rows number in the low thousands and
concentrate in a handful of hours. So one scalar per tail per artifact, with
per-hour and per-subsystem coverage **reported and never corrected** — correct
marginally, report conditionally. The median gets no correction: a median has no
interval to cover, and is scored instead by pinball loss and by the share of
observations below it.

Exchangeability is violated and is not pretended otherwise. The calibration
window is the 90 days immediately preceding the evaluation period so the two are
as close in distribution as the design allows, the guarantee is treated as
approximate, and `δ_lo` and `δ_hi` are published per fold — a `δ_lo` that grows
across folds means the boosters' intervals are drifting narrow.

**Blocked by:** 04. (01 arrives with it.)

**Status:** ready-for-agent

- [ ] Both corrections are fitted on the calibration window's positive rows,
      against the **composed** band, and stored in the bundle
- [ ] The two tails are independent: perturbing only the upper tail's residuals
      leaves `δ_lo` unchanged
- [ ] Empirical coverage is reported per fold, per subsystem and per local hour,
      and no reported conditional coverage is ever fed back as a correction
- [ ] `δ_lo` and `δ_hi` are per-fold published numbers in the card
- [ ] On synthetic exchangeable data with a known conditional distribution and
      deliberately mis-scaled quantile regressors, the conformalised interval
      reaches nominal coverage within tolerance and the uncorrected one does not
- [ ] The median is not corrected, and its unbiasedness — share of observations
      below P50, target 0.5 — is reported

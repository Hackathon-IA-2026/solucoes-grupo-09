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

**Status:** ready-for-agent

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

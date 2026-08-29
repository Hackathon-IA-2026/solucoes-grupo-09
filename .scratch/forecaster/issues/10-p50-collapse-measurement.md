# 10 — Measure whether the optimizer's posture collapses

**What to build:** the number this spec owes the flex-optimizer work — how often
a P50-planned day has no hour to act in — published per fold and per subsystem
as a first-class backtest figure.

The optimizer rejected planning on P10 on the argument that a hurdle makes the
hour-wise P10 zero in most hours, and called it a falsifiable prediction. **It
is not falsifiable — it is arithmetic**: P10 is exactly zero unless `p > 0.90`.
But the same arithmetic runs one notch weaker against the posture the optimizer
*did* choose: P50 is exactly zero unless `p > 0.50`, so a P50-planned dispatch
sees no offered energy in every hour more likely than not to be quiet. That is
defensible — the median of a day that probably has no curtailment above
threshold genuinely is "no curtailment above threshold" — but it means the
plan's shape is set by the **classifier's operating region** rather than by the
magnitude model at all, and nobody has written that down.

So the backtest publishes, per fold and per subsystem:

```
hours_per_day_p_ge_50, hours_per_day_p_ge_90     (mean, p25, p75)
share_of_hours_with_p50_zero, share_with_p10_zero
share_of_days_with_no_non_zero_p50_hour
```

If `share_of_days_with_no_non_zero_p50_hour` is large, the optimizer's chosen
posture collapses in the same way it argued P10 would, and its uncertainty
posture has to reopen. This ticket produces the evidence; it does not decide.

**Blocked by:** 09.

**Status:** ready-for-agent

- [ ] All six figures are computed per fold and per subsystem and land in the
      metrics table and the card
- [ ] The two hours-per-day figures carry mean, p25 and p75, not a mean alone
- [ ] `share_of_days_with_no_non_zero_p50_hour` is counted over target days, not
      over hours, and a day with no served band at all is excluded and counted
      separately rather than silently treated as a collapse
- [ ] A fixture test confirms by construction that P10 is zero exactly when
      `p ≤ 0.90` and P50 zero exactly when `p ≤ 0.50` — asserted as arithmetic,
      not measured as an empirical claim
- [ ] The figures are stamped with `VintageFidelity` and reported per fold, so a
      revision-optimistic fold cannot carry the decision alone
- [ ] The block is written into the card under a name the optimizer work can
      read without knowing the harness

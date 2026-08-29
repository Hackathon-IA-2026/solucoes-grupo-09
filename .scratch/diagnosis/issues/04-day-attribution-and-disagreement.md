# 04 — The whole day, the hours that disagree, and how big the noise is

**What to build:** the ranking the Explain screen actually shows. One
`(subsystem, target_date)` produces eight signed day contributions, a published
measure of how much each group's hours disagreed with each other, the peak
hour's own attribution beside the day's, and a number saying when the ranking is
smaller than its own error.

**The day attribution is the exact hour-wise sum** over the 24 hours of the
target date in `America/Sao_Paulo`: `Φ_j = Σ_t φ_{j,t}`. The reason is one line
— **expectations add and quantiles do not.** The day's expected MWh really is
the sum of the hourly expectations, the baseline really is the sum of the hourly
baselines, and Shapley values are linear in the value function, so the sum of
the hourly attributions *is* the attribution of the day's expected total against
a typical day's, with no averaging rule and no weighting scheme to defend. This
is the same argument that forbids summing a band, running in the one direction
where it is valid.

Ranking the mean of hourly ranks, or of hourly shares, is refused: both are
averages of normalisations, so an hour whose total attribution is 0.2 MWh would
weigh as much as one carrying 90 MWh.

**The cost of summing is measured rather than waved at.** A group can dominate
at noon and reverse at dawn, and the sum hides it. So the payload carries, per
group:

```
hour_disagreement_j = Σ_t |φ_{j,t}| / max(|Σ_t φ_{j,t}|, ε)
```

`1.0` means every hour pulled the same way. `≥ 2.0` is flagged, and a later
ticket makes the narration state that the driver acted in both directions across
the day. The threshold is a judgement placed where being wrong is conservative,
and it is named as a constant rather than buried.

**The peak hour is returned beside the day, never instead of it.** The same
eight groups, computed for the single hour with the largest expected MWh, plus
that hour's local hour. The headline ranking is always the day.

**Shares are shares of attributed movement.** `share_j = |φ_j| / Σ_k |φ_k|`,
so they sum to 1 and a day whose drivers cancel still produces a full bar chart.
This is not a share of the curtailment and not a share of "the attributed
magnitude" — the prototype's doc comment and footnote both say otherwise and are
corrected in the API-surface ticket set.

**The ranking's own error is measured.** `attribution_stderr_mwh` is a bootstrap
over the background sample: resample the matched background with replacement 200
times, recompute `v(∅)` and `Σ_j|φ_j|`, take the standard deviation of the day
total. It is the one number that turns "this ranking is noise" into a
measurement rather than a taste, and the rules ticket consumes it.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] One `(subsystem, target_date)` yields eight signed day contributions, ranked by absolute share
- [ ] The day value is exactly the hour-wise sum, asserted against a seeded fixture
- [ ] The eight day contributions sum exactly to `day_expected_mwh − baseline_expected_mwh`
- [ ] 24 hours are consumed, asserted — the day is a Brasília civil date, not a UTC one
- [ ] `hour_disagreement` is `≥ 1` always and exactly `1` when every hour shares a sign
- [ ] The peak hour's attribution and its local hour are returned beside the day's
- [ ] Shares sum to 1 and are shares of attributed movement, documented as such
- [ ] `attribution_stderr_mwh` is a bootstrap over the background, with the resample count recorded
- [ ] The four subsystems complete inside the publication budget, with wall-clock recorded

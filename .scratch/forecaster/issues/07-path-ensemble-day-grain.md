# 07 — Day totals and peak power, from a path ensemble that nothing sums

**What to build:** the day-grain numbers the screens need — day energy, peak
power, and the day-level occurrence probability — computed as quantiles of 500
temporally coherent draws, because quantiles do not add and no arithmetic on the
24 hour-wise bands can produce them.

```
1. On the calibration window, for every day d and hour t, the randomised PIT of
   the composed predictive CDF:
       u_{d,t} = F_Y(y_{d,t})                  if y_{d,t} > τ
       u_{d,t} ~ Uniform(0, 1 − p_{d,t})       if y_{d,t} ≤ τ
2. Store the matrix U (n_days × 24) in the bundle.
3. At serve time draw 500 whole rows of U with replacement — whole days, never
   individual hours — and map each through tomorrow's marginals: y*_{k,t} = Q_Y(u_{k,t} | x_t)
4. Day total = quantiles of Σ_t y*_{k,t};  peak power = quantiles of max_t y*_{k,t};
   day P(occurrence) = share of draws with at least one hour above τ
```

Whole days are what preserves the dependence: curtailment is autocorrelated
within a day by construction, and independent hourly draws would produce day
totals with roughly `1/√24` of the true spread — a narrower band arrived at by a
more sophisticated route. The randomisation is required, not decorative: with a
point mass at zero the naive PIT of a zero observation is not uniform and the
ensemble would inherit a spike at `1 − p`. No copula is fitted, so no copula
parameter is invented. Day-level occurrence is emphatically **not**
`1 − Π(1 − p_t)`, which assumes independence and overstates day-level risk.

The ensemble's marginals *are* the marginals by construction, so the hour band
and the day band cannot disagree about hour 14. It also, as a side effect, is
the set of temporally coherent scenario paths the optimizer names as the
precondition for scenario-based dispatch — they exist internally from day one;
serialising them across the API is not in v1.

**Blocked by:** 05, 06 (the marginals must be calibrated and conformalised
before their PIT means anything).

**Status:** done

- [ ] The PIT matrix is computed on the calibration window with the randomised
      rule for sub-threshold hours and stored in the bundle
- [ ] Day energy, peak power and day-level occurrence come from 500 whole-day
      draws, seeded and reproducible
- [ ] A test asserts the stored matrix is uniform on [0,1] per column within a
      Kolmogorov–Smirnov tolerance — the only test that sees a miscalibrated
      marginal
- [ ] The ensemble's own marginal quantiles reproduce the composed hour band
      within Monte-Carlo error at 500 draws
- [ ] On a seeded fixture, day-total P90 is strictly less than the sum of hourly
      P90s and day-total P10 strictly greater than the sum of hourly P10s
- [ ] A grep-level test asserts no code path computes a day-grain figure by
      summing a band
- [ ] Day-total coverage and peak coverage are reported per fold

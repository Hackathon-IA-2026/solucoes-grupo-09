# 21 — The upper conformal correction barely reaches the served band

**What to build:** the correction, applied to the quantity its residuals were
measured on. This held a defect in the spec's own formula that ticket 06 found,
instrumented and refused to hide.

The conformal residuals are measured on the **composed** band, and the ticket's
formula applied the correction to the **magnitude knots**:
`Q_pos^0.90 ← q̂^0.90 + δ_hi`. Composition then reads `Q_pos` at
`u = (q − (1 − p)) / p`, so the upper quantile is read at `u_hi = 1 − 0.1/p` —
which is *below* the 0.90 knot for every `p < 1`, and at or below the median
knot once `p ≤ 0.20`, where `δ_hi` did nothing at all.

Measured on the shipped code, before and after:

| `p` | share of `δ_hi` reaching the served P90, before | after |
|---|---|---|
| 1.00 | 1.000 | 1.000 |
| 0.90 | 0.972 | 1.000 |
| 0.50 | 0.750 | 1.000 |
| 0.30 | 0.417 | 1.000 |
| 0.20 | 0.000 | 1.000 |
| 0.15 | 0.000 | 1.000 |
| **0.10 and below** | **0.000** | **0.000 — and correctly so** |

On ticket 06's fixture the mean realised fraction was **0.25**, with 49 % of rows
receiving exactly zero correction. `p ≤ 0.20` is not an edge case — it is most
hours on most days, which is the same arithmetic that makes P50 zero unless
`p > 0.50`. On the same fold and the same fit it is now **0.65**, and
`coverage_p90` moved 0.51 → 0.60.

**The decision: fix it.** An under-corrected P90 is a band too *narrow* at the
top — it tells an operator the worst case is milder than it is. The product
exists so operators can size storage and flexible demand against that edge, so
the error is in the unsafe direction: an under-stated P90 means under-sized
storage. Labelling it on the model card does not stop the under-sizing, and a
narrower band is the flattering direction, which this repository fixes or
withholds rather than shipping with a footnote.

**What was preserved, and it is half of the old "0.000" column.** `Q_Y(q) = 0`
for every `q ≤ 1 − p`, so at `p ≤ 0.10` the served P90 is exactly zero and that
is the *right* answer — the model is saying there is at least a 90 % chance of no
curtailment, and correcting it upward would invent curtailment the mixture
denies, in the hours the classifier is most confident about. The genuine defect
was the band `0.10 < p ≤ 0.20`, and partially everything below `p = 1`, where the
composed upper edge is positive and real and received none of `δ_hi`. The
structural zero stays; the positive edge is corrected.

**The route, and the one the ticket assumed.** The ticket assumed the fix had to
apply the shift at a `p`-dependent point *inside* `Q_pos`, turning it into a
`p`-parameterised callable with a blast radius through ticket 07's 500 × 24
inversions. It does not. The correction is applied **after composition**, as a
shift in the mixture's own `q` — `δ(0.10) = −δ_lo`, `δ(0.50) = 0`,
`δ(0.90) = +δ_hi`, linear between and flat outside, added inside the positive
branch of `HurdleMixture.quantile`. `Q_pos` stays an ordinary
`MagnitudeQuantiles` value and the ensemble still inverts one object.

The naive form of that route — adding `δ` to the two *served* quantiles after
composition — is **not** sound, and the reason is worth recording: the served
band is not the only thing that inverts the mixture. Ticket 07's ensemble asks
`Q_Y` for 500 × 24 arbitrary `q` per day and its stated invariant is that its
marginals *are* the served marginals. A shift applied only at `q = 0.10` and
`q = 0.90` would move the band and leave the ensemble drawing from the
uncorrected distribution, and the hour band and the day band would disagree about
hour 14. Defining `δ` at every `q` and carrying it on the mixture is what makes
the after-composition route sound, and it is why the shift is a field on
`HurdleMixture` rather than an argument to a band builder.

**Cost.** One extra piecewise-linear lookup per inversion. Measured, not
estimated: 48,000 inversions (one day, four subsystems) go 22.7 ms → 30.9 ms;
one subsystem-day's `PathEnsemble.draw` goes 7.43 ms → 7.79 ms median over 60
runs, because resampling and sorting dominate. The whole ML suite's wall time is
unchanged.

**Blocked by:** 06 (merged).

**Status:** done

- [x] The decision is recorded: the correction is applied to the composed
      quantile as a shift in `q`, and `forecaster.md`'s formula is corrected to
      match — in the composition section, in the model section and in "Quantiles
      — quantile regression, conformalised", which stated the knot form.
- [x] `coverage_p90` means what `coverage_p10` means: each counts the fold's
      curtailed hours against a served edge that received its tail's whole `δ`.
      What remains asymmetric is the mixture's point mass, not the correction.
- [x] Ticket 07's ensemble still inverts one object — the same
      `HurdleMixture`, with the shift on it — and a test asserts its marginals
      reproduce the *corrected* composed band, which is the invariant that
      ruled out the naive after-composition form.
- [x] The lower tail did not move: the served P10 is bit-identical under both
      rules at every `p`, asserted against a reconstruction of the old one.
- [x] The structural zero is preserved, asserted with a `δ` two orders of
      magnitude larger than the band.
- [x] `correction_regime` is bumped to `conformal_v2_full_upper`. Rows written
      under `conformal_v1_partial_upper` are not re-stamped, both regimes stay in
      the gateway's `CORRECTION_REACH` table, and `/v1/model/card` reports
      `correction_applied` per tail from it.
- [x] `upper_correction_realised` is still published and still required beside
      `coverage_p90`. Its meaning changed and its note says so: it is now the
      share of scored hours whose P90 is positive at all, and it bounds
      `coverage_p90` from above.

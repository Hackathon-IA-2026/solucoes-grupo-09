# 21 — The upper conformal correction barely reaches the served band

**What to build:** nothing until a decision is made. This holds a defect in the
spec's own formula that ticket 06 found, instrumented and refused to hide.

The conformal residuals are measured on the **composed** band, and the ticket's
formula applies the correction to the **magnitude knots**:
`Q_pos^0.90 ← q̂^0.90 + δ_hi`. Composition then reads `Q_pos` at
`u = (q − (1 − p)) / p`, so the upper quantile is read at `u_hi = 1 − 0.1/p` —
which is *below* the 0.90 knot for every `p < 1`, and at or below the median
knot once `p ≤ 0.20`, where `δ_hi` does nothing at all.

Measured on the shipped code:

| `p` | share of `δ_hi` that reaches the served P90 |
|---|---|
| 1.00 | 1.000 |
| 0.90 | 0.972 |
| 0.50 | 0.750 |
| 0.30 | 0.417 |
| **0.20 and below** | **0.000** |

On ticket 06's fixture the mean realised fraction was **0.25**, with 49 % of rows
receiving exactly zero correction. `p ≤ 0.20` is not an edge case — it is most
hours on most days, which is the same arithmetic that makes P50 zero unless
`p > 0.50`.

**The lower tail is exact for every `p`**, because `u_lo ≤ 0.10` always and the
interpolant is flat below its first knot. So the floor the product actually
quotes is fine; it is the upper edge of the band that under-covers, and it does
so by *under-application* rather than by a bad fit.

**Why this needs a decision rather than a fix.** Making both tails exact means
applying the shift at a `p`-dependent point in `u`. That is still two global
scalars — the fit stays global and the tails stay independent — but it turns
`Q_pos` from a `MagnitudeQuantiles` value into a `p`-parameterised callable, and
ticket 07's path ensemble inverts that same object 500×24 times per day. The
blast radius is the reason ticket 06 stopped and instrumented instead.

The alternative reading — measure the residuals on the knots rather than on the
composed band — is internally consistent but answers the wrong question: it would
make the coverage statement about a quantity nobody is served.

**Blocked by:** 06 (merged). Blocked on a decision, not on code.

**Status:** needs-decision

- [ ] A decision is recorded on whether the correction is applied at a
      `p`-dependent point in `u`, and `forecaster.md`'s formula is corrected to
      match whatever is chosen
- [ ] If it moves: `coverage_p90` means what `coverage_p10` means, and ticket 07's
      ensemble still inverts one object
- [ ] If it stays: the model card says plainly that the published P90 carries a
      partial correction, and `upper_correction_realised` is surfaced rather than
      buried

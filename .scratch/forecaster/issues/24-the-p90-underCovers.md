# 24 — The P90 band under-covers, and it is now a question about the fit

**What to build:** an upper band that covers what it claims to, or a measured
statement of why it cannot.

Forecaster 21 fixed the correction's **reach**: `δ_hi` now lands in full wherever
the served P90 is positive, realised share 0.2317 → 0.6494 (the remainder is the
structural zero at `p ≤ 0.10`, where a zero P90 is correct).

What it did **not** fix, and deliberately did not count as closed:

| figure | reference fold |
|---|---|
| `coverage_p90` | **0.5974** |
| nominal | 0.90 |
| `coverage_p10` | 1.0 |

A P90 that covers 60% of observations is a band the product should not print as a
90% statement. The lower tail is fine. This is no longer an *application* defect —
it is the fit, the conformal calibration set, or the composition.

**Where to look, in rough order of suspicion.** The conformal `δ` pair is two
global scalars fitted across all hours; if the residual scale varies strongly with
`p` or with subsystem, one global upper scalar cannot cover a heteroscedastic
upper tail — the lower tail escapes this because it is pinned near zero by the
mixture. Also worth checking before anything else: whether `coverage_p90` is being
*computed* the way it is being read, since `coverage_p10 = 1.0` exactly is the kind
of round number that sometimes means "denominator is the wrong set" rather than
"the floor is perfect". Confirm the metric before trusting it as the target.

**The reference fold is small.** Establish whether 0.60 is a property of the fit or
an artifact of that fixture before treating it as the production number. If it is a
fixture artifact, say so with the measurement and close this — that is a real
result, not a dodge.

**Blocked by:** 21 (merged).

**Status:** ready-for-agent

- [ ] `coverage_p90`'s definition and denominator are confirmed against
      `coverage_p10`'s, and any disagreement between the two is resolved
- [ ] Whether 0.60 holds beyond the reference fold is measured, not assumed
- [ ] If the cause is in reach: fixed, with the coverage figure before and after
- [ ] If the cause needs data no environment here has: a named unmeasured reason
      on the card in the `NOT_RUN_YET` register, never a fixture figure presented
      as a measurement
- [ ] The band is never printed as a 90% statement while it is not one — if the
      gap survives, the card and the wire say so plainly

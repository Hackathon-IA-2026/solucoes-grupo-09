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

**Status:** done

- [x] `coverage_p90`'s definition and denominator are confirmed against
      `coverage_p10`'s, and any disagreement between the two is resolved
- [x] Whether 0.60 holds beyond the reference fold is measured, not assumed
- [x] If the cause is in reach: fixed, with the coverage figure before and after
- [x] If the cause needs data no environment here has: a named unmeasured reason
      on the card in the `NOT_RUN_YET` register, never a fixture figure presented
      as a measurement
- [x] The band is never printed as a 90% statement while it is not one — if the
      gap survives, the card and the wire say so plainly

---

## What was found

**The metric was the finding. The upper tail's width is not short.**

### The two coverages share their rows and disagree about a zero edge

Both are counted over the same population — every curtailed hour of the fold,
`y > τ`. There is no wrong denominator. What differs is what a **structural
zero** does to each numerator. A scored hour has `y > τ > 0`, so wherever the
mixture puts a served edge on its point mass:

| | `p ≤ 0.90` → `P10 = 0` | `p ≤ 0.10` → `P90 = 0` |
|---|---|---|
| `y ≥ P10` | true for free | — |
| `y ≤ P90` | — | false with certainty |

The same zero ticket 21 established as *correct* is a free pass in one numerator
and a guaranteed failure in the other. That is the whole of the disagreement.

### `coverage_p10 = 1.0` is vacuous, not perfect

Measured on the shared fixture fold with a real trained bundle: **0 of 79**
scored hours have a positive P10. Not one row tested the floor. The 1.0 is 79
evaluations of `y ≥ 0`.

### The upper band covers nominally wherever it is a band

| | shared fixture fold, live fit | card fixture |
|---|---|---|
| scored rows | 79 | 77 |
| rows with a positive P90 | 58 | 50 |
| covered | 52 | 46 |
| marginal `coverage_p90` | 0.6582 | 0.5974 |
| **`coverage_p90_where_stated`** | **0.8966** | **0.9200** |

`coverage_p90 = upper_correction_realised × coverage_p90_where_stated`, exactly,
because a row whose P90 is zero can never be covered. The first factor is the
classifier's point-mass share; the second is what `δ_hi` is answerable for, and
it is at nominal on both. Conditional coverage by `p` decile is flat
(0.89 / 0.86 / 1.00 / 1.00 / 0.80 on 18/14/14/2/10 rows) — no heteroscedastic
upper tail is visible, and the ticket's leading suspicion is **not** what this
is. The spec's already-recorded answer stands: a better classifier, not a wider
band.

### Does 0.60 generalise?

**The decomposition does; the number does not, and cannot be measured here.**
`coverage_p90_where_stated ≈ 0.90` is split conformal's own guarantee showing up
— `δ_hi` is the ⌈(n+1)·0.9⌉-th of 924 calibration residuals — and it is a
property of the fit. The marginal is `0.90 × (share of curtailed hours the
classifier put at p ≤ 0.10)`, which is a classifier-calibration figure over
fabricated rows. `MARGINAL_COVERAGE_NOT_RUN_YET` names that: unrun, not "no data
source", and it needs a fold sweep against a migrated database.

## What changed

No coverage number moved and no fit changed. What moved is what is published
beside them.

- `CoverageReport` gains `lower_stated_rows`, `upper_stated_rows`,
  `coverage_p10_where_stated` and `coverage_p90_where_stated` (**`None`, never
  1.0**, where a tail states no bound), and the derived `nominal_claim` /
  `claim_note`. `ScoredHour` gains `states_lower_bound` / `states_upper_bound`.
- The card publishes all six; the wire carries `stated_rows` and
  `coverage_*_where_stated` inside each tail block and `nominal_claim` +
  `claim_note` on the coverage block, forwarded and never derived at the gateway.
- `nominal_claim` is `false` on this fold for both available reasons — the upper
  marginal is outside the guardrail and the lower tail states no bound at all —
  so nothing can render the band as a 90% statement.

`feature_hash` did **not** move: `sha256:510b86c6…` before and after on the
shared fixture fold. Nothing here touches the feature function, the contract,
`compose`, `TailShift` or `ConformalCorrection.fit`.

## Result: the fit is fine. The metric was unreadable, and one half of it was vacuous.

No change to the fit, the composition, `TailShift` or `ConformalCorrection.fit`.
Only what is published changed — because nothing was wrong with the band.

**`coverage_p10 = 1.0` was vacuous.** Of 79 scored hours on the live fit, **zero**
have a positive P10. The 1.0 was 79 evaluations of `y ≥ 0`. It was never evidence
that the floor is perfect, and this ticket's suspicion that a round number might
mean a wrong denominator was right about the smell and wrong about the cause: the
row set is the same for both tails. What differs is what the **structural zero**
does to each numerator. A scored hour has `y > τ > 0`, so:

* `p ≤ 0.90` → `P10 = 0` → `y ≥ P10` is **true for free**
* `p ≤ 0.10` → `P90 = 0` → `y ≤ P90` is **false with certainty**

The same zero forecaster 21 established as correct is a free pass in one
numerator and a guaranteed failure in the other.

**The upper band covers at nominal wherever it is a band.**

| | live fit | card fixture |
|---|---|---|
| scored rows | 79 | 77 |
| rows with a positive P10 | **0** | 0 |
| rows with a positive P90 | 58 | 50 |
| `coverage_p10` | 1.0 | 1.0 |
| `coverage_p90` | 0.6582 | 0.5974 |
| **coverage where the P90 is a bound** | **0.8966** | **0.9200** |

And the decomposition is exact, verified to the last bit on the fixture:
`0.6493506493506493 × 0.92 = 0.5974025974025974`. A zero-P90 row can never be
covered, so `coverage_p90 = upper_correction_realised × coverage_p90_where_stated`
identically. The first factor is the classifier's point-mass share; the second is
what `δ_hi` is answerable for.

**So this ticket's leading suspicion is not supported.** Conditional coverage
across `p` deciles is flat (0.89 / 0.86 / 1.00 / 1.00 / 0.80), so there is no
heteroscedastic upper tail defeating one global scalar. The spec's already
recorded answer stands: **a better classifier, not a wider band.**

## What is published now

Both figures travel with the denominator that makes them readable —
`stated_rows` and `coverage_*_where_stated` per tail, the latter `None` and never
`1.0` where a tail states no bound — and `nominal_claim` requires both marginals
inside the published guardrail *and* at least one stated row per tail. On this
fold it is **false**, and `claim_note` says the band "is NOT a 90% band over its
curtailed hours and must not be described as one".

The guardrail rather than a hard `≥ 0.90` because conformal makes coverage
*equal* nominal, so a hard threshold flips on sampling noise — verified against an
honest synthetic band landing at 0.891 / 0.884.

Whether the marginal survives outside a fixture is not measurable in any
environment here, and is recorded as `MARGINAL_COVERAGE_NOT_RUN_YET` — forecaster
18's "unrun" register, explicitly not forecaster 16's "no data source" — with a
test that refuses any fixture figure inside it.

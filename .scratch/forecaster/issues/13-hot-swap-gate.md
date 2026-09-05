# 13 — The hot-swap gate: one number decides, constants only veto

**What to build:** an operator does not make a judgement call at 03:00 — the
weekly candidate is promoted or refused by a comparison against the incumbent,
and either way the decision and its evidence are on the volume.

The gate carries **no invented constant in its decision**. The map records the
backtest threshold as unspecifiable before the first honest numbers exist, which
is an argument against an *absolute* bar, not against a gate. A paired block
bootstrap against the incumbent is decidable on day one, gets stricter
automatically as the incumbent improves, and cannot be tuned to pass.

The checks, in order; all must pass:

1. **Lane identity** — candidate's (feature set, gate profile, threshold) equals
   the incumbent's. A different triple is a different lane and never a swap.
2. **Estimator allow-list** — family in `{"lightgbm"}`. This is where the
   transformer benchmark's non-promotion is enforced rather than agreed.
3. **Feature contract** — the candidate's feature hash equals the hash the live
   feature function produces right now. If the feature SQL changed, **the
   incumbent is also invalid**: the gate refuses *and* raises, rather than
   promoting into a mismatch or leaving a stale model serving a changed contract
   silently.
4. **Freshness and coverage** — newest training target date within 7 days; the
   evaluation fold has at least 60 test days; no fold used has a worse
   `VintageFidelity` than the incumbent's deciding fold. A revision-optimistic
   fold may not be the deciding fold once any point-in-time fold exists.
5. **The gate proper** — on the shared newest fold, resample **whole target
   days** with replacement, 2,000 times, and compute `qloss_mwh` for both.
   Promote iff `P(qloss_candidate < qloss_incumbent) ≥ 0.90`. Whole days,
   because hours within a day are strongly dependent. **Cold start**, with no
   incumbent: the same test against the 7-day same-hour baseline.
6. **Guardrails — vetoes, each with a stated constant**, placed so a wrong value
   blocks a swap rather than choosing one: PR-AUC no worse than the incumbent's
   by 0.02, pooled *and* in every subsystem; both coverages in [0.85, 0.97];
   P50 unbiasedness in [0.45, 0.55]; ECE at most 0.05; crossing rate at most
   0.01; recall at the calibrated 0.5 no worse than the incumbent's by 0.05.
7. **Serving smoke, on the real vector** — a complete 24-hour band for every
   subsystem for tomorrow, from the live feature function: no NaN, monotone in
   every hour, the ensemble's day total inside the summed band's range, and no
   feature whose serve-time NULL rate exceeds its training NULL rate by more
   than 5 percentage points. This is the check that catches an upstream dataset
   having gone quiet, which no historical metric can see.
8. **Record the decision either way** — one line appended, and the card written
   regardless, so a refused candidate is inspectable.

**Blocked by:** 02, 09.

**Status:** done

- [ ] A candidate byte-identical to the incumbent does not promote
- [ ] A candidate strictly better on every test day promotes
- [ ] A mismatched feature hash refuses *and* raises, and the incumbent is
      marked invalid rather than left quietly serving
- [ ] A candidate whose estimator family is not on the allow-list refuses
- [ ] Each guardrail is exercised by a candidate that fails only that guardrail
- [ ] Cold start compares against the 7-day same-hour baseline and refuses a
      model that cannot beat it
- [ ] The bootstrap resamples whole target days, is seeded, and its statistic is
      written into the card's decision block
- [ ] A refusal writes a card and exactly one log line; a rollback line restores
      the earlier artifact and deletes nothing

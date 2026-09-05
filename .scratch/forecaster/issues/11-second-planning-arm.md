# 11 — Score two planning arms, publish both

**What to build:** the backtest builds a plan against P50 *and* a plan against
`E[Y]`, runs both through the optimizer's simulator on the same days with the
same reference fleet, and publishes both arms' `recovered_floor_mwh`.

This is decided work, not an open question. v1 still ships the P50 plan. The
second arm exists so that the number deciding the posture and the evidence for
its replacement arrive together: `E[Y] > P50` exactly when `p < 0.5`, which is
to say the expectation is non-zero in precisely the hours where the P50 plan
goes blind. If ticket 10's collapse figure comes in large, the replacement is
already evidenced instead of starting a fresh argument.

It costs almost nothing: the expectation is already a served field and the
scoring path is already shared. The objection that killed scenario-weighting
does not apply — that failed because the hour-wise quantile envelope is not a
physically realisable day, whereas `E[Y]` is a genuine expectation and adds
across hours legitimately.

The simulator is **imported, not reimplemented** — the same function that scores
a live plan. Both arms are scored against P10, P50 and P90 the way the optimizer
spec specifies, and the floor stays an hour-wise statement: the P10 envelope is
not a member of the path ensemble and is not a realisable day.

**Blocked by:** 09. **External blocker:** the optimizer's simulator and its
execution rule, owned by the flex-optimizer work.

**Status:** done

- [ ] Both arms are built on the same days, from the same served artifact, with
      the same fixed published reference fleet
- [ ] Both are scored by the imported simulator; the forecaster contains no
      second copy of the execution rule
- [ ] Both arms' `recovered_floor_mwh` are published per fold in the card, side
      by side, with neither presented as the shipped posture
- [ ] The card states that v1 serves the P50 plan
- [ ] A test asserts the `E[Y]` arm's plan is non-zero in at least the hours
      where `p < 0.5` and the P50 arm's is zero there
- [ ] The reference fleet is stamped on the comparison so the numbers are
      reproducible

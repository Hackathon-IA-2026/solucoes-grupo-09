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

**Status:** done for the machinery; **the comparison is never produced by a
running process** — corrected by api-surface 30, see "30 — Corrected" below.
The status line previously read `done` without qualification.

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

---

## 30 — Corrected: the arms are scored by tests and by nothing else

**Status of this correction:** the ticket's status line is amended; no code is
changed here. Found by api-surface 30's reachability sweep, which is
data-platform 03's failure mode asked of every `done` ticket.

`apps/ml/src/wattsteer_ml/evaluation/planning_arms.py` is merged, complete and
covered — `apps/ml/tests/test_second_planning_arm.py` exercises
`score_planning_arms`, `measure_planning_arms` and `record_planning_arms` at
length. **No production path calls any of them.** Checked directly:

```
grep -rn "planning_arms" apps/ml/src/wattsteer_ml/retrain.py \
    apps/ml/src/wattsteer_ml/app.py apps/ml/src/wattsteer_ml/__main__.py
→ no matches
```

The only non-test reference anywhere is a docstring cross-reference in
`dessem_ab_run.py`. So the third box — "published per fold in the card, side by
side" — cannot be true through any run: `retrain_lane` never reaches the
module, and nothing writes a `planning_arm_comparison` block.

**The system itself is honest about this; the ticket was not.**
`NO_HELDOUT_BAND_FOR_ARMS` is a `DeclinedFigure` declared in that module, and
`declined_figures()` (`declined.py:225`) finds it by walking the package rather
than by a list, so `/v1/meta` already publishes "the comparison is unmade
rather than made and found uninteresting". A reader of the API is told the
truth. A reader of this ticket was told the arms were published.

**What it would take to wire it.** One call. `retrain_lane` already holds the
connection, the lane and the `as_of` that `measure_planning_arms(connection,
segments=…, lane=…, as_of=…)` wants, and `record_planning_arms` already writes
the block; the missing line sits beside `run_ladder` at `retrain.py:603`. The
cost is a second simulator pass over the held-out days, which the ticket's own
"it costs almost nothing" argument already priced. Out of scope for this
correction because `apps/ml/**` is owned by a sibling branch this wave.


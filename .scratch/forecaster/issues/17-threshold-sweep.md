# 17 — The threshold sweep, published rather than acted on

**What to build:** evidence for the 1 / 5 / 10 MW question IDEA asks, produced
by three fold sweeps and no rebuild, each in its own artifact lane.

The feature function takes the threshold as an argument, so the sweep is cheap.
Run once on the free feature set at the late gate profile, reporting per
threshold: prevalence, positives per local hour, PR-AUC, `qloss_mwh`,
`coverage_p10`, and the optimizer-facing `share_p50_zero`.

**5 MW remains the default and only moves by an explicit decision.** The sweep's
job is to produce evidence. Two conditions would force a move: a positive-class
prevalence below roughly 3%, too rare for the classifier to learn a usable
ranking and the risk classes collapse into one; or above roughly 40%, at which
point the threshold has stopped selecting anything and `has_curtailment` no
longer names an event. Between those, 5 MW stands on the domain model's
reasoning — 1 MW is inside the rounding noise of a subsystem sum and 10 MW
discards dispatchable events.

Because the artifact's identity is the triple (feature set, gate profile,
threshold), each threshold produces its own lane. **Only the 5 MW lane is
promoted for serving**, and the lane machinery is what makes that structural
rather than a convention.

**Blocked by:** 02, 09.

**Status:** done for the machinery; **no sweep has ever been run** — corrected
by api-surface 30, see "30 — Corrected" below. The status line previously read
`done` without qualification.

- [ ] Three sweeps run on identical folds and rows, differing only in the
      threshold passed to the feature function
- [ ] Each threshold writes its own lane, and a sweep lane cannot be promoted
      into the serving lane
- [ ] The six reported figures are published per threshold and per fold in the
      card's sweep block
- [ ] The two move-forcing prevalence conditions are evaluated and reported as
      met or not met, rather than left for a reader to compute
- [ ] The default stays 5 MW, and every artifact, episode view and screen
      carries the threshold that produced its numbers

---

## 30 — Corrected: `run_threshold_sweep` has no caller at all, not even a test

**Status of this correction:** the ticket's status line is amended; no code is
changed here. Found by api-surface 30's reachability sweep.

This is a sharper case than forecaster 11's. There, the driver was exercised by
its own test file. Here the driver is exercised by **nothing**:

```
grep -rn "run_threshold_sweep" apps/ml
→ evaluation/threshold_sweep.py:909   (the def)
→ evaluation/threshold_sweep.py:1067  (its own __all__)
→ evaluation/dessem_ab.py:1146        (a docstring cross-reference)
```

`record_threshold_sweep` fares slightly better — `apps/ml/tests/
test_threshold_sweep.py` calls it twice — but neither `retrain.py` nor `app.py`
mentions `threshold_sweep` in any form. So the first box ("three sweeps run on
identical folds and rows") and the third ("the six reported figures are
published per threshold and per fold in the card's sweep block") describe a
thing that has not happened, and the fourth (the two move-forcing prevalence
conditions "evaluated and reported") depends on a prevalence figure nothing has
computed.

**The module says so itself.** `SWEEP_ARMS_NOT_SCORED`
(`threshold_sweep.py:1030`) reads *"The sweep has not been run. This is not a
prevalence of zero and not a …"*, and because `declined_figures()` discovers
`DeclinedFigure` constants by walking the package rather than from a list, that
sentence is already on `/v1/meta`. The code was written by someone who knew;
the checklist and the one-word status were written as if it had shipped.

**What it would take to run it.** Nothing new is needed to *wire* — the sweep
is not a scheduled unit, it is a one-off evaluation over three lanes, and
`run_threshold_sweep` is the driver for exactly that. What is missing is the
run: three lane trainings at 1 / 5 / 10 MW on identical folds, then
`record_threshold_sweep` to write the block. The correct closing move may well
be to delete the two unticked run-claims from the checklist rather than to tick
them, and to leave `SWEEP_ARMS_NOT_SCORED` published until a real sweep
replaces it. That is a forecaster decision, not this ticket's.


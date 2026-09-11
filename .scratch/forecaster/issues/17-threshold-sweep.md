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

**Status:** done for the machinery; the **driver now exists** —
`wattsteer_ml.threshold_sweep_run`, so `run_threshold_sweep` has a caller for
the first time — and **no sweep has still been run**. Three lane trainings
against an ingested database is the remaining work and it is not this branch's.
See "30 — Corrected" and "30 — Wired" below. The status line read `done`
without qualification before api-surface 30.

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

---

## 30 — Wired: the driver exists; the run still does not

**Status of this wiring:** code added, no sweep executed. Branch
`wire-the-orphans`. The correction above is left standing.

The correction's sentence was "nothing new is needed to *wire*". That was half
right and the half it missed is what this section adds. The sweep is indeed not
a scheduled unit and wants no cron — the ticket's own words are that it is
published rather than acted on, and a weekly re-sweep would be three more
artifact lanes a week for a question asked once. But `run_threshold_sweep`
takes a `SweepScorer`, and **nothing in the repository had ever produced one**:
train at this threshold, compose, hand back the segment's settled hours needs a
database, a fold calendar and LightGBM, and none of those belong to the module
that answers what the arms may be read as saying. Without that seam filled the
sweep was not merely unrun; it was unrunnable without someone writing a driver
first, which is the difference between "press go" and "there is no go".

`apps/ml/src/wattsteer_ml/threshold_sweep_run.py` is that driver, and it is
deliberately `dessem_ab_run.py`'s shape — forecaster 18's answer to the
identical omission, down to isolating per-segment data failures so a
decision-grade quarter is not thrown away over a quarter that decides nothing.
Three things are this module's own, and each is one of the ticket's boxes:

- **An arm is a lane and every arm is saved.** `sweep_lane(threshold)` is the
  authority; the three fits are written into their own directories, which is
  the second box and is why `record_threshold_sweep` has a card to edit in the
  two lanes nothing serves.
- **Nothing is promoted, checked rather than intended.**
  `assert_no_sweep_lane_promoted` runs before the first fit *and* after the
  last write, against the append-only log. The driver appends nothing to
  `promotions.jsonl` and has no branch that could.
- **Identical folds and identical rows.** All three arms read the same fold
  through the same matrix arm, differing only in the `threshold_mw` handed to
  `feature_rows`, so row identity holds by construction — and `ScoredFold`
  still digests it per segment rather than counting.

`apps/ml/tests/test_threshold_sweep_run.py` covers the driver over a stand-in
scorer and a real fold calendar: a measured run publishes all three arms on all
three cards and writes no promotion line; a database with no settled hour
produces the unmeasured block *with the reason* rather than a prevalence of
zero; a missing card is reported rather than minted; an already-promoted sweep
arm stops the run before the first fit, asserted by the scorer never being
called. The empty case is proved at the verdict: an impossible window start
makes `reportable_folds` return `()` and the run refuses, rather than sweeping
nothing and calling it a sweep.

### What happened to the honest refusal

`SWEEP_ARMS_NOT_SCORED` is **unchanged and still published on `/v1/meta`**, and
that is the truthful state: the sweep has still not been run. What changed is
that the sentence is now reachable from a running process — the driver writes
`UnmeasuredThresholdSweep` onto every arm's card, carrying that constant as its
`reads` field, whenever the database cannot support the arms. Only
`SweepProvenance.measured` displaces it, and that is reached from exactly one
place, only after all three arms have come back from `forecast_rows` over rows
read out of Postgres. There is no flag and no fixture path that reaches it.

### What was not done, and why

**No sweep was run.** Three lane trainings at 1 / 5 / 10 MW over every
reportable fold is six LightGBM fits per lane per fold against an ingested
database; the only Postgres this branch could reach is read-only and shared
with a live weather job, and a cloned instance would have no ingested rows to
sweep. So the first, third and fourth boxes stay unticked and
`SWEEP_ARMS_NOT_SCORED` stays published. What has changed is that the closing
move is now a command — `python -m wattsteer_ml.threshold_sweep_run
--database-url …` — rather than a module somebody has to write first.


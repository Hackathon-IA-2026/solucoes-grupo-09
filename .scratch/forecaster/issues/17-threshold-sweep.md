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

**Status:** ready-for-agent

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

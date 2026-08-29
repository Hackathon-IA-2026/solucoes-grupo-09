# 16 — The weather lead-time A/B, measured where the harm was predicted

**What to build:** the acceptance test the lead-time research named for its own
recommendation — the same model trained on archive weather and on lead-matched
weather, both evaluated on lead-matched features, with the interval metrics
reported and not only the point metrics.

Two arms, one evaluation set. The served arm trains and evaluates on the D−1 12Z
single run. The control arm trains on the historical forecast archive with the
same variables and centroids and is **evaluated on the lead-matched features**,
because that is what serving provides. The archive-trained model evaluated on
archive features is the overstated number the research exists to prevent, and it
is reported too, as a third column labelled *not achievable* — because the gap
between the two archive columns is the size of the leak in the product's own
metric, and that is the number worth putting in front of a human.

What it reports, and where the harm is expected: `Δ qloss_mwh` is the
point-forecast harm and the research predicts it is the *smaller* effect. The
harm should land in `Δ coverage_p10`, `Δ coverage_p90` and `Δ interval width` —
an archive-trained model has learned the weather feature is more trustworthy
than it is, so its intervals should be too narrow and under-cover when evaluated
lead-matched. `Δ delta_lo` is the cleanest single expression of it: the
correction is literally the amount by which the interval was wrong. If coverage
does *not* degrade, the errors-in-variables argument did not survive the move
from a linear model to boosted trees, and that is worth knowing.

The second, cheap experiment the research left open runs here because it needs
the centroids: recompute the train-to-serve correlation on the **real
capacity-weighted aggregate** rather than per point. The measured per-point
figure is an upper bound on the harm and aggregation will raise it; above 0.95
the claimed gap should be revised downward and this becomes a standing
model-health metric.

Run once on the free feature set at the late gate profile across all folds — not
on every retrain.

**Blocked by:** 09.

**Status:** ready-for-agent

- [ ] Both arms train on the shared fold calendar and are evaluated on identical
      lead-matched test rows
- [ ] A third column reports archive-trained on archive-evaluated, labelled as
      not achievable, and the gap between the two archive columns is stated
- [ ] Interval metrics — both coverages, mean interval width and both conformal
      corrections — are reported per arm, not only `qloss_mwh`
- [ ] The train-to-serve correlation is recomputed on the capacity-weighted
      aggregate and recorded
- [ ] The whole block lands in the card as a named experiment and does not run
      on the weekly retrain

# 13 — The two weather experiments this spec inherits

**What to build:** two numbers that were left open by the research and that
decide how strongly the weather decision should be stated — measured on the real
feature vector rather than on the per-point proxy the research had available.

Both are feature-level questions, which is why they live here rather than with
the model.

**Train twice.** Train the same model once on features built from the stitched
historical archive and once on features built from the lead-matched named runs,
and evaluate both on the lead-matched feature. The lead-time research names this
the definitive experiment and the acceptance test for choosing named runs over
the archive. Until it is run, the choice is argued rather than demonstrated.

**Recompute the train/serve gap on the real aggregate.** The measured per-point
correlation of 0.88 is an *upper bound* on the harm: the feature is a
capacity-weighted average over frozen centroids, and aggregation will raise it.
Recompute on the real centroids and publish the number. If it comes back above
0.95, the size of the claim made elsewhere about the archive's cost should be
revised downward — publishing an overstated number and leaving it standing is
its own small dishonesty.

Neither experiment changes a feature definition. Both produce a written result
that other documents point at.

**Blocked by:** 08 — the weather block, for the real aggregated feature. 11 —
both feature sets, for something to train twice on.

**Status:** ready-for-agent

- [ ] A model is trained on archive-built features and on named-run-built features, both evaluated on the lead-matched feature, and the difference is published
- [ ] The train/serve correlation is recomputed on the capacity-weighted aggregate over the real frozen centroids, and the number is published
- [ ] Where the aggregated number contradicts the per-point number, the claim made elsewhere is revised rather than left standing
- [ ] Both results are written down where the weather decision is stated, not only in a test output

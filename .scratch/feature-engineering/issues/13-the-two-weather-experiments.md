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

## What was built, and what turned out not to be buildable

**Experiment 2 is built and runnable.** `apps/ml/src/wattsteer_ml/weather_reads.py`
builds both aggregate series from real weather versions and the real
`canonical_capacity_weight` vector, and hands them to
`AggregateCorrelation.measured`, which stamps `correlation_source =
weather_forecast_hour`. It needs no archive ingestion, because it needs no
feature row and no training run. The archive series is recovered as the
shortest-lead slice — one publication cut per valid hour instead of one per
target day — on the strength of this repository's own recorded measurement that
the stitched archive is bit-identical to `_previous_day0`. An hour whose newest
available run is older than twelve hours is not a day-0 slice; it is dropped and
counted rather than correlated, because treating it as one turns the control arm
into a second lead-matched arm and drives `r` toward 1.

**Experiment 1 cannot be run, and the reason is not the one forecaster 16
recorded.** Its reason — the archive is not ingested — stands, but the
archive-equivalence above means the control arm's *weather* is in fact
recoverable. What is not recoverable is the control arm's **feature rows**: the
archive is twenty-four different publication cuts inside one target day,
`feature_apply_gate` writes one instant for the whole day, and `feature_rows`
accepts no instant at all. No setting of the axes yields an archive-built
feature row. Building one means either a second weather read axis inside the
feature spine — the train/serve skew the spec exists to make unwritable — or a
parallel feature builder, which is a second definition of the vector. So the A/B
stays `UnmeasuredLeadTime` carrying `ARCHIVE_NOT_INGESTED`, **written to the
card** rather than omitted, with the correlation carried beside it on the same
block. No arms were fabricated to tick the first box.

**A defect found on the way, recorded rather than fixed.**
`0016_the_feature_gate.sql` says the feature-side `as_of` "filters nothing" over
the backfill window. It filters everything: `ingested_at` is the backfill
instant, the gate is a D−1 instant one to two years earlier, and
`feature_weather_block('2024-04-10', 'gate_late')` returns **zero rows** on a
migrated database with weather ingested in 2026 — not even the coverage-0 spine
rows the same migration promises. Every historical feature row is weatherless.
That is a defect in the gate spine and belongs to the ticket that owns it; it is
pinned as the behaviour it is by `tests/test_aggregate_train_serve_gap.py`, so
the day it is fixed that test fails and names the sentence to delete.

**Which boxes are genuinely ticked.** Box 2 and box 4. Box 1 is not, and cannot
be here. Box 3 is ticked in mechanism rather than in content: no number is
copied into this spec, `forecaster.md` or the map, because the block itself
states whether the aggregate cleared `r > 0.95` and therefore whether the
claimed gap should be revised — a figure restated in prose is a figure that can
be right on the card and stale everywhere else.

**Status:** done

- [ ] A model is trained on archive-built features and on named-run-built features, both evaluated on the lead-matched feature, and the difference is published
- [ ] The train/serve correlation is recomputed on the capacity-weighted aggregate over the real frozen centroids, and the number is published
- [ ] Where the aggregated number contradicts the per-point number, the claim made elsewhere is revised rather than left standing
- [ ] Both results are written down where the weather decision is stated, not only in a test output

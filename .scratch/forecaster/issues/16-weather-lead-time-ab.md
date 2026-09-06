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

**Status:** done (machinery); the run is blocked on archive ingestion — see below

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

## Why this experiment cannot be run yet

The control arm trains on the stitched Historical Forecast archive. **This repo
deliberately does not ingest it.** `apps/api/src/ingest/weather/single-runs.ts`
records the decision and the measurement behind it: the archive is bit-identical
to `_previous_day0`, the shortest-lead slice of each run, and training on it
inflates the intervals the product promises — RMSE 4.38 km/h train↔serve on
`wind_speed_120m` against a field sd of 8.87. The module "cannot address that
endpoint at all; `run=` is required on every request."

So `A-full-archive` has been a row of the matrix since before this ticket with
no data source behind it, and the same gap blocks the aggregate correlation,
one of whose two series is the archive one.

The comparison, the identity assertion, the interval deltas and the correlation
arithmetic are built and tested. Today's honest output is `UnmeasuredLeadTime`
carrying a named `ARCHIVE_NOT_INGESTED` reason **written to the card**, because
a card with no block and a card saying "the control arm has no data source" look
identical to anyone grepping for the figure.

**The remaining work is an archive-ingestion ticket, not a change here** — and
it would first have to overturn the measured decision above.

## Decision: the archive is not ingested, and will not be

Recorded so this stops being re-litigated by each ticket that trips over it.

`apps/api/src/ingest/weather/single-runs.ts` refuses the stitched Historical
Forecast archive on a **measurement**, not a preference: the archive is
bit-identical to `_previous_day0`, the shortest-lead slice of each run, and
training on it inflates the intervals the product promises — RMSE 4.38 km/h
train↔serve on `wind_speed_120m` against a field sd of 8.87. The module cannot
address that endpoint at all; `run=` is required on every request.

**The decision is to keep that refusal.** Ingesting the archive would buy one
control arm and cost the honesty of every published band, because a model fit on
systematically easier weather produces intervals that are too narrow on the
weather it is actually served. Too-narrow intervals under-state risk, which is
the unsafe direction for a product operators size storage against. A control arm
is not worth that.

What this does *not* block, and what changed after this ticket: the **aggregate
correlation** never needed the archive to be ingested. Feature-engineering 13
showed the archive weather series is recoverable from data already held — the two
arms are one axis apart, `published_at_or_before = gate_at(...)` against
`published_at_or_before = valid_time` — so that half is measurable and is being
wired up. Only the *training* arm stays unrunnable, and for a different reason:
a missing shape, not a missing ingestion.

# 10 — Time-varying capacity-weighted aggregation

**What to build:** point weather becomes one feature vector per subsystem, weighted
by where generating capacity actually was **at that moment**, not where it is today.

This is not a precaution. Applying present-day weights across the training window
was measured to misallocate a large share of the weight mass at window start, and
to move a capacity centroid far enough to cross several model grid cells. Static
weights would leak today's fleet composition into the earliest features and quietly
contaminate every backtest built on them.

**Blocked by:** 05, 09

**Status:** ready-for-agent

- [ ] Weights are computed as of each timestamp from as-of installed capacity
- [ ] Wind and solar carry separate weight vectors, since the two fleets sit in different places
- [ ] Aggregation produces one vector per subsystem per hour
- [ ] Centroids that collapse into the same model grid cell are detected and deduplicated
- [ ] A test demonstrates that static and as-of weights differ materially at window start
- [ ] Plants without usable coordinates still contribute their capacity via the fallback

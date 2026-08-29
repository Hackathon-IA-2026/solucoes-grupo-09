# 15 — The weekly retrain runs by itself, and reproduces itself

**What to build:** on its schedule, the retrain goes from the live database to a
gate decision without a human — and a rerun of it, from the same inputs and
seed, produces the same artifact.

End to end against real Postgres: build features for the current window, fit the
base learners on the base-fit block, fit the calibration layer and the two
conformal scalars on the trailing 90 days, compute the PIT matrix, write bundle
and card, run the gate against the incumbent on the live-edge fold, and append
exactly one line. Wall-clock and peak memory are recorded, so a retrain that
starts to outgrow the service is visible before it fails.

Determinism is part of the deliverable rather than an aspiration, because the
gate compares two artifacts and a nondeterministic pipeline makes the comparison
meaningless: same inputs and seed must give identical predictions, identical
feature hash and identical conformal corrections, and reloading the artifact
from the volume must reproduce predictions bit-identically.

**Blocked by:** 13, 14.

**Status:** ready-for-agent

- [ ] The retrain runs on the existing job infrastructure, is idempotent on
      retry, and appends exactly one decision line per run
- [ ] It scores against the live-edge fold, and refuses to let a
      revision-optimistic fold decide once a point-in-time fold exists
- [ ] Wall-clock and peak memory are recorded on the card
- [ ] Same inputs and seed give identical predictions, feature hash and
      conformal corrections
- [ ] Reloading the written artifact reproduces predictions bit-identically
- [ ] A retrain that fails part-way leaves no half-written artifact that the
      promotion log could later name
- [ ] The full fold sweep for every run in the matrix completes inside the
      retrain's budget

# 09 — Weather from named model runs, both cycles

**What to build:** WattSteer has weather that is the same object at training time
and at serving time — recovered from named model runs at a real day-ahead lead,
rather than from a stitched archive that was measured to be easier than reality.

Two run cycles are ingested. The earlier publishes sooner and buys operators
notice; the later is measurably better, especially in the evening hours where
curtailment risk concentrates. The later supersedes the earlier, and this needs no
special case: a run's initialisation time is its publication time, so supersession
is simply a newer vintage of the same valid hours.

Two silent failures must be made loud. Requesting a variable a model does not serve
returns nulls rather than an error. And automatic model selection silently
substitutes a different model between lead offsets — no null, no warning, plausible
numbers — so the model must be pinned explicitly on every request.

**Blocked by:** 01. Also gated by **Feature engineering spec** for the variable list
and the centroid set.

**Status:** ready-for-agent

- [ ] Weather is fetched from named runs, never from the stitched archive
- [ ] An explicit model is pinned on every request
- [ ] A requested variable returning all nulls fails loudly rather than storing missing data
- [ ] Both run cycles are ingested and remain distinguishable
- [ ] Run initialisation time is stored as the row's publication time
- [ ] The run's own first hour is excluded for accumulated variables
- [ ] Backoff is driven by the rate-limit status alone, since no rate-limit headers are returned
- [ ] Endpoint host and key are configuration, so moving to the commercial tier is an environment change
- [ ] A backfill of the full window completes within the documented call budget

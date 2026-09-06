# 24 — The replay cache key and seam 11 contradict each other

**What to build:** one true statement about the replay result's identity.

api-surface 20 left this open with the gap pinned rather than papered over, and it
is a spec self-contradiction rather than a bug:

- the caching table wants `<obs_data_version>` in the replay key, so a revision to
  the observed rows invalidates a cached replay;
- `replay_result` **publishes no observed data version**, and the spec's own
  "As built" paragraph says so;
- **seam 11 still demands the assertion anyway.**

So the document asks for a component that the thing it describes does not carry,
and then tests for it. Today the key has four components (the spec said five until
20 corrected it) and a test asserts the exact key string so it fails the day a
fifth lands.

**Decide it, do not restate it.** Either the replay result publishes the observed
data version it was computed against — which is the honest identity for a
point-in-time answer, and makes the key a complete provenance — or the spec drops
the requirement and seam 11 says what is actually true, with the consequence
written down: a cached replay can outlive a revision to the observations beneath
it, and for how long.

Note the metering precedent when weighing cost: `/v1/replay/days/<date>` was once
metered at the solve rate because it sat under a solver path, when a date picker
is a read. The cheap reading of a route's identity has been wrong here before.

**Blocked by:** api-surface 20 (merged).

**Status:** ready-for-agent

- [ ] The key's components and the spec's claim about them agree
- [ ] Seam 11 asserts something true
- [ ] If the observed version starts being published, it is a real provenance and
      not a clock, and the existing duration/clock scan still passes
- [ ] If it does not, the staleness window a cached replay can carry is stated
- [ ] The exact-key-string test is updated rather than deleted

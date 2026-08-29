# 13 — Canonical read contract for the ML service

**What to build:** the modelling service reads WattSteer's domain, not ONS's quirks.

Everything the modelling side needs is exposed as stable reads in the project's own
vocabulary: curtailment observations, system context, the operational day-ahead
balance, weather, and the registry with as-of capacity. The consumer never sees a
padded code, an average-power value, an aggregate row, or an end-of-interval
timestamp, because all of those were resolved at ingest.

This is what keeps the two-language architecture honest. Without it, ONS's
conventions get reimplemented on the Python side and the two implementations drift
— which is exactly the failure the template's deleted resolver-parity suite existed
to prevent, and is worth recovering from git history as prior art.

The reads must expose the vintage dimension rather than hiding it, so the modelling
side can request a point-in-time view and can tell when it is instead getting a
revision-optimistic one.

**Blocked by:** 02, 04, 07, 08, 09

**Status:** done

- [ ] Reads are exposed in domain vocabulary, with no source-specific naming
- [ ] The consumer can request an as-of view and receives exactly one row per key
- [ ] A read covering periods before ingestion go-live is flagged as revision-optimistic
- [ ] The forecast source is distinguishable from observations in the contract itself
- [ ] Reason codes are reachable only at the grain where they are observed
- [ ] The service reads only and holds no migration rights
- [ ] The contract is documented well enough that the modelling side never reads raw tables

# 05 — Registry coordinates from the ANEEL extract

**What to build:** every plant in the registry gains a location, so weather can be
sampled where the fleet actually is rather than where its state capital is.

The external registry contributes coordinates, municipality and ownership — and
nothing else. Capacity and dates stay with ONS, which has them per unit and
without the registration lag that leaves newly-operating plants sitting at zero
capacity in the external source while they are being curtailed.

The join is the whole risk. The obvious key matches nothing at all, and does so
silently: an inner join returns an empty result, a left join returns a column of
nulls. The version segment must be stripped from the identifier on both sides
before comparing, and the resulting match rate must be asserted on every ingest
so a regression is caught immediately rather than surfacing months later as
missing coordinates.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] The daily registry resource is ingested, not the monthly one
- [ ] The join key strips the version segment on both sides; raw identifiers are retained
- [ ] The match rate is asserted on every ingest, and ingestion fails if it regresses
- [ ] Plants at the null-island coordinate are treated as missing, not as located
- [ ] A municipality fallback exists for plants without usable coordinates
- [ ] Technology and size filters are applied before any capacity aggregation
- [ ] Row deletions are detected by diffing against the prior snapshot
- [ ] A fixture test proves the naive verbatim key comparison matches nothing

# 03 — Per-plant constrained-off detail

**What to build:** WattSteer can show which individual plants were curtailed and by
how much, with the per-plant measured wind speed or irradiance and the estimated
versus verified generation that came with it.

The defining constraint of this ticket is what it must *not* do. The per-plant
files carry no reason code and no reference generation. A reason must never be
attached to a plant, and no join may be built that makes it appear one could be.
If a later screen wants per-plant reasons, it will have to compute an explicit,
labelled allocation — a product decision, not a storage one.

**Blocked by:** 02

**Status:** done

- [ ] Per-plant curtailment detail is ingested for both wind and solar
- [ ] Measured wind speed and irradiance are stored with their invalid-data flags
- [ ] The permanent difference in boolean encoding between the two technologies is handled
- [ ] The asymmetry in available columns between entity and detail files is handled
- [ ] No schema path exists by which a reason code can reach a plant row
- [ ] Plant identity resolves consistently against the entity-grain data
- [ ] A documented unit that is dimensionally wrong at source is corrected on ingest, and the correction recorded

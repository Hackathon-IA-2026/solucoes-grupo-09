# 20 — Two tables a feature reads have no go-live row, so the horizon cannot narrow

**What to build:** a go-live record for every source the feature gate actually
depends on.

Feature-engineering 16 set out to give the ingestion cut a per-source floor and
found the per-source floor would move **zero rows** — the gate precedes every
`valid_time` in the spine by at least five hours, so "every source's floor is
satisfied" and "the gate is at or after the last go-live" are the same predicate.

But it found the reason the horizon **cannot** be narrowed even where narrowing
would help, and that reason is this ticket:

> `canonical_plant_registry` — behind every weather feature via
> `canonical_capacity_weight` — reads `plant_geo` under `canonical_as_of()`, and
> `plant_geo` is in no row of `canonical_read_go_live`.

Verified: that view names eight reads and neither `plant` nor `plant_geo` is
among them. So `feature_ingestion_history_from()` maxes over nine rows, two of
which no feature block reads, while a source that **is** read has no row at all.
Narrowing the horizon to the sources features use would make the vintage stamp
claim more than the data supports — which is why 16 left the wide horizon
standing and filed this.

The cost of the gap today is over-stamping: onboard one of the two unread sources
last and target dates in between read `revision_optimistic` when they are
genuinely point-in-time (11,904 rows over 62 dates in the scenario that shows it).
That is the safe direction, which is why nothing is on fire.

**Blocked by:** None. Feature-engineering 16 is merged and recorded the finding.

**Status:** ready-for-agent

- [ ] Every table the canonical views read under `canonical_as_of()` has a go-live
      record, or is shown not to need one
- [ ] The set is **derived** rather than listed — a tenth read added tomorrow must
      not silently lack a row, and this repo has been bitten five times by
      enumeration where discovery was needed
- [ ] `feature_vintage_fidelity`'s weakest-link stamp still binds at the last
      go-live among the sources a row actually reads
- [ ] Whether the horizon can now narrow is answered with the measurement, not
      asserted; if it can, the over-stamped rows become `point_in_time`
- [ ] `feature_rows` still accepts no instant; the publication cut is untouched
- [ ] Any `feature_hash` movement is reported prominently — the tree is already
      carrying `0039`'s retrain debt

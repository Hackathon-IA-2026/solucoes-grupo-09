# 02 — Constrained-off at entity grain, with conjunto and reason codes

**What to build:** WattSteer knows how much renewable energy was curtailed, where,
when, and for which documented reason — at the grain ONS actually reports it,
which is the conjunto for the overwhelming majority of wind.

This is the target variable. It also introduces the conjunto as an entity in its
own right, and establishes the rule that governs the rest of the product: a
curtailment reason exists at conjunto grain and nowhere else.

Unlike the tracer's dataset, these files have a moving schema. A column was added
to the published dictionary long after it had appeared in the files, and was
backfilled retroactively into already-closed months. The adapter must read each
file's header on every ingest, and must treat a column that is present but empty
as different from one that is absent.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Both wind and solar constrained-off are ingested at entity grain
- [ ] Each file's header is read on every ingest; no schema is cached per period
- [ ] A column present but empty is distinguishable from one that is absent
- [ ] All four reason codes are modelled, including the one documented but not yet observed
- [ ] Restriction origin is captured alongside reason
- [ ] Conjunto exists as an entity; entity rows resolve to conjunto or plant correctly
- [ ] Curtailed energy is derived from the reference-generation columns, as energy
- [ ] Data is downsampled to hourly to meet the system context, in the lossless direction
- [ ] A retroactive backfill of a closed month is detected and stored as a new vintage
- [ ] Fixture tests cover the schema-drift and empty-column cases explicitly

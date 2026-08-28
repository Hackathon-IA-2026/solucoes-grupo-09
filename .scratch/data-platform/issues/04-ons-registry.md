# 04 — ONS registry: plants, units, as-of capacity, conjunto membership

**What to build:** WattSteer can answer "what generating capacity existed, where,
and in which conjunto — as of any date in the window" from ONS sources alone.

Installed capacity is published only as a snapshot that is overwritten daily, but
its rows carry per-unit commissioning and deactivation dates, so an as-of capacity
series is reconstructable from a single current cut. That reconstruction is what
capacity normalisation and capacity weighting both depend on, and getting it right
here means neither has to approximate later.

Conjunto membership is time-resolved at source, so a plant that joined a conjunto
mid-window is attributed correctly rather than retroactively.

**Blocked by:** 02

**Status:** done

- [x] Plant, generating-unit and conjunto-membership registries are ingested
- [x] Capacity is aggregated from unit grain to plant grain correctly
- [x] Installed capacity is queryable as of any date in the window
- [x] Conjunto membership is queryable as of any date, honouring its validity dates
- [x] Operation modality is available per plant
- [x] Subsystem comes from the electrical assignment and is never derived from state
- [x] An assertion fires if any renewable unit ever gains a deactivation date, since none currently has one
- [x] The snapshot is stored with its own vintage, since the previous day's is unrecoverable

# 01 — Tracer: balanço de energia, end to end

**What to build:** WattSteer can answer "what were load, hydro, thermal, wind and
solar generation for each subsystem, hour by hour, and what did we believe about
that at any past moment" — for one ONS dataset, all the way from the published
file to a queryable answer.

This is the tracer bullet. The dataset is chosen not because it is the most
important but because its schema has been stable since 2000, so the work is the
machinery rather than the dataset. It nonetheless exercises four of the
normalisation traps, so the canonical form is proven rather than asserted.

By the end, the shape every later adapter follows exists: discover the resource
from the catalogue rather than constructing a URL, detect whether it changed,
fetch and parse it, normalise into WattSteer's canonical form, write append-only
with both time axes, and read it back as of a chosen moment.

**Blocked by:** Nothing — can start immediately. The strip has landed.

This ticket also **makes** the bitemporal schema decision rather than waiting on
it: the wide-vs-narrow table shape and how `data_version` is derived are settled
here, while writing the first real tables, because one parsed adapter teaches
more than an hour of speculating about datasets nobody has read yet. Everything
ingestion needs from the domain model is already decided on the map — subsystem
grain, conjunto as an entity, reasons only at conjunto grain, forecasts stored
apart from observations, the 2024-04 window.

**Status:** done

- [x] Resource URLs are read from the catalogue API, never constructed
- [x] A changed file is detected without downloading it
- [x] Parquet is preferred; the CSV fallback path exists and is exercised
- [x] Subsystem codes are canonicalised; padded and unpadded forms both resolve
- [x] The system-wide aggregate row is filtered at the adapter boundary
- [x] Timestamps become UTC instants; interval labelling is normalised to start-of-interval
- [x] Average-power values are converted to energy using the source interval length
- [x] Every string column is trimmed unconditionally
- [x] A re-ingest with identical values writes no new version
- [x] A re-ingest with changed values appends a version rather than overwriting
- [x] An as-of read returns exactly one row per key
- [x] Fixture tests cover each normalisation rule, using a real captured payload
- [x] As-of behaviour is tested against real Postgres, gated the way the template gates its database test
- [x] Ingestion runs on the existing job infrastructure and is idempotent on retry
- [x] The chosen table shape and `data_version` derivation are recorded, and the
      wayfinder ticket **Bitemporal schema and ingestion contract** is closed

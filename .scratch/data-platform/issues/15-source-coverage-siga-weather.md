# 15 — Refresh, dispatch and health cover SIGA and weather

**What to build:** the two ingestors that landed after the refresh/observability
work are planned, dispatched and watched like every other source.

Ticket 11 branched before tickets 05 and 09 merged, so `ingestion_source` has
nine members and neither `siga` nor `weather` is among them. The consequence is
not cosmetic: neither source is scheduled by a refresh tier, neither is reachable
through the queue dispatcher, and — worst — `GET /ingest/health` cannot report
either as stale. A registry snapshot or a weather run could stop arriving and the
health endpoint would keep returning 200.

Weather is not merely a tenth row in an existing table. Its cadence is a *model
run*, not a published month, so the tiered vocabulary has to be given a meaning
for it rather than a slot: decide what `live`, `recent` and `history` mean for
two daily runs and a bounded archive, and say why in the code. SIGA is a
twice-daily snapshot of now, so it has no period — like `plant_registry`, whose
handling is the prior art.

**Blocked by:** 05, 09, 11 — all merged, can start immediately

**Status:** done

- [ ] `ingestion_source` covers both, and the enum change ships as a migration
- [ ] Both are planned by `planRefresh` with a cadence that suits their real publication rhythm, documented in the code
- [ ] The dispatcher fans out to both, so a task for either can be enqueued
- [ ] `/ingest/health` reports freshness for both against the facts, with a per-source staleness tolerance, and returns 503 when either goes quiet
- [ ] Custody covers the weather transport's payloads, as it does the carga API's
- [ ] A test proves a missing weather run and a missing SIGA snapshot each turn the endpoint 503

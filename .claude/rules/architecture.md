# Architecture

Four services and two packages. The shape exists so that **the modelling service
being down is a stale timestamp, not an outage**.

```
ONS + weather ──▶ apps/api (worker)  ──▶ Postgres ──▶ canonical views
                                                          │
                            apps/ml  ◀── feature_rows() ───┤
                          (artifacts,                      │
                           gates, MILP)                    │
                                 ▲                         ▼
apps/web  ───────────────▶  apps/api (gateway)  ◀──────────┘
 (static)                    /v1/*                  apps/rag (evidence)
```

## Who may call whom

- **`apps/web` calls the gateway and nothing else.** No direct database, no
  direct modelling service. It is a static export served by a tiny Bun server.
- **The gateway owns the boundary onto `apps/ml`.** Exactly the modules named in
  `apps/api/test/ml-boundary.test.ts` may cross it, each with a stated reason,
  and `apps/api/src/api/ml-proxy.ts` is the only door. Adding a fifth crossing
  means adding it to that list with an argument — the test enumerates them and
  fails on a new one.
- **`/internal/*` on `apps/ml` is private.** The worker calls it; the gateway
  serves nothing under that prefix and never will. The prefix *is* the marker.
- **Product reads never touch an ingest table.** ADR-0005. They read
  `apps/api/src/database/canonical-views.ts`, which owns the vintage pick, the
  renames, the grain and the units.

## Degradation is a property of the graph

`GET /v1/grid/now`, `/v1/curtailment/*` and `/v1/grid/context` resolve entirely
from Postgres. With `apps/ml` returning 503 for everything and no promoted
artifact in any lane, those routes still answer 200 with real numbers — which is
what makes the product honest on a day with no forecast, and it is a property of
the dependency graph rather than a fallback somebody has to remember to write.

Keep it that way: a new observed route that imports anything from the modelling
side has quietly moved itself into the other category.

## The worker is the only scheduler

One queue, one scheduler, registered in `apps/api/src/worker.ts`: the refresh
sweeps (live hourly, recent weekly, history monthly), retention, centroid drift,
the publications, the RAG refresh, and the weekly retrain. Schedule ids are
stable so N replicas converge on one entry apiece.

A schedule that needs `WATTSTEER_ML_URL` is skipped **loudly** without one, in
its own sentence — a weekly job firing into an unconfigured URL is a guaranteed
Friday failure, and what an operator should see instead is the incumbent going
on serving with no new decision line.

## `apps/rag` is evidence, not classification

It finds the ONS document that states a rule, quotes it and cites it. It never
classifies a curtailment: REL, CNF and ENE stay with the rule and with SHAP.

## Where the reasoning is

`CONTEXT.md` → the domain model, the contracts, the ADRs. Most modules open with
the argument for their own shape, and for this repository that is usually the
best documentation of a subsystem — `canonical-views.ts` and
`use-app-params.ts` are worth reading in full before you touch either area.

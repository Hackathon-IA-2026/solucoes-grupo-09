# Diagnosis + Public API Surface — the two ticket sets, and how they block each other

These two specs were sliced together because **the diagnosis output is part of
the API's wire contract**. The driver rows, the reason codes and the
`data_conditions` group all cross the boundary, so slicing them apart would have
produced two ticket sets that disagree about the same JSON.

- Diagnosis tickets: `.scratch/diagnosis/issues/01…11`
- API-surface tickets: `.scratch/api-surface/issues/01…22`

This file is the dependency graph for **both**. There is no separate diagnosis
README.

## External ticket sets referenced as blockers

Named rather than specified. Nothing here re-specifies any of them.

| Name | What it owes these tickets |
|---|---|
| **forecaster** (`.scratch/forecaster/issues/`, being sliced in parallel) | the two estimators and the single composition function; the path ensemble and the day-grain figures; the model card; the three artifact states; **and the two additions this spec asks for** — the matched background sample (128 rows per subsystem × local-hour cell, stamped seed, in the artifact bundle) and the three card fields (driver-group version, driver-group hash, headline-feature check) |
| **flex-optimizer** (`.scratch/flex-optimizer/issues/`, in parallel) | the scenario contract, the eighteen validation rules, the solve, the simulator, the avoidability rule |
| **replay** | the replay and backtest contracts, the featured-day rule, the pinned-origin discipline |
| **data-platform 16** (in flight) | the canonical contract as SQL views. `/v1/canonical/*` keeps serving from those views. Gates only the routes that read canonical rows. |
| **product-fixes 01** (already sliced) | the landing hero's national headline and its copy |
| **i18n 04** (done) | the hardcoded-string guard every copy-touching ticket below must pass |

## What can start today, in parallel, with no model and no artifact

Seven independent fronts. None of these waits on anything.

| Ticket | Why it is unblocked |
|---|---|
| **API 01** — proxy failure mapping | Two defects in code that already exists. Smallest ticket in either set. |
| **API 02** — error envelope and closed code enum | Foundation; breaks a surface with no consumers yet. |
| **API 03** — shared constants and promoted vocabulary | Pure refactor plus one duplicated-constant bug. |
| **API 05** — rate limiting and per-route body limits | Needs only API 02's envelope for its 429. |
| **DIAG 01** — the causality-boundary enforcer | A repo-level check. No model, no endpoint. |
| **DIAG 02** — the eight-group driver map | Groups names the feature spec already fixed. |
| **product-fixes 01** — the national headline | Already sliced; independent of all of this. |

API 04 (schema, generated types, typed client) unlocks nine tickets and should
start the moment 02 and 03 land — it is the highest-leverage node in the graph.

## The API-surface graph

```
01 proxy failure mapping ──────────────────┐
02 error envelope ──┬── 05 rate limiting   │
03 core constants ──┤                      │
                    └── 04 schema/types/client ──┬── 06 meta
                                                 ├── 12 grid/now ── (dp16)
                                                 ├── 14 observed ── (dp16)
                                                 ├── 16 model card ── (forecaster)
                                                 ├── 19 plants
                                                 ├── 21 parity vectors
                                                 └── 17 solver+replay ─┬─ 18 one execution rule
03 ──┬── 07 explain contract   ── (diag 02, diag 04)                   │
     ├── 08 forecast not per-technology ── (forecaster)                │
     └── 09 replay day + landing origin ── (replay, product-fixes 01)  │
                                                                       │
(forecaster, dp16) ── 10 forecast publication ──┬── 11 day-ahead ──────┤
                                                └── 13 outlook         │
                              (diag 06/07/09/12) ── 15 diagnosis ──────┤
                                                                       │
                        11,13,14,15,17 ── 20 caching+ETags             │
                        11,15,17 ────────── 22 the boundary asserted ──┘
```

Per-ticket blockers, in one line each:

| # | Ticket | Blocked by |
|---|---|---|
| 01 | Proxy failure mapping | **None** |
| 02 | Error envelope and code enum | **None** |
| 03 | Shared constants and vocabulary | **None** |
| 04 | Schema, generated types, typed client | 02, 03 |
| 05 | Rate limiting and body limits | 02 |
| 06 | `/v1/meta` | 03, 04 |
| 07 | Explain screen contract | 03 · *diag 02, diag 04* |
| 08 | Forecast is not per-technology | 03 · *forecaster* |
| 09 | Replay day and landing origins | 03 · *replay, product-fixes 01* |
| 10 | Forecast publication jobs and tables | *forecaster, data-platform 16* |
| 11 | `/v1/forecast/day-ahead` from Postgres | 04, 10 |
| 12 | `/v1/grid/now` | 04 · *data-platform 16* |
| 13 | `/v1/grid/outlook` | 04, 10 · *product-fixes 01 owns the copy* |
| 14 | Observed endpoints | 04 · *data-platform 16* |
| 15 | `/v1/diagnosis/day-ahead` | 04, 05, 11 · *diag 06, 07, 09, 11* |
| 16 | `/v1/model/card` | 04 · *forecaster* |
| 17 | Solver and replay routes | 01, 02, 04, 05 · *flex-optimizer, replay* |
| 18 | Exactly one execution rule | 17 |
| 19 | `/v1/plants` | 04 |
| 20 | Caching and ETags | 11, 13, 14, 15, 17 |
| 21 | Cross-language parity vectors | 04 · *flex-optimizer, feature-engineering* |
| 22 | The boundary, asserted | 11, 15, 17 |

## The diagnosis graph

```
01 causality enforcer ──────────────────────────┐
02 driver group map ── 03 grouped Shapley ──┬── 04 day attribution ──┬── 05 detectors
     (forecaster: composition fn +          │                        ├── 06 persisted attribution
      matched background)                   │                        │      └── 07 domain rules
                                            │                        │             └── 08 payload
                                            │                        │                    └── 09 template
                                            │                        │                          ├── 10 validator ←01
                                            │                        │                          └── 11 renderer ←10
                                            └────────────────────────┘
```

The narration **cache** has no ticket of its own in this set: it is folded into
**API 15**, which owns the key's use, the single-flight lock and the daily cap.
The key's *definition* is fixed by the diagnosis spec and is cited there rather
than re-decided.

| # | Ticket | Blocked by |
|---|---|---|
| 01 | Causality-boundary enforcer | **None** |
| 02 | Eight-group driver map | **None** |
| 03 | Grouped Shapley, one hour | 02 · *forecaster: composition function + matched background sample* |
| 04 | Day attribution, disagreement, stderr | 03 |
| 05 | Attribution detectors | 03, 04 |
| 06 | Persisted attribution | 04 · *API 10 owns the schedule* |
| 07 | Domain rules, one-way valve | 04, 06 |
| 08 | Narration payload | 06, 07 |
| 09 | Template narration | 08, 01 |
| 10 | Output validator | 01, 08, 09 |
| 11 | The renderer | 09, 10 |

## The cross-spec edges, listed explicitly

These are the ones easiest to lose, and the reason the two sets were sliced
together.

1. **DIAG 02 → API 07.** The eight group codes and their label keys are the
   Explain screen's closed driver-code union. The screen's current union is
   twelve prototype names that are not the eight groups.
2. **DIAG 04 → API 07.** The mixed-direction merge rule and the
   share-of-attributed-movement definition are the screen's display rule and its
   footnote copy.
3. **DIAG 06 ↔ API 10.** Diagnosis owns the attribution row's content and grain;
   the API owns the scheduled job that produces it and the worker that writes it.
   Neither is complete alone.
4. **DIAG 07, 09 → API 15.** The withheld state is a 200 with a template
   narration. The endpoint cannot be finished before the rules and the template
   exist.
5. **The narration cache key → API 15.** One key, defined by the diagnosis spec
   and consumed at the gateway, which also owns the single-flight lock and the
   daily cap. **A third cache key over the composed response is forbidden.**
6. **DIAG 01 → API 02, 07, 09, 11, 15, 19.** Every ticket that adds copy is
   scanned by the causality enforcer and by the existing hardcoded-string guard.
7. **API 10 → DIAG 03.** Both wait on the forecaster's composition function; the
   forecast publication and the attribution publication are the same job chain.

## Standing rules every ticket in both sets inherits

- **Portuguese is the default locale.** Any ticket adding user-facing copy puts
  every string in both dictionaries and passes the hardcoded-string guard. The
  guard's current scope is the app and component trees — copy assembled in a
  library module would evade it, which is a live risk for the template narration.
- **Codes on the wire, never translated strings.** Risk classes, driver labels,
  reason codes, error codes and units are all codes; the client translates. The
  single settled exception is generated narration prose.
- **Never an invented number, and never a zero standing in for an absence.**
- **Nothing sums two bands.** Expectations add; quantiles and medians do not.
- **The public API never calls the modelling service for a forecast or an
  attribution.** Only scenarios go to Python per request.

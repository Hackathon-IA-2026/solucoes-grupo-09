# 06 — One HTTP request, no job id, and a number that can be traced to its run

**What to build:** a client posts a scenario and gets a plan back inside one
request — no job id, no polling, no "your scenario is being computed" screen —
because Mitigate is a what-if tool and a slider must move the chart. And every
result carries enough provenance that a number on a screen can be traced to the
run that produced it.

```
POST /v1/optimize          body: the Scenario object
GET  /v1/optimize?s=<blob> for deep links and shares
```

There is **no queue, no job and no `OptimizationJob` noun.** The research measured
3.15 ms at real size, 33.7 ms at ten batteries plus ten loads, and 63.2 ms at 96
periods. The optimizer lives in `apps/ml`, which already owns OR-Tools; `apps/api`
is the only public surface — it validates, resolves the forecast vintage, applies
the rate limit, checks the cache and proxies. The ml service is not publicly
routable.

The FastAPI handler is a **`def`, not an `async def`**, so the solve runs on the
threadpool and a worst-case 2 s solve cannot block the event loop. Each solve calls
`SetNumThreads(1)`: per-request CPU stays bounded under concurrency, and at these
sizes parallel branch-and-bound buys nothing.

Failure posture for a public unauthenticated endpoint running a solver:

| Condition | Status | Code |
|---|---|---|
| validation | `422` | the code from ticket 04 |
| rate limit exceeded | `429` | `RATE_LIMITED`, with `Retry-After` |
| solver `FEASIBLE` (gap unclosed at the time limit) | `503` | `SOLVER_GAP_UNCLOSED` |
| solver `NOT_SOLVED` / time limit hit | `504` | `SOLVER_TIMEOUT` |
| solver `INFEASIBLE` / `UNBOUNDED` / `ABNORMAL` | `500` | `SOLVER_BUG` + scenario hash logged |
| ml service unreachable | `502` | `OPTIMIZER_UNAVAILABLE` |

**A non-`OPTIMAL` status is never rendered.** A `FEASIBLE` result means the gap was
not closed, so the Avoidability Score would be a lower bound, and there is no honest
way to put a lower bound in a box labelled with a percentage.

**`INFEASIBLE` is a WattSteer bug, not a user error.** The do-nothing dispatch —
all charge, discharge, shift and absorb at zero — satisfies every constraint,
provided validation has guaranteed `min_soc ≤ initial_soc ≤ max_soc`. The model is
therefore feasible by construction for every scenario that passes validation, so
infeasibility can only mean validation let something through. Hence the `500` and
hence the scenario hash in the log.

**Cache** — a cache, not persistence, evictable at any time with no user-visible
loss. Redis, key
`opt:v1:<sha256(canonical scenario)>:<resolved forecast_origin>:<optimizer_build>`,
TTL 24 h. The forecast origin is in the key because a superseding 12Z run must not
be served an 00Z plan; `optimizer_build` is in it because a deploy that changes the
formulation must not serve yesterday's plan under today's code.

**Blocked by:** 01, 04. (05 is not a blocker — a battery-only endpoint is a
complete slice, and the load variant flows through unchanged.)

**Status:** ready-for-agent

- [ ] `POST` and `GET ?s=` both answer inside one request with no job id anywhere in the contract
- [ ] The handler is a `def`; `SetNumThreads(1)` and `SetTimeLimit(2000)` are set per solve; the gateway timeout is 5 s
- [ ] One test per row of the failure table, each asserting the status and the code
- [ ] A `FEASIBLE` solve is a `503` and never a rendered result
- [ ] Feasibility invariant, property-based: randomly generated valid scenarios return `OPTIMAL` every time, backed by a direct test that the do-nothing dispatch satisfies every constraint
- [ ] Per-IP token bucket at the gateway, 30 requests/minute burst 10, on the existing Elysia rate-limit plugin
- [ ] Requests are rejected on size and shape *before* a model is built
- [ ] `solver` carries backend, status, wall time, objective and the runtime-read `ortools_version` / `scip_version`
- [ ] A cache hit returns byte-identical output; a changed `forecast_origin` or `optimizer_build` misses

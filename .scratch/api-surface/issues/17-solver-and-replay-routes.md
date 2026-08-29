# 17 — Moving a slider moves the chart, and the solver is the only thing behind the gateway

**What to build:** the routes that genuinely call the modelling service per
request, versioned and rate-limited: the optimizer, the replay, the replayable
calendar and the backtest aggregate.

```
POST /v1/optimize   ·   GET /v1/optimize?s=
GET  /v1/replay/days?subsystem=
GET  /v1/replay?d=&s=&subsystem=   ·   POST /v1/replay
GET  /v1/backtest?fold=&subsystem=&vintage_fidelity=
```

**The optimizer and the replay solve are the mirror image of the forecast and
must stay per-request.** They have no artifact dependency, the solve is
milliseconds, and the input is a user-supplied scenario from an unbounded space —
there is nothing to precompute. The optimizer spec already fixed the call as
synchronous with **no job noun**, and the domain model records that there is
therefore no optimization-job entity to invent.

**These contracts are re-pathed, never re-shaped.** Both sibling specs declare
their request and response contracts fixed and say this ticket may re-path them.
The only change is the version prefix the optimize route already effectively had.
The body is the scenario object; the query form is the base64url of the same
canonical bytes.

**The scenario is carried, never stored.** A scenario-shortening service is
deliberately not an endpoint: adding one would invent the persistence and the
identity the domain model spent a section removing. The URL is the storage; the
server-side result cache keyed by the scenario hash is a *cache*, evictable at
any time with no user-visible loss.

**The replayable calendar** returns a compact run-length encoding of dates plus,
per date, the provenance and vintage fidelity that would apply, and the featured
shortlist from the published deterministic rule — so a date picker renders before
any replay is requested.

**The backtest never averages across vintage fidelity.** The grouping is
structural: the endpoint takes fidelity as a **group key** and returns one row per
value, rather than accepting it as a filter that could be omitted.

**Replay keeps working when no artifact is promoted**, because it reads pinned
rows and never consults the currently promoted serving artifact for a historical
day. That is a real product property and this ticket must assert it.

**Blocked by:** 01 (the proxy's corrected failure mapping is what makes a bad
scenario distinguishable from an outage), 02, 04, 05. Cross-spec:
**flex-optimizer** and **replay** own these contracts and their solve
implementations; nothing here re-specifies them.

**Status:** ready-for-agent

- [ ] All four routes are versioned and their contracts are byte-identical to the sibling specs'
- [ ] The optimize call is synchronous with no job identifier anywhere in the surface
- [ ] The query form and the body form produce the same canonical bytes and hit the same cache key
- [ ] These are the only route handlers permitted to reach the modelling service, asserted structurally
- [ ] With the modelling service returning 503, these two return the upstream-unavailable code while every read route still returns 200
- [ ] The backtest returns one row per vintage fidelity and never averages across them
- [ ] A replay returns a complete result with no promoted artifact
- [ ] The scenario is never persisted; the result cache is evictable with no user-visible loss

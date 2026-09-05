# Spec — WattSteer Public API Surface

> One gateway, fourteen routes, and a boundary drawn so that the ML service
> being down is a stale timestamp rather than an outage.
>
> **Upstream specs.** [`forecaster.md`](forecaster.md) fixes the content of a
> forecast (composed band, path-ensemble day figures, artifact metadata, the
> three artifact states) and defers "API paths, response envelopes and caching"
> to here. [`diagnosis.md`](diagnosis.md) fixes the attribution payload, the
> narration cache key and **three UI contract changes** that the prototype's
> fixtures currently contradict; reconciling them is this spec's job.
> [`flex-optimizer.md`](flex-optimizer.md) and [`replay.md`](replay.md) each
> declare their request/response contract **fixed** and say ticket 013 "may
> re-path" them — so this spec re-paths and never re-shapes.
> [`feature-engineering.md`](feature-engineering.md) owns
> `gate_at(target_date, gate_profile)`, which is what makes a forecast's
> `published_at` a property of the target date rather than of the request.
> [`i18n.md`](i18n.md) owns the rule that the API returns codes, never
> translated strings, with generated narration as the single exception.
>
> **Naming authority.** [`../domain-model.md`](../domain-model.md); where it and
> this spec disagree, it wins.
>
> **The surface as built.** `apps/api/src/api/index.ts`,
> `apps/api/src/api/ml-proxy.ts`, `apps/api/src/api/plugins/*`,
> `apps/api/src/errors.ts`. Every change this spec asks for in those files is
> named explicitly rather than assumed.
>
> Ticket: [`013-api-surface.md`](../../.wayfinder/tickets/013-api-surface.md).
> Map: [`.wayfinder/map.md`](../../.wayfinder/map.md).

## Problem Statement

IDEA.md §41 sketches three endpoints — `GET /forecast`, `GET /diagnosis`,
`POST /optimize` — and four specs have since fixed what two of them return. The
work left is not "write down the paths". It is four questions the other specs
each deferred here, and one they did not know they were asking.

**1. The boundary is a failure-mode decision wearing a routing costume.** The
gateway already has an `ml-proxy` module that forwards `/forecast/day-ahead` to
the Python service per request. That is a defensible architecture and it makes
the ML service a hard dependency of the product's most-viewed screen. The
alternative — the worker precomputes forecasts into Postgres and the public API
reads rows — makes the same screen survive an ML outage entirely. The two
differ in nothing a user can see on a good day and in everything they can see on
a bad one. The specs contain the deciding argument and none of them states it:
`replay.md` already requires the forecast to be precomputed, and
`forecaster.md` story 35 already requires every served forecast to be persisted.
If both are true, a per-request inference is a **second** producer of a number
that is already in a table — which is the drift class this whole effort keeps
ruling out, arriving at the last layer.

**2. The fixtures and the specs disagree, and the disagreements are not
symmetric.** `diagnosis.md` flags three UI contract changes. There are five, and
two of them are larger than the three that were flagged: the prototype builds an
explanation per `(subsystem, technology)` for a model that has no per-technology
head, and the landing hero stamps a curtailment forecast with
`producer: "open_meteo"`, which names the *weather* run and not the forecast.

**3. Nothing at all adds, including the national headline.** Ticket 014 made
"nothing in the UI sums two bands" a test. The landing page's hero then sums
four subsystem P50s into a national P50 and calls the rest non-additive. Medians
do not add either — the median of a sum is not the sum of the medians — and the
forecaster's path ensemble is drawn per subsystem, so **there is no national
band and no national median that any published quantity supports**. This is a
product surface with no engine behind it, and it is the largest gap between what
the screens render and what the specs can produce.

**4. The public, unauthenticated, account-free posture makes caching and rate
limiting harder than usual, not easier.** There is no `Authorization` header to
`Vary` on, so every response is shared-cacheable, so a wrong `max-age` is wrong
for everyone. And one endpoint runs a branch-and-bound solver on
attacker-controlled input while another spends money on a language model.

**5. The ticket's own caching premise is false in one place.** "Forecasts change
daily, replays never change." A forecast changes *twice* daily, at two gates,
and a replay changes whenever ONS restates the day it is scored against —
which the map records ONS doing to a whole year, in place, with no version
marker. A replay is reproducible at a **pinned forecast origin**; it is not
immutable, and an `immutable` cache directive on it would freeze a number
against a restatement the product's entire honesty posture exists to surface.

Underneath all five is the failure class every prior spec names: **a number that
is wrong in a direction nobody can see.** At this layer it takes two new shapes
— a stale forecast that looks fresh because nothing on the response says when it
published, and a zero standing in for an absence.

## Solution

**One public gateway; the model never sits in a request path; the solver always
does.**

- **The boundary is drawn between *artifact* and *solver*, not between
  *request* and *batch*.** Anything that needs a model artifact — the composed
  band, the day-grain ensemble figures, the SHAP attribution — is computed by
  the **worker on a schedule** at the two gate instants and written to Postgres.
  The public API reads rows. Anything that is a pure function of stored data
  plus user input — the MILP and the simulator, 3.15 ms measured — is called
  **per request** on the ML service, because the scenario is unbounded and
  cannot be precomputed. The forecast route is deleted from `ml-proxy`; the
  module survives, its failure mapping intact, pointed at the solver.
- **Fourteen routes under `/v1`**, plus the four unversioned probes that exist.
  Two of them are new to every spec: a national/grid readout for the landing
  page, and a machine-readable plant registry that the map's ODbL analysis
  requires and no ticket has claimed.
- **The wire is `snake_case` and the client is the only translator.**
  `flex-optimizer.md` and `replay.md` fixed their contracts in `snake_case`, the
  Python service speaks `snake_case`, and the web app speaks `camelCase`. One
  mapping layer, in `packages/core`, or there will be four.
- **`packages/core` holds the JSON Schema, the generated types, the typed
  client, and the published constants** — including `REFERENCE_FLEET`, which
  `replay.md` names as "`packages/core`'s single published `REFERENCE_FLEET`"
  in as many words. The resolver-parity pattern from the template is recovered
  as a **shared golden-vector directory** read by `bun test` and `pytest`, and
  it is pointed at the five values now computed in two languages.
- **Caching is keyed on provenance, never on wall-clock.** A forecast's cache
  identity is its `ForecastOrigin`; a replay's is its pinned origin *plus* the
  observation `data_version`; a scenario result's is the canonical scenario hash
  plus the resolved origin plus the optimizer build. Nothing carries
  `immutable`.
- **Rate limiting is three tiers and the scarce resource is what gets
  protected.** Reads are cheap and CDN-cached; the solver gets a token bucket;
  the language model gets a single-flight lock and a daily cap rather than an IP
  limit, because sixteen distinct narrations a day cannot be protected by
  counting requests.
- **The error contract is one envelope, one closed code enum, and four distinct
  "no forecast" states** — because "not published yet", "no promoted artifact",
  "stale" and "the gateway is down" are four different sentences and the screen
  must not collapse them into a spinner.

## User Stories

**The boundary**

1. As a visitor, I want the Grid Overview to render when the ML service is
   down, so that a modelling outage is not a product outage.
2. As an operator, I want a forecast's `published_at` to be the gate instant it
   claims, so that a `ForecastOrigin` is a record and not a timestamp of when
   somebody happened to load the page.
3. As a developer, I want exactly one producer of a served forecast, so that the
   live path and the Replay path cannot return different bands for the same day.
4. As a user, I want the optimizer to answer inside one HTTP request with no job
   id, so that moving a slider moves the chart.
5. As an operator, I want the gateway to distinguish "the ML service is not
   configured", "unreachable", "too slow" and "answered with an error", so that
   a page rendering wrong is diagnosable from one log line.
6. As an operator, I want a failed publication to leave yesterday's forecast
   served with a visible age, rather than serving nothing.

**The endpoints**

7. As the landing page, I want one call that returns the four subsystems'
   day-ahead outlook, so that the hero is one request and not four.
8. As the landing page, I want a national figure I can defend, so that the hero
   does not sum four bands.
9. As the Grid Overview, I want the hourly profile, the day figures and the
   `ForecastOrigin` in one response, so that no screen assembles a forecast from
   two calls that could disagree.
10. As the Explain screen, I want the day's attribution and the model's
    calibration curve from **two** endpoints, so that a per-day payload does not
    carry model metadata that changes weekly.
11. As the Time Machine, I want the replayable calendar and the featured
    shortlist in one call, so that a date picker can be rendered before any
    replay is requested.
12. As a data consumer, I want the plant registry available as a machine-readable
    download, because ODbL §4.6 obliges it and nothing else in the product does.
13. As an operator, I want one endpoint that answers "what can this deployment
    actually do right now", so that a misconfiguration is one request away.

**Shapes**

14. As a developer, I want every response in the domain model's vocabulary, so
    that a field name on the wire is a term I can look up.
15. As a developer, I want the wire to be `snake_case` and exactly one place to
    convert, so that a field renamed in the API breaks a compile rather than a
    screen.
16. As a developer, I want the technology split typed as a scalar, so that no
    client can render a band where the forecaster refuses to publish one.
17. As a user, I want `observed` and `typical` on a driver to arrive as numbers
    with a unit code, so that they are formatted in my locale rather than in the
    server's.
18. As a user, I want an `other` driver row that can say `mixed`, so that a
    merged row whose members disagree does not claim a direction.
19. As a reader, I want a driver's share described as a share of *attributed
    movement*, so that the footnote under the bars is true.
20. As a developer, I want one attribution per subsystem-day and no `technology`
    parameter, so that the client cannot request an explanation that does not
    exist.

**Caching**

21. As an operator, I want a superseding 12Z run to invalidate a cached 00Z
    forecast by construction, so that there is no manual invalidation path to
    forget.
22. As an operator, I want a replay cached against the vintage of the
    observations it scored, so that an ONS restatement changes the number rather
    than being hidden by a cache.
23. As an operator, I want identical scenarios against the same forecast vintage
    served from cache, and the cache to be evictable with no user-visible loss.
24. As a developer, I want no response to carry `immutable`, because nothing in
    this domain is.
25. As an operator, I want an ETag on every read so that a shared cache
    revalidates cheaply rather than re-querying Postgres.

**Rate limiting and abuse**

26. As an operator, I want the solver endpoint on its own budget, so that a
    public MILP is not a free compute service.
27. As an operator, I want a request rejected on size and shape before a model
    is built, since model construction dominates the request.
28. As an operator, I want the narration's language-model call protected by a
    single-flight lock and a daily cap rather than by an IP limit, because the
    scarce resource is the call and not the request.
29. As an operator, I want the rate limiter to work when the API runs on more
    than one replica, so that the published budget is the real budget.
30. As an operator, I want the client key derived only from a hop a trusted
    proxy set, so that a header cannot buy an attacker a fresh budget.

**Errors, and absence**

31. As a client, I want one error envelope and one closed code enum, so that
    every failure is machine-handleable and translatable.
32. As a user, I want "tomorrow's forecast has not published yet" to look
    nothing like "the model is unavailable", so that a countdown is not
    rendered as a failure.
33. As a user, I want a withheld diagnosis to be a successful response saying it
    was withheld, so that "there is nothing to explain" is an answer rather than
    an error.
34. As a user, I want an absent forecast rendered as an absence, never as zeros
    or an empty band, so that the stub's promise survives the model landing.
35. As a user, I want Replay to keep working when no artifact is promoted,
    because it reads pinned rows and never the serving artifact.

**`packages/core`**

36. As a developer, I want the Scenario and the result shapes to be one JSON
    Schema both languages assert against, so that they cannot drift while both
    look right in isolation.
37. As a developer, I want the reference fleet, the threshold defaults and the
    R$/MWh assumption published once in a place Python can also read.
38. As a reviewer, I want every value computed in both TypeScript and Python
    covered by a shared golden-vector file, so that adding a case is enough and
    neither side can quietly skip one.
39. As a developer, I want the web app's `evaluatePlan` deleted rather than kept
    in sync, because `replay.md` requires exactly one implementation of the
    execution rule in the repository.

## Implementation Decisions

### The boundary — precompute the model, call the solver

**Decision: the public API never calls the ML service for a forecast or an
attribution. The worker computes both at the two gate instants and writes them
to Postgres. The public API calls the ML service, per request and
synchronously, for the MILP and the simulator only.**

This is the ticket's central question and the answer is not a preference. Five
arguments, ordered by how hard they are to argue with.

**1. `published_at` cannot be the request time.** A `Forecast` row's
`published_at` is, by the domain model, the instant the producer asserted the
value, and by `feature-engineering.md` that instant is
`gate_at(target_date, gate_profile)` — D−1 09:00 BRT or D−1 19:00 BRT, Brasília
civil time. A per-request inference either stamps the row with the request time,
which makes the `ForecastOrigin` a lie, or stamps it with the gate, which
asserts a publication that did not happen. `replay.md` had to invent
`origin_kind = 'backfilled_holdout'` precisely to keep a counterfactual
publication instant distinguishable from a record. Serving live forecasts
per-request would create a third case with no discriminator. **This argument
alone settles it**; the rest are corroboration.

**2. The number is persisted anyway, so a second producer is pure risk.**
Forecaster story 35: "every served forecast persisted as a `Forecast` row with a
`wattsteer` `ForecastOrigin`", so that Replay reads a query rather than
re-running a model. Replay's own decision: "the forecast is precomputed… a
replay contains no model in the request path at all." If the row must exist for
Replay, and the live path computes the same numbers independently, then the
product holds two producers of one quantity — and the specs have ruled that out
five times at five layers (one composition function with four callers, one
simulator imported not reimplemented, one feature function for model and
baseline, one canonical encoding, one group map).

**3. The failure modes are not comparable.**

| | Per-request | Precomputed |
|---|---|---|
| ML service down | Overview, Explain, Mitigate, Replay all 502 | Overview, Explain and Replay serve; the forecast carries its real age; only *tomorrow's new* forecast is missing |
| ML service slow | every page view waits `mlTimeoutMs` | nothing waits |
| Artifact volume unmounted | 503 on every read | the last published rows still serve, with `/v1/meta` saying the volume is gone |
| Postgres down | 503 | 503 |
| Publication job fails | invisible until someone loads a page | visible in `/v1/meta` and in the response's `forecast_origin.age_hours` |

The precomputed column degrades; the per-request column fails. For a public,
read-only, unauthenticated product whose landing page *is* the readout, that
difference is the product.

**4. The work does not fit in a request.** A serve is a joblib load, a
`gate_at` feature build, a mixture composition and a 500-member path-ensemble
draw. `replay.md` calls this "far outside an interactive budget" and it is the
same work here. Caching would hide it, at which point the architecture is
precompute with a worse invalidation story.

**5. The solver is the mirror image and must stay per-request.** It has no
artifact dependency, it is 3.15 ms, and its input is a user-supplied Scenario
from an unbounded space — there is nothing to precompute. `flex-optimizer.md`
already fixed it as synchronous with no job noun.

**What the worker runs.** Two BullMQ repeatable jobs per lane, on the existing
worker and the existing Redis — no second scheduler, per `data-platform.md`:

| Job | Cron (America/Sao_Paulo) | Lane | Writes |
|---|---|---|---|
| `publish-forecast:gate_early` | `10 9 * * *` | `dessem_free_v1__gate_early__thr5` | `curtailment_forecast_hour`, `curtailment_forecast_day` |
| `publish-forecast:gate_late` | `10 19 * * *` | the promoted `gate_late` lane | the same, superseding |
| `publish-diagnosis` | on completion of each above | same lane | `diagnosis_attribution` |
| `refresh-featured-days` | `30 3 * * *` | — | the Replay shortlist cache |

Ten minutes after the gate, not on it, because the gate is when the *inputs*
become knowable, not when the job may start.

The worker calls the ML service over the private network at
`POST /internal/publish/forecast` — **worker → ml, never gateway → ml**. The ML
service is read-only against Postgres (`default_transaction_read_only`, enforced
in `apps/ml`), so it returns the computed rows and the **worker** writes them.
That keeps the read-only guarantee intact and keeps every write in the service
that owns the Drizzle schema.

**What the ML service reads are the canonical views, not the tables.** The
contract of ticket 013, made SQL views by ticket 016, owns the row vocabulary — the
renames, the grain, the unit and timestamp resolution — so "the ML service reads
Postgres directly" and "there is exactly one definition of a canonical read" are
both true at once, which they cannot be if the contract is TypeScript. Ticket 016
settled this against two alternatives: having Python call the gateway would put a
37M-row training read through JSON over HTTP and make `ml → api → ml` a
dependency cycle, and having Python re-query the base tables would put the
renames and the vintage rule in two languages, which is the drift the contract
exists to prevent. This is the same choice `feature-engineering.md` already made
one layer up when it put the feature function in SQL "with the schema authority".

The `/v1/canonical/*` HTTP routes stay, but for the web app and for debugging —
they are no longer the modelling path.

`vintageFidelity` is the deliberate exception: a pure function of two timestamps,
bound in both languages by shared golden vectors. Duplicating that is safe in a
way duplicating row-shaping SQL is not.

**A publication is atomic and additive.** Rows are inserted with a new
`data_version` under the append-only discipline; nothing is updated in place; a
half-written publication is impossible because the insert is one transaction. A
failed job retries under the existing `jobAttempts` policy and, on exhaustion,
leaves the previous origin serving — which is the degradation the table above
promises.

#### The `ml-proxy` verdict: the module is right, its one route is a stopgap

`apps/api/src/api/ml-proxy.ts` was read closely. Its **failure mapping is
correct and is the reason the module deserves to exist**, exactly as its own
comment argues:

- unconfigured `mlUrl` → `UpstreamError`, distinguished from broken rather than
  dialling `undefined` and reporting the fetch error as an upstream fault;
- `TimeoutError` → `BusyError` (503, "retry") versus a refused connection →
  `UpstreamError` (502, "don't bother yet") — the right distinction, made for
  the right reason;
- upstream 502/503/504 → `BusyError` rather than passthrough, so an ML outage is
  not reported as a WattSteer bug.

Keep all of it. **The stopgap is the route it currently carries**, and it is a
stopgap in four specific ways:

1. **It is unversioned.** `GET /forecast/day-ahead` against an ML service whose
   own path is `/v1/forecast/day-ahead`. The public surface is the one that
   needs the version.
2. **It returns the ML body verbatim, on the stated ground that "the forecast
   contract belongs to the service that computes it".** That is the right
   instinct for a proxy and the wrong one for a read. Under this spec the
   contract belongs to `packages/core`'s JSON Schema and the row in Postgres,
   and the gateway shapes the response — including fields the ML service does
   not have, such as `origin_kind`, the `AsOf` pin, the risk class from
   `risk_bins`, and the ODbL/CC-BY attribution block.
3. **It cannot honour `origin_kind = 'served'`.** `replay.md` seam 6 requires a
   test that a `backfilled_holdout` row is never returned by
   `/v1/forecast/day-ahead` "under any query". A verbatim proxy has no row to
   filter.
4. **It makes the most-viewed screen depend on the ML service**, which is
   argument 3 above.

**Two live defects in the mapping**, which matter the moment the module is
pointed at `/v1/optimize`:

- Every non-`ok` upstream status that is not 502/503/504 collapses into
  `UpstreamError` (502). Under `flex-optimizer.md` the ML service returns **422**
  for a scenario it re-validated and rejected, and **500** for `SOLVER_BUG`.
  Both would surface as `OPTIMIZER_UNAVAILABLE` — a user's bad scenario would
  read as an outage, and a WattSteer bug would read as an outage. Gateway
  validation makes the 422 case *unlikely*, not impossible: the ML service
  "trusts nothing it did not validate itself" by design. **A 4xx from the ML
  service must pass through with its status code and its error code — but
  re-wrapped in the gateway's envelope, not forwarded verbatim.**

  This is the one place where "pass the body through" and "one envelope,
  everywhere" collide, and the envelope wins. A client that must parse one shape
  for gateway errors and another for upstream ones has no closed enum, which is
  the property the envelope exists to provide. What has to survive is the
  *information* — the distinction between a rejected scenario and an outage —
  and that lives in the status and the code, not in the byte-for-byte body. The
  upstream code is therefore admitted into the gateway's closed enum rather than
  smuggled past it, and any upstream detail the enum has no room for travels in
  the envelope's detail field.
- The optimizer's failure table needs `503 SOLVER_GAP_UNCLOSED` and
  `504 SOLVER_TIMEOUT` as **distinct** outcomes. Today both would land in
  `BusyError`'s single sentence, and "the gap was not closed" is a different
  thing to tell a user than "we gave up waiting".

> **Why the subtag rule, not the exact-match rule.** The web app's `Locale` is
> `"pt" | "en"` and its `languageTag` helper emits `pt-BR` and **`en`** — so an
> exact-match `locale ∈ {pt-BR, en-US}` would have the gateway return a `422` to
> its own client for English. The app's own locale negotiation already
> prefix-matches on the primary subtag; the API matches it rather than
> contradicting it.

**So: keep `ml-proxy.ts`, keep its comment, delete its forecast route when
`curtailment_forecast_hour` lands, add the 4xx passthrough and the two solver
statuses, and point it at the solve.** It becomes the gateway's edge onto the
solver, which is the only thing left behind it.

**What the ML service still exposes**, all private:

```
GET  /health, /ready, /v1/meta          probes and self-description
POST /internal/publish/forecast         worker-only; returns rows, writes nothing
POST /internal/publish/diagnosis        worker-only
POST /v1/optimize                       gateway-only; the MILP + simulator
POST /v1/replay/solve                   gateway-only; the four-realisation score
```

`GET /v1/forecast/day-ahead` on the ML service is **retired** when the publisher
lands. Until then it remains as the stub it is, and the gateway route in front
of it is documented as provisional.

### The endpoint list

Four unversioned probes survive unchanged: `GET /`, `/health`, `/ready`,
`/docs`. Everything else is `/v1`.

| # | Route | Reads | Screen |
|---|---|---|---|
| 1 | `GET /v1/meta` | artifact lanes, ingestion freshness, window bounds, constants, attribution | every screen's precondition |
| 2 | `GET /v1/grid/outlook` | four subsystems, one target date | landing hero, Overview first paint |
| 3 | `GET /v1/grid/now` | latest settled hour, four subsystems + derived national | landing hero's "right now" line |
| 4 | `GET /v1/forecast/day-ahead` | one subsystem, one day, one gate | Overview, Explain, Mitigate |
| 5 | `GET /v1/curtailment/hours` | observed `CurtailmentHour` series | Overview's observed panel, Time Machine |
| 6 | `GET /v1/curtailment/episodes` | `CurtailmentEpisode` read-time view | Time Machine, Overview |
| 7 | `GET /v1/curtailment/reasons` | observed `RestrictionCause` at `ReportingEntity` grain | Explain |
| 8 | `GET /v1/diagnosis/day-ahead` | attribution + narration | Explain |
| 9 | `GET /v1/model/card` | reliability curve, `risk_bins`, headline metrics, lane state | Explain |
| 10 | `POST /v1/optimize` · `GET /v1/optimize?s=` | the MILP | Mitigate |
| 11 | `GET /v1/replay/days` | replayable calendar + featured shortlist | Time Machine |
| 12 | `GET /v1/replay?d=&s=` · `POST /v1/replay` | one replay | Time Machine |
| 13 | `GET /v1/backtest` | the aggregate — **not served; there is no aggregate yet, see 11–13** | Time Machine's footer, ops |
| 14 | `GET /v1/plants` | the plant registry, machine-readable | ODbL §4.6 |

**Three things that are deliberately *not* endpoints.**

- **`GET /v1/subsystems`.** `Subsystem` is an enum with exactly four members and
  ONS's display names are constants. It ships in `packages/core` as
  `SUBSYSTEMS`, and an endpoint would invite a fifth member.
- **`GET /v1/reference-fleet`.** Same reasoning, and stronger: `replay.md`
  requires it to be "one published constant in one place" so that floor coverage
  and the forecaster's `Δ recovered_floor_mwh` are computed against the same
  battery. It ships as `REFERENCE_FLEET` and is echoed in `/v1/meta` for
  diagnosability, never fetched to be used.
- **A scenario-shortening service.** The URL is the storage. Adding a
  `POST /v1/scenarios → id` would invent the persistence and the identity the
  domain model spent a section removing.

#### 1. `GET /v1/meta`

The precondition every screen reads first, and the endpoint that makes a
misconfigured deployment diagnosable in one request. It is the gateway's own
answer, not a proxy of the ML service's `/v1/meta` — it merges what only the
gateway knows (ingestion freshness, published forecast origins) with what only
the ML service knows (the volume, the lanes), and it degrades: if the ML service
is unreachable, `model` reports `unreachable` and the rest of the body is still
correct.

```jsonc
{
  "service": "wattsteer-api",
  "version": "0.1.0",
  "environment": "production",
  "server_time": "2026-08-28T18:04:11Z",

  "window": { "opens_on": "2024-04-01", "ingestion_go_live": "2026-07-01",
              "first_holdout_fold_start": "2025-04-01" },

  "defaults": { "subsystem_threshold_mw": 5, "reporting_entity_threshold_mw": 1,
                "max_gap_hours": 0, "brl_per_mwh": 180 },

  "gates": [ { "profile": "gate_late",  "publishes_at_local": "19:00",
               "timezone": "America/Sao_Paulo", "weather_run": "12Z" },
             { "profile": "gate_early", "publishes_at_local": "09:00",
               "timezone": "America/Sao_Paulo", "weather_run": "00Z" } ],

  "model": {
    "reachable": true,
    "lanes": [ { "lane": "dessem_free_v1__gate_late__thr5",
                 "state": "promoted",              // no_artifact | present_unpromoted | promoted
                 "artifact_id": "…/2026-08-28T03:11:07Z",
                 "trained_through": "2026-06-30",
                 "vintage_fidelity": "point_in_time" } ],
    "volume": { "mounted": true, "writable": true }
  },

  "forecast": {
    "latest_published": [ { "target_date": "2026-08-29", "gate_profile": "gate_late",
                            "published_at": "2026-08-28T22:00:00Z", "age_hours": 0.1,
                            "subsystems": ["N","NE","S","SE"] } ],
    "next_publication_at": "2026-08-29T12:00:00Z"
  },

  "data": {
    "freshness": [ { "source": "constrained_off", "latest_valid_time": "2026-08-26T23:00:00Z",
                     "latest_ingested_at": "2026-08-28T15:02:11Z", "lag_hours": 40.1 } ]
  },

  "reference_fleet": { /* REFERENCE_FLEET, echoed */ },

  "attribution": {
    "ons":  { "name": "ONS Dados Abertos", "licence": "CC-BY-4.0", "url": "…" },
    "aneel_siga": { "name": "ANEEL SIGA", "licence": "ODbL-1.0", "url": "…",
                    "derivative_database": true, "machine_readable_at": "/v1/plants" },
    "open_meteo": { "name": "Open-Meteo", "licence": "CC-BY-4.0", "url": "…" }
  }
}
```

The `attribution` block is data rather than copy because the map requires "a
bilingual §4.3 notice on public surfaces" and a bilingual notice assembled from
translated strings around untranslated licence identifiers is exactly the shape
`i18n.md` asks for.

**`model.lanes[].state` reproduces the forecaster's three states verbatim** —
`no_artifact`, `present_unpromoted`, `promoted` — because story 33 requires
"a stale forecast and an unmounted volume do not look alike", and the volume
state is reported separately for the same reason.

**Four things the built endpoint carries that this block does not show**, each
because the alternative was a claim the gateway cannot support:

- **`state` has a fourth value, `unresolvable`.** It is not a fourth state so
  much as the refusal to guess between the three:
  `apps/ml/src/wattsteer_ml/artifacts.py` reports it for a damaged promotion log
  or a `promote` line naming an artifact that is not on the volume, and the one
  thing that module must never do when it cannot tell is fall back to the newest
  file. Mapping it onto `no_artifact` here would report a broken volume as an
  untrained lane. An optional `fault` carries the modelling service's own prose.
- **`model.volume` is `null` when the service is unreachable**, not
  `{mounted: false}`. The volume is mounted into *that* process; with the
  process unreachable its state is unknown, and this is the endpoint that may
  least afford to invent one. `model.unreachable_reason` carries the code
  `ml-proxy.ts` produced — unconfigured, refused, timed out — because those are
  three different sentences for an operator and a boolean flattens them.
- **The three instants in `data.freshness[]` are nullable.** A source that has
  *never* ingested is the most diagnostic line this endpoint has; omitting it,
  which is what a non-nullable instant would force, is exactly how a feed that
  silently stopped becomes invisible.
- **`reference_fleet`'s fields are named in the schema** rather than left a
  free-form object. The one translator renames only what the generated table
  knows about, so an unnamed block would travel in whatever casing the gateway
  happened to build it in.

**This route is the third and last crossing to the ML service**, against Seam 1
below, which names only the optimizer and the replay solve. The crossing is
diagnostic rather than a data path: it contributes one field, it is wrapped
whole, and its failure is a value on the response instead of a status on it.

**No `ETag`, against story 25's "an ETag on every read".** The two are in
tension and the caching table wins: an ETag exists so a shared cache can
revalidate rather than re-query, and a response that may not be stored has
nothing to revalidate. The 304 it would enable is also the wrong answer to this
endpoint's question — "unchanged" is not what an operator asking whether the
volume is still gone can be told by a cache that was never allowed to hold the
previous answer. Story 25 stands for every other read, all of which are
storable.

#### 2. `GET /v1/grid/outlook?target_date=&gate_profile=`

The one call the landing hero and the Overview's first paint both make. Four
subsystems, no hourly detail, no drivers.

```jsonc
{
  "target_date": "2026-08-29",
  "threshold_mw": 5,
  "forecast_origin": { "producer": "wattsteer", "run_label": "…artifact_id…",
                       "published_at": "2026-08-28T22:00:00Z", "age_hours": 0.1,
                       "origin_kind": "served", "gate_profile": "gate_late",
                       "weather_run_label": "D−1 12Z" },
  "vintage_fidelity": "point_in_time",
  "risk_bins": { "low": [0.0, 0.25], "elevated": [0.25, 0.60], "high": [0.60, 1.0] },
  "subsystems": [
    { "subsystem": "NE", "ons_display_name": "NORDESTE",
      "day_occurrence_probability": 0.89,
      "risk_class": "high",
      "day_energy_mwh":   { "p10": 1720, "p50": 2780, "p90": 4260 },
      "peak_power_mw":    { "p10": 118,  "p50": 186,  "p90": 271 },
      "day_expected_mwh": 2960.0,
      "split": { "wind_mwh": 2410.0, "solar_mwh": 550.0 } }
    // … N, S, SE
  ],
  "national": {
    "expected_mwh": 4318.0,
    "risk_class_counts": { "low": 2, "elevated": 1, "high": 1 },
    "band": null,
    "band_unavailable_reason": "no_joint_ensemble"
  }
}
```

`weather_run_label` is carried beside the WattSteer origin because the
prototype's `ForecastOrigin.runLabel` is used to render "D−1 12Z" and the
domain's `run_label` for a `wattsteer` producer is the artifact version. Two
facts, two fields; the landing page currently conflates them (see below).

#### 3. `GET /v1/grid/now`

Observed, not forecast — it needs no model, which is what makes it the honest
thing to show on a landing page when no artifact is promoted.

```jsonc
{
  "as_of": "2026-08-28T15:02:11Z",
  "latest_settled_hour": "2026-08-26T23:00:00Z",
  "lag_hours": 40.1,
  "vintage_fidelity": "point_in_time",
  "subsystems": [ { "subsystem": "NE", "ons_display_name": "NORDESTE",
                    "last_24h_constrained_off_mwh": 2140.0,
                    "latest_hour_constrained_off_mwh": 96.4,
                    "split": { "wind_mwh": 1980.0, "solar_mwh": 160.0 } } ],
  "national": { "last_24h_constrained_off_mwh": 3011.0, "derived": "sum_of_four" }
}
```

`national.derived: "sum_of_four"` is a field and not a comment, because the
domain model makes `SIN` structurally unrepresentable as a `Subsystem` and this
is the one place a national number exists. Observations add exactly, so this
national total is legitimate where the forecast's is not.

#### 4. `GET /v1/forecast/day-ahead?subsystem=&target_date=&gate_profile=`

The content is `forecaster.md`'s, unchanged. Query parameters:
`subsystem` (required, `N|NE|S|SE`), `target_date` (optional, default tomorrow
in `America/Sao_Paulo`), `gate_profile` (optional, default `gate_late`).
**There is no `technology` parameter** — the forecast grain is the subsystem and
the split is a scalar.

```jsonc
{
  "subsystem": "NE", "ons_display_name": "NORDESTE",
  "target_date": "2026-08-29",
  "threshold_mw": 5,
  "forecast_origin": { "producer": "wattsteer", "run_label": "…", "published_at": "…",
                       "age_hours": 0.1, "origin_kind": "served",
                       "gate_profile": "gate_late", "weather_run_label": "D−1 12Z" },
  "vintage_fidelity": "point_in_time",
  "artifact": { "artifact_id": "…", "feature_set": "dessem_free_v1",
                "trained_through": "2026-06-30" },
  "risk_bins": { "low": [0,0.25], "elevated": [0.25,0.60], "high": [0.60,1.0] },

  "day_occurrence_probability": 0.89,          // from the path ensemble, not 1−Π(1−p)
  "risk_class": "high",
  "day_energy_mwh":   { "p10": 1720, "p50": 2780, "p90": 4260 },
  "peak_power_mw":    { "p10": 118,  "p50": 186,  "p90": 271 },
  "day_expected_mwh": 2960.0,
  "split": { "wind_mwh": 2410.0, "solar_mwh": 550.0 },
  "hours_p50_nonzero": 9,

  "hours": [ { "valid_time": "2026-08-29T03:00:00Z", "hour_local": 0,
               "constrained_off_mwh": { "p10": 0.0, "p50": 0.0, "p90": 41.0 },
               "expected_mwh": 12.4,
               "occurrence_probability": 0.31,
               "split": { "wind_mwh": 10.1, "solar_mwh": 2.3 } } ]
}
```

Five decisions inside that shape:

1. **`day_energy_mwh` and `peak_power_mw` are read from the persisted
   day-grain row, never computed from `hours`.** They are path-ensemble
   quantiles. `replay.md` already owes ticket 009 the persistence; this endpoint
   is the second consumer and the reason the hand-back is load-bearing.
2. **`expected_mwh` appears at both grains and is never inside the band.** It is
   the diagnosis engine's attribution target and, for a mixture, it exceeds the
   P50 whenever `p < 0.5`. Publishing it as a sibling of the band rather than as
   the band's centre is the forecaster's rule, made structural by the field
   layout.
3. **`split` is two scalars, at both grains, and there is no `split` band.** The
   forecaster types it as a scalar "so no screen can render it as a band"; the
   schema is what enforces that, and a test asserts the schema rejects an object
   with `p10` under `split`.
4. **`origin_kind` is on every `ForecastOrigin`** and this endpoint filters
   `origin_kind = 'served'` unconditionally, in the query, not in a branch.
5. **`age_hours` is derived and returned**, because "is this stale" is a
   question every screen asks and none of them should compute a date difference
   against a clock the server has and the client may not.

#### 5–7. Observed

```
GET /v1/curtailment/hours?subsystem=&from=&to=&technology=
GET /v1/curtailment/episodes?subsystem=&from=&to=&technology=&threshold_mw=&max_gap_hours=
GET /v1/curtailment/reasons?subsystem=&date=&limit=
```

- `hours` returns `CurtailmentHour` observations at
  (`Subsystem`, `Technology`, `valid_time`) grain with a `vintage_fidelity` and
  the `data_version` the rows were read at. Range capped at 400 days.
- `episodes` returns the read-time view, and **every episode carries the
  `threshold_mw` and `max_gap_hours` that produced it**, per the domain model.
  The parameters default to 5 and 0 and are echoed at the top level too, so a
  screen cannot render an episode list beside a threshold it did not use.
- `reasons` returns `ObservedReason` rows: `grain`
  (`conjunto | self_reporting_plant`), `entity_code`, `entity_label`, `reason`,
  `origin`, `constrained_off_mwh`, `description`, `cause_mixed`. **`grain` is
  required on every row**, per the domain model's rule that screens label the
  grain rather than assume it, and `cause_mixed` is surfaced because the schema
  already records that an hour changed cause mid-way and hiding it would make
  the single stored reason look like an observation rather than a simplification.
  Nothing is aggregated to plant grain; there is no `plant` parameter.

#### 8. `GET /v1/diagnosis/day-ahead?subsystem=&date=&gate_profile=&locale=`

Path and parameters exactly as `diagnosis.md` fixes them, with `run=` re-spelled
`gate_profile=` for consistency with the forecast route. **No `technology`
parameter.** `locale ∈ {pt-BR, en-US}`, **negotiated by primary subtag** —
`pt*` resolves to `pt-BR`, `en*` to `en-US` — defaulting from `Accept-Language`,
and
`Vary: Accept-Language` is set — this is the only endpoint that varies by
locale, because it is the only one that returns generated prose.

The attribution half is a row read from `diagnosis_attribution`. The narration
half is the Redis-cached LLM call, keyed exactly as `diagnosis.md` specifies. A
`withhold` rule produces a **200** carrying the **drivers untouched**,
`withheld_by: ["attribution_is_noise"]` and a template narration in place of the
model's — not an error;
see [the error contract](#the-error-contract-and-what-a-missing-forecast-looks-like).

```jsonc
{
  "subsystem": "NE", "target_date": "2026-08-29",
  "threshold_mw": 5,
  "forecast_origin": { /* the same object as the forecast route's */ },
  "attribution": {
    "target": "expected_mwh_day",
    "total_attributed_mwh": 316.0,
    "sum_abs_attributed_mwh": 402.0,
    "stderr_mwh": 4.1,
    "baseline_expected_mwh": 96.0,
    "day_expected_mwh": 412.0,
    "driver_group_version": "3", "driver_group_hash": "sha256:…",
    "drivers": [
      { "code": "net_surplus", "label_code": "driver.net_surplus",
        "phi_mwh": 128.0, "share": 0.31, "direction": "raises",
        "headline_feature": "proxy_renewable_load_ratio",
        "observed": 1.42, "typical": 0.96, "unit": "ratio",
        "hour_disagreement": 1.1, "demoted": false }
    ],
    "peak_hour_local": 13,
    "peak_hour_drivers": [ /* same shape */ ]
  },
  "rule_flags": [ { "code": "stale_inputs", "severity": "annotate",
                    "facts": { "weather_run_age_hours": 12 } } ],
  "withheld_by": [],
  "narration": { "text": "…", "source": "model", "locale": "pt-BR",
                 "prompt_version": "2026-08-28.1" },
  "observed_reasons_latest": { "date": "2026-08-27", "top_reason": "ENE",
                               "top_reason_share": 0.62 }
}
```

**All eight groups are returned, ranked by `|share|`; the client applies the
`share ≥ 0.03` / six-row / merge-into-`other` display rule.** `diagnosis.md`
assigns that rule to the screen, and putting it server-side would mean the
`other` row's `direction: "mixed"` computation lives in two places the first
time a second client appears.

**`share_j` is computed over all eight groups, not over the displayed ones.**
`diagnosis.md` defined it over "the displayed rows", which is circular: the
client decides what is displayed by applying a `share ≥ 0.03` cut to the very
number being defined. A share whose denominator does not exist until after the
cut cannot be put on a wire. Over all eight it is well-defined, the cut has
something to act on, and the LLM's numeric whitelist — which whitelists wire
values — stays honest.

**Selection is shared; the merge is not.** The narration is assembled
server-side and `diagnosis.md` needs "any *displayed* group" to state a driver
acted both ways, so the server must know which groups are notable. That is the
selection predicate — `share ≥ 0.03`, top six — and applying it to identical
wire numbers on both sides is deterministic and cannot drift. What stays
client-only is the part that is a *rendering* decision: merging the remainder
into `other` and computing its `direction: "mixed"`. Duplicating a predicate
over agreed numbers is not the duplication this rule was written to prevent;
duplicating the `mixed` computation is.

#### 9. `GET /v1/model/card?lane=`

Model metadata, not a day's answer: the reliability curve and its sample counts,
`reliabilityWindow` and `reliabilityFidelity`, `ece`, `mce`, `top_bin_gap`,
`risk_bins`, `delta_lo`/`delta_hi`, the headline metrics table per fold, the
baseline-ladder deltas, the lane identity and its training/calibration windows.

It is a **separate endpoint from the diagnosis** on the forecaster's own
grounds: the curve "is a property of the *model*, not of a day". Folding it into
the per-day payload would give a weekly-changing object a daily cache key, and
would put the same 40 KB on the wire on every Explain view.

The full card is large; this endpoint returns the product-facing subset and a
`card_url` pointing at the raw `*.card.json` for anyone auditing.

#### 10. `POST /v1/optimize` · `GET /v1/optimize?s=`

Verbatim from `flex-optimizer.md`, re-pathed only in that it acquires the `/v1`
it already had. Body is the Scenario object; `?s=` is the base64url of the same
canonical bytes. Response is that spec's contract unchanged.

#### 11–13. Replay and Backtest

```
GET  /v1/replay/days?subsystem=
GET  /v1/replay?d=&s=&subsystem=
POST /v1/replay
GET  /v1/backtest?fold=&subsystem=&vintage_fidelity=
```

Contracts verbatim from `replay.md`. `/v1/replay/days` returns the replayable
calendar (a compact run-length encoding of dates plus, per date, the
`provenance` and `vintage_fidelity` that would apply) and the eight featured
days from the published deterministic rule. `/v1/backtest` never averages across
`vintage_fidelity` — the grouping is structural, per seam 9, so the endpoint
takes fidelity as a group key and returns one row per value rather than
accepting it as a filter that could be omitted.

**As built, three of these four are served and `/v1/backtest` is not.** The
aggregate it would return belongs to replay 08, which has not landed: nothing in
the repository computes `days_replayed`, `floor_coverage` or
`mean_avoidability` at any grain, and `apps/ml` exposes no `/v1/backtest` to
stand in front of. `domain-model.md` gives `Backtest` to the aggregate of many
Replays consumed by the hot-swap gate — not to the forecaster's fold evaluation,
which is a different noun wearing the same English word — so there is no second
thing this route could have been pointed at either.

The route is therefore absent rather than provisional, and the two alternatives
are both worse. A gateway route forwarding to a path that does not exist would
publish an endpoint answering `502 OPTIMIZER_NOT_READY` forever, naming a
healthy service as the broken thing; and a gateway route *computing* the
aggregate would put a second scoring implementation on the far side of a network
hop from the replay path it is supposed to aggregate, which replay 08 forbids in
its own words ("every metric is produced by running the ticket 03 replay path
per day"). It would also have to choose the grouping, and fidelity-as-group-key
is a property of an aggregation function rather than of a query string: put at
the gateway, the one structural rule this endpoint has could not be enforced.

`apps/api/test/solver-surface.test.ts` holds the absence from both ends — the
gateway serves no `/v1/backtest`, and `apps/ml` exposes none — so the day the
aggregate lands, that test fails and names this route as the thing then owed.

**Two other gaps on this surface, recorded rather than papered over.** The
calendar `/v1/replay/days` currently returns a flat list of days and no featured
shortlist, not the run-length encoding described above: the shortlist is replay
07's and has not landed, and the encoding is `replay.md`'s contract to shape.
This spec re-paths and never re-shapes, so neither is fixed here. And the
calendar's caching row asks for an ETag of `W/"<featured-days computation id>"`,
which is the same missing id; the route ships with the `max-age` and no
validator until there is an id to build one from.

#### 14. `GET /v1/plants`

The map's ODbL analysis is unambiguous and no ticket has claimed it: the plant
table is a Derivative Database, §4.4(c) pulls it under share-alike because
public charts are Publicly Used Produced Works, and **§4.6 requires
machine-readable access**. That obligation bites from day one, not at
monetisation. Nothing else in the product discharges it.

```
GET /v1/plants?subsystem=&technology=&format=json|csv
```

Returns `ons_plant_code`, `ceg_core`, name, `subsystem`, `state`, `technology`,
`operation_modality`, `municipality`, coordinates as an
`Option<Coordinate>` (`null`, not `(0,0)` — Null Island is *absent*), ownership,
and `installed_capacity_mw` as of the request date via
`InstalledCapacityAsOf`, with the as-of date stamped on the response. The ODbL
notice and the SIGA/ONS attribution ride on the payload, not only on `/v1/meta`.

**This is flagged as a call for the dev**, because it is the one endpoint in
this spec that no upstream ticket asked for and it exists to satisfy a licence.

### Response shapes — the vocabulary, and the one translation

**Every field name on the wire is a domain-model term in `snake_case`.**

The decision is forced rather than chosen: `flex-optimizer.md` and `replay.md`
both publish `snake_case` contracts and declare them fixed; the ML service is
Python and speaks `snake_case`; the database columns are `snake_case`. The web
app's fixtures are `camelCase`. Something converts, and the only question is
where.

**It converts once, in `packages/core`'s generated client, and nowhere else.**
Not in each screen, not in a fetch wrapper per feature, not in the API. The
generated TypeScript types carry the `camelCase` shape the screens already use;
the codec that maps them is generated from the same JSON Schema, so a renamed
field is a compile error in the web app rather than an `undefined` on a chart.

**Nine vocabulary rules the schema enforces**, each because a prototype or a
sibling spec has already got it wrong once:

1. **`Band` is `{p10, p50, p90}` and is never summed.** A JSON Schema `$ref`,
   used everywhere a band appears, so a grep over the schema finds every one.
2. **An expectation is never inside a band object.** `day_expected_mwh` is a
   sibling of `day_energy_mwh`, never its `p50`.
3. **A technology split is two scalars.** `{wind_mwh, solar_mwh}` with
   `additionalProperties: false`, so `{wind: {p50: …}}` fails validation.
4. **`avoidability` is `number | null` and null is meaningful.** The schema
   permits null; a test asserts no code path emits `0` where the domain model
   requires null.
5. **`lead_time` is absent.** Derived, never stored, and therefore never
   returned — a client that wants it subtracts two timestamps it already has.
6. **`SIN` is not a subsystem value anywhere.** The `subsystem` enum has four
   members; a national figure lives under a `national` key with its derivation
   named.
7. **Reason codes are the identifier and the gloss is not returned.** `"ENE"`,
   not `"Energetic (oversupply)"`. The gloss is a `t()` key.
8. **`threshold_mw` is on every object it applies to**, per the domain model's
   "stamped on every output", including every episode and every optimization
   result.
9. **`vintage_fidelity` is on every object carrying a metric or a historical
   number**, and is never averaged across values by anything.

**Timestamps.** Every instant is a UTC ISO-8601 string with an explicit `Z`.
Every civil date is `YYYY-MM-DD` and is a `America/Sao_Paulo` civil date, named
so in the schema description. `hour_local` is an integer 0–23 in
`America/Sao_Paulo`. There is no offset-carrying local timestamp anywhere; the
two representations are UTC instants and Brasília civil dates, and mixing them
is what the domain model's interval convention exists to prevent.

**No envelope.** A successful response is the resource. Adding
`{data: …, meta: …}` would buy nothing here — pagination is needed on exactly
two routes and carries its own `next_cursor` field — and it would put a second
shape between every screen and every number.

### Reconciling the diagnosis spec's UI contract changes — three flagged, five real

`diagnosis.md` flags three. Reading the fixtures against all four specs turns up
five, and the two unflagged ones are larger.

| # | What the fixture says today | What the specs require | Flagged by 010? |
|---|---|---|---|
| 1 | `Driver.direction: "raises" \| "lowers"` | `\| "mixed"` — for the merged `other` row when `Σ\|φ\| > 1.5·\|Σφ\|` | ✓ |
| 2 | `Driver.observed`/`typical` are already a structured `DriverReading` sum type — `{kind:"quantity", value, unit?, …}` \| `{kind:"term", term}` \| `{kind:"none"}` | Add the headline-feature name. **Do not** flatten to `observed: number, unit: string`: that model has no home for the `term` variant (`weekend`, `importing`), and `calendar_season` is precisely the group whose headline reading is categorical | ✓ |
| 3 | `Driver.share` doc: "share of the total attributed magnitude" | share of **attributed movement**, `\|φ_j\| / Σ_k\|φ_k\|` over displayed rows | ✓ |
| 4 | `buildExplain(subsystem, technology)`; `ExplainFixture.technology` | **one attribution per subsystem-day**; no technology dimension exists | ✗ — named in 010's "calls the dev" but not as a contract change |
| 5 | `SubsystemDayForecast.technology` — a forecast *per technology* | one forecast per subsystem; technology is a **scalar split** of the P50 and the expectation | ✗ — no spec names it |

**Changes 1–3, as they land in code.** All three are in
`apps/web/src/lib/domain.ts`, which is the single frontend definition and is the
file this spec proposes promoting into `packages/core`:

```ts
export type DriverDirection = "raises" | "lowers" | "mixed";

export interface Driver {
  code: string;
  labelCode: string;              // was `label` — a t() key, not copy
  phiMwh: number;                 // new: the signed contribution itself
  /** Share of the total attributed *movement*: |φ_j| / Σ_k |φ_k| over the
   *  displayed rows. Shares sum to 1. This is not a share of the curtailment
   *  and not a share of "the attributed magnitude". */
  share: number;
  direction: DriverDirection;
  headlineFeature: string;
  observed: number;
  typical: number;
  unit: string;                   // a code: "mwh" | "mw" | "ratio" | "pct" | …
  hourDisagreement: number;
  demoted: boolean;
}
```

~~`label` becomes `labelCode`.~~ **Withdrawn: there is no `Driver.label` to
rename.** The i18n work removed it; labels live in the two dictionaries keyed by
the driver's code, under a comment noting that a `label` field "would be an
English string travelling through the data layer". This spec called `labelCode`
"a sixth change nobody flagged", which was right about the flagging and wrong
about the direction — it would reintroduce a field the current design
deliberately does not have. The code alone travels, as it already does.

**`"mixed"` reaches the UI in exactly one place and a test says so.** Only the
merged `other` row can carry it; the eight real groups always have a sign
because a grouped Shapley value is one number. A test asserts that no response
carries `direction: "mixed"` on a row whose `code` is one of the eight.

**Change 4 is a deletion, not an edit.** `buildExplain(subsystem, technology)`
must become `buildExplain(subsystem)`, `ExplainFixture.technology` must go, and
the Explain screen must stop passing `technology` through `sharedParams` to the
diagnosis. The URL parameter `technology` survives for the *observed* panels,
where a technology dimension genuinely exists.

**Change 5 is the one with the most code behind it.** `SubsystemDayForecast`
carries `technology` and `buildForecast(subsystem, technology, run)` builds a
band per technology. There is no such model. The corrected shape:

```ts
export interface SubsystemDayForecast {
  subsystem: SubsystemCode;
  targetDate: string;
  forecastOrigin: ForecastOrigin;
  thresholdMw: number;
  occurrenceProbability: number;      // day grain, from the path ensemble
  dailyEnergy: Band;                  // path ensemble; never Σ hours
  peakPower: Band;                    // path ensemble
  dayExpectedMwh: number;             // NOT the band's centre
  split: { windMwh: number; solarMwh: number };   // scalars, no band
  hours: CurtailmentHourForecast[];
}
```

and `CurtailmentHourForecast` gains `expectedMwh` and its own scalar `split`.
The `technology` selector on the Overview stops filtering the forecast and
starts selecting which scalar the split panel emphasises — a real UI change and
a smaller one than it sounds, because the fan chart was never per-technology in
any defensible sense.

**A sixth contradiction, on the landing page.** `components/landing/fixtures.ts`
sets `FORECAST_ORIGIN = { producer: "open_meteo", runLabel: "D−1 12Z", … }` on
what is presented as a curtailment forecast. `open_meteo` is the producer of the
**weather** run; a WattSteer curtailment forecast has `producer: "wattsteer"`
and a `run_label` that is the artifact version. Both facts belong on the screen
— which is why `/v1/grid/outlook` returns `weather_run_label` beside the
WattSteer origin rather than making the screen choose one.

**And a seventh, on Replay.** `ReplayDay.inTrainingWindow` /
`modelTrainedThrough` become `provenance: "served" | "fold_holdout"` plus
`heldOutBy`, per `replay.md`. The `IN-SAMPLE` branch in `replay.tsx` becomes
unreachable and is deleted rather than left as dead code, and the day band stops
being `Σ` of the hourly quantiles and reads `forecast.day_total` from the
contract.

### The national readout, and the band that cannot be built

> **Fixed.** Product-fix 01 landed the change this section specifies: the hero
> now renders `national.expected_mwh` with `band: null` and
> `band_unavailable_reason: "no_joint_ensemble"`, and the null band is
> unrepresentable without a stated reason. What follows is kept as the record of
> what was found and why, and the joint-band upgrade it argues for is still owed
> by forecaster ticket 08.

The landing hero rendered `NATIONAL_ENERGY = band(2640, 4180, 6320)` MWh over
four subsystem bands whose P50s summed to 4180. The comment concedes that "nothing
else sums", which is the right instinct applied one notch too late: **medians do
not add either.** The median of a sum is the sum of the medians only when the
components are comonotone, and four subsystems' curtailment is not.

So the national headline is, today, three numbers with no engine behind them,
and it sits in the most prominent position in the product.

**What can be published honestly, with the machinery that exists:**

| Quantity | Additive across subsystems? | Available today |
|---|---|---|
| `expected_mwh` — `E[Y]` | **Yes, exactly.** Expectations add. | ✓ |
| `constrained_off_mwh` observed | Yes, exactly. | ✓ |
| a national **band** | No — needs a joint distribution | ✗ |
| a national **median** | No | ✗ |
| a national day-occurrence probability | No | ✗ |

**Decision: the national figure is the expected MWh, plus a count of subsystems
per risk class.** `/v1/grid/outlook` returns `national.band: null` with
`band_unavailable_reason: "no_joint_ensemble"`, and the hero's headline becomes
an expectation with a stated meaning rather than a band with none. The four
subsystem bands stay, drawn on a shared scale, which is where the band belongs
and where the ticket-014 fan-chart work already pays off.

**The upgrade, handed back to ticket 009, and it is nearly free.** The path
ensemble already draws **whole rows of the PIT matrix `U`** — whole days —
which is what preserves intra-day dependence. If the same drawn day-row index is
used for all four subsystems within a draw `k`, cross-subsystem dependence is
preserved for free by exactly the same argument, and

```
national day total quantiles = quantiles over k of  Σ_s Σ_t Q_Y(u_{k,t} | x_{s,t})
```

is a legitimate joint band computed from 500 draws with **no new model, no
copula, and no new parameter**. It costs one line in the draw loop (share the
index) and one more persisted row grain (`national`). Until that lands,
`national.band` is `null` and says why.

> **This is the one place where the API surface changes what a screen can
> promise, and it is the largest product consequence in this spec.**

### Caching

**One rule: a cache key is a provenance, never a duration.** Every entity in
this domain already carries the thing that should invalidate it — a
`ForecastOrigin`, a `data_version`, an `artifact_id`, a scenario hash — and a
key built from those has no manual invalidation path to forget to call.

| Surface | Shared-cache directive | ETag / Redis key | Why |
|---|---|---|---|
| `/v1/meta` | `no-store` | — | It is what you read to discover something is broken |
| `/v1/grid/outlook`, `/v1/forecast/day-ahead` | `public, max-age=300, stale-while-revalidate=3600` | `W/"<artifact_id>:<published_at>:<max data_version>"` | A superseding 12Z run changes the ETag by construction; `max-age` never crosses the next gate |
| `/v1/grid/now` | `public, max-age=60` | `W/"<latest ingested_at>"` | Moves with ingestion, which is hourly at best |
| `/v1/curtailment/*` for a settled past range | `public, max-age=3600, stale-while-revalidate=86400` | `W/"<max data_version in range>"` | **Not `immutable`** — ONS rewrites history in place |
| `/v1/curtailment/*` touching the last 48 h | `public, max-age=300` | same | The tail is still settling |
| `/v1/diagnosis/day-ahead` | `public, max-age=300`, `Vary: Accept-Language` | attribution row's version + `diagnosis.md`'s narration key | Two caches, not one — see below |
| `/v1/model/card` | `public, max-age=3600` | `W/"<artifact_id>"` | Changes only on promotion |
| `/v1/optimize` (`GET ?s=`) | `public, max-age=300` | Redis `opt:v1:<scenario_hash>:<origin>:<optimizer_build>`, TTL 24 h | `flex-optimizer.md`, verbatim |
| `/v1/optimize` (`POST`) | `no-store` | the same Redis key | A POST is not shared-cacheable; Redis does the work |
| `/v1/replay` | `public, max-age=600` | Redis `replay:v1:<scenario_hash>:<date>:<origin>:<optimizer_build>:<obs_data_version>` | See below |
| `/v1/replay/days`, `/v1/backtest` | `public, max-age=3600` | `W/"<featured-days computation id>"` | Recomputed nightly |
| `/v1/plants` | `public, max-age=86400` | `W/"<registry snapshot ingested_at>"` | Daily SIGA/ONS snapshot |

**The ticket's premise, corrected.** "Forecasts change daily, replays never
change" is half right and half a trap.

- A forecast changes **twice** daily — `gate_early` at 09:00 BRT and `gate_late`
  at 19:00 BRT — and the second supersedes the first as a newer vintage of the
  same valid hours. A `max-age` tuned to "daily" would serve an 00Z view for ten
  hours after the 12Z view existed. Hence the 5-minute `max-age` and the ETag
  that carries the origin: revalidation is cheap and correctness does not depend
  on the clock.
- **A replay is reproducible, not immutable.** `replay.md` seam 7 asserts that a
  replay at a **pinned** `forecast_origin` reproduces byte-identically after a
  retrain — that is a statement about the *forecast* half. The observed half is
  read `AsOf(now)`, and ONS restates history in place: the map records all of
  2025 rewritten in 2026 under the same filenames. So the observed
  `data_version` is in the Redis key, and no replay response carries
  `immutable`. **A cache that froze a replay against a restatement would hide
  precisely the thing `revision_optimistic` exists to surface.**

**As built, the replay key has five components and not six.** `obs_data_version`
is missing, because the replay contract publishes no observed data version to
put in it: `replay_result` carries the target date, the origin, the fidelity and
the numbers, and nothing on the wire names the vintage of the observed half.
The cost is bounded and is worth stating rather than hiding — for up to the
24 h TTL after ONS rewrites a day, a cached replay of that day answers with the
numbers from before the rewrite. That is staleness on a *cache* and not a broken
pin (the answer was true of the record when it was computed, and the response
names the publication it planned against), but for that window
`vintage_fidelity` is the only thing telling a reader the ground may have moved.
Closing it means either the ML service publishing the observed `data_version` on
a contract `replay.md` declares fixed and this spec may only re-path, or the
gateway querying Postgres on a route whose whole claim is that it contains
neither a model nor a read. Both are somebody else's ticket; the gap is recorded
on `replayKey` in `plugins/result-cache.ts`.

**The diagnosis has two caches and inventing a third is forbidden.** The
attribution is a row read and caches like any other row. The narration is
cached under `diagnosis.md`'s exact key —
`narration:v1:{prompt_version}:{model_id}:{locale}:{sha256(canonical(input))}`,
TTL 26 h, template fallback at 5 min. The HTTP layer must not add a third key
over the composed response, because the composed response's identity is already
the pair and a third key would have its own drift.

**CDN.** There are no accounts, no cookies and no `Authorization` header, so
every `GET` is shared-cacheable and there is no `Vary` beyond
`Accept-Language` on the one route that generates prose. The `Cache-Control`
values above are written for a CDN in front of the gateway; the ETags make
revalidation a 304 rather than a query. `stale-while-revalidate` is what turns a
publication failure into a slightly older number instead of a spinner.

### Rate limiting

The endpoint is public and unauthenticated, and behind it sit a
branch-and-bound solver and a language model. One budget cannot protect both,
and neither is protected by counting page views.

**Three tiers.**

| Tier | Routes | Budget | Shape |
|---|---|---|---|
| Unmetered | `/`, `/health`, `/ready`, `/docs` | ∞ | as built |
| Read | 1–9, 11, 13, 14 | **120 / min / IP** | fixed window; almost every hit is a CDN hit anyway |
| Solve | `POST`+`GET /v1/optimize`, `/v1/replay` | **30 / min / IP, burst 10** | token bucket, per `flex-optimizer.md` |

**The solve tier's budget was sized against one route's cost and now covers
two.** `flex-optimizer.md` chose 30/minute against the optimizer's measured
**3.15 ms**. `apps/ml/tests/test_replay_cost.py` has since measured the other
route on the tier: a replay on the published `REFERENCE_FLEET` is **24.4 ms** —
two MILP solves and five simulator passes rather than one and one, **7.7×** the
figure the budget was chosen against. At full budget that is 732 ms of solver
time per IP per minute (1.2 % of a core) rather than 95 ms (0.16 %), so one core
saturates at roughly **82** IPs sustaining the budget instead of roughly 635.

**The published number stands and the margin is what changed.** 82 distinct IPs
each holding the full budget is a botnet rather than a bored user;
`mlTimeoutMs` is 5 s against a worst-case burst of 10 replays ≈ 244 ms, so the
burst allowance is not what fails first; and 30/minute is `flex-optimizer.md`'s
published contract, which this spec may re-path and not re-shape — a gateway
lowering a published budget on its own authority would be the second place the
budget is specified. `WATTSTEER_RATE_LIMIT_SOLVE` is the operator's knob, and
the arithmetic above is written into `plugins/rate-limit.ts` so the next reader
does not have to rediscover it. The measurement also settles which way the tiers
split if they ever do: replay is the dearer by 7.7× and must therefore take the
*smaller* allowance, not inherit the cheap route's number a second time.

**The language model is not protected by an IP limit, and that is the
interesting one.** `diagnosis.md` computes the real volume: 4 subsystems ×
2 locales × 2 gate profiles ≈ **16 distinct narrations a day**. Everything else
is a cache hit. An IP budget would therefore protect nothing (16 calls do not
threaten anyone) while doing nothing about the actual risk, which is a **cache
stampede**: a thousand concurrent misses on one cold key make a thousand calls.
So:

- **Single-flight per narration key.** A Redis `SETNX` lock on the cache key;
  losers wait on the winner's result with a short deadline and fall back to the
  template on expiry. One call per key, always.
- **A global daily call cap** (default 200, an order of magnitude above the
  expected 16), beyond which the endpoint serves the template and sets
  `narration.source: "template"` — which the response already carries a field
  for, so the panel's footnote stays true with no new mechanism.
- The endpoint itself sits in the read tier.

**Four changes to `apps/api/src/api/plugins/rate-limit.ts`**, each a real defect
for this surface rather than a preference:

1. **It is in-memory and per-process.** The comment is honest about this ("with
   the in-process runner there is exactly one API process"), and Railway can
   scale the `api` service, at which point the published budget silently
   multiplies by the replica count. Redis is already a dependency; the counter
   moves there, with the in-memory map as the no-Redis fallback.
2. **`clientKey` trusts the first hop of `X-Forwarded-For` unconditionally.**
   That is correct behind a trusted proxy that overwrites the header and is a
   free budget reset for anyone who can reach the port directly. Pin it: take
   the *n*-th-from-last hop where *n* is the configured trusted-proxy depth,
   default 1.
3. **It is a fixed window; the optimizer asks for a token bucket** ("30
   requests/minute burst 10"). Two different shapes: a fixed window lets 60
   requests through across a window boundary. The solve tier needs the bucket.
4. **It returns `{ error: string }`**, not the typed envelope below. Its 429
   body becomes `{ error: { code: "RATE_LIMITED", … } }` and keeps
   `Retry-After`.

**Body limits are per-route.** `MAX_BODY_BYTES` is 10 MB, which is right for an
ingestion endpoint and wrong for a solver: the Scenario is capped at 4096 bytes
by `flex-optimizer.md`, so `POST /v1/optimize` and `POST /v1/replay` take
**16 KB**, rejected in `onRequest` on `Content-Length` before anything is
allocated. `bodyLimit(maxBytes)` already takes the parameter; it needs to be
mounted per-route rather than only globally. This is the cheapest half of story
27 — the other half is the validation table, which
`flex-optimizer.md` already places at the gateway before a model is built.

### The error contract, and what a missing forecast looks like

**One envelope, everywhere, including validation:**

```jsonc
{ "error": {
    "code": "SHIFT_EXCEEDS_BASELINE",
    "message": "max_shift_mw (70) exceeds daily_energy_mwh / 24 (50).",
    "details": { "field": "assets[1].max_shift_mw", "limit": 50 },
    "request_id": "1f2c…"
} }
```

- **`code` is a stable identifier from a closed enum in `packages/core`.** Never
  translated, never reworded, never removed without a version bump. The client
  renders `t("error." + code)`; `i18n.md` requires exactly this.
- **`message` is English developer prose and is never shown to a user.** It is
  for logs and for `/docs`. A client that renders it has a bug, and the copy
  test should look for it.
- **`details` is optional and typed per code**, carrying the field path for
  validation failures and the limit that was exceeded.
- **`request_id` echoes the `x-request-id` the `request-context` plugin already
  assigns**, so a user-reported failure is one grep.

**Four changes to `apps/api/src/errors.ts` and `plugins/errors.ts`:**

1. `ErrorStatus` is `400 | 500 | 502 | 503` and this surface needs
   **404, 422 and 429** as well.
2. `AppError` carries only a status and a message; it needs a `code`.
3. `errorHandler` returns early on `code === "VALIDATION"` and keeps Elysia's
   native 422 body. That is a **second error shape on the same API** — the one
   place a client is most likely to need machine-readable detail. Elysia's
   validation error must be mapped into the envelope, with its field path
   preserved in `details`.
4. `NOT_FOUND` returns `{ error: "Not found" }` — the old string shape.

**The code table** is the union of the optimizer's eighteen validation codes,
Replay's five refusals, and the eleven this spec adds:

| Code | Status | Meaning |
|---|---|---|
| `SUBSYSTEM_UNKNOWN` | 422 | not one of the four |
| `TARGET_DATE_OUT_OF_RANGE` | 422 | before 2024-04, or beyond tomorrow |
| `DATE_RANGE_TOO_LARGE` | 422 | observed range over 400 days |
| `GATE_PROFILE_UNKNOWN` | 422 | not `gate_early` / `gate_late` |
| `LOCALE_UNSUPPORTED` | 422 | primary subtag is neither `pt` nor `en` |
| `FORECAST_NOT_YET_PUBLISHED` | 404 | the gate for that target date has not passed |
| `FORECAST_UNAVAILABLE` | 404 | the gate passed and no rows exist — a publication failure |
| `MODEL_UNAVAILABLE` | 503 | no promoted artifact in the requested lane |
| `DIAGNOSIS_UNAVAILABLE` | 404 | forecast exists, attribution row does not |
| `OPTIMIZER_UNAVAILABLE` | 502 | ML service unreachable |
| `DATA_UNAVAILABLE` | 503 | Postgres unreachable |
| `RATE_LIMITED` | 429 | with `Retry-After` |
| `PAYLOAD_TOO_LARGE` | 413 | body over the route's limit |

Plus, verbatim: `SCENARIO_VERSION_UNSUPPORTED`, `SCENARIO_TOO_LARGE`,
`ASSET_TYPE_UNKNOWN`, `SUBSYSTEM_MISMATCH`, `FIELD_NOT_ON_VARIANT`,
`MAGNITUDE_OUT_OF_RANGE`, `RTE_OUT_OF_RANGE`, `EFFICIENCY_PAIR_INCOMPLETE`,
`SOC_BOUNDS_INVALID`, `SOC_INITIAL_OUT_OF_BOUNDS`, `POWER_LIMIT_INCONSISTENT`,
`SHIFT_EXCEEDS_CONNECTION`, `SHIFT_EXCEEDS_BASELINE`,
`SHIFT_WINDOW_OUT_OF_RANGE`, `RECOVERY_TIME_OUT_OF_RANGE`,
`AVAILABILITY_INVALID`, `ECONOMIC_ASSUMPTION_OUT_OF_RANGE`,
`SOLVER_GAP_UNCLOSED`, `SOLVER_TIMEOUT`, `SOLVER_BUG`,
`REPLAY_DATE_BEFORE_HOLDOUT_WINDOW`, `REPLAY_DATE_OUT_OF_RANGE`,
`REPLAY_FORECAST_UNAVAILABLE`, `REPLAY_OBSERVATION_INCOMPLETE`,
`REPLAY_INTEGRITY_VIOLATION`.

#### The four "no forecast" states, and what the UI shows

They are four different sentences and collapsing them into a spinner is the
failure this section exists to prevent.

**1. Not yet published** — `FORECAST_NOT_YET_PUBLISHED`, 404. The requested
target date is tomorrow and the gate has not passed. **This is not an error
state on screen.** The Overview shows *today's* forecast, clearly dated, beside
one line: "Tomorrow's view publishes at 19:00 BRT" — the gate instant comes from
`/v1/meta`, so the sentence is data, not a hardcoded string. A countdown is
optional; an error is wrong.

**2. No promoted artifact** — `MODEL_UNAVAILABLE`, 503, with
`details.lane_state ∈ {no_artifact, present_unpromoted}`. This is the
forecaster's story 34 reaching the UI: the service refuses rather than invents.
The screens:

- **Overview** renders its **observed** panels — `/v1/grid/now`,
  `/v1/curtailment/hours`, `/v1/curtailment/episodes` — which need no model at
  all, and states which of the three artifact states holds. The forecast panels
  are *absent*, not skeletons and not zeroed bands.
- **Explain** and **Mitigate** are disabled with the same sentence, because both
  require a forecast.
- **Time Machine still works.** It reads pinned `Forecast` rows and, per
  `replay.md`, "never consults the currently promoted serving artifact for a
  historical day". That is a real and slightly surprising product property and
  it is worth putting on the screen: the historical view survives an unpromoted
  model.

**3. Published but stale** — a **200**, not an error. Rows exist from an earlier
gate or an earlier day; the response carries `forecast_origin.age_hours` and
`gate_profile`. The screen renders the numbers and states the origin, which it
is obliged to do anyway ("every surface that shows a forecast must name its
`ForecastOrigin`"). Above a configurable age (default: past the next expected
gate), the origin line takes the `warning` tone the landing page's sample badge
already uses. **Nothing is hidden and nothing is refused** — a forecast from
this morning is a real forecast.

**4. The gateway or the database is down** — `DATA_UNAVAILABLE`, 503, with
`Retry-After`. The generic case, and the only one that gets a generic message.

**The standing rule across all four, inherited from the ML stub's own comment:
never invented numbers, and never a zero standing in for an absence.** An
absent forecast renders as an absence. `avoidability: null` renders "—" with the
"undefined, not zero" explanation the prototype already has. An empty `hours`
array is never drawn as a flat line at zero.

### `packages/core` — yes, and what the parity test is for now

**Decision: `packages/core` holds the contract, the client, the constants and
the parity fixtures. It is the only package both `apps/api` and `apps/web`
depend on, and its `fixtures/` directory is read by `pytest` as well.**

It holds `format.ts` (two functions) **and a working cross-language parity
harness**: `fixtures/canonical-contract/` with its README, enumerated by
`test/canonical-contract.test.ts` and by
`apps/ml/tests/test_canonical_contract.py`, pinning the canonical read manifest
and the `VintageFidelity` rule. (An earlier draft of this section described the
package as holding "four things today" and proposed *recovering* the parity
pattern; it was already recovered by the data-platform work. What follows
extends it rather than rebuilding it.) Its own strip-spec records the rest of
the emptiness as deliberate: "it is the declared home for domain shared between
Elysia and Expo, and the Public API surface ticket explicitly considers putting
the typed API client back there." It does.

```
packages/core/
  schema/                     # the cross-language authority
    scenario.schema.json
    optimization-result.schema.json
    forecast-day-ahead.schema.json
    diagnosis.schema.json
    replay.schema.json
    grid-outlook.schema.json
    error.schema.json
  src/
    domain.ts                 # promoted from apps/web/src/lib/domain.ts
    types.generated.ts        # from schema/, checked in, CI asserts it is current
    client.ts                 # the typed client
    errors.ts                 # the closed error-code enum + ApiError
    scenario.ts               # canonical JSON + base64url + sha256
    constants.ts              # SUBSYSTEMS, REFERENCE_FLEET, thresholds, BRL_PER_MWH
    format.ts                 # as today
  fixtures/                   # golden vectors, read by bun test AND pytest
    canonical-contract/*        # already shipped: the read manifest + VintageFidelity
    published-constants/*       # the constants above, pinned in both languages
    gate-at/*.json
    scenario-canonical/*.json
    scenario-validation/*.json
    avoidability/*.json
    simulator/*.json
```

**The client is a fetch-based typed client, not Eden alone.** Elysia's Eden
treaty over `type App` gives compile-time parity between gateway and web for
free, and it gives Python nothing — so the **JSON Schema is the cross-language
authority and Eden is a TypeScript convenience**; where they disagree the schema
wins and a test says so. The template's `client.ts` shape is the right one to
recover: a fetch wrapper returning typed results and throwing an `ApiError`
carrying `status`, the domain `code`, and a `retryable` flag for 429/5xx/network
— which is what a UI needs to decide between "retry" and "show state 2 above".

**Four constants move, and one of them is a real bug today.**
`SCENARIO_BRL_PER_MWH = 180` (`apps/web/src/lib/economics.ts`) is one
definition, which `apps/web/src/lib/fixtures/mitigate.ts` re-exported under the
second name `ECONOMIC_ASSUMPTION_BRL_PER_MWH` — an alias worth deleting, but not
a second definition, and an earlier draft of this section overstated it as
"written down twice". The real defect is narrower and is a live bug:
`flex-optimizer.md` calls this "the single place it is written down", the
optimizer that needs it is **Python**, and a constant in `apps/web` is one the
optimizer cannot read. It becomes `BRL_PER_MWH` in
`packages/core/src/constants.ts`, beside
`SUBSYSTEMS`, `REFERENCE_FLEET`, `SUBSYSTEM_THRESHOLD_MW = 5`,
`REPORTING_ENTITY_THRESHOLD_MW = 1` and `MAX_GAP_HOURS = 0`.

#### The parity harness — the pattern, and where it now points

The template's suite lives at `packages/core/test/resolve.test.ts` before commit
`9b8a1fc`. Its shape, which is what transfers:

```ts
import { resolveTarget as apiResolve } from "../../../apps/api/src/resolve.js";
import { resolveTarget } from "../src/resolve";

const PARITY_FIXTURES: Array<{ input: string; expected: Target }> = [ /* … */ ];

describe("resolver parity with the API", () => {
  for (const { input, expected } of PARITY_FIXTURES) {
    test(`both resolvers agree on ${JSON.stringify(input)}`, () => {
      expect(resolveTarget(input)).toEqual(expected);
      expect(apiResolve(input)).toEqual(expected);
    });
  }
});
```

Four properties made it work, and all four survive the translation:

1. **One shared fixture table is the contract**, and it is data.
2. **A cross-workspace import** exercises both implementations on identical
   inputs in one process.
3. **Each side is asserted against `expected`, not against the other** — so a
   shared bug cannot cancel out. This is the property most likely to be lost in
   a rewrite and it is the one that matters.
4. **Deliberate asymmetries get their own `describe` block**, so "the client is
   more liberal here" is documented rather than discovered as drift.

**What transfers is (1), (3) and (4). What does not is (2)** — a TypeScript test
cannot import a Python function. So the fixture table moves out of the test file
and into `packages/core/fixtures/`, a directory of `{input, expected}` JSON
cases, and **both** `bun test` and `pytest` enumerate the directory and assert
their own implementation against `expected`. A test on each side fails if a file
in the directory has no case covering it, so adding a vector is sufficient and
neither language can quietly skip one.

**Five values are now computed in two languages**, and each gets a vector file:

| Value | TypeScript | Python | Why it will drift |
|---|---|---|---|
| `gate_at(target_date, gate_profile)` | gateway: "has tomorrow published yet", validation of `published_at` | feature builder, everywhere | A timezone or a DST assumption; the window has no DST but the code must not assume it |
| canonical scenario JSON + sha256 | web builds the URL, gateway builds the cache key | ML re-derives it to validate | Float formatting. `0.92` vs `0.920` is a different hash and a cache that silently never hits |
| the 18 scenario validation rules | gateway, "before a model is built" | ML, "trusts nothing it did not validate itself" | Two hand-written tables of eighteen rules |
| `avoidability` and its null rule | web renders "—" | ML computes it | The null-vs-zero rule is one line and it is the product's most quoted percentage |
| **the simulator / execution rule** | `apps/web/src/lib/fixtures/optimize.ts` `evaluatePlan` | `apps/ml`, the authority | See below |

**The simulator is not a parity case. It is a deletion.** `replay.md` seam 3
requires a structural test that **exactly one implementation of the execution
rule exists in the repository**. There are currently two — the prototype's
`evaluatePlan`, and the one `flex-optimizer.md` specifies for `apps/ml` — and
`flex-optimizer.md` separately records that the prototype's version is *wrong*
(it clips absorption but not state of charge, so on a low realisation it reports
a battery filled with energy it never received). Keeping them in parity would be
maintaining a known-broken second copy. **The web's `evaluatePlan` and
`planDispatch` are deleted when Mitigate stops using fixtures and calls
`/v1/optimize`**, and the structural test that counts implementations is what
keeps them deleted.

## Testing Decisions

**What makes a good test here.** An API surface has no ground truth to assert
against, so the tests that matter assert **that two things cannot disagree** and
**that an absence is rendered as an absence**. Two of them are generic detectors
in the family of the feature spec's gate ablation and the forecaster's
shuffled-label control.

**Seam 1 — the boundary, structurally.** A grep/AST-level test asserts that no
route handler under `apps/api/src/api` reaches the ML service except the
optimizer and replay solve handlers. `/v1/forecast/day-ahead` and
`/v1/diagnosis/day-ahead` resolve from Postgres only, asserted by running them
against a fixture database with `WATTSTEER_ML_URL` unset and expecting a 200.
**This is the test that keeps the architecture**, because re-adding a per-request
inference is a two-line change that nothing else would notice.

**Seam 2 — degradation, as behaviour.** With the ML service returning 503 for
everything: `/v1/grid/outlook`, `/v1/forecast/day-ahead`, `/v1/diagnosis`,
`/v1/curtailment/*` and `/v1/replay/days` all return 200; `/v1/optimize` and
`/v1/replay` return 502 `OPTIMIZER_UNAVAILABLE`; `/v1/meta` returns 200 with
`model.reachable: false`. One test, one table, and it is the whole product
promise of the boundary decision.

**Seam 3 — the ml-proxy failure mapping, per branch.** Unconfigured URL,
connection refused, timeout, upstream 502/503/504, upstream **422** (must pass
through with its code and body — the defect named above), upstream 500. Each
asserts a distinct status *and* a distinct code, because the whole point of the
module is that the caller can tell whose fault it is.

**Seam 4 — `origin_kind`, negatively.** A `backfilled_holdout` row is never
returned by `/v1/forecast/day-ahead` or `/v1/grid/outlook` under any query,
including one that names its `published_at` exactly. This is `replay.md` seam 6
enforced at the surface that would leak it.

**Seam 5 — nothing sums a band, at the API layer.** The UI already has this
test; the API needs its own, because the API is now where day-grain figures come
from. Assert that `day_energy_mwh` on a fixture response is **not** the
componentwise sum of `hours[].constrained_off_mwh`, and a grep-level assertion
that no handler computes a day figure by reducing an hourly band. Plus:
`national.band` is `null` and `band_unavailable_reason` is populated, until the
joint ensemble lands.

**Seam 6 — the schema is the contract, in both languages.** Every example in
this spec and in the four upstream specs validates against
`packages/core/schema/*`. The generated `types.generated.ts` is current (CI
regenerates and diffs). A response containing `split: {p50: …}` fails
validation; a `Band` with `p10 > p50` fails; a `subsystem: "SIN"` fails.

**Seam 7 — the parity vectors, both sides.** For each of the four remaining
parity values, every file in the fixture directory is asserted by `bun test` and
by `pytest`. Each side additionally asserts that it consumed **every** file in
the directory, so a vector added for one language cannot be silently skipped by
the other. A deliberately-broken vector (a canonical encoding with a trailing
zero) must fail on both sides, which is the test of the test.

**Seam 8 — exactly one execution rule.** The structural count from `replay.md`
seam 3, run in the default path, asserted against the whole repository including
`apps/web`. It fails today, and it should — that is the deletion this spec asks
for.

**Seam 9 — the error contract, exhaustively.** One case per code, each asserting
the envelope shape, the status, and that `code` is a member of the closed enum.
Explicitly: an Elysia validation failure produces the envelope and not Elysia's
native body; a 404 produces the envelope and not `{error: "Not found"}`; a 429
produces the envelope and keeps `Retry-After`; every 5xx logs server-side and
leaks no detail.

**Seam 10 — the four absences.** Four fixtures — gate not passed, no promoted
artifact, stale rows, database down — asserting four distinct codes and, on the
two that return 200, that no field is zero-filled. Plus the positive: with no
promoted artifact, `/v1/replay?d=…` still returns a complete replay.

**Seam 11 — caching, as key behaviour.** A 12Z publication changes the forecast
ETag; a re-ingest that writes no new `data_version` does not. A replay's Redis
key changes when the observed `data_version` changes and not otherwise. A
scenario re-encoded with `0.920` instead of `0.92` hits the same key. No
response carries `immutable` — a grep-level assertion over the header
middleware.

**Seam 12 — rate limiting.** The three tiers have three budgets; the solve tier
is a token bucket that permits a burst of 10 then throttles; `clientKey` ignores
an `X-Forwarded-For` hop beyond the trusted depth; with Redis configured, two
API instances share one budget. A 16 KB body on `/v1/optimize` is a 413 before
any handler runs.

**Seam 13 — the narration single-flight.** 100 concurrent misses on one cold
narration key produce exactly one call to the language model (assert the client
is invoked once, not that the outputs match). Beyond the daily cap, the response
is a 200 with `narration.source: "template"`.

**Seam 14 — live, scheduled.** The publication job runs end to end against real
Postgres and the real ML service, writes rows, and `/v1/forecast/day-ahead`
returns them with a `published_at` equal to `gate_at(target_date, gate_profile)`
exactly. The single most valuable scheduled test here, because the gate equality
is the argument the whole boundary decision rests on.

**Acceptance gate.** Default `bun test` passes with no network, no database and
no ML service (seams 1, 3, 5, 6, 8, 9, 10, 11, 12, 13 are fixture-driven).
Seams 2, 4, 7 and 14 run against real Postgres under the existing env-var
gating. The generated types are current. Every example in this document
validates against the schema.

## Out of Scope

- **The content of a forecast, an attribution, a plan or a replay.** Owned by
  tickets 009–012 and fixed there. This spec routes, shapes, caches, limits and
  fails; it decides no number.
- **Authentication, accounts, API keys and tenancy.** The map rules them out for
  v1 and the whole caching and rate-limiting posture above depends on their
  absence. Adding them later is additive: a `Vary: Authorization` and a per-key
  budget tier.
- **GraphQL, tRPC, gRPC.** The surface is fourteen read-shaped routes with two
  fixed-by-spec POST contracts and a static-exported client. REST plus a
  generated typed client is the shape with the least machinery.
- **Webhooks, subscriptions, SSE, WebSockets.** Nothing here is push-shaped:
  the data changes twice a day at known instants, which is what
  `/v1/meta.next_publication_at` is for.
- **Pagination beyond a cursor on the two range endpoints.** Everything else is
  bounded by four subsystems and twenty-four hours.
- **A public write surface of any kind.** The product is read-only; the Scenario
  is carried, never stored.
- **Serialising the path ensemble.** Ticket 009 keeps the 500 paths internal;
  the contract stays P10/P50/P90 plus the day-grain quantiles. The **joint
  national band** proposed above needs no serialisation — it is a fifth
  persisted row grain, not an exposed ensemble.
- **The ML service's public routability.** It stays private. Its `/docs` stays
  closed in production, as built.
- **API versioning beyond `/v1`.** One version exists. The Scenario's `v: 1` is
  a separate and stricter mechanism and is not this.
- **A national forecast band today.** `null`, with a reason, until the shared
  draw index lands in ticket 009.
- **Deleting the ML service's `/v1/forecast/day-ahead` stub before the publisher
  exists.** It stays until there is something to replace it with, and the
  gateway route in front of it is documented as provisional.

## Further Notes

**The headline is that the boundary question answers itself once
`published_at` is taken seriously.** Every other argument for precomputing — the
latency, the failure modes, the second producer — is corroboration. The
structural argument is that a `Forecast` row's `published_at` is
`gate_at(target_date, gate_profile)`, a function of the target date fixed by the
feature spec, and a per-request inference has no honest value to put there. The
same discipline that made train/serve skew inexpressible one layer down makes a
per-request forecast inexpressible at this one.

**The `ml-proxy` module was built for the right reason and pointed at the wrong
route.** Its comment — "a proxy that lets upstream statuses through unexamined
reports an ML outage as an API bug… every branch below is about answering that
question honestly" — is the correct design note for a gateway edge onto a
solver. The mistake is narrower than it looks: it is the assumption, stated in
the forecast route's own docstring, that "the forecast contract belongs to the
service that computes it". That is true of a computation and false of a
**record**, and the forecast became a record the moment ticket 012 required it
to be a query.

**The ticket asked which endpoints are cached and got a sharper answer than
"these ones".** A cache keyed on a duration is a guess about how fast the world
changes. A cache keyed on a provenance is a statement that this response *is*
that version, and every entity in this domain already carries its provenance
because the bitemporal decision put it there. The one place the ticket's own
framing was wrong — "replays never change" — is wrong for the most important
reason in the project: ONS restates history in place, which is the fact the
whole vintage vocabulary exists to survive.

**Three things this spec found that no ticket had claimed.**

1. **There is no national band and no national median**, so the landing page's
   most prominent number has no engine behind it. The fix is one line in the
   forecaster's draw loop.
2. **ODbL §4.6 obliges machine-readable access to the plant registry**, and
   nothing in the product provided it. `/v1/plants` exists for a licence and not
   for a screen.
3. **The number `flex-optimizer.md` calls "the single place it is written down"
   lives where Python cannot read it**, and the optimizer that needs it is
   Python. (It also carried a second *name* — an alias, since deleted — which
   an earlier draft of this spec mistook for a second definition.)

**Where this spec is weakest.** Four places, ranked:

1. **The precompute makes a publication failure a product-visible event with no
   automatic recovery beyond a retry.** If both gates fail on a given day the
   product serves yesterday's forecast with an honest age and nobody is paged,
   because there is no paging. The mitigation is entirely in `/v1/meta` and in
   `forecast_origin.age_hours`, which is monitoring by hoping someone looks. A
   real alert on `next_publication_at` passing without a new origin is the
   obvious follow-up and it is not specified here.
2. **The three rate-limit tiers are three invented constants** (120, 30, 200).
   They are placed where being wrong is conservative — too low throttles a
   legitimate user, which is visible and complained about, rather than too high,
   which is invisible until a bill — but none of them is measured, and the first
   month of real traffic should move them.
3. **The typed client is two mechanisms (JSON Schema and Eden) and they can
   disagree.** The rule that the schema wins is stated and asserted by a test,
   but a test that two type systems agree is harder to write well than this spec
   admits, and the honest fallback is that Eden is a convenience which may be
   dropped without losing the contract.
4. **`/v1/meta` is doing a lot of jobs.** Capability discovery, freshness,
   constants, licensing and the artifact state are five concerns in one
   document, and it will grow. The argument for one document is that a client
   needs all five before it renders anything and five round trips before first
   paint is worse; the argument against is that it will eventually be cached
   wrongly by someone. It is `no-store` for exactly that reason.

### Calls the dev should review

1. **The forecast is precomputed by the worker and the public API never calls
   the ML service for one.** This is the spec's central decision. It deletes the
   `ml-proxy` forecast route, adds two scheduled publication jobs and two tables
   (`curtailment_forecast_hour`, `curtailment_forecast_day`, neither of which
   exists in `apps/api/src/database/schema.ts` today), and makes the ML service
   a dependency of *tomorrow's* forecast rather than of *every page view*. The
   alternative — keep the per-request path — is simpler today and gives up the
   degradation table.
2. **There is no national forecast band, and the landing hero's headline
   changes.** `national.band` is `null` with a stated reason until ticket 009
   shares the ensemble's draw index across subsystems. Until then the hero
   headline is an expectation, not a band. This is the largest product
   consequence in this spec and it is a correction to the most visible number in
   the product.
3. **`GET /v1/plants` exists to satisfy ODbL §4.6**, not because a screen asked
   for it. If the legal reading in the map is wrong, this endpoint should go; if
   it is right, this endpoint is not optional and the bilingual §4.3 notice
   needs to reach the public surfaces too.
4. **Five UI contract changes, not the three `diagnosis.md` flagged.** The two
   unflagged ones are larger: `buildExplain(subsystem, technology)` loses its
   technology argument, and `SubsystemDayForecast` stops being per-technology
   entirely. The `technology` URL parameter survives for the observed panels
   only.
5. **The wire is `snake_case` and `packages/core` is the only translator.** The
   web app's `camelCase` vocabulary is preserved through generated types. The
   alternative — `camelCase` on the wire — would require re-shaping two
   contracts that two specs declared fixed and would put the conversion in the
   Python service instead.
6. **`apps/web/src/lib/fixtures/optimize.ts`'s `evaluatePlan` and `planDispatch` are
   deleted, not ported.** `replay.md` requires exactly one execution rule in the
   repository and `flex-optimizer.md` records that this copy is wrong. Deleting
   it means Mitigate must call `/v1/optimize` before the fixtures come out, so
   the two changes are one change.
7. **The rate limiter moves to Redis and `clientKey` stops trusting an arbitrary
   `X-Forwarded-For` hop.** Both are correctness issues the moment the `api`
   service scales past one replica, which is a Railway checkbox.
8. **The error envelope changes shape for every existing route**, including the
   ones that ship today, and Elysia's native validation body is wrapped rather
   than passed through. This is a breaking change to a surface with no consumers
   yet, which is the cheapest moment it will ever be.

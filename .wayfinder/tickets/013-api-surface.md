---
id: "013"
title: Public API surface
type: wayfinder:grilling
status: closed
assignee: spec-agent
blocked_by: ["009", "010", "011", "012"]
---

## Question

What does Elysia expose to the web app, and what does it proxy to the Python
service?

IDEA.md §41 sketches `GET /forecast`, `GET /diagnosis`, `POST /optimize`.

- Full endpoint list including the landing page's live grid data, the replay
  endpoints, and whatever the four screens need.
- Response shapes, in the vocabulary from ticket 006.
- Which endpoints are cached and for how long — forecasts change daily, replays
  never change.
- Where the boundary sits: does Elysia call the Python service per request, or
  does the worker precompute forecasts nightly into Postgres so the public API
  never depends on the ml service being up? This materially changes the failure
  modes.
- Rate limiting posture for a public unauthenticated API.
- Error contract, and what the UI shows when a forecast is unavailable.
- Whether `packages/core` still holds a typed API client and shared types the
  way it did for Zalytix — it is the natural home, and the parity-test pattern
  from the template may transfer.

Use `/grilling`.

## Resolution

Spec: [`docs/specs/api-surface.md`](../../docs/specs/api-surface.md).

**The boundary — precompute the model, call the solver.** The public API
**never** calls the ML service for a forecast or an attribution: the worker
publishes both at the two gate instants into Postgres and the gateway reads
rows. The MILP and the simulator stay **per-request and synchronous**, because
the scenario is user-supplied and there is nothing to precompute. The deciding
argument is structural rather than operational: a `Forecast` row's
`published_at` **is** `gate_at(target_date, gate_profile)` — D−1 09:00 or
D−1 19:00 BRT, fixed by the feature spec — and a per-request inference has no
honest value to put there. It would either stamp the request time (a lying
`ForecastOrigin`) or the gate (asserting a publication that did not happen),
and `replay.md` had to invent `origin_kind` precisely to keep those apart.
Everything else corroborates: forecaster story 35 already persists every served
forecast, `replay.md` already requires the forecast precomputed, so a
per-request path is a **second producer of a number already in a table** — the
drift class five prior specs have each ruled out at their own layer. The
failure modes are not comparable either: precomputed, an ML outage costs
*tomorrow's* forecast and every screen still serves with an honest age;
per-request, Overview, Explain, Mitigate and Replay all 502.

**`ml-proxy` — the module is right, its one route is a stopgap.** Its failure
mapping is correct and worth keeping verbatim (unconfigured ≠ broken; timeout →
503 "retry" vs refused → 502 "don't bother"; upstream 5xx never passed through
as a WattSteer bug). The stopgap is `GET /forecast/day-ahead`: unversioned,
returning the ML body verbatim on the stated ground that "the forecast contract
belongs to the service that computes it" — right for a proxy, wrong for a
**record**, and the forecast became a record the moment ticket 012 made it a
query. It also cannot filter `origin_kind = 'served'`, which replay seam 6
requires. So: keep the module, delete the forecast route, point it at the
solve. Two live defects named: a non-5xx upstream error collapses into
`UpstreamError`, so the ML service's own **422** re-validation refusal and its
**500** `SOLVER_BUG` would both read as an outage; and `SOLVER_GAP_UNCLOSED`
(503) and `SOLVER_TIMEOUT` (504) need to be distinct outcomes.

**Fourteen `/v1` routes**, plus the four probes as built. Two exist that no
upstream ticket asked for: `GET /v1/grid/outlook` + `GET /v1/grid/now` for the
landing readout, and `GET /v1/plants`, which discharges the ODbL §4.6
machine-readable-access obligation the map records and nothing else provides.
Three things are deliberately **not** endpoints — `SUBSYSTEMS`,
`REFERENCE_FLEET` and any scenario-shortening service — because an enum with
four members, a constant `replay.md` requires to be published once, and the
URL-as-storage decision each become worse as a fetch.

**Shapes.** The wire is `snake_case` (forced: two specs fixed their contracts in
it, the ML service is Python, the columns are `snake_case`) and
`packages/core`'s generated client is the **only** translator to the web app's
`camelCase`. Nine schema-enforced vocabulary rules, each because something has
already got it wrong once: the technology split is two scalars with
`additionalProperties: false` so no client can render a band there; an
expectation is never inside a band object; `avoidability` is `number | null`
and null is meaningful; `lead_time` is absent because it is derived; `SIN` is
not a `subsystem` value anywhere.

**The three flagged UI contract changes are five.** `Driver.direction` gains
`"mixed"` (only reachable on the merged `other` row, asserted); `observed` /
`typical` become numbers plus a `unit` code, formatted client-side through
`Intl`; `share` is of *attributed movement* (`|φ_j| / Σ|φ_k|`), which changes
the doc comment and the bars footnote. Two more, both unflagged and both
larger: `buildExplain(subsystem, technology)` must lose its technology argument
(there is one attribution per subsystem-day), and `SubsystemDayForecast` must
stop being **per technology** entirely — there is no per-technology model, and
the split is a scalar point-split of the P50 and the expectation. A sixth,
smaller: `Driver.label` becomes `labelCode`, per the API-returns-codes rule. A
seventh, on Replay: `inTrainingWindow` / `modelTrainedThrough` become
`provenance` + `heldOutBy`, and the `IN-SAMPLE` branch is deleted rather than
left unreachable.

**Caching — keyed on provenance, never on duration.** Every entity already
carries what should invalidate it (`ForecastOrigin`, `data_version`,
`artifact_id`, scenario hash), so a key built from those has no manual
invalidation path to forget. **The ticket's premise is half wrong.** A forecast
changes *twice* daily, at two gates, so a "daily" `max-age` would serve an 00Z
view for ten hours after the 12Z view existed — hence 5 minutes plus an ETag
carrying the origin. And **replays are reproducible, not immutable**: the
forecast half is pinned, but the observed half is read `AsOf(now)` and ONS
restates history in place. So the observation `data_version` is in the replay
cache key and **nothing on this API carries `immutable`** — a cache that froze a
replay against a restatement would hide exactly what `revision_optimistic`
exists to surface.

**Rate limiting — three tiers, and the scarce resource is what gets
protected.** Reads 120/min; the solver a 30/min token bucket with burst 10, per
the optimizer spec. The **language model is not protected by an IP limit**:
there are only ~16 distinct narrations a day, so an IP budget protects nothing
while the real risk is a cache stampede — hence a Redis single-flight lock per
narration key plus a global daily cap that degrades to the template, which the
response already has a field for. Four real defects in the shipped plugin:
in-memory and per-process (so the budget multiplies by replica count the moment
Railway scales `api`), `clientKey` trusts an arbitrary `X-Forwarded-For` hop,
fixed window where the optimizer asked for a bucket, and the untyped error body.
Plus a per-route body limit: 10 MB is right for ingestion and wrong in front of
a solver whose scenario caps at 4 KB.

**The error contract** is one envelope (`{error: {code, message, details,
request_id}}`), one closed code enum in `packages/core`, English `message`
never rendered to a user. Four changes to the shipped code: `ErrorStatus` lacks
404/422/429; `AppError` has no `code`; `errorHandler` returns Elysia's native
422 unchanged, which is a **second error shape on the same API** at the one
place a client most needs machine-readable detail; and `NOT_FOUND` still emits
the old string body.

**Four distinct "no forecast" states**, because collapsing them into a spinner
is the failure this section exists to prevent: *not yet published* (a 404 code,
rendered as today's forecast plus the gate time from `/v1/meta` — not an error
on screen); *no promoted artifact* (503, the forecaster's story-34 refusal —
Overview falls back to its **observed** panels, which need no model, and
**Time Machine keeps working**, because it reads pinned rows and never the
serving artifact); *stale* (a **200** with `age_hours` and the origin named);
and *infrastructure down*. Standing rule inherited from the ML stub: never
invented numbers, and never a zero standing in for an absence.

**`packages/core` — yes, with a sharper job than the template's.** It holds the
JSON Schema (the cross-language authority; Eden is a TypeScript convenience and
the schema wins), the generated types, the fetch client with an `ApiError`
carrying `status`/`code`/`retryable`, the promoted `domain.ts`, and the
published constants — including `REFERENCE_FLEET`, which `replay.md` already
names as living there, and `BRL_PER_MWH`, which currently exists under **two
names** (`SCENARIO_BRL_PER_MWH`, `ECONOMIC_ASSUMPTION_BRL_PER_MWH`) in a
package Python cannot read, while the optimizer spec calls it "the single place
it is written down".

**The parity pattern transfers with one property replaced.** The template's
`packages/core/test/resolve.test.ts` (pre-`9b8a1fc`) worked on four properties:
one shared fixture table as the contract; a cross-workspace import so both
implementations run on identical inputs; **each side asserted against
`expected` rather than against the other**, so a shared bug cannot cancel out;
and deliberate asymmetries in their own block. The cross-workspace import
cannot survive a language boundary, so the fixture table moves into
`packages/core/fixtures/` as JSON and **both `bun test` and `pytest` enumerate
the directory**, each also asserting it consumed every file — so adding a vector
is sufficient and neither language can quietly skip one. Four values now need
vectors: `gate_at`, the canonical scenario encoding + hash (float formatting is
the drift — `0.92` vs `0.920` is a different hash and a cache that silently
never hits), the 18 validation rules (written twice by design), and
`avoidability`'s null rule. The **simulator is not a parity case — it is a
deletion**: `replay.md` requires exactly one execution rule in the repository
and `flex-optimizer.md` records the web's `evaluatePlan` as wrong, so keeping
them in parity would mean maintaining a known-broken second copy.

**Three findings no ticket had claimed.** (1) **There is no national forecast
band and no national median.** The landing hero sums four subsystem P50s into a
national P50 and concedes "nothing else sums" — but medians do not add either,
and the path ensemble is drawn per subsystem, so the product's most prominent
number has no engine behind it. `national.band` is `null` with
`band_unavailable_reason` until ticket 009 shares the ensemble's **drawn day-row
index across all four subsystems**, which yields a legitimate joint band from
the existing 500 draws with no copula and no new parameter. Until then the
national headline is the **expected** MWh, which adds exactly. (2) ODbL §4.6
obliges machine-readable registry access and `/v1/plants` is the only thing that
provides it. (3) The R$/MWh assumption is written down twice, in the wrong
package.

**Eight calls listed for the dev**, the first being the boundary itself and the
second being the national band — the largest product consequence in the spec,
because it corrects the most visible number in the product.

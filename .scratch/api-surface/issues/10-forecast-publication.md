# 10 — The forecast is a row that a schedule wrote, not an inference a page view triggered

**What to build:** the boundary decision, made real. Ten minutes after each gate,
the worker asks the modelling service for tomorrow's forecast and writes it to
Postgres. Nothing a user does ever triggers an inference.

**Why this and not per-request inference**, in the order the arguments are hard
to refuse:

1. **The publication instant cannot be the request time.** A forecast row's
   `published_at` is, by the domain model, the instant the producer asserted the
   value, and by the feature spec that instant is `gate_at(target_date,
   gate_profile)` — D−1 09:00 or D−1 19:00 Brasília civil time. A per-request
   inference either stamps the row with the request time, which makes the origin
   a lie, or stamps it with the gate, which asserts a publication that did not
   happen. Replay already had to invent a distinct origin kind to keep a
   counterfactual publication instant distinguishable from a record; a third case
   would have no discriminator. **This argument alone settles it.**
2. **The number is persisted anyway**, so a second producer is pure risk — and
   this project has ruled out a second producer of one quantity at five layers
   already.
3. **The failure modes are not comparable.** With the modelling service down, the
   precomputed design serves the Overview, the Explain screen and the Time
   Machine with an honest age and loses only *tomorrow's new* forecast; the
   per-request design 502s all of them.
4. **The work does not fit in a request** — an artifact load, a feature build, a
   mixture composition and a 500-member ensemble draw.

**What the worker runs**, as repeatable jobs on the existing worker and the
existing Redis — no second scheduler:

| Job | Cron (Brasília) | Writes |
|---|---|---|
| `publish-forecast:gate_early` | `10 9 * * *` | the hour-grain and day-grain forecast tables |
| `publish-forecast:gate_late` | `10 19 * * *` | the same, superseding |
| `publish-diagnosis` | on completion of each above | the attribution table |
| `refresh-featured-days` | `30 3 * * *` | the replay shortlist cache |

Ten minutes after the gate, not on it, because the gate is when the *inputs*
become knowable, not when the job may start.

**The direction of the call is worker → modelling service, never gateway →
modelling service**, over the private network. The modelling service is read-only
against Postgres, so it returns the computed rows and the **worker** writes them.
That keeps the read-only guarantee intact and keeps every write in the service
that owns the schema.

**A publication is atomic and additive.** Rows are inserted with a new data
version under the append-only discipline; nothing is updated in place; a
half-written publication is impossible because the insert is one transaction. A
failed job retries under the existing attempts policy and, on exhaustion, leaves
the previous origin serving.

Two tables are new: the hour-grain and the day-grain forecast tables. Neither
exists today.

A weakness carried deliberately: a publication failure is product-visible with no
automatic recovery beyond the retry, and the only monitoring is the meta endpoint
and the response's age. A real alert on a publication instant passing without a
new origin is the obvious follow-up and is not specified here.

**Blocked by:** cross-spec, **forecaster** — the artifact, the composition, the
path ensemble and the private publish route on the modelling service are its
work, and none of it is re-specified here. Also **data-platform 16** (in flight),
because the modelling service reads the canonical SQL views to build features.

**Status:** done (two boxes open — see “What landed”)

- [x] The two forecast tables exist, append-only, with the project's four time columns
- [x] Two repeatable jobs run at ten past each gate on the existing worker and the existing Redis
- [ ] The diagnosis publication runs on completion of each forecast publication
- [x] The gateway never calls the modelling service for a forecast, and a structural test says so
- [x] The modelling service writes nothing; the worker performs every write
- [x] A published row's publication instant equals the gate instant for its target date exactly
- [x] A publication is one transaction; a partial write is not representable
- [x] A failed publication leaves the previous origin serving, with its real age
- [ ] The end-to-end job is exercised against real Postgres and the real modelling service under the existing environment-variable gating

## What landed

`apps/api/src/jobs/publication.ts` — the schedule table (`publish-forecast:gate_late`
`10 19 * * *`, `publish-forecast:gate_early` `10 9 * * *`, both in
`America/Sao_Paulo`), the lane per gate, and the handler: it resolves tomorrow in
Brasilia from its own clock, refuses a run that beats its own gate, calls
`publishForecast`, and names the modelling service's refusal rather than
flattening it. `apps/api/src/jobs/worker-tasks.ts` adds `publish_forecast` to the
queue's task union one level above the ingest dispatcher and composes the two;
`worker.ts` registers the schedules, and skips them loudly without
`WATTSTEER_ML_URL` rather than failing twice a day.

**On missing inputs** - the case feature-engineering 12 measured, ONS's evening
files landing 19:00:25-19:08 BRT after a 19:00 gate: the job writes nothing,
logs the condition by name, and rethrows the modelling service's own
`FORECAST_UNAVAILABLE` so the queue retries under the existing attempts policy.
On exhaustion the previous origin keeps serving with its real age. No catch-up
cron was added; a re-run is free because the publication is idempotent by
digest, so a redelivery or a hand-submitted task writes nothing when the numbers
have not changed.

**The gate equality** is enforced by the publisher, not by a table constraint:
the job computes `gate_at(target_date, gate_profile)` on this side and
`publishForecast` refuses a payload stamped with anything else *before* the
first insert. A CHECK against the SQL `gate_at` would be stronger and belongs in
`drizzle/`, which another agent held this cycle.

**The two open boxes.**

- `publish-diagnosis` is not built. `diagnosis_attribution` does not exist in
  the schema and `apps/ml` has no attribution route, so there is nothing to run
  on completion; the chaining without a unit of work would be scaffolding.
  `refresh-featured-days` is in the same position - the Replay shortlist cache
  does not exist.
- The end-to-end job runs against real Postgres under
  `WATTSTEER_TEST_DATABASE_URL`, and against the modelling service as a stub
  over a real socket - or the real one when `WATTSTEER_TEST_ML_URL` names it,
  which was not exercised here: a live `apps/ml` publication needs a promoted
  artifact and feature rows for the day.

---

## Two gaps this ticket named rather than closed

**1. The retry budget covers a late input, not a late *source*.** The job
refuses before the ML call when it beats its own gate, and rethrows the
modelling service's code so BullMQ retries under the existing backoff — about
three attempts at 5 s. That covers inputs seconds-to-a-minute late. It does not
cover the case feature-engineering 12 measured: ONS's evening publication landing
at 19:00:25–19:08 BRT, and a staleness that projects to ~43.7 h against a
configured 40 h lag. That falls through to "the previous origin keeps serving at
its real age, visible in `/v1/meta`" — which is what the spec specifies, and
which the spec also flags as **un-alerted**. Nothing pages when a publication
silently stops happening.

No catch-up cron was added on purpose: `writePublication` is idempotent by
digest, so a redelivery or a hand-run after the files land writes nothing if the
numbers match and appends a version if they do not. The missing piece is the
alarm, not the mechanism.

**2. "The publication instant is the gate" is enforced by the publisher, not by
the table.** A CHECK calling the SQL `gate_at` would be stronger — it would make
a mis-stamped row unrepresentable rather than merely refused on the one path that
currently writes. It was not added because `apps/api/drizzle/` was held by
another agent this cycle.

- [ ] A publication that has not happened by some stated margin past its gate
      raises something a human sees, rather than only aging out in `/v1/meta`
- [ ] `published_at == gate_at(target_date, gate_profile)` is a table constraint,
      not a publisher-side check


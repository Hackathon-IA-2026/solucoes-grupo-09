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

**Status:** ready-for-agent

- [ ] The two forecast tables exist, append-only, with the project's four time columns
- [ ] Two repeatable jobs run at ten past each gate on the existing worker and the existing Redis
- [ ] The diagnosis publication runs on completion of each forecast publication
- [ ] The gateway never calls the modelling service for a forecast, and a structural test says so
- [ ] The modelling service writes nothing; the worker performs every write
- [ ] A published row's publication instant equals the gate instant for its target date exactly
- [ ] A publication is one transaction; a partial write is not representable
- [ ] A failed publication leaves the previous origin serving, with its real age
- [ ] The end-to-end job is exercised against real Postgres and the real modelling service under the existing environment-variable gating

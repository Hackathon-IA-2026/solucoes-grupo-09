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

**Status:** done (**three boxes open** — see “What is still open, and why”)

The previous revision of this line also said “two boxes open”, and it was
wrong twice over: a grep found **six** unticked, because the count was written
against the acceptance list at the top and nobody updated it when the two
sections below added two boxes each. Four of those six are now closed, one
sub-box was split out of a fifth and left open, and the two that remain are
named with exactly what is unverified. The count above is a count of unticked
boxes in this file, which is what it should always have been.

- [x] The two forecast tables exist, append-only, with the project's four time columns
- [x] Two repeatable jobs run at ten past each gate on the existing worker and the existing Redis
- [x] The diagnosis publication runs on completion of each forecast publication
      — the worker's half: the chain, the write and the reason read. `apps/ml`
      serves no `/internal/publish/diagnosis` route yet; see the sub-box below
- [x] The gateway never calls the modelling service for a forecast, and a structural test says so
- [x] The modelling service writes nothing; the worker performs every write
- [x] A published row's publication instant equals the gate instant for its target date exactly
- [x] A publication is one transaction; a partial write is not representable
- [x] A failed publication leaves the previous origin serving, with its real age
- [ ] The end-to-end job is exercised against real Postgres and the real
      modelling service under the existing environment-variable gating
      — real Postgres: yes. Real modelling service: **no**, and measured to be
      impossible here; see “What is still open, and why”
- [ ] `apps/ml` serves `POST /internal/publish/diagnosis` — blocked on the
      forecaster's matched background sample in the artifact bundle

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

> **Superseded.** It is now both. `drizzle/0041_the_gate_as_a_table_constraint.sql`
> adds the CHECK on all four tables that carry `published_at` beside
> `target_date` and `gate_profile`; the publisher-side check stays, because it
> refuses *before* the ML call's payload reaches a transaction and its message
> names both instants instead of a constraint.

**The two open boxes**, as this section originally read - and both sentences
have since been overtaken. Kept because the *reasons* are the record:

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

The first sentence's premise is **stale**. `diagnosis_attribution` landed in
`drizzle/0035_the_persisted_attribution.sql` (diagnosis 06), with
`writeAttributionPublication` and `parseAttributionPublication` beside it in
`src/diagnosis/publication.ts`, and `apps/ml`'s
`wattsteer_ml/diagnosis/publication.py` builds the payload the parser reads —
`test/fixtures/diagnosis/attribution.json` is a checked-in vector of it that
both sides assert against. So there *is* a unit of work, and what was missing
was the trigger, the write, the read one of its rules needs, and the HTTP route
on `apps/ml`. Three of those four are the section below.

---

## What the reconciliation pass found, and what it closed

The status line said "two boxes open" and a grep found **six** unticked. The
count was not a lie so much as a stale scope: it was written against the
acceptance list at the top of the ticket, and the two sections the ticket added
afterwards - "Two gaps this ticket named rather than closed" and "A third thing
this ticket will own" - carry two boxes each, and nobody went back to the
number. None of the six was superseded or duplicated. What each of them was
actually waiting on:

| Box | Was it genuinely open | What it was waiting on |
|---|---|---|
| the diagnosis publication runs on completion | yes | the trigger and the write, not the table. The stated reason - "`diagnosis_attribution` does not exist" - was **stale** |
| end to end against the real modelling service | yes | a promoted artifact. Still true, and now measured rather than assumed |
| an unpublished publication raises something a human sees | yes | an alerting surface this product does not have. Deliberately deferred by the ticket, and left deferred |
| `published_at == gate_at(...)` as a table constraint | yes | nothing, any more. The stated reason - "`drizzle/` was held by another agent this cycle" - was **stale** |
| a publish path that skips the rules fails | yes | nothing. A design decision, not a dependency |
| `recent_reasons` from a real read | yes | nothing. The stated blocker - "`curtailment-by-reporting-entity` is not filterable by subsystem" - was **half stale**: true of the canonical *view*, false of the dimension underneath it |

### 1. The gate equality is now a table constraint

`drizzle/0041_the_gate_as_a_table_constraint.sql`. Four tables get
`CHECK (published_at = gate_at(target_date, gate_profile::text))`:
`curtailment_forecast_hour`, `curtailment_forecast_day`,
`curtailment_forecast_national_day` and `diagnosis_attribution` - every table
that carries the three columns, derived rather than listed.

A **call** to `gate_at` rather than an inlined gate hour, because the hour is
already spelled three times and `forecast/gate.ts` says in as many words that a
fourth would be worth avoiding. `gate_at` is declared `STABLE` and `0016` is
left alone: Postgres accepts a `STABLE` function in a CHECK - verified on a
migrated database, not assumed - and re-marking a function eight migrations of
callers depend on buys nothing here.

**Not** scoped to `origin_kind = 'served'`. A reconstruction's instant is the
counterfactual gate for the day it describes, which is the same function of the
same two columns; the discriminator was always `origin_kind`.

**It found one.** `test/database-forecast.test.ts`'s ETag test wrote a
"superseding publication" stamped 19:30 BRT to make the validator move.
Superseding *within* a gate is a new `data_version` at the *same* instant, so
that row asserted a publication that never happened - and the row is now
unwritable. The test moves the artifact id instead, which is what actually
changes, and the ETag still changes.

The guard is proved three ways and each is non-vacuous: the correctly stamped
publication is inserted and asserted to have landed (96 hours, 4 days, 1
national row) *before* the refusal is measured; the refusal is asserted on
`cause.constraint_name`, so a refusal for any other reason fails; and a
catalogue test derives the covered tables from `information_schema` and requires
the four, so a fifth table carrying the three columns fails on the day it is
added. Dropping the constraint and re-running fails the refusal test and the
catalogue test and leaves twelve passing - the guard was tested, not just
written.

### 2. The rules provably ran

The valve was enforced four ways *inside* `apply_rules` and none of them said
the rules were **called**. `AttributionRow.rule_flags` defaulted to `()`, and
`rule_flags: []` is the ordinary shape of a quiet day - most days fire nothing -
so the skipped publish path had a perfect disguise.

`()` is not a witness. So a published attribution now carries the **roll call**:
every rule code the engine evaluated, fired or not. Refused at three layers:

- **`apps/ml`.** `RuleOutcome.evaluated` is filled by `apply_rules` from the
  declared rules; `RuleOutcome.for_row()` is the one call that hands the flags,
  the demotions and the roll call over together. `AttributionRow.rule_flags` and
  `rules_evaluated` have **no defaults**, so a path that skips the rules cannot
  construct the row at all, and `_assert_the_rules_ran` refuses an empty roll
  call, a duplicated code, and a fired rule outside it. `apply_rules(context,
  ())` - an explicitly empty rule set - is refused for the same reason.
- **The gateway's parse.** `parseRuleFlags` no longer defaults an absent
  `rule_flags` to `[]`, and `parseRulesEvaluated` requires a non-empty roll call
  of codes drawn from `EVALUABLE_RULE_CODES` - so "names at least one evaluated
  rule" cannot be satisfied with an invented word. The roll call is in the
  value digest, because re-explaining the same day under a different rule set is
  a different explanation of it even when nothing fires.
- **The table.** `drizzle/0042_the_roll_call_of_the_rules.sql` adds
  `rules_evaluated text[] NOT NULL` with `diagnosis_attribution_the_rules_ran`
  (cardinality > 0) and `diagnosis_attribution_flags_were_evaluated`, the latter
  through an IMMUTABLE `rule_flags_were_evaluated(jsonb, text[])` because
  Postgres refuses a subquery in a CHECK - measured, not assumed.

The column is `NOT NULL` with no default and no backfill, because there is no
honest one: a row written before the roll call existed does not know which rules
explained it, the four codes would be an invention and `{}` trips the constraint
that is the point. That is safe only because the table is empty in every
database that exists, so the migration **checks** that with a `DO` block that
raises and names the row count rather than assuming it.

`EVALUABLE_RULE_CODES` is held against `apps/ml` by parsing `SHIPPING_RULES` out
of `rules.py`, the way `declined-figures.test.ts` and `caveated-figures.test.ts`
already hold their own cross-language lists - so a fifth rule shipped upstream
fails a test here on the day it lands.

Non-vacuity throughout: the quiet day is asserted to parse and to store first,
so every refusal is a refusal of the skipped path rather than of every empty
flag list. Dropping the two constraints fails the two DB tests and leaves
eighteen passing. Removing the Python defaults broke 30 tests across two files
on the first run, which is the same fact from the other side.

### 3. The diagnosis publication is chained to the forecast publication

`src/jobs/diagnosis-publication.ts` is the handler, `src/diagnosis/publish.ts`
the unit of work, and `jobs/worker-tasks.ts`'s `chainDiagnosis` the trigger:
`publish_diagnosis` joins the queue's task union and a finished
`publish_forecast` **submits** one, because the spec's job table gives this row
"on completion of each above" and that is the one entry that is not a cron.

Four decisions worth stating:

- **A separate task, not a second half of the forecast publisher.** Separate
  retry budgets - retrying the pair because the attribution failed would redo a
  500-member ensemble draw, and failing the pair would mark a forecast
  publication that *did* write its rows as a failed job.
- **The day is carried, never re-resolved.** The follow-on's payload takes the
  target date off the finished publication's result. A follow-on that recomputed
  "tomorrow in Brasília" seconds after midnight would explain the wrong day.
- **Chained on `unchanged` as well as on `published`.** A forecast publication
  that wrote nothing says nothing about whether the *attribution* exists; the
  attribution has its own digest and its own way of having failed last time.
- **A failed submission does not fail the forecast publication.** The rows are
  committed by then. It warns, loudly, and the day gets a forecast with no
  explanation - which `/v1/diagnosis/day-ahead` reports as its own absence.

`worker.ts` closes the one knot this creates: the runner is built *from* the
dispatcher, so the dispatcher is handed a thunk and the thunk is bound to the
runner afterwards. `submit` absent means the chain is off, which is what the
in-process runner and every ingest test get.

The boundary holds. Nothing under `src/api/` imports `diagnosis/publish`,
`diagnosis/reason-mix`, `jobs/diagnosis-publication` or `jobs/worker-tasks`, and
the `src/diagnosis/` barrel deliberately does **not** re-export the publish path
- `src/api/diagnosis.ts` imports that barrel, so a re-export would have put
`ml-proxy` and the private route on the gateway's request graph by the back
door. `test/ml-boundary.test.ts`'s calibration caught exactly that: its list of
modules spelling `/internal` is now four rather than three, and it independently
asserts none of them is reachable from the request graph.

### 4. `recent_reasons` comes from a real read

`src/diagnosis/reason-mix.ts`. `unmodelled_outage_regime` - the sharpest of the
four shipping rules - could not fire, because diagnosis 07 shipped the rule
against a *supplied* `ReasonMix` and nothing read one.

The recorded blocker was half stale. "`curtailment-by-reporting-entity` is not
filterable by subsystem" is true of the canonical *view*, which projects
`reporting_entity_kind` and not `subsystem`; the `reporting_entity` dimension
underneath it has carried `subsystem NOT NULL` since it was created, out of the
constrained-off files themselves. So this is a join to a dimension, not a change
to a published read: no column of the canonical view moves, nothing in
`contract/manifest.ts` changes, and no consumer of that read is affected.

Three decisions:

- **Cut at `actuals_cutoff`, not at the gate.** `recent_reasons` is an
  *observation* - `FIELD_PROVENANCE` says so - and every observation-sourced
  input here is filtered on
  `actuals_cutoff(target_date, gate_profile, 'restricao-coff')`, the gate minus
  a configured 40 h publication lag. Reading it at the gate would hand the rule
  ONS rows that had not been published when the forecast was made, and put a
  causally impossible annotation beside an attribution computed honestly.
- **A whole civil day or nothing.** The evening's reason mix is not the day's,
  and a partial day's shares look exactly like a complete one.
- **An absence stays an absence.** No qualifying day means the subsystem is
  *absent from the map*, `RuleContext.recent_reasons` is `None`, and the rule
  does not fire. Never a day of zero shares, which would make "nothing was
  restricted" and "we cannot see yet" the same input.

The read is performed by the job, on the worker's Postgres handle, and the
shares travel on the request - one producer per quantity, rather than a second
read of the same series at a second instant under a different vintage axis.
`wattsteer_ml.diagnosis.rule_context.reason_mixes_from_payload` is the other
side of the wire, and it *refuses* a malformed block rather than dropping it,
because a dropped mix is indistinguishable from an absent day and would turn a
bug into a rule that quietly stops firing.

The test is against real ONS-shaped rows in real Postgres and the sharp
assertion is the cutoff: the fixture puts a **newer** day one day past
`actuals_cutoff`, carrying nine times the energy and led by `CNF` rather than
`REL`, so a read at the gate would return a different day *and* a different top
reason and the rule would stop firing on a day it should fire on. Rewriting the
read to use `gate_at` instead fails three tests; restoring it passes all
fifteen. On the `apps/ml` side, the rule is shown firing from
`reason_mixes_from_payload`'s output on the gateway's own payload shape, with
`top_reason_share` exactly `0.6` off rows a reader can add up.

---

## What is still open, and why

**Two boxes, and neither is a judgement call.**

**1. The end-to-end job against the *real* modelling service.** Real Postgres:
done, and it is how everything above was verified - Postgres 17 in Docker,
`WATTSTEER_TEST_DATABASE_URL`, all 42 migrations applied. The real modelling
service: **not exercised, and measured to be unexercisable here.** `apps/ml` was
started against the same test database with an artifact directory of its own and
asked directly:

    POST /internal/publish/forecast   -> 503
      {"error":{"code":"MODEL_UNAVAILABLE",
                "message":"no artifact has been promoted in this lane",
                "details":{"lane":"dessem_free_v1__gate_late__thr5",
                           "lane_state":"no_artifact","volume_mounted":true}}}

and the existing gating, `WATTSTEER_TEST_ML_URL=http://localhost:8123`, fails
`the publication job end to end (real Postgres) > runs the queued task and
leaves the day readable at its gate` with `ProxiedError: The ML service answered
MODEL_UNAVAILABLE (HTTP 503)` - 13 pass, 1 fail. So the refusal path *is* now
exercised against the real service, which is worth something; the publication
path is not, and cannot be until a lane has a promoted artifact. There is no
`.joblib` and no `promotions.jsonl` anywhere in the repo, and minting one needs
a retrain over years of ingested ONS history. **What remains unverified is
precisely this: that a live `apps/ml` publication route returns a payload this
gateway's parser accepts and writes.** Every other link in that chain - the
schedule, the day resolution, the gate check, the transaction, the idempotence,
the refusal handling, the reads - is exercised against real Postgres with the
modelling service as a stub over a real socket.

**2. An unpublished publication raising something a human sees.** Untouched, and
still deliberately so. The spec carries the weakness by name and the mechanism
it needs - an alert on a publication instant passing with no new origin - has no
surface in this product to be raised on. `/v1/meta` and
`forecast_origin.age_hours` still make it *visible* and nothing makes it
*noticed*.

**And one sub-box this pass added rather than closed:** `apps/ml` serves no
`POST /internal/publish/diagnosis`. Probed directly: **404**. The worker's half
of the chain is built, tested and structurally sound, and until that route
exists the chain fires twice a day, gets a 404, names it as a missing route
rather than as a bad payload, and leaves the forecast serving with no
explanation beside it. It is blocked on a **cross-spec** dependency the lane
README already lists: the forecaster owes "the matched background sample (128
rows per subsystem × local-hour cell, stamped seed, in the artifact bundle)",
and `draw_matched_background` draws from rows the bundle does not carry, so
there is no `typical` for the route to measure against. Writing the route
against a seeded fixture would put an invented "typical" in a table whose whole
purpose is that nothing in it was invented.

`refresh-featured-days` is also still unbuilt, for the reason the original
section gave: the Replay shortlist cache does not exist. It is in the spec's job
table and in no checkbox, and it is named here so it is not lost.

## Verification, with numbers

Postgres 17 in Docker on 5434, Redis 7 on 6390, all migrations applied.

| Suite | Before | After |
|---|---|---|
| `apps/api` (`WATTSTEER_TEST_DATABASE_URL` set) | 1616 pass · 47 skip · 0 fail · 86 files | **1643 pass · 47 skip · 0 fail · 87 files** |
| `apps/ml` (`uv run pytest`) | 1650 passed · 90 skipped | **1657 passed · 90 skipped** |
| `packages/core` | — | 471 pass · 0 fail |
| `apps/web` | — | 189 pass · 0 fail |
| `test/` hygiene | — | 59 pass · 0 fail |
| `bun run typecheck` | — | clean |
| `bunx biome check` | — | clean (519 files) |
| `ruff check` · `ruff format --check` · `mypy` | — | clean (171 source files) |

Every guard added here was reintroduced-against, not just written:

- dropping `curtailment_forecast_hour_published_at_is_the_gate` and
  `diagnosis_attribution_published_at_is_the_gate` → 2 fail, 12 pass;
  restoring → 14 pass.
- dropping `diagnosis_attribution_the_rules_ran` and
  `diagnosis_attribution_flags_were_evaluated` → 2 fail, 18 pass;
  restoring → 20 pass.
- making `chainDiagnosis` a no-op and re-cutting the reason read at `gate_at`
  instead of `actuals_cutoff` → 6 fail, 9 pass; restoring → 15 pass.
- removing the Python roll-call defaults broke 30 tests across two files before
  the call sites were updated.

`test/drizzle-snapshot.test.ts` passes, so the two new snapshots describe the
schema `src/database/schema.ts` actually has: both migrations were produced by a
plain `bun run db:generate` and then hand-edited for the DDL drizzle-kit cannot
emit, per `apps/api/README.md`, and neither snapshot was touched.

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
the table.** ~~A CHECK calling the SQL `gate_at` would be stronger — it would
make a mis-stamped row unrepresentable rather than merely refused on the one path
that currently writes. It was not added because `apps/api/drizzle/` was held by
another agent this cycle.~~ **Closed** — `0041`. The reason it was open no
longer applied, and the constraint found one mis-stamped row in the existing
test suite on the way in.

- [ ] A publication that has not happened by some stated margin past its gate
      raises something a human sees, rather than only aging out in `/v1/meta`
- [x] `published_at == gate_at(target_date, gate_profile)` is a table constraint,
      not a publisher-side check
      — `drizzle/0041_the_gate_as_a_table_constraint.sql`, on all four tables that
      carry the three columns

---

## A third thing this ticket will own, from diagnosis 07

The rules valve is enforced four ways *inside* `apply_rules` — a rule is never
handed a number it could change, cannot return one, is held to that by an AST
walk, and the whole payload is compared byte-for-byte before and after. But
`AttributionRow.rule_flags` still defaults to `()`, so **nothing structurally
forces a publish path to run the rules at all**. A future job that assembles an
attribution row and skips `apply_rules` writes a valid, empty-flagged row and no
test notices.

That is the one place the valve is still a convention rather than a mechanism,
and it is here rather than in `diagnosis/` because the publish job is what would
skip it. Diagnosis 07 deliberately did not break ticket 06's tested signature to
fix it.

> **Closed** — the roll call. `AttributionRow` requires `rule_flags` *and*
> `rules_evaluated` with no defaults, so ticket 06's signature did have to
> break, and breaking it is what made the skipped path unconstructible rather
> than merely discouraged. See "The rules provably ran" below.

Also inherited: `unmodelled_outage_regime` cannot fire until a caller supplies
`recent_reasons`. The rule, its predicate and its facts are complete and tested
against a supplied `ReasonMix`; the read is not built, because
`curtailment-by-reporting-entity` is not filterable by subsystem and "the most
recent settled day's reason shares for this subsystem" is a new canonical read
that belongs with the job rather than under `diagnosis/`.

> **Closed** — `src/diagnosis/reason-mix.ts`, and the blocker was half stale:
> the *canonical view* projects no subsystem, but the `reporting_entity`
> dimension it reads from has always carried one. See "`recent_reasons` comes
> from a real read" below.

- [x] A publish path that assembles an attribution row without running the rules
      fails, rather than writing an empty-flagged row
      — the roll call, refused at three layers: `AttributionRow`'s constructor,
      the gateway's parse, and two table constraints in
      `drizzle/0042_the_roll_call_of_the_rules.sql`
- [x] `recent_reasons` is supplied from a real read, so
      `unmodelled_outage_regime` can fire
      — `apps/api/src/diagnosis/reason-mix.ts`, cut at `actuals_cutoff`, performed
      by the diagnosis publication job and carried on its request


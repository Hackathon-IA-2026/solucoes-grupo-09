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

> **Superseded.** The follow-up is built — `publication-watch`, a scheduled job
> in the idiom the repo already had three of. It does not replace the retry and
> it recovers nothing; it *asks*, twice a day at each gate plus two hours,
> whether the origin the gate promised is there, and its failing run is the
> alarm. See “The missed publication now raises something” below. The automatic
> recovery beyond the retry is still nothing, which is correct: a catch-up cron
> would be a second producer of the same publication.

**Blocked by:** cross-spec, **forecaster** — the artifact, the composition, the
path ensemble and the private publish route on the modelling service are its
work, and none of it is re-specified here. Also **data-platform 16** (in flight),
because the modelling service reads the canonical SQL views to build features.

**Status:** done (**one box open** — see “What is still open, and why”)

The count was four and is now one. Three were closed in the same wave by three
different hands: the missed-publication alarm, the null-headline pair's stated
absence, and — from the forecaster lane — the frozen matched background that
makes a published "typical" reproducible from the artifact. Each of those passes
reduced the count on its own branch without being able to see the others, so
each recorded a number that was already stale by the time it merged. This is the
count that holds after all three landed. A grep for `- [ ]` in this file returns
one, which is what the count is, and the one that remains needs a promoted
artifact rather than a decision.

The previous revision of this line also said “two boxes open”, and it was
wrong twice over: a grep at the time found **six** unticked, because the count
was written against the acceptance list at the top and nobody updated it when
the two sections below added two boxes each. Four of those six are now closed, one
sub-box was split out of a fifth and left open, and the two that remain are
named with exactly what is unverified. The count above is a count of unticked
boxes in this file, which is what it should always have been.

The previous revision of this paragraph read “**It is now three**, and the count
was re-grepped rather than decremented from memory” — true on the branch that
wrote it and stale by the time it merged, which is the defect api-surface 29
exists to end. What it recorded is kept, because the reasons are the record: the
null-headline box was closed there (option (a) — the wire learned to state an
absence), leaving the end-to-end run against a real promoted artifact, the frozen
background sample (forecaster 30), and the un-alerted missed publication. The
last two of those three have since landed as well, which is how three became
one.

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
      — real Postgres: yes. Real modelling service: **partly**. Both private
      routes are now probed against a live `apps/ml` under
      `WATTSTEER_TEST_ML_URL` and both answer a code in the closed enum; a
      live *publication* still needs a promoted artifact and there is none.
      See “What is still open, and why”
- [x] `apps/ml` serves `POST /internal/publish/diagnosis` — it does, and the
      route is not blocked on the forecaster's frozen background sample. See
      “The route, and why the block was the wrong diagnosis”
- [x] A published attribution's "typical" is reproducible from the artifact
      alone — **closed by forecaster 30**, merged in the same wave.
      `HurdleBundle.background` is a required, undefaulted `MatchedBackground`
      drawn once in `train_fold` under `BACKGROUND_SEED`, so every loadable
      bundle carries the rows its "typical" is averaged over, the publish path
      prefers them over a redraw, and the seed, row count and cell count are on
      the card. The publish-time draw survives as the labelled fallback, still
      stamped `base_fit`, and `background_source` is what tells the two apart.
      Ticked here rather than in the forecaster lane because this is the box
      that asked for it; forecaster 30 records the other half.
- [x] A driver group whose headline feature is NULL for the day can be
      published with the pair's absence stated, rather than refusing the whole
      day — **option (a)**, and the refusal is gone. `observed` and `typical`
      are each `number | null`, each with an `observed_absent_reason` /
      `typical_absent_reason` beside it from the closed set `null_in_day` /
      `null_in_background`; a value XOR a reason at the schema, the parse and
      the table. See “The gap the route found — closed”

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
| an unpublished publication raises something a human sees | yes | nothing, as it turned out. "An alerting surface this product does not have" was **half stale**: the product has none, but the *repo* has had one since `live-conformance.yml` — a scheduled job whose failing run is the alarm. Closed below |
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

**One box, and it is not a judgement call.** (This heading had outlived three
revisions of its own count before api-surface 29 corrected it. It was written
when there were two; the missed-publication alarm became a third and is now
closed; the null-headline box was a fourth, *was* a judgement call, and has since
been decided — option (a); and the frozen background sample landed with
forecaster 30. The one below is the first of the original two, unchanged, and it
waits on work in another lane rather than on a decision. This number is now
derived from this file's own `- [ ]` lines by `test/ticket-claims.ts`, so the next
revision that forgets it fails a test instead of outliving its count.)

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

~~**2. An unpublished publication raising something a human sees.** Untouched, and
still deliberately so. The spec carries the weakness by name and the mechanism
it needs - an alert on a publication instant passing with no new origin - has no
surface in this product to be raised on. `/v1/meta` and
`forecast_origin.age_hours` still make it *visible* and nothing makes it
*noticed*.~~

**Closed.** The recorded reason was that the mechanism "has no surface in this
product to be raised on", and that is true and was the wrong place to look: the
surface is not in the product, it is in `.github/workflows/`, where three
scheduled jobs already exist for exactly this class of question. See “The
missed publication now raises something”.

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

> **The last sentence is right and the conclusion drawn from it was wrong.** A
> seeded *fixture* would indeed be an invented "typical". But the frozen sample
> is not the only honest source of one — see the section below. The route is
> built.

`refresh-featured-days` is also still unbuilt, for the reason the original
section gave: the Replay shortlist cache does not exist. It is in the spec's job
table and in no checkbox, and it is named here so it is not lost.

---

## The route, and why the block was the wrong diagnosis

`apps/ml` serves `POST /internal/publish/diagnosis`. The 404 is gone; the
chain's other end exists.

**What the block actually said.** The recorded reason was: the forecaster owes
a matched background sample frozen in the artifact bundle, the bundle does not
carry one, therefore there is no `typical`, therefore writing the route "against
a seeded fixture would put an invented 'typical' in the table". Every clause is
true except the middle inference. Checked, one at a time:

| Claim | Verified how | Verdict |
|---|---|---|
| The bundle carries no frozen sample | `HurdleBundle`'s field list; `grep -n background training/bundle.py` returns nothing | **true** |
| A forecaster ticket owns it | `grep -r "matched background" .scratch/forecaster/` returns nothing | **false** — no ticket existed. Written now as **forecaster 30** |
| There is therefore no `typical` | `background.py`'s own docstring: "Until the forecaster's bundle carries one, this module draws the same shape from a block, stamping the seed and the row count it used; `source` records which of the two it is" | **false** |
| A fixture-drawn background would be invisible once stored | `AttributionRow.as_row()` emits `background_source`; `parseAttributionPublication` reads it; `diagnosis_attribution` stores it | **true, and it is why the field exists** |

`MatchedBackground.source` has two members — `artifact` and `base_fit` — and
`BASE_FIT_SOURCE` was put there for exactly this interim.
`diagnosis/publication.py` says so in as many words: "the matched background
this ticket's dependency draws is a seeded sample from the base-fit block, and
the artifact's frozen sample has not landed. A row that does not say which of
the two defined its 'typical' cannot be told apart from one measured against the
other." The design had already decided that a base-fit draw is a legitimate,
*labelled* answer. The previous pass read "not in the bundle" as "not
available", which conflated a fixture with the real base-fit rows.

**So the route draws it, from real ingested data.**
`wattsteer_ml/diagnosis/publish.py`:

- the base-fit window comes off the promoted artifact's **own card**
  (`data.base_fit_window`) — read, never derived, because the fold calendar plus
  a run window would be a second answer;
- the rows come back from `feature_rows(...)` under the lane's own gate
  profile, feature set and threshold — the days the boosters were fitted on;
- `draw_matched_background` partitions before it draws and refuses a cell short
  of 128 rows rather than drawing with replacement, so a short window is a
  refusal and never a thinner "typical";
- every published row carries `background_source: base_fit`, its seed and its
  row count, so a row measured this way is *distinguishable* from one measured
  against the frozen sample the spec asks for;
- the seed is `blake2b(artifact_id)` and not a clock, so two publications of one
  day under one artifact draw the same sample and the gateway's digest
  idempotence survives a redelivery. A retrain is a new id and therefore a new
  draw, which is correct: the window moved.

What is genuinely weaker than the spec's ask — reproducibility from the artifact
*alone*, a ~17,000-row read twice a day per lane, and a value drift the contract
hash cannot see — is **forecaster 30**, written by this pass, with the box above.

**Refusals, five, each with its own repair and each proved to fire** — plus the
positive case beside it, because a guard that cannot be made to pass proves
nothing. `REFUSAL_CONDITIONS` is a closed tuple and a test asserts the set:

| Condition | Answer | Repair |
|---|---|---|
| lane name is not one | 422 `REQUEST_INVALID` | the caller |
| malformed `recent_reasons` | 422 `REQUEST_INVALID` | the caller. Refused rather than dropped: a dropped mix is indistinguishable from an absent day |
| nothing promoted | 503 `MODEL_UNAVAILABLE` + `lane_state` + `volume_mounted` | a promotion, or the mount |
| no database | 503 `DATA_UNAVAILABLE` | the deployment |
| no feature rows for the day | 404 `FORECAST_UNAVAILABLE` | the forecast's, not this one's |
| `no_base_fit_window` | 404 `DIAGNOSIS_UNAVAILABLE` + `condition` | a card that dates its own fit |
| `no_matched_background` | as above | forecaster 30, or a longer run window |
| `contract_and_groups_disagree` | as above | a line in `driver_groups.yaml` |
| `incomplete_day` | as above | the feature function |
| ~~`null_headline_feature`~~ | ~~as above~~ | **no longer a refusal** — the row states the absence. See “The gap the route found — closed” |

Every code is in `packages/core`'s closed enum, so `mapUpstreamFailure` admits
it rather than flattening it to `UPSTREAM_REJECTED`. No code was added or
removed from that enum by any of this; `REFUSAL_CONDITIONS` lost a member and
is four.

**The roll call.** This route reaches `AttributionRow` through
`RuleOutcome.for_row()` and an AST test asserts it never spells `rule_flags` or
`rules_evaluated` itself — so the one publish path cannot hand over a roll call
it made up, on top of the three layers that already refuse an empty one.

## The gap the route found — closed

> **Closed, as option (a): the wire learned to state an absence.** The section
> below is the diagnosis as it stood, kept verbatim because the measurement in
> it is the evidence the decision was made on. What changed is at the end, under
> “The contract, decided”.

**A driver group whose headline feature is NULL has no publishable
observed/typical pair, and the wire has no way to say so.**

`DriverReading` refuses a non-finite `observed` or `typical`, and the gateway's
`parseDriver` reads both through `num()` on every one of the sixteen rows. But
three of the eight real headline features are in the weather block —
`weather_expected_wind_mwh`, `weather_expected_vre_ramp_1h`,
`weather_centroid_coverage` — and that block arrives from one run and goes NULL
together. A day whose weather run did not land therefore has no pair for those
bars, at either grain.

The design *knows* this happens: `RuleContext.null_headline_features` exists for
exactly it and `stale_inputs` can withhold the narration over it. What is
missing is a representation for the pair's absence — the field is a required
number and there is no `observed_absent_reason` beside it — so the intended
outcome, publish the ranking and flag the degradation, is not expressible.

Found by running the assembly rather than by reading: the first pass at the
happy-path test failed with `'weather_temperature_2m' reports typical nan`.

**And it is not a corner case — that was measured too.** The pair is
unavailable if the headline feature is NULL *anywhere* in the day or in its
background cells, and a background is 128 rows per cell drawn over months of
days. At the feature fixture's own 5%-per-day weather-null rate — which is
there because a NULL feature is the case the no-imputation rule exists for — a
window of base-fit length contains gaps with near-certainty. The scale run at
the spec's 128 had to be given a gap-free window to complete at all;
`test_a_realistic_window_refuses_because_the_weather_block_has_gaps` is the
same fact asserted rather than worked around. So on real ONS history, a
base-fit-drawn attribution refuses on most windows.

Until the contract can say it, the route **refuses the day**, typed, naming the
features. The two alternatives are both invisible once stored: a zero is the
invented number the whole spec is against, and a mean over the hours that
happened to carry a reading is a *different* "typical" than the one `v(∅)` was
averaged over, published under the same name. Closing it is a wire-contract
change across both languages and the table — an `observed_absent_reason` beside
the pair, or a nullable pair the renderer states — which is a ticket and not a
line; the box is above.

**A typed refusal is still strictly better than the 404 it replaces.** The
chain now gets `DIAGNOSIS_UNAVAILABLE` with `details.condition:
null_headline_feature` and the three feature names, which says what is missing
and where to fix it, instead of `UPSTREAM_REJECTED` on a body with no code that
reads like a wrong base URL.

### The contract, decided

**Option (a).** The refusal was not a corner case, it was the normal case, and
the number is now exact rather than “near-certainty”. Counted over a year of
`feature_row_fixtures.feature_rows` at its own default 5% weather-null rate:

| Quantity | Measured |
|---|---|
| NULL rows (`weather_expected_wind_mwh`) | 1,770 of 35,040 — **5.05%** |
| Subsystem-days with ≥1 NULL weather hour | 1,048 of 1,460 — **71.8%** |
| Calendar days with one somewhere | 362 of 365 — **99.2%** |
| P(one 128-row background cell gap-free) | `0.9495^128` ≈ **0.0013** |
| P(all 24 day-grain cells gap-free) | ≈ **7e-70** |

So the old contract refused ~99% of days on the `observed` side alone, and
effectively every day once the background was drawn at the spec's 128 rows per
cell. Weighed against that: the pair is a **subtitle** under a bar whose `φ`,
sign, share and rank the boosters compute *with* the NULL in the matrix — which
is why `attribute_day` was already succeeding before the refusal fired, one line
later in `build_diagnosis_publication`. Refusing eight bars, two grains and four
subsystems because one bar lost its caption was a large cost for a small gap,
and the explain screen's reader loses the whole day's attribution rather than
one line of it.

**And forecaster 30 raises the cost of the alternative by an order of
magnitude.** `fc-30-frozen-background` (`f97e678`, unmerged at the time of
writing, and this branch is *not* rebased onto it) makes
`HurdleBundle.background` a required field: `B(s, h)` is drawn once inside
`train_fold` from the base-fit block and frozen into the joblib. The frozen
sample is drawn from a **real** base-fit window, so a lane whose window held
any weather gap freezes a NULL — and under the old contract that artifact
refuses **every** publication for its whole life, not merely the days that had
gaps. Freezing did not create the defect; it moved discovery from publish time
to retrain time and widened the blast radius from one day to one artifact.

That is not a projection. That agent's own `loaded` fixture had to *redraw* a
null-free background rather than use `trained.bundle`'s, and said why: "the
shared fixture fold is generated at the harness's own 5% weather-null rate, so
its frozen background contains NULL headline features and every publication
from it is a `null_headline_feature` refusal". A ticket having to synthesise a
clean artifact in order to test the happy path is the clearest possible reading
on option (b)'s cost. With the absence stated, that artifact publishes — its
weather bars carrying `typical_absent_reason: null_in_background` — and the
workaround stops being load-bearing.

**The representation works on both background paths, and does not collapse
their distinction.** `_reading` is handed a pooled column out of whichever
`MatchedBackground` `_background()` returned, and it never reads
`MatchedBackground.source`; `background_source` (`artifact` vs `base_fit`) is
copied onto the row by `build_attribution_publication` and is untouched here.
Asserted rather than reasoned:
`test_an_absent_reading_does_not_depend_on_where_the_background_came_from`
holes one cell of one headline column and runs `headline_readings` twice, once
under each label, and requires the same `null_in_background` and the same
untouched `source` both times — because a reading's absence must never be
readable as a claim about provenance, or an operator chases the wrong repair.

**What lands where when the two branches meet.** Both touch
`diagnosis/publish.py` and `tests/test_diagnosis_publication_route.py`. The
resolutions are decided, not discovered:

- `DiagnosisPublicationRefusedError`'s docstring — fc-30 rewrites the
  `no_matched_background` bullet, this branch deletes the
  `null_headline_feature` bullet. Take both.
- `build_diagnosis_publication` and `_background` — fc-30 rewrites
  `_background` (frozen sample first, redraw kept and labelled); this branch
  deletes the `null_headlines` call above it and `_null_headline_features`
  below it. Disjoint edits on adjacent lines; take both.
- `test_a_realistic_window_refuses_because_the_weather_block_has_gaps` — fc-30
  re-points it at its `pre_thirty` fixture; this branch renames it to
  `…_publishes_where_it_used_to_refuse` and inverts the assertion. **This
  branch wins**, and the merged test should run over the *frozen* sample as
  well, because that is now the path where the gap lives.
- fc-30's `loaded` fixture can stop redrawing a null-free background, and
  should, since the reason it redraws is closed here.

**What the previous agent got right and this change keeps.** No `nanmean`, no
zero. `_reading` refuses to average over the values that happened to be there,
and says why in its docstring: `v(∅)` was averaged over **all** the background
rows, NULLs included, so a mean over the non-NULL ones is a different “typical”
under the same name.

**What moved, and it moved together:**

| Layer | Change |
|---|---|
| `apps/ml` `DriverReading` | `observed`/`typical` are `float | None` with `observed_absent_reason` / `typical_absent_reason`; a value XOR a reason, non-finite still refused |
| `apps/ml` `headline_readings` | `_reading()` returns the mean or `(None, reason)`; day and peak, each side its own |
| `apps/ml` `publish.py` | the `null_headline_feature` branch and `_null_headline_features` are gone; `REFUSAL_CONDITIONS` is four |
| Payload | both reason keys always travel, `None` included |
| `packages/core/schema/diagnosis.schema.json` | nullable pair, new `driver_reading_absence` enum, two required reason fields, and an `if`/`then`/`else` per half — the `coverage_absent_reason` pattern from `model-card.schema.json`, verbatim |
| `types.generated.ts` | regenerated: `DriverReadingAbsence`, and `WIRE_SHAPES.Driver` gained the two keys |
| Gateway `parseDriver` | `parseReading()` — refuses a `null` with no reason, a number beside one, an unknown reason, and an omitted field |
| Digest | the absence and its reason are in `attributionDigest`, so `null` and `0` hash differently |
| Table | `0043_a_reading_or_its_stated_absence.sql`: the two columns nullable, two `text` reason columns, two CHECKs, view recreated |
| Narration | `driver_raises_no_reading` / `driver_lowers_no_reading` in both locales, and `driverClause` picks the key rather than putting a `null` in a placeholder |
| Fixtures | the spec fences in `api-surface.md` and `diagnosis.md`, `05-…`, `07-…`, and the cross-language vector `apps/api/test/fixtures/diagnosis/attribution.json` |
| Specs | `diagnosis.md` and `api-surface.md` both state the contract, the two reason codes, and the measurement above |

**The display half needed nothing, which is the tell that (a) was the intended
design.** `packages/core`'s `DriverReading` already had `{ kind: "none" }` with
the comment “a group with no reading at serve time reads as `none`, and the pair
line is omitted rather than printed empty”; `formatReading` already returns
`null` for it and `driver-bars.tsx` already omits the line. The wire and the
table were the only layers that could not say what the domain model already
said.

**Non-vacuity, each measured rather than argued:**

- **`DriverReading`'s guard fails in four ways** and passes in two:
  `test_a_reading_is_a_number_or_a_stated_absence_and_never_both` produces a
  number beside a reason (`never both`), a `None` with none (`never neither`),
  an invented reason (`not one of`) and a NaN, and asserts the ordinary reading
  and the honest absence both construct.
- **The assembly publishes where it refused.**
  `test_a_null_headline_feature_publishes_the_bar_with_a_stated_absence` runs
  the real map over a day with `weather_null_rate=1.0`: four subsystems, sixteen
  bars each grain, shares summing to 1, and every absent half carrying a reason
  — with the assertion that no bar reports a zero or a NaN where a reading is
  absent.
- **The realistic window.**
  `test_a_realistic_window_publishes_where_it_used_to_refuse` is the renamed
  refusal test: it still asserts `gaps > 0` *before* publishing, so it cannot
  pass on a gap-free window, and it asserts the absences are
  `null_in_background` while the day's own side is intact.
- **The gateway parse** has seven tests, four of them refusals with the
  positive case beside them, plus `digests an absent reading differently from a
  zero` — and differently again for a different reason.
- **Both table CHECKs fire, by name.** Against Postgres 17 on **5439** (my own
  container; `fc18-pg` on 5434 was left alone):
  `diagnosis_attribution_driver_observed_or_its_absence` and
  `…_typical_or_its_absence`, each proved on both bad shapes, with the honest
  absence and the ordinary reading both landing. The read path is asserted to
  come back as `null` and not as `Number(null) === 0`.
- **The narration-cache digest moved on purpose**, from `593294f6…` to
  `406b3760…`, and the comment above it says why invalidating every cached
  paragraph is what we meant: a paragraph written before the document could say
  “this group has no reading” was written against a document that refused to
  exist in that case.

**What this does *not* claim.** `stale_inputs` still fires off the *day* side
only (`RuleContext.null_headline_features` is unchanged), so a background-only
absence is stated on the row and not in the narration's flag list. That is the
existing, tested meaning of “no headline reading at serve time” and it was left
alone deliberately.

## One stale comment found in passing

`test_day_attribution.py`'s scale test and `test_grouped_shapley.py` both build
a synthetic eight-group map because "the real map's eight groups do not all have
a column in [the fixture] contract". That is no longer true — the real
`DRIVER_GROUP_MAP` partitions all 100 fixture columns, 3–30 per group — and the
new route's tests run the real map, which is the route's own default. The two
older files are left alone: their synthetic maps are small on purpose, which is
a separate reason for having them.

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

### The route pass, with its own numbers

| Suite | Before | After |
|---|---|---|
| `apps/ml` (`uv run pytest`) | 1666 passed · 91 skipped | **1687 passed · 91 skipped** |
| `bun run check` (typecheck · biome · every JS suite) | clean | **clean, exit 0** — 524 files, 1233+471+107+189 pass, 0 fail |
| `apps/api` with `WATTSTEER_TEST_DATABASE_URL` | — | `diagnosis-publication-job` **15 pass · 1 skip · 0 fail** on its own. A whole-suite run on the shared container shows 8 timeouts across four files (`ingest`, `database-weather`, `ml-boundary`, this one); each of those files passes alone, so they are contention on a container this session does not own, not this change |
| `apps/ml` scale run (`WATTSTEER_SCALE_TESTS=1`) | — | the publication at the spec's 128 rows per cell, four subsystems: **35.1 s**, inside the gateway's 120 s `PUBLISH_DIAGNOSIS_TIMEOUT_MS` |

Non-vacuity, each measured rather than argued:

- **The route's existence.** A stand-in answering FastAPI's own
  `{"detail": "Not Found"}` on port 8124 fails
  `answers with a code in the closed enum, never a bare 404` on
  `expect(body.detail).toBeUndefined()` — 0 pass, 1 fail. A live `apps/ml` on
  8123 passes it, answering `MODEL_UNAVAILABLE` with
  `lane_state: no_artifact`, `volume_mounted: false`. So the new test measures
  the change and not the weather.
- **The short-window refusal.** Asserted with the day count of the block it
  refused (30 days, and 30 < 128) *before* the refusal, and with the same call
  at a sample the window can supply publishing successfully after it.
- **All five refusal conditions** are produced by a test, and
  `REFUSAL_CONDITIONS` is asserted to be exactly that set — so a sixth branch
  without a test fails. **Since the null-headline box closed there are four**,
  and the census test is the same shape: the removed condition had to leave the
  tuple *and* the assertion together, which is why deleting the branch failed
  three tests before any of them was touched.
- **The roll call** is asserted off the AST: every `AttributionRow(...)` in the
  publish module passes `**outcome.for_row()` and names neither `rule_flags`
  nor `rules_evaluated` itself.

### The null-headline pass, with its own numbers

Postgres 17 in Docker on **5439** — my own container, `fc18-pg-api10`; the
shared one on 5434 was not touched. All **43** migrations applied.

| Suite | Before | After |
|---|---|---|
| `bun run check` (typecheck · biome · every JS suite) | clean, exit 0 — 145+471+1237+189 pass, 542 skip, 0 fail | **clean, exit 0** — 526 files, 145+471+**1244**+189 pass, 544 skip, 0 fail |
| `bun run ml:test` | 1703 passed · 93 skipped | **1705 passed · 93 skipped** |
| `bun run ml:lint` · `ml:typecheck` | — | clean — 176 files formatted, mypy clean on 175 source files |
| `apps/api` whole suite with `WATTSTEER_TEST_DATABASE_URL` (5439) | — | **1658 pass · 48 skip · 0 fail**, no timeouts on a container this session owns |
| `apps/api/test/database-diagnosis.test.ts` alone | 20 pass | **22 pass · 0 fail** — the two new ones are the absence round trip and the CHECKs |
| `test/drizzle-snapshot.test.ts` | pass | **pass** — `0043` was a plain `bun run db:generate`, only the file name and the header prose were hand-written; the snapshot was not touched |

The `+7` on `apps/api` in `bun run check` is the parser's absence tests; the
`+2` on skip is the two new DB tests, which skip without the URL. `apps/ml`'s
`+1` is three tests replaced by two plus one new guard test.

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
which the spec also flags as **un-alerted**. ~~Nothing pages when a publication
silently stops happening.~~ **Something does now** — `publication-watch`, below.
The retry budget is still what it was; what changed is that its exhaustion
stops being silent two hours later.

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

- [x] A publication that has not happened by some stated margin past its gate
      raises something a human sees, rather than only aging out in `/v1/meta`
      — `publication-watch`: `apps/api/src/forecast/publication-watch.ts`,
      `apps/api/test/publication-watch.test.ts`,
      `.github/workflows/publication-watch.yml`. The margin is two hours and it
      is bounded rather than asserted; the alarm is a failing scheduled run;
      and an empty database says "never published" rather than "late". Shown
      firing on a genuinely late publication and staying quiet on a healthy
      one, both against real Postgres. See "The missed publication now raises
      something"
- [x] `published_at == gate_at(target_date, gate_profile)` is a table constraint,
      not a publisher-side check
      — `drizzle/0041_the_gate_as_a_table_constraint.sql`, on all four tables that
      carry the three columns

---

## The missed publication now raises something

`docs/specs/api-surface.md` ranks this first among the places it is weakest: if
both gates fail the product serves yesterday's forecast with an honest age,
"and nobody is paged, because there is no paging". Every previous pass on this
ticket recorded the box as open with the same reason — *there is no alerting
surface in this product*.

**That reason was half stale, and the stale half is the important one.** The
*product* has no alerting surface, and it should not get one for this: a page,
a webhook or a notification channel is a whole subsystem, and `api-surface.md`
section "Out of scope" has already ruled out push-shaped mechanisms on this
spec. But the **repo** has had an alerting surface since `live-conformance.yml`:
a scheduled workflow whose failing run *is* the alarm. There are three of them —
`live-conformance.yml`, `narration-live.yml`, `publication-lag-conformance.yml`
— each `schedule` + `workflow_dispatch`, each carrying an explicit "Never on
push", each existing to answer a question about the **world** rather than about
a commit. A missed publication is precisely that shape of question: nothing
broke in the code that ran; reality diverged from what the system promised.

So this is the fourth one, and it invents nothing:
`.github/workflows/publication-watch.yml` runs `bun run test:publication-watch`
against the deployment's own Postgres and reports through the same `Claim` /
`assertClaim` / `measuring` / `publish` vocabulary out of
`test/support/conformance.ts` that the other two gated suites share.

### The margin: two hours, bounded rather than asserted

`PUBLICATION_GRACE_MS`, stated once in
`apps/api/src/forecast/publication-watch.ts`. It is **not** derived from
anything, because there is nothing to derive it from — it is the answer to "how
long would you let a publication be missing before you want to be told". What
*is* derived is the pair of bounds that keep it honest, and both are computed by
the test rather than written down:

- **Above the whole automatic-recovery window.** Nothing recovers a publication
  after the queue gives up, and the window is computable end to end: the job's
  offset past its gate (`FORECAST_PUBLICATIONS`' crons measured against
  `GATES`, = 10 min), `config.jobAttempts` attempts each bounded by
  `PUBLISH_TIMEOUT_MS`, and the exponential `config.jobBackoffMs` waits between
  them. **Measured at 16.25 min.** Below that bound the alarm would be
  reporting a job that is still allowed to be running.
- **Below the shortest interval between two consecutive gates**, computed off
  `GATES` — **10 h**. At or above it, a missed *early* publication would be
  masked by the late one that supersedes it, which is the exact failure this
  exists to catch: the day quietly served by an older vintage.

Two hours is an order of magnitude above the first and a fifth of the way to
the second. Move a gate hour, a cron, `jobAttempts` or the publish timeout and
the bound that stops holding fails a test — which is the point of computing
them. Verified by reintroduction: `11 h` fails the second bound (and four other
cases), `5 min` fails the first.

**Not one gate hour is restated anywhere in this work.** The watch knows a
profile and a date and asks `gateAt(targetDate, profile)`, which is
`forecast/gate.ts` — the same call the publisher makes and the same function
`drizzle/0041`'s CHECK calls in SQL. The module says why: `gate.ts` already
records that the two hours are spelled three times and that a fourth is worth
avoiding, and this repo has already found five places where a gate interval was
stated wrongly.

**The workflow's two crons are the one place a literal hour was unavoidable** —
YAML cannot call a function — so they are held against the derivation rather
than trusted. `publication-watch.test.ts` section "the schedule" computes each
cron from `GATES` plus the margin, reads
`.github/workflows/publication-watch.yml`, and asserts the sets are equal. It
also computes each cron in January *and* July and requires them to agree, so
Brazil reinstating summer time fails a test instead of quietly moving the watch
an hour off its gate. Non-vacuity: changing one cron from `0 14` to `0 15`
fails that test — 11 pass, 1 fail.

### Three verdicts, because two would have been switched off in a week

The database has **zero ingested rows today**. A two-state alarm — "the last
gate has an origin, or it does not" — would therefore fire continuously from
now until the first artifact is promoted, and an alarm that always fires is an
alarm someone disables. So the census is read *beside* the origins, in one
read-only transaction at one `as_of` so the two halves cannot describe
different instants of the table:

| Verdict | When | What the run does |
|---|---|---|
| `never_published` | no `served` day row exists anywhere, at any gate, for any date | **passes**, printing `NOT YET LIVE` with the gate it is waiting for. "We have never had data" is a true and *different* sentence from "we stopped having data" |
| `late` | the deployment has published before, and the most recent gate whose margin has elapsed has no origin | **fails** — this is the alarm |
| `published` | that gate has an origin stamped at exactly the gate instant | passes, printing the numbers |

The discriminator is the table's own census and deliberately **not** a
configured go-live date: a date is maintained by hand, and the day it is wrong
is the day the alarm is either silent or screaming.

Three further decisions:

- **The match is on the (target date, gate profile) pair, not the date.** The
  early publication for tomorrow existing does not satisfy the late gate; a
  watch keyed on the date alone would report the day as covered by a vintage
  ten hours older than the one owed. Asserted as its own case.
- **The match requires `published_at == gateAt(...)`.** After `0041` a
  mis-stamped row is unrepresentable, so this is not a second enforcement of
  that constraint — it is what makes "we found the right row" different from
  "we found a row".
- **A read whose two halves disagree draws no verdict at all.** A census of
  zero beside a non-empty origin list is a broken read, and it throws rather
  than resolving to `never_published` — that resolution is the one way an empty
  answer could pass as a healthy one, and it would be the alarm's own off
  switch. Asserted.

**Missing configuration is not silence either.** With no
`WATTSTEER_WATCH_DATABASE_URL` the run reports `SOURCE UNREACHABLE — the
deployment's Postgres` and fails, because a watch that did not look is not a
watch that saw nothing wrong. Measured.

### Proved firing, proved quiet, proved non-empty

Postgres 17 in Docker on **5436** (5434 was held by another agent's backfill),
all migrations applied. The alarm was run end to end through the workflow's own
command, `bun run test:publication-watch`, against that database in three
states, each seeded by writing a real publication through `writePublication`
with `published_at` supplied by `gateAt` — so the fixture passes `0041`'s CHECK
rather than working around it:

| State of the database | Verdict | The run |
|---|---|---|
| empty | `never_published` | **passes**, 13 pass · 0 fail, printing `NOT YET LIVE`, `served rows: 0` |
| one publication, for the *previous* day's late gate only | `late` | **fails** — `ASSUMPTION EXPIRED`, naming the gate, `3.7 h past the margin`, the older vintage that is being served and its age, and the four reads that render it |
| one publication, at the due gate | `published` | **passes**, printing the gate instant and the subsystem it covers |

The middle row is the whole point: the alarm can be made to fire on a genuinely
late publication, and the third row is why the first two mean something — the
same guard, unchanged, goes quiet when the publication is there.

**The inputs are asserted non-empty, three times.** In the real-Postgres
section, every verdict is drawn only after `readPublicationWatch`'s two halves
are asserted directly: the empty case asserts `servedDayRows === 0` **and**
`origins === []` before concluding "never published", so that conclusion is a
measurement rather than a query that failed; the quiet case asserts
`servedDayRows === 1` and one origin *before* the `published` verdict; and the
firing case asserts the same two before the `late` verdict, so "late" is a
verdict that matched nothing among rows that came back rather than a query that
returned nothing. The schedule test asserts the workflow file has as many crons
as there are gates before comparing them, and the recovery-window bound is
asserted to exceed the attempts' own timeouts before the margin is compared to
it — so neither is cleared by a zero.

### Verification, with numbers

| Suite | Result |
|---|---|
| `bun run check` (typecheck · biome · every JS suite) | **clean, exit 0** — 528 files linted; 145 hygiene · 471 core · 1249 api · 189 web pass, **0 fail** |
| `apps/api` with `WATTSTEER_TEST_DATABASE_URL` (5436) | **1664 pass · 49 skip · 0 fail · 88 files** (was 1643 · 47 · 0 · 87) |
| `test/publication-watch.test.ts` alone, offline | 12 pass · 5 skip · 0 fail |
| the same, with real Postgres | 15 pass · 1 skip · 0 fail |
| the same, as the workflow runs it | see the three-state table above |

Reintroduced against, rather than only written:

- workflow cron `0 14` changed to `0 15`: **1 fail** (the schedule test), 11 pass.
- `PUBLICATION_GRACE_MS` at 11 h: **5 fail** (the gate-interval bound, the
  due-gate identity, the firing case, the same-day-other-gate case, the
  schedule), 7 pass.
- `PUBLICATION_GRACE_MS` at 5 min: **3 fail** (the recovery-window bound, the
  firing case, the schedule), 9 pass.
- restored: 12 pass · 0 fail.

### What this does not do

It does not recover anything, and no catch-up cron was added — that reasoning
is unchanged and is above: `writePublication` is idempotent by digest, so a
hand-run after the files land is free, and a *scheduled* catch-up would be a
second producer of one quantity. It does not notify anyone outside GitHub's own
failed-workflow notifications, which is the same reach the other three
scheduled suites have and is the honest ceiling of this idiom. And it watches
the **forecast** publication only: the chained `publish_diagnosis` has its own
way of having failed and `/v1/diagnosis/day-ahead` reports its absence as its
own, so a watch over it is a separate question and not this box.

> **Closed** — that last sentence was true for one wave. The chained half is now
> watched, behind the same two crons and in the same file, and the reasons the
> chain needed more than a copy of this section are in "The chained diagnosis
> publication is watched too" at the end of this ticket.


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


---

## The chained diagnosis publication is watched too

The gap the previous wave named in its own "What this does not do". The two
publications are chained: a finished `publish_forecast` submits a
`publish_diagnosis` carrying the day it wrote. So a forecast can publish
perfectly, the chained half can die, and the watch reports a healthy system —
which it is, for one grain. Demonstrated rather than asserted: in the run below
the forecast half printed `verdict: published` and the chained half failed the
workflow in the same run.

Same file (`src/forecast/publication-watch.ts`), same suite, **same two crons**.
No parallel mechanism and no second margin.

### The due time is not a gate hour, because it is not a gate

`publish_diagnosis` has no cron. The job table's trigger is "on completion of
each above", which is the one row that is not a pattern. So the instant it
becomes answerable for is measured from the forecast publication it chains off,
and the forecast rows already record that instant — `ingested_at` is the `AsOf`
axis, the wall clock at the write, as against `published_at`, which is the gate:

    dueAt = max(gateAt(target, profile) + PUBLICATION_GRACE_MS,
                forecast.ingested_at + diagnosisRecoveryWindowMs())

- `gateAt` is **called**, never restated. No hour appears anywhere on the
  chained path, in the ledger's DDL (`0044` calls `gate_at` in its CHECK, as
  `0041` does), or in the workflow's new comment.
- `diagnosisRecoveryWindowMs()` is derived from `config.jobAttempts`,
  `config.jobBackoffMs` and `PUBLISH_DIAGNOSIS_TIMEOUT_MS` — **6.25 min**
  measured. It has no cron-offset term, because a completion-triggered task has
  no offset: the offset is already inside `ingested_at`.
- The first term is why there is no third cron. The whole chain — the forecast
  job's offset and retries (**16.25 min**) then the diagnosis job's
  (**6.25 min**) = **22.50 min** — fits inside the **2 h** margin the two
  existing crons already wait, so a scheduled run reaches a verdict. That bound
  is a test, not a paragraph: had it stopped holding, every scheduled run would
  report `not_yet_due` and the alarm could never fire, which is worse than none.
- The second term is what makes it honest when the ordinary case does not hold:
  a forecast published five hours late by hand starts its chain five hours late,
  and a diagnosis is not owed before the forecast it explains. Asserted both
  ways — the ordinary case *equals* the margin, the hand-run case slides.

### Six verdicts, and only one of them alarms

| Verdict | When | The scheduled run |
|---|---|---|
| `forecast_absent` | the due gate has no served forecast publication | passes — nothing was owed; the forecast half is the alarm for that and this one must not double-report it |
| `published` | an attribution is stamped at the due gate's instant | passes, printing the subsystems and the forecast's commit instant |
| `not_yet_due` | the chain is still inside its own retry budget | passes — alarming here would alarm on a job still allowed to be running |
| `refused` | `apps/ml` **declared** a typed refusal, observed at or after the forecast committed | passes, printing the condition — a declared refusal is not a missed publication |
| `never_diagnosed` | the deployment holds no served attribution row at all | passes, printing `NOT YET LIVE` — this is today's real state |
| `late` | the forecast published, the budget ran out, and there is neither an attribution nor a fresh refusal | **fails** — this is the alarm |

### The refusal had to become a record — `drizzle/0044`

`apps/ml` can *correctly* decline an attribution with a condition out of its own
closed tuple (`no_base_fit_window`, `no_matched_background`,
`contract_and_groups_disagree`, `incomplete_day`; **not**
`null_headline_feature`, which stopped being a refusal this wave and is now a
stated absence on the driver row). That is the system working — the repair is a
retrain or a line of YAML — and an absent attribution looks identical in
Postgres whether it was refused or the chain died. The statement lived only in a
`console.warn`, so the two were indistinguishable to anything on a schedule, and
a watch that could not tell them apart would fire on correct behaviour twice a
day until somebody switched it off.

So `diagnosis_publication_refusal` is the ledger, written by the job
(`declareRefusal` in `src/jobs/diagnosis-publication.ts`, via
`src/diagnosis/refusal.ts`) and read by the watch. Six decisions:

- **Only a *declared* refusal is recorded** — `DIAGNOSIS_UNAVAILABLE` carrying
  one of the four conditions. `MODEL_UNAVAILABLE`, `DATA_UNAVAILABLE`,
  `SERVICE_BUSY`, a 404 with no code in it, or a condition this side has never
  heard of are the chain failing and must still reach the watch as the alarm
  they are. Recording anything wider would be the watch's own off switch. Each
  of those is asserted to write **nothing**.
- **`observed_at` against the forecast's `ingested_at` is the freshness test.**
  A refusal older than the forecast publication now serving is a statement about
  a previous vintage: the lane-day was refused yesterday, the forecast has since
  been re-published, and *that* chain left no statement at all. A watch keyed on
  "is there a refusal for this lane-day" would be silent for good. Its own case,
  and the one a mutation was reintroduced against.
- **One current answer per lane-day, upserted.** Each of the queue's attempts
  refuses again; three rows ten seconds apart are not three refusals. Asserted
  against real Postgres over three attempts, the last with a different
  condition.
- **`expected_published_at` carries `0041`'s constraint**, calling `gate_at`. A
  refusal about some other instant is a statement about a publication nobody can
  identify. Refused by Postgres, asserted.
- **The vocabulary is parsed out of `apps/ml`, not restated.** The test reads
  `REFUSAL_CONDITIONS` out of `wattsteer_ml/diagnosis/publish.py` and compares
  it to this side's list *and* to `0044`'s CHECK, and asserts
  `null_headline_feature` is absent from all three while still present in the
  Python source, as the removal it is. A fifth condition upstream lands as a
  failing test rather than as a refusal nothing could record.
- **A read whose halves disagree draws no verdict**, as in the forecast half: a
  census of zero beside rows for the gate throws, and so does an attribution
  standing on a forecast publication that is not there — `0041` makes the
  instant right and nothing makes the *pair* right.

### Proved firing, proved quiet three ways

Postgres 17 in Docker on **5439** — my own container. 5434 (`fc18-pg`) was
reserved for a bulk backfill, was never touched, and no suite in this ticket was
pointed at it. All 44 migrations applied. The alarm was run through the
workflow's own command, `bun run test:publication-watch`, against that database,
each state seeded by writing real publications through `writePublication` and
`writeAttributionPublication` with `published_at` from `gateAt`:

| State of the database | Chained verdict | The run |
|---|---|---|
| empty | `forecast_absent` | **passes**, exit 0 — `NOT YET LIVE`, `attributions: 0 rows`, and the forecast half says `never_published` |
| forecast at the due gate + an attribution for the *previous* day only | `late` | **fails**, exit 1 — `ASSUMPTION EXPIRED`, `5.4 h past the instant the chained publication became answerable for`, "the ledger holds no refusal for this lane-day at all" — *while the forecast half printed `verdict: published`* |
| the same rows, plus the refusal on the ledger | `refused` | **passes**, exit 0 — `no_matched_background at 2026-09-09T22:06:00.000Z`, naming the lane |
| the same rows, plus the attribution at the due gate | `published` | **passes**, exit 0 — `this gate covering NE` |

The second row is the whole point, and the two below it are what make it mean
something: the same guard, unchanged, goes quiet on a refusal the system
declared and on a chain that completed.

**The inputs are asserted non-empty.** In the real-Postgres section every
chained verdict is drawn only after `readDiagnosisWatch`'s four halves are
asserted directly: the empty case asserts `attributionRows === 0`,
`forecastIngestedAt === null`, no subsystems **and** an empty ledger before
concluding nothing was owed; the `never_diagnosed` case asserts the forecast's
commit instant *equals* the instant it was written with; the quiet case asserts
one attribution row and `["NE"]`; the firing case asserts a non-null commit
instant beside an empty subsystem list, so `late` is a verdict that matched
nothing among rows that came back; and the refused case asserts the ledger holds
exactly one row with the expected condition. The vocabulary tests assert the
Python scan found the tuple at all and found all of it before comparing, and the
constraint test asserts the same insert *is accepted* with a real condition at
the real gate, so the two refusals it demonstrates are the constraints rather
than a broken statement.

### Verification, with numbers

| Suite | Result |
|---|---|
| `bun run check` (typecheck · biome · every JS suite) | **clean, exit 0** — 529 files linted; 145 hygiene · 471 core · 1273 api · 189 web pass, **0 fail** |
| `apps/api` with `WATTSTEER_TEST_DATABASE_URL` (5439) | **1700 pass · 0 fail · 88 files**, 19.9 s |
| `test/publication-watch.test.ts` alone, offline | 29 pass · 14 skip · 0 fail |
| the same, with real Postgres | 39 pass · 2 skip · 0 fail |
| `test/diagnosis-publication-job.test.ts` with real Postgres | 18 pass · 1 skip · 0 fail |
| the same, as the workflow runs it | the four-state table above |

Reintroduced against, rather than only written:

- the freshness test dropped, so any refusal for the lane-day silences the
  watch: **1 fail** — "is not silenced by a refusal older than the forecast now
  serving".
- the `late` branch returning `published`, an alarm that cannot fire: **3 fail**
  — the firing case, the stale-refusal case and the verdict roll call.
- `null_headline_feature` added back to the TS condition list: **3 fail** — all
  three vocabulary tests, one against Python and one against the migration.
- `declareRefusal` removed from the job's catch: **1 fail** — "records the
  condition apps/ml declared, and still fails the job".
- `WATTSTEER_JOB_ATTEMPTS=10 WATTSTEER_JOB_BACKOFF_MS=120000`, a chain an hour
  wide against a two-hour margin: **9 fail**, including the forecast half's own
  recovery bound and "fits the whole chain inside the margin, so the scheduled
  run can fire at all".
- restored in every case: 29 pass · 0 fail offline, 39 · 0 with Postgres.

- [x] The chained `publish_diagnosis` is watched, in the same file and behind
      the same two crons — `src/forecast/publication-watch.ts`,
      `watchDiagnosisPublications`
- [x] Its due time is derived from the forecast publication it chains off, and
      no gate hour is restated on the path — `gateAt` is called, and the chain's
      budget comes off `config` and `PUBLISH_DIAGNOSIS_TIMEOUT_MS`
- [x] A refusal the system declared does not alarm, and is distinguished from
      "never ran" and from "should have run and did not" —
      `drizzle/0044_a_refusal_is_a_record.sql`, `src/diagnosis/refusal.ts`
- [x] The alarm is shown *firing* on a genuinely missed diagnosis publication
      and *quiet* on an empty database, a healthy chain and a correctly-refused
      publication — the four-state table above, through the workflow's own
      command
- [x] Every check's inputs are asserted non-empty before a verdict is drawn

### What this still does not do

It does not recover a missed diagnosis publication and no catch-up cron was
added, for the reason the forecast half has none: `writeAttributionPublication`
is idempotent by digest, so a hand-submitted task is free and a scheduled
catch-up would be a second producer of one quantity. It does not read
`apps/ml`: the refusal it trusts is the one the *job* recorded, so a refusal
declared by a service the worker never reached is not a refusal this watch can
see — and that failure correctly reads as `late`. It watches the one lane per
gate profile that `PUBLICATION_LANES` names; a second lane per gate would need
the verdict to say *which* lane is unexplained, and the ledger is keyed for that
(`lane` is in the primary key) while the verdict is not. And the reach is still
GitHub's own failed-workflow notification, the honest ceiling of this idiom.


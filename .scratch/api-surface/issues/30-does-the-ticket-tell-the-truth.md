# 30 — Does the ticket tell the truth: is the thing it built reachable?

**What to build:** the third question in the series 27 and 29 opened, and the
one with teeth. 27 established that a spec cannot be trusted to describe itself
and 29 that a ticket cannot be trusted to count itself. Neither asks whether the
thing a ticket says it built is ever **called**.

**The evidence that this was worth doing.** On 2026-09-10,
`.scratch/data-platform/issues/03-constrained-off-per-plant.md` carried
`**Status:** done` with **not one of its seven boxes ticked** — and the work was
not done. Its ingestor, parser and repository were merged and covered by forty
tests, and `createConstrainedOffDetailIngestor` appeared in **no** `IngestTask`
kind, **no** branch of `createIngestDispatcher` and **no** line of
`planRefresh`. `plant_detail_hour` was unfillable and
`canonical_curtailment_by_plant` was the one canonical read with a null go-live.
It was found by accident, while someone worked on something else — exactly how
api-surface 27's eighteen false spec claims were found. The detection was
trivial in hindsight: the constructor appeared only in its own module and in the
ingest barrel.

**The population, measured rather than assumed.** **92** tickets were `done`
with none of their checklist ticked and something still on it when this ticket
was written. `a93ff74` wired ticket 03 and ticked its boxes, so the live population
at the time of the sweep is **91** — the same set minus the one already found.
That shape is normally innocent: `.scratch/forecaster/issues/28-*.md` is `done`,
merged, and leaves its whole checklist unticked as written, which is this repo's
convention, and **the `Status:` line is the authority, not the boxes** (29's
central rule, and this ticket does not relitigate it). But one counterexample is
enough to make "all 92 are fine" an unsafe assumption, so all 91 were checked.

**Blocked by:** None. (api-surface 27 and 29 are the model, and are done.)

**Status:** done — four orphans found and their tickets corrected; the guard is
`test/reachability.ts` and `test/reachability.test.ts`.

- [x] Every one of the 91 is reported reachable, orphaned with evidence, or not
      applicable with the reason — the not-applicable ones **named**, which is
      the honest half and what 27 required
- [x] Every orphan says what it would take to wire it, and its ticket's
      `Status:` line is corrected where it was wrong
- [x] The corrections record what happened rather than deleting the history of
      what was found
- [x] The guard needs no human to keep a list in step — nothing it checks is an
      allow-list, and a module added tomorrow is governed the day it is written
- [x] The guard is proven to fail on drift **and** on empty input, with the
      empty case refused at the verdict rather than passing as `[] === []`
- [x] What is not mechanically checkable is named with the reason, including the
      three dispatch mechanisms that defeat a textual sweep

---

## The tally

| | count |
|---|---|
| **reachable** | 78 |
| **orphaned** | 4 |
| **not applicable** | 9 |
| | **91** |

### The four orphans

**`.scratch/forecaster/issues/11-second-planning-arm.md`.**
`apps/ml/src/wattsteer_ml/evaluation/planning_arms.py` is merged and covered by
`apps/ml/tests/test_second_planning_arm.py`. `grep -rn "planning_arms"` over
`retrain.py`, `app.py` and `__main__.py` returns **nothing**: the only non-test
reference in the whole package is a docstring cross-reference in
`dessem_ab_run.py`. The third box — both arms "published per fold in the card,
side by side" — cannot be true through any run. **Wiring:** one call to
`measure_planning_arms` in `retrain_lane`, beside `run_ladder` at
`retrain.py:603`; `record_planning_arms` already writes the block.

**`.scratch/forecaster/issues/17-threshold-sweep.md`.** Sharper: `grep -rn
"run_threshold_sweep" apps/ml` finds the `def` at `threshold_sweep.py:909`, its
own `__all__`, and one docstring in `dessem_ab.py` — **no caller at all, not
even a test**. `record_threshold_sweep` is reached only by
`apps/ml/tests/test_threshold_sweep.py`. Neither `retrain.py` nor `app.py`
mentions the module. The first, third and fourth boxes describe sweeps that have
never run. **Wiring:** nothing to wire — the sweep is a one-off evaluation over
three lanes, and what is missing is the *run*.

**`.scratch/replay/issues/07-featured-days-not-a-highlight-reel.md`.**
`POST /internal/replay/featured-days` (`apps/ml/src/wattsteer_ml/app.py:1847`)
exists and is tested; nothing calls it. There is no member of `WorkerTask`
(`apps/api/src/jobs/worker-tasks.ts:58-61` — `publish_forecast`,
`publish_diagnosis`, `retrain`, `holdout_backfill`), no schedule in
`apps/api/src/worker.ts`, and no cron in `railway.json`,
`apps/ml/railway.json`, `docker-compose.yml` or `.github/workflows/`. The
design is explicit that the list is *"computed nightly and never on the request
path"*, so the process-local cache starts empty and stays empty and
`GET /v1/replay/days` permanently serves the `pending` payload.

**`.scratch/replay/issues/08-backtest-aggregate.md`.** The same omission in the
same module: `POST /internal/replay/backtest` (`app.py:2007`) has no caller
outside its tests, so `backtest_cache` is never filled and `GET /v1/backtest`
serves `pending` forever. **Wiring, for both:** one `WorkerTask` kind, one
branch beside `worker-tasks.ts:139`, one schedule entry beside
`holdoutBackfillScheduleForQueue()` in `worker.ts`, fanned out per subsystem and
lane — the shape `holdout_backfill` already has.

`docs/specs/api-surface.md:323` lists `refresh-featured-days | 30 3 * * *` in
its scheduled-jobs table and `:467` records `/v1/backtest` as "served since
replay 08 landed it". The endpoint is exposed. It is not fed.

### What the four have in common, and it is not sloppiness

In every one of them **the running system is honest and the ticket is not**.
`SWEEP_ARMS_NOT_SCORED` (*"The sweep has not been run"*) and
`NO_HELDOUT_BAND_FOR_ARMS` are `DeclinedFigure` constants that
`declined_figures()` discovers by walking the package, so `/v1/meta` already
publishes both absences; `/v1/replay/days` names the missing nightly job in its
own response body. Somebody knew, in each case, and wrote it down **in the
code**. What did not happen is the ticket being brought into step. That is the
narrow lesson of this sweep: a repository can be more truthful than its record
of itself, and the record is what the next agent reads.

### The nine not applicable, and why

Reachability is a question about an artefact. These nine tickets do not deliver
one, and naming them is the half 27 insisted on:

| ticket | why |
|---|---|
| `forecaster/08-national-joint-band` | an honest hand-back: the band is computed, persistence is recorded as absent and deferred to forecaster 22, which built it |
| `forecaster/16-weather-lead-time-ab` | the status line itself says the run is blocked on archive ingestion; `UnmeasuredLeadTime` / `ARCHIVE_NOT_INGESTED` is written to the card instead |
| `feature-engineering/13-the-two-weather-experiments` | a measurement, which admits experiment 1 cannot be run |
| `api-surface/23-the-unmetered-tier-has-no-cache-directive` | a caching decision, verified present as `CACHE_POLICIES` |
| `api-surface/24-the-replay-key-and-seam-11` | a decision about what belongs in a cache key |
| `api-surface/25-no-guard-passes-vacuously` | a guard-hygiene sweep; its deliverable is other tests' properties |
| `api-surface/26-one-lane-two-answers` | a vocabulary decision; `LANE_STATES` still has three members |
| `data-platform/19-resync-the-drizzle-snapshots` | a tooling resync, with no call site to have |
| `diagnosis/05-attribution-detectors` | a detector suite; the tests *are* the deliverable |

### One candidate rejected, and why it matters

`api-surface/21-cross-language-parity-vectors` looked like an overclaim: its
second box says "both test runners enumerate each directory", and
`packages/core/fixtures/execution-rule/` is enumerated by
`apps/ml/tests/test_execution_rule_vectors.py` alone. But the ticket's fifth box
is "deliberate asymmetries live in their own block with a stated reason", and
`packages/core/fixtures/README.md:73-84` is exactly that block: *"A fifth value
was not a parity case — it was a deletion … Those vectors are no longer a
parity directory"*, because api-surface 18 deleted the TypeScript copy of the
execution rule on purpose. Recorded, therefore not a lie. **Verdict: reachable.**

---

## The guard

`test/reachability.ts` and `test/reachability.test.ts`, run by
`bun run test:hygiene` and so by `bun run check`.

### What it does not do, and why that is the design

"Everything exported must be called" is not a rule this repository can hold. A
comment-stripped sweep of every exported value in `apps/{api,web}`, `packages`
and `scripts` finds **107** with no non-test caller, and most are legitimate: a
design-system primitive the app has not used yet, a repository read the
canonical layer reaches through SQL instead, a helper a test pins on purpose. A
guard that failed on all 107 would be deleted within a week, which is
api-surface 25's fourth lesson arriving in advance. So the guard governs the
**shapes the repository itself declares to be wired**, each discovered rather
than listed:

1. **Every `create*Ingestor` and `create*Routes`** is named by something other
   than its own module, a barrel re-export and its tests. The naming convention
   is the repo's own statement that a thing is a unit the system runs, so a
   module adding `createFooIngestor` tomorrow is governed the day it is written.
   Ticket 03's defect is red on the first run.
2. **Every `IngestTask` kind** reaches a dispatcher branch and is planned by
   `planRefresh`.
3. **Every `ingestion_source` enum member** is producible by `sourceOf` —
   data-platform 15's failure mode, where `siga` and `weather` were added to the
   enum and to no plan.
4. **Every route object** under `apps/api/src/api/` is mounted in
   `api/index.ts`.
5. **Every `config` key** is read as `config.<key>` outside `config.ts`.
6. **Every `WorkerTask` kind** reaches a `createWorkerDispatch` branch **and**
   something that puts it on the queue. Added by **api-surface 32**; see the
   section below for what "reaches" means and why it is not "has a cron".

None of the six is an allow-list and none needs an edit when a module is added.

### Proving it can fail, and that its inputs are not empty

Every check is a pure function over text, so the test feeds it mutated real
repository text and watches it go red rather than asserting that it would:

- **ticket 03, reconstructed**: a four-file corpus in which
  `createConstrainedOffDetailIngestor` is declared, re-exported from the ingest
  barrel and imported by one test — the orphan list comes back with exactly that
  name, and the barrel is not mistaken for a caller.
- **a new source added to the union and to nothing else** turns both the
  dispatch check and the plan check red; **deleting the plant-grain
  `planRefresh` line** turns the plan check red on `constrained_off_detail`.
- **an enum member with no plan** turns the `sourceOf` check red —
  data-platform 15, as an input rather than as a story.
- **`.use(replayRoutes)` removed** from `api/index.ts` turns the mount check
  red; **a new `apps/api/src/api/tariffs.ts` exporting a route object** is red
  the day it is written.
- **a config key nothing reads** is red.

And on empty input, which is where this repository has been bitten four times:
`orphanUnits` **throws** on an empty population rather than returning `[]`, and
the test proves it twice — once on an empty corpus and once on a corpus the
stripper has emptied, which is the nastier version. `taskKinds`,
`ingestionSourceMembers`, `configKeys` and `routeObjects` throw when the
declaration they parse is gone; `unreadConfigKeys([], …)` reports every key
unread rather than none.

### The stripper, and the bug 29 found in 27's

api-surface 25's third recorded defect was a scanner that removed block comments
*before* line comments and so deleted a hundred lines of `api/grid.ts` from its
own input, because one `//` comment on that file contains `/*`. `stripCode` is
positional — one left-to-right pass that takes whichever of `//`, `/*` or a
quote it meets first — and the test asserts the property **on that exact file**:
every route path declared after the offending line is still present in the
stripped text, and the stripped text is the same length as the original. That
this mattered is not hypothetical: an earlier, comment-blind revision of this
sweep reported `createArchiveFetch` as reached, because its own docstring
contains a usage example naming it.

String literals are deliberately **kept**. Dispatch in this repository goes
through string keys, and blanking them would manufacture orphans.

---

## What could not be checked, with the reason

- **SQL.** The feature gate is a Postgres function in `apps/api/drizzle/`, and
  reachability of a view or a function is not derivable from TypeScript. This
  matters for a real verdict: `apps/api/src/features/weather-aggregate.ts`
  (`aggregateSubsystemHour`, `readSubsystemWeatherAsOf`) is imported only by the
  features barrel and its exports are used nowhere — but
  `feature-engineering/08-the-weather-block`'s claim is honoured by
  `feature_weather_block` in `drizzle/0029_the_weather_block.sql`, joined into
  `feature_rows`. The ticket is truthful; the TypeScript is a parallel that
  nothing runs. **Verdict: reachable, with a dead sibling.**
- **Python.** `apps/ml` dispatches through FastAPI decorators and a CLI, so a
  textual caller sweep there is advisory only and every Python verdict above was
  confirmed by hand against `app.py`'s route table and `retrain.py`'s call
  chain. `apps/ml/**` is owned by a sibling branch this wave and is not edited
  here.
- **Table writes.** Rows go in through `writeVersioned(db, SPEC, rows,
  vintage)`, so "no textual `.insert(table)`" proves nothing — a naive check
  reports thirteen tables as unwritten, including `plant_detail_hour`, which
  data-platform 03 has since filled with 310,080 real rows. No table-write check
  is attempted.
- **The three dispatch mechanisms that defeat a textual sweep**, found before
  concluding anything: the ingest dispatcher's exhaustive `default:` branch
  (`plant_registry` has no `case` and is handled there); FastAPI's decorators;
  and `declined_figures()` / `caveated_figures()`, which find their constants by
  walking package modules, so a `DeclinedFigure` with no textual reference is
  still published on `/v1/meta`.

## Adjacent findings, outside the 91

Recorded because the sweep found them and deleting the finding would be the
thing this ticket exists to stop:

- **`apps/api/src/ingest/archive-fetch.ts`** (`createArchiveFetch`) is imported
  only by the ingest barrel and called by nothing. It is the reprocessing path —
  `docs/specs/data-platform.md:464` describes it, and
  `data-platform/11-refresh-custody-observability` ticks "Archived payloads can
  be reprocessed without re-fetching". The capability is real and tested and has
  no entry point: `src/scripts/ingest.ts` has no flag that would pass it as the
  ingestor's `fetch`. Ticket 11 is outside this sweep's population (its boxes are
  ticked), so its status is left alone and the finding is written here.
- **`apps/web/src/i18n/narration.ts`** — the client-side narration formatter —
  is imported by no screen. Noted on `diagnosis/09-template-narration` rather
  than corrected, because the Explain screen says so in its own source: *"This
  screen is still on fixtures … the constant becomes `explain.narration.source`
  the day the screen reads the endpoint"*.
- **`apps/api/src/database/plugin.ts`** (`databasePlugin`) is mounted nowhere
  and claimed by no ticket; routes reach persistence by importing `database`
  directly. Dead code, not a false claim.
- Three barrels nobody imports: `apps/api/src/forecast/index.ts`,
  `apps/api/src/database/index.ts`, `apps/web/src/components/landing/index.ts`.
  Their members are imported directly. Harmless, and not worth a guard.

## What this ticket deliberately did not do

It did not delete a single line of product code. Four orphans and four
dead-but-claimed modules are a temptation to tidy, and tidying them would have
destroyed the evidence and mixed an audit with a refactor. The record is
corrected; the wiring is described and left for the lane that owns it.

---

## api-surface 32 — the sixth check, and the gap it closes

The agent that wired the four orphans reported honestly that this guard had not
caught replay 07 and 08 and **could not have**: the five checks govern
`create*Ingestor`/`create*Routes` factories, `IngestTask` kinds,
`ingestion_source` members, route mounts and `config` keys, and
`createReplayRefresher` is none of those while `WorkerTask` kinds were checked
by nothing. Its recommendation was a sixth check. This is that check.

### How each `WorkerTask` kind is actually reached, found before deciding

The naive rule — *every kind needs a cron* — would fire on correct code and be
deleted within a week, which is api-surface 25's fourth lesson. There are
**three** mechanisms, and they look nothing alike:

| kind | dispatch | enqueue |
|---|---|---|
| `publish_forecast` | `task.kind === …` branch | `forecastPublicationSchedules()`, looped by `worker.ts:135` |
| `publish_diagnosis` | branch | **chained, not scheduled** — `chainDiagnosis` submits it from inside the `publish_forecast` branch through `deps.submit` |
| `retrain` | branch | `retrainScheduleForQueue()`, `worker.ts:160` |
| `holdout_backfill` | branch | `holdoutBackfillScheduleForQueue()`, `worker.ts:179` |
| `refresh_replay_caches` | branch | `replayRefreshSchedulesForQueue()`, `worker.ts:202` |
| `QueueTask` (the ingest union, folded in) | the `return ingest(task, report)` delegation | check 2, plus three **inline schedule literals** — `refresh_sweep`, `retention`, `centroid_drift` are registered in `worker.ts` as `payload: { kind: … }` objects with no producer function at all |

**`publish_diagnosis` is legitimately unscheduled.** It is the one row of
`docs/specs/api-surface.md`'s job table whose trigger is *"on completion of
each"* rather than a cron pattern. A check demanding a schedule for it would be
accusing correct code, so the rule is dispatch **and** (registered schedule
producer **or** chain **or** inline literal).

### What the sixth check derives, all by shape

- the **kinds**, from the `export type WorkerTask =` union — plus the union's
  *type-reference* members (`QueueTask`), so that half the union is not silently
  ignored: the test asserts the `return ingest(task, report)` delegation exists;
- the **dispatch** side, from the body of `createWorkerDispatch` (both
  `task.kind === "…"` and `case "…":`, so a rewrite from one to the other does
  not empty the check);
- the **schedule producers**, by *return type* — every
  `export function …(): JobSchedule<WorkerTask>[]` — never by name, so a fifth
  one called anything at all is governed the day it is written;
- the **registration**, by requiring a non-test module *other than the declaring
  one* to name the producer. A producer nobody loops over schedules nothing;
- the **chain** (`submit({ kind: … })`) and the **inline literal**
  (`payload: { kind: … }`) in any non-test file.

It also runs the **other direction**: a branch or a schedule for a kind the
union no longer declares. That is the shape a half-reverted wiring commit leaves
behind, and it is the only way the *member*'s removal can be seen.

### Proved retroactively, by putting replay 07/08 back one half at a time

Each mutation is applied to real repository text and the verdict is asserted,
not described:

| mutation | verdict |
|---|---|
| the `WorkerTask` member removed, branch and schedule left | **red** — `refresh_replay_caches` undeclared, `from: ["dispatch", "schedule"]` |
| the `createWorkerDispatch` branch removed | **red** — `missing: ["dispatch"]` |
| `worker.ts`'s `replayRefreshSchedulesForQueue()` loop removed | **red** — `missing: ["enqueue"]`, with the producer still sitting in `worker-tasks.ts` |

**The honest limit, stated rather than skipped.** Replay 07/08 were not
*half*-wired: they had **no** member, **no** branch and **no** schedule. A check
over declared shapes cannot see a capability nothing declares, so the sixth
check alone would still have read green on the day replay 07 merged. The
recommendation as written is therefore only two-thirds true, and the missing
third is covered **from the other side of the wire**: every `/internal/` route
the modelling service declares must be named by non-test TypeScript. That
population is `app.py`'s own decorators — six routes today, all six named by a
path constant under `apps/api/src/`. Deleting `jobs/replay-refresh.ts` from the
corpus, which is exactly the pre-wiring state, reports
`/internal/replay/featured-days` and `/internal/replay/backtest` as uncalled.
`apps/ml` is read and never edited; only its route table is read, which is a
declaration rather than a call graph.

### Non-vacuity, checked in the place the repository has been bitten

`workerTaskKinds`, `workerDispatchedKinds`, `scheduleProducers`,
`mlInternalRoutes`, `unreachedWorkerKinds` and `undeclaredWorkerKinds` all
**throw** rather than return `[]`: on empty text, on a union with no `kind:`
member, on a dispatcher that branches on nothing, on a corpus the stripper has
emptied, and on an empty dispatched or enqueued set at the verdict itself.
`uncalledMlRoutes(routes, [])` reports every route uncalled rather than none.

The comment-stripping path is tested in **both** directions on the file that
broke two previous guards:

- a `//`-commented `submit({ kind: … })` is **not** a call site — the
  `createArchiveFetch` bug, where a docstring's usage example was read as a
  caller (and `jobs/replay-refresh.ts`'s own header names both `/internal/`
  paths in prose, so this is live, not hypothetical);
- the actual offending line from `apps/api/src/api/grid.ts` — a `//` comment
  containing `/*` — placed **above** a real enqueue does not hide it, which a
  block-comments-first stripper would.

`bun run check` is green: typecheck, biome (2 pre-existing warnings in
`test/phantom-schedules.test.ts`, api-surface 31's file), 273 hygiene tests
across 15 files, 471 core, 1282 api, 189 web. Nothing under `apps/ml/**`,
`apps/api/src/ingest/**` or `apps/api/src/jobs/**` was edited.

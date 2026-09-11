# 07 — The featured days are a query, and one of them is a day WattSteer got wrong

**What to build:** the Time Machine opens on a shortlist of interesting days chosen by
a published deterministic rule — not by anyone's taste — and the rule is *obliged* to
put a day WattSteer got wrong in front of the user.

Shipping only one of "any date by URL" and "a curated set" would be a mistake in either
direction: a curated-only tool is a slideshow, and an any-date-only tool opens as a
blank date picker over seventeen months. Both ship. Hand-picking the featured days
would be selecting on the outcome — the same failure the shuffled-label control exists
to catch one layer down.

The rule, published on the screen in one sentence and evaluated on the replayable set:

> The **eight** featured days are: the three days with the largest observed
> `total_mwh`; the day with the largest **absolute forecast error** on the day total;
> the day with the largest observed total in **each** `VintageFidelity` class; the day
> with the largest observed total in **each** provenance class; and — mandatorily —
> **the day with the largest shortfall against its own promised floor**, i.e.
> `min(scored.observed.recovered − recovered_floor)`. Duplicates collapse and the list
> is padded from the top of the first criterion. Ties break on date, ascending.

The last clause is the one that matters, and it means the demo screen can open on a bad
day. If no day missed its floor, the slot is filled by the smallest margin and labelled
as the closest call.

The list is recomputed nightly against the published `REFERENCE_FLEET` and cached; it
is deterministic given the data.

**Blocked by:** 02, 03; **Flex-optimizer 03** (`REFERENCE_FLEET` as one published
constant — the list is not reproducible if the fleet it is computed against is
restated per surface).

**Status:** done for the rule and the endpoint, and **the nightly job now
exists**: `refresh_replay_caches` is a `WorkerTask` kind with a dispatcher
branch and a schedule at `30 3 * * *` in Brasília, one per (subsystem, served
lane). **No deployed instance has been observed serving a filled cache** — the
wiring is covered by tests against a stand-in modelling service and has not
been run against a live one. See "30 — Corrected" and "30 — Wired" below. The
status line read `done` without qualification before api-surface 30.

- [ ] `GET /v1/replay/days` returns the calendar and the eight featured days together
- [ ] The query is deterministic given the data, and re-running it changes nothing
- [ ] The list contains at least one day from each populated `VintageFidelity` and each populated provenance class
- [ ] The worst-floor-shortfall clause is present and non-empty, asserted by a test; on a synthetic dataset where one day badly missed its floor, that day is in the list
- [ ] With no day missing its floor, the slot holds the smallest margin and is labelled the closest call
- [ ] Duplicates collapse, padding comes from the top of the first criterion, ties break on date ascending
- [ ] It is computed against `REFERENCE_FLEET`, stamped on the response
- [ ] The rule is rendered on the screen in one sentence

---

## 30 — Corrected: the nightly job the design depends on does not exist

**Status of this correction:** the ticket's status line is amended; no code is
changed here. Found by api-surface 30's reachability sweep, which is
data-platform 03's failure mode asked of every `done` ticket.

The shortlist rule is built, the endpoint is built, and both are covered
(`apps/ml/tests/test_database_featured_days.py`). The design is explicit that
the list is **computed nightly and never on the request path** — a recompute is
~13 s and the gateway's ML timeout is five seconds — so `GET /v1/replay/days`
serves a process-local cache and `POST /internal/replay/featured-days`
(`apps/ml/src/wattsteer_ml/app.py:1847`) fills it.

**Nothing calls that endpoint.** Checked directly:

- no member of `WorkerTask` in `apps/api/src/jobs/worker-tasks.ts:58-61`
  (`publish_forecast`, `publish_diagnosis`, `retrain`, `holdout_backfill`);
- no schedule registered in `apps/api/src/worker.ts`;
- no cron in `railway.json`, `apps/ml/railway.json`, `docker-compose.yml` or
  `.github/workflows/`;
- `grep -rn "refresh-featured-days"` finds it only in the docstrings that name
  it, one test's docstring, and `docs/specs/api-surface.md:323`, where the
  scheduled-jobs table lists `refresh-featured-days | 30 3 * * *` as though it
  ran. The only callers of the route are `apps/ml/tests/
  test_database_featured_days.py:390` and its siblings.

So the first box — "`GET /v1/replay/days` returns the calendar and the eight
featured days together" — is false of every deployed instance. The cache starts
empty and nothing fills it, so the route permanently returns the `pending`
payload: *"the featured-days rule has not been run on this instance yet; the
nightly refresh-featured-days job computes it"* (`app.py:1827-1830`).

**The service is honest and the ticket was not**, the same split forecaster 11
and 17 show: the fallback names the missing job in the response body, so an API
reader is told. A ticket reader was told the days were served.

**What it would take to wire it.** The same shape `holdout_backfill` already
has, and that is the whole of the work: a `refresh_featured_days` member on
`WorkerTask`, a branch beside `worker-tasks.ts:139`, and a schedule entry in
`worker.ts` beside `holdoutBackfillScheduleForQueue()`. One task per subsystem
per served lane. `apps/api/**` is reachable from this branch but `apps/ml/**`
is owned by a sibling this wave, and the endpoint needs no change — only a
caller — so the correction is recorded rather than made here.

---

## 30 — Wired: the nightly job exists, and the spec's cron row is now true

**Status of this wiring:** code added on branch `wire-the-orphans`. The
correction above is left standing rather than rewritten. **Replay 08 is the
same wiring and is not a second one** — see that ticket's own "30 — Wired",
which describes the same task kind from the aggregate's side.

`apps/api/src/jobs/replay-refresh.ts` is the caller, and it is exactly the
shape `holdout_backfill` already has:

- a `refresh_replay_caches` member on `WorkerTask` and on `WorkerTaskResult`;
- one branch in `createWorkerDispatch`, beside the backfill's;
- `replayRefreshSchedulesForQueue()` registered in `apps/api/src/worker.ts`
  beside `holdoutBackfillScheduleForQueue()`, under its own `if (config.mlUrl)`
  with its own warning, because a deployment with no modelling service should
  be told about each schedule in its own sentence.

Four decisions are this module's, and each is written down in it:

1. **One task kind carries both caches.** Replay 08 says the same task should
   carry both, and the reason is that they are one omission: both caches are
   process-local on the modelling service, both are filled only from an
   `/internal` route, and both replay the same window against the same
   `REFERENCE_FLEET`. Two kinds would be two schedules that could drift into
   refreshing a shortlist against one night's rows and an aggregate against
   another's.
2. **The fan-out is derived, not listed.** `SUBSYSTEM_DISPLAY_ORDER` ×
   `PUBLICATION_LANES`, so a fifth subsystem or a third served lane is
   scheduled the day it is added. One schedule per pair rather than one job
   that loops, which is what `FORECAST_PUBLICATIONS` does and for the same
   reason: a pair that refuses is one entry in the queue's failure list and can
   be re-submitted without recomputing the other seven.
3. **A refusal finishes the run; an outage retries it.** The retrain's
   distinction, in its vocabulary. `REPLAY_FORECAST_UNAVAILABLE` means the
   window holds no replayable day for that pair — true before go-live and of
   any lane nothing has backfilled — and does not improve by being asked again
   at 03:31, so it is logged, recorded on the result, and the second cache is
   still attempted. Anything at 5xx, an unreachable service or a timeout is
   rethrown for the queue's backoff.
4. **`30 3 * * *` in Brasília**, because that is the row
   `docs/specs/api-surface.md` already published and its column header says
   `Cron (America/Sao_Paulo)`. It is after the late gate's publication and its
   diagnosis follow-on and well before the 09:10 one.

`docs/specs/api-surface.md:323` **is now true rather than corrected away**: the
job's name and cron are unchanged, and the row's Lane and Writes columns were
widened to say what it actually covers, with a note beneath the table recording
that the row described a cron existing in no file until this landed.

### What happened to the honest refusal

The `pending` payload at `app.py:1827-1830` — *"the featured-days rule has not
been run on this instance yet; the nightly refresh-featured-days job computes
it"* — is **unchanged and still there**, and should be. It is the correct
answer for a process that has started and not yet been refreshed, which is
every modelling-service replica between boot and the next 03:30. What it stops
being is *permanent*: the job it names now exists, so the sentence describes a
window rather than a state of the world.

### What has not been done, and one thing that cannot be

- No live run: the tests drive the job against a stand-in modelling service
  over a real socket, not against `apps/ml`.
- **Both caches are process-local**, which no scheduler can fix from the
  gateway side. A refresh reaches the replica that answered it, so a modelling
  service scaled past one replica has the others serving `pending` until they
  are refreshed in their turn. That is the cache's own design — `app.py` argues
  for it — and it is written into the new module's docstring rather than left
  for the next reader to discover.

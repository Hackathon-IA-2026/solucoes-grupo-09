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

**Status:** done for the rule and the endpoint; **nothing ever calls the
endpoint, so the cache is never filled and `/v1/replay/days` serves `pending`
in production** — corrected by api-surface 30, see "30 — Corrected" below. The
status line previously read `done` without qualification.

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

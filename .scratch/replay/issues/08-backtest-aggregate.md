# 08 — The Backtest: many replays, the same code, and no averaging across a caveat

**What to build:** an analyst can see how WattSteer's plans would have done over a whole
fold — floor coverage, the distribution of avoidability, what better forecasting would
have been worth — computed by running the same replay path once per day and aggregating
it, so the aggregate cannot drift from the thing it aggregates.

`Backtest` is the distinct noun for many days: a Replay is one day for a human, a
Backtest is many days for a gate. They share the machinery and not the name.

| Metric | Grain | Note |
|---|---|---|
| `days_replayed` | fold, subsystem, fidelity | |
| `floor_coverage` | fold, subsystem, fidelity | share of days where `floor_met` |
| `mean_avoidability`, `p25`, `p75` | fold, fidelity | a distribution, not a single number |
| `total_recovered_mwh` | fold, fidelity | |
| `mean_forecast_value_gap_mwh` | fold | what better forecasting is worth |
| `days_forecast_underestimated` | fold | share where `Σf50 < Σa` |
| `revision_premium_recovered_mwh` | once available | the measured vintage caveat |
| `vintage_fidelity` | every row | **never averaged across values** |

Two rules stop an aggregate from laundering a caveat, and they are enforced
structurally rather than agreed: a `revision_optimistic` row is never averaged into a
`point_in_time` one — asserted by making the aggregation function take fidelity as a
**group key** rather than filtering on it — and a fold straddling ingestion go-live is
split at go-live and reported as two rows.

**The floor is not a per-day theorem.** The simulator's monotonicity property
guarantees `recovered(plan, r) ≥ recovered(plan, f10)` only when `r ≥ f10` *pointwise*,
and an observed day is not obliged to dominate the P10 envelope in every hour. So floor
coverage is an **empirical claim the product checks**, which is precisely why the
Flex-optimizer spec requires the metric rather than asserting the property.

Aggregating "what if WattSteer had run all year" into a single annual figure is out of
scope: a single headline over mixed fidelities is the exact averaging this forbids.

**Blocked by:** 03, 05; **Flex-optimizer 03** (`REFERENCE_FLEET`). **Cross-spec,
external: Forecaster 03** (the fold calendar as data, and the straddling-fold split).

**Status:** done for the aggregate and the endpoint, and **the nightly job now
exists**: the same `refresh_replay_caches` task replay 07 needed fills this
cache too, on the same schedule, in the same POST pair. **No deployed instance
has been observed serving a filled cache** — the wiring is covered by tests
against a stand-in modelling service. See "30 — Corrected" and "30 — Wired"
below. The status line read `done` without qualification before api-surface 30.

- [ ] `GET /v1/backtest?fold=…` returns the table above at the stated grains
- [ ] Every metric is produced by running the ticket 03 replay path per day — no second scoring implementation exists
- [ ] The aggregation function takes `VintageFidelity` as a group key; a test asserts no code path can average across values
- [ ] A fold straddling ingestion go-live emits two rows and never one
- [ ] `REFERENCE_FLEET` is stamped on every aggregate
- [ ] Distributions are reported as mean with p25/p75, never collapsed to a single number
- [ ] No annual or cross-fidelity headline figure is offered anywhere in the contract

---

## 30 — Corrected: `/v1/backtest` has the same missing caller as replay 07

**Status of this correction:** the ticket's status line is amended; no code is
changed here. Found by api-surface 30's reachability sweep.

This is replay 07's defect in the same module, and it is worth saying that the
two are one omission rather than two: both caches are process-local, both are
filled only from an `/internal` endpoint, and the scheduler that was supposed
to call both was never written.

`POST /internal/replay/backtest` (`apps/ml/src/wattsteer_ml/app.py:2007`) is
built and covered (`apps/ml/tests/test_database_backtest.py:335`). Its only
callers are those tests. There is no `WorkerTask` member, no branch in
`apps/api/src/jobs/worker-tasks.ts`, no schedule in `apps/api/src/worker.ts`
and no cron anywhere in the repository. `backtest_cache` (`app.py:1937`) starts
empty and stays empty, so the first box — "`GET /v1/backtest?fold=…` returns
the table above at the stated grains" — is false of every deployed instance;
the route publishes the stated absence instead, which is the right behaviour
and not the claimed one.

Note that `docs/specs/api-surface.md:467` records `/v1/backtest` as
"**served since replay 08 landed it**". It is exposed; it is not fed.

**What it would take to wire it.** Exactly what replay 07 needs, and the same
task should carry both: one worker task kind, one dispatcher branch, one
schedule entry, fanned out per subsystem and lane. Recorded rather than made
here for the same reason — the endpoint needs a caller, not a change, and
`apps/ml/**` is a sibling's this wave.

---

## 30 — Wired: one task, both caches, on branch `wire-the-orphans`

**Status of this wiring:** code added. The correction above stands. The
mechanics live in replay 07's own "30 — Wired" section and are not repeated
here; this section says what is this ticket's.

The correction's prediction held exactly: it is **one** omission and it took
**one** task. `apps/api/src/jobs/replay-refresh.ts` POSTs
`/internal/replay/featured-days` and then `/internal/replay/backtest` for the
same `(subsystem, lane)` in one job, so the shortlist a reader opens on and the
aggregate in the footer beneath it are computed from one night's rows rather
than from two. One `WorkerTask` kind (`refresh_replay_caches`), one dispatcher
branch, one schedule set — `30 3 * * *` Brasília, fanned out over
`SUBSYSTEM_DISPLAY_ORDER` × `PUBLICATION_LANES`.

Two things specific to the aggregate:

- **The second POST runs whether or not the first found anything.** A lane with
  no featured day can still have a fold with a backtest row, and a job that
  stopped at the first stated absence would make this cache unreachable for
  exactly the lanes that most need filling. Asserted by a test.
- **Nothing here writes a row.** The aggregate is computed and cached on the
  modelling service; this job appends nothing to Postgres, which is what makes
  the retry free and the whole task idempotent by construction rather than by a
  digest.

### What happened to the honest refusal

`backtest_pending_payload`'s sentence — *"the backtest has not been computed on
this instance yet; the nightly refresh job computes it"* — is **unchanged and
still served**, and still correct for a replica between boot and its next
refresh. It stops being permanent, not present. `docs/specs/api-surface.md:467`
recorded `/v1/backtest` as "served since replay 08 landed it"; the endpoint was
exposed and not fed, and it is now fed by a job that exists in a file. That
line needed no edit — the wiring made it true.

### What has not been done

No live run against `apps/ml`; the tests drive the job against a stand-in
service over a real socket. And the cache is process-local, so a modelling
service on more than one replica has the un-refreshed ones still answering
`pending` — recorded in replay 07's section and in the new module's docstring.

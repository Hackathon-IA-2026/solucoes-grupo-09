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

**Status:** done for the aggregate and the endpoint; **nothing ever fills the
cache, so `/v1/backtest` serves `pending` in production** — corrected by
api-surface 30, see "30 — Corrected" below. The status line previously read
`done` without qualification.

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

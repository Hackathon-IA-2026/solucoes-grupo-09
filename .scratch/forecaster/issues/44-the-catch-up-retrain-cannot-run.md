# 44 — the catch-up retrain cannot run, and it fails as a crash

**What to build:** a hand-submitted retrain that reaches a decision on a day the
schedule has already run.

**Status:** diagnosed on the live deployment, both defects reproduced from the
logs. Not yet fixed.

## What happened

Forecaster 43 changed the conformal correction's units and the artifact on the
volume was minted under the old ones, so a retrain was owed. `config.ts` names
the lever for exactly this:

> **This is the operator path to a catch-up run, and until now there was none.**
> […] Overriding the pattern is the one lever that does not require exposing
> Redis, the modelling service or the unauthenticated jobs dashboard to the
> public internet.

`WATTSTEER_RETRAIN_PATTERN` was set to `5 * * * *`. The schedule registered
correctly — the worker logged `retrain: retrain:serving-lanes 5 * * * *
(Etc/UTC)` — fired at 18:05Z, and produced this, three times, once per queue
retry:

```
retrain 2026-09-15T03:10:00Z exited 1: b''
POST /internal/retrain HTTP/1.1" 500 Internal Server Error
⚠️  retrain 2026-09-15T03:10:00Z — the retrain did not complete: The ML service failed: HTTP 500
```

Each attempt took **under two seconds**. A healthy run is ~750 s. Nothing was
retrained, and the operator path the comment advertises does not work.

## Two defects, and they compound

### 1. The catch-up cannot mint a new run id

`retrainRunId` (`apps/api/src/jobs/retrain.ts:109`) floors the clock to
`RETRAIN_HOUR`/`RETRAIN_MINUTE` — **the constants 3 and 10**, not the instant the
job actually fired:

```ts
Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
         RETRAIN_HOUR, RETRAIN_MINUTE, 0, 0)
```

So a firing at 18:05Z on 2026-09-15 resolves to `2026-09-15T03:10:00Z` — the id
**this morning's scheduled run already used**. The id is correct for the
schedule it was written for and wrong for every other pattern, because it
derives the run's identity from a constant rather than from the schedule in
force. The docstring says the id makes "a redelivery, a backoff retry and a
hand-submitted catch-up" idempotent; for the first two that is the point, and
for the third it is the bug — a catch-up on a day the schedule already ran is
*indistinguishable from a retry of it*.

### 2. An all-short-circuited run exits non-zero

`gate_one` returns `NoCandidate` for a lane already carrying a decision line for
the run id — correct, and it is what keeps "exactly one decision line per run"
true under redelivery. But `main` then reads:

```python
decided = [o for o in report.outcomes if o.status in ("promoted", "refused")]
return 0 if decided else 1
```

Every lane short-circuited, so `decided` is empty and the process exits 1. Its
own docstring states the rule it is breaking:

> The exit code is the operator's signal — non-zero when *no* lane reached a
> decision, **which is the only outcome that is unambiguously a failed run.**

A run whose every lane was already decided is unambiguously **not** a failed
run. It is the idempotent no-op the short-circuit exists to produce. The service
turns it into `RETRAIN_FAILED` / HTTP 500, the queue treats 500 as retryable and
burns three attempts, and the log says "the retrain did not complete" about a
run that completed correctly and did nothing.

**The empty stderr is the third of it.** `exited 1: b''` — the failure carries no
diagnosis at all, because the short-circuit path writes to stdout and nothing
reads it on the error branch. An operator sees a 500 with no cause.

## Boxes

- [ ] `retrainRunId` derives the instant from the schedule in force, not from
      two constants, so an overridden pattern mints an id of its own
- [ ] An all-short-circuited run exits 0 and reports what it skipped, because
      "already decided" is a no-op and not a failure
- [ ] The service's failure branch carries the child's stdout as well as its
      stderr, so a non-zero exit is never diagnosed as `b''`
- [ ] Each of the three is asserted by a test that fails on the defect and on
      empty input
- [ ] The catch-up runs end to end on the deployment and reaches a decision

## What this does not claim

That the retrain then promotes. Forecaster 43 changed the floor's units and the
gate decides what that is worth; `crossing_rate` on `gate_late` was **0.0107
against 0.01** on the refused pair and forecaster 43 does not touch it, so one
lane may still refuse on a rail this ticket has nothing to do with.

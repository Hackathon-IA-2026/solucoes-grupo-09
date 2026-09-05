# 15 — The weekly retrain runs by itself, and reproduces itself

**What to build:** on its schedule, the retrain goes from the live database to a
gate decision without a human — and a rerun of it, from the same inputs and
seed, produces the same artifact.

End to end against real Postgres: build features for the current window, fit the
base learners on the base-fit block, fit the calibration layer and the two
conformal scalars on the trailing 90 days, compute the PIT matrix, write bundle
and card, run the gate against the incumbent on the live-edge fold, and append
exactly one line. Wall-clock and peak memory are recorded, so a retrain that
starts to outgrow the service is visible before it fails.

Determinism is part of the deliverable rather than an aspiration, because the
gate compares two artifacts and a nondeterministic pipeline makes the comparison
meaningless: same inputs and seed must give identical predictions, identical
feature hash and identical conformal corrections, and reloading the artifact
from the volume must reproduce predictions bit-identically.

**Blocked by:** 13, 14.

**Status:** done

- [x] The retrain runs on the existing job infrastructure, is idempotent on
      retry, and appends exactly one decision line per run
- [x] It scores against the live-edge fold, and refuses to let a
      revision-optimistic fold decide once a point-in-time fold exists
- [x] Wall-clock and peak memory are recorded on the card
- [x] Same inputs and seed give identical predictions, feature hash and
      conformal corrections — the driver reads no clock; see the caveat below
- [x] Reloading the written artifact reproduces predictions bit-identically
- [x] A retrain that fails part-way leaves no half-written artifact that the
      promotion log could later name
- [ ] The full fold sweep for every run in the matrix completes inside the
      retrain's budget — **not ticked; see below**

## What was built

**The cron entry, which is what was missing.** `apps/api/src/jobs/retrain.ts` is
one repeatable job on the queue the worker already owns — `10 3 * * 5`,
`Etc/UTC`, registered in `worker.ts` beside the two publications. One scheduler,
per `docs/specs/data-platform.md`. Fridays at 03:10 UTC is where this spec's own
artifact stems put it (`2026-08-28T03:11:07Z` and `2026-08-21T03:09:44Z`, two
Fridays a week apart) and it is 00:10 BRT, so the civil day has just turned and
`as_of − 1` is a day whose labels have settled — nine hours ahead of the 09:10
BRT publication, so a Friday promotion is serving by the morning gate.

**The driver.** `wattsteer_ml.retrain` is `run_serving_lanes`' missing
`gate_one`: calendar → the prior folds' out-of-fold occurrence → the pool →
`train_fold` → `save_artifact` → the ladder → the incumbent scored on the same
rows → the serving smoke on tomorrow's real vector → `run_gate`. Nothing in that
chain is reimplemented; what is new is the order and the provenance of the
inputs. Verified against a migrated Postgres: both lanes read 85,056 rows over
F6's window with five prior folds behind them, reached a per-lane outcome
independently, wrote nothing to the volume and appended nothing, in 9.8 s at
646 MB peak.

**Idempotency without new state.** The run id *is* the artifact id in both lanes,
and `decided_in_run` short-circuits a lane that already carries a line for it. A
redelivery, a backoff retry and a hand-submitted catch-up therefore retrain
nothing and append nothing. `retrainRunId` floors the clock to the schedule's own
hour and minute, so every attempt of one firing computes the same id — a handler
that read its own clock would turn one Friday into two artifacts nothing could
tell were retries of each other. The modelling service additionally refuses an
overlapping run of the same id (409 `RETRAIN_IN_PROGRESS`), because a retrain
outlives most client timeouts.

**A child interpreter, not a request handler.** `POST /internal/retrain` spawns
`python -m wattsteer_ml.retrain` and returns its JSON report. Three reasons and
they are all load-bearing: a peak RSS read inside the API process is that
process's peak and not the retrain's; a multi-minute LightGBM fit on the event
loop stalls every read the same instance is serving; and a run killed by the
memory limit takes the child down rather than the service.
`tests/reproduce_fold.py` already records the determinism half of the same fact
— "the weekly retrain is always a second interpreter".

**One new modelling seam, and it is small.** `train_fold` requires an
`OutOfFoldPool`, and the pool is assembled from the folds *before* the one being
fitted — so building it by training the artifact on each prior fold would need a
pool to get a pool. `training.out_of_fold_occurrence` is the way out: the pool
carries a raw occurrence probability and a settled label and nothing else, so
the occurrence booster is the only estimator it can need. It is `train_fold`'s
own occurrence stage through the same `_fit`, the same params and the same
blocks, not a cheaper model's approximation of it.

**Atomic artifact writes.** `save_artifact` and `write_card` now compose each
file under a temporary name in the destination directory and `os.replace` it
into place. Ordering alone was not enough for the case this ticket has to
survive: a retrain killed part-way through `joblib.dump` left a truncated
`.joblib` under a real artifact id, which `artifacts.py` lists and `rollback`
would accept as a target on the strength of the file existing.

## Two readings this ticket had to choose between

**The deciding fold, and the trailing 90 days.** The ticket says "fit the
calibration layer and the two conformal scalars on the trailing 90 days", which
read literally is a window ending yesterday — and F6's own test rows are inside
it, so the gate would be scoring the candidate on rows it was calibrated on. The
spec's fold protocol wins: the trailing 90 days are the last 90 of the *training
block*, which is what `Fold.blocks_for` computes and what seam 7 asserts. The
ticket's prose is the loose one and the spec is the authority.

**What "the newest training target date" means to check 4.** Under that reading a
fold-trained artifact's last fitted day is the live edge's `train_end` — the
quarter's start — so it is more than seven days old for almost every week of
every quarter, and check 4 would refuse every candidate forever. That cannot be
what a rule named *freshness and coverage* is for: it exists to notice that
ingestion has stopped. So the candidate reports the newest target date the run's
data window reached (`blocks.test_end`, i.e. `as_of − 1`), and the card's
`retrain.reproduction` block records **both** that and the true `trained_to`, so
the artifact never overstates what it was fitted on.

## Notes for whoever picks this up next

**The gate can only promote in roughly the last third of each quarter, and that
is a property of the spec's constants rather than of this driver.** Check 4 needs
sixty test days on the deciding fold; the live edge starts each quarter at one
day and reaches sixty around the ninth week. Nothing here relaxes that — twenty
days of paired bootstrap decide nothing — but it means an operator watching
`promotions.jsonl` will see nine or ten consecutive weekly *refusals* naming
`freshness_and_coverage`, and those are the system working. If that is not
wanted, the fix is a decision about `MINIMUM_TEST_DAYS` or about promoting
against the newest *frozen* fold early in a quarter, and it belongs in the spec
rather than in the driver.

**Migration `0036` and the 112th attribute: an operational note, not this
ticket's scope.** Every artifact predating `0036` is bound to a 111-attribute
vector, so its `feature_hash` disagrees with the live one. The first scheduled
run therefore refuses both lanes at check 3 and *raises* — by design: the gate
records the refusal, marks the incumbent's card with a contract fault so
`load_artifact` refuses it, and deletes nothing. The lane then serves nothing
until something promotes. The driver makes that recoverable without a human:
`_incumbent` treats an incumbent that refuses to load as a cold start, so the
*second* run measures the candidate against rung 1 and can promote. Two runs, or
one run and a `rollback`, and the widening was not silently folded into this
ticket.

**The end-to-end run has never trained a model, because no environment here has
ingested data.** The read path is proved against real Postgres (`feature_rows`
returns the full spine even on an empty database, which is why 85,056 rows came
back), and everything downstream of the first booster is proved on the fixture
fold by the existing suites. What has *not* been observed is a real fit, a real
bootstrap or a real promotion — so the wall clock and the peak RSS this ticket
records have no production reading yet, and the last acceptance box ("the full
fold sweep completes inside the retrain's budget") is deliberately unticked: it
is a measurement and there is nothing to measure. The 40-minute
`RETRAIN_TIMEOUT_MS` is an upper bound chosen from the shape of the work, not
from a run.

**Determinism is inherited, not re-proved end to end.** Seam 9 is asserted across
two interpreters on the fixture fold (`tests/reproduce_fold.py`). What this
ticket adds is that the *driver* introduces no new nondeterminism — asserted by
a grep-level test that no clock is read below `main`, so every instant the run
depends on comes from `request.as_of`. A live two-run comparison needs a
database with data in it.

**`ml:test:db` does not run this ticket's DB test.** The script points at port
5434 and a database seeded by the TypeScript suites; the retrain's read test
gates on the same `WATTSTEER_TEST_DATABASE_URL` and passes against any migrated
database.

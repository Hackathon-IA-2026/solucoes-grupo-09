# 23 — Nothing writes the out-of-fold forecast rows the Time Machine replays

**What to build:** a `fold_holdout` date that answers with numbers instead of a refusal.

`forecast_origin_kind` has been `ENUM('served','backfilled_holdout')` since
migration `0034`, and 42 files reference the kind — `forecast/reads.ts` is careful
that such a row is never returned by a live route, and the Python side mirrors the
rule. But a repository-wide search finds **no writer**: nothing under
`apps/api/src/replay/`, `apps/api/src/jobs/` or `apps/ml/src/` ever persists a row
with that origin kind.

So the Time Machine's whole point — replaying a day the model did not train on —
answers `REPLAY_FORECAST_UNAVAILABLE` at runtime. Replay 10's screen is correct;
the data is not there.

This belongs beside forecaster 15's retrain driver, because that is what produces
the fold artifacts whose out-of-fold predictions are the thing to persist.

**Blocked by:** None — 15 (retrain driver) and 34/10 (schema, screen) are merged.

**Status:** ready-for-agent

- [ ] Scoring a fold artifact persists its out-of-fold predictions with
      `origin_kind = 'backfilled_holdout'`, append-only, with a `data_version`
- [ ] A `backfilled_holdout` row is still unreachable from every live route —
      the existing guard holds, and a test proves it after the writer exists
- [ ] `/v1/replay` on a `fold_holdout` date returns the replay rather than
      `REPLAY_FORECAST_UNAVAILABLE`, asserted against real Postgres
- [ ] The rows carry the fold identity so a replay can name which artifact and
      which window held the day out
- [ ] Re-scoring the same fold is idempotent, or appends a vintage — not a
      duplicate

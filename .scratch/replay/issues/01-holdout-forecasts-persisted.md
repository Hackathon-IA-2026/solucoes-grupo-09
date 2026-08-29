# 01 — Stop throwing away the out-of-fold forecasts, and make them unservable

**What to build:** after a backtest run, WattSteer holds a `Forecast` for every
held-out day in every walk-forward fold — produced by an artifact that had not seen
that day — and those rows are **structurally unable** to leave the day-ahead
endpoint as if they had been published.

Replay's entire storage requirement is this. The backtest already computes a composed
band for every test row in every fold — that is what `qloss_mwh` is computed from —
and then discards them.

> At the end of a backtest run, every fold's out-of-fold predictions are persisted as
> `Forecast` rows at (`Subsystem`, `valid_time`) grain, with a `ForecastOrigin` whose
> `producer` is `wattsteer`, whose `run_label` is the fold artifact's `artifact_id`,
> whose `published_at` is `gate_at(target_date, gate_profile)` — the instant that
> forecast would have been published — and whose new field `origin_kind` is
> **`backfilled_holdout`**.

Roughly 6 folds × 90 days × 24 hours × 4 subsystems ≈ 52,000 rows per run, which is
nothing. `ingested_at` is the real one — when the backtest ran — so `AsOf` handles
supersession for free: a later backtest writes a newer vintage and an older replay
remains reconstructible at its own as-of.

**`origin_kind` is the field that keeps the two apart, and it is load-bearing.**
`published_at` on a backfilled row is a *counterfactual* publication instant — the
forecast was never actually published then. Storing it without a discriminator would
make a reconstruction indistinguishable from a record, which is the exact class of
error this project keeps ruling out. So `origin_kind ∈ {served, backfilled_holdout}`,
it travels on every surface that carries a `ForecastOrigin`, and
**`/v1/forecast/day-ahead` filters `origin_kind = 'served'` unconditionally.**

**Blocked by:** None in this graph. **Cross-spec, external: the Forecaster spec owns
the fold calendar (F1–F6), the fold artifacts and the backtest run that computes
these predictions; the Feature-engineering spec owns `gate_at(target_date,
gate_profile)`.** Both are consumed here, neither is specified here.

**Status:** ready-for-agent

- [ ] `origin_kind` exists on `ForecastOrigin`, round-trips through persistence and through the API, and appears on every surface that carries an origin
- [ ] A backtest run persists its out-of-fold predictions rather than discarding them, at (`Subsystem`, `valid_time`) grain, carrying the fold artifact's id as `run_label`
- [ ] A backfilled row's `published_at` equals `gate_at(target_date, gate_profile)` exactly
- [ ] `ingested_at` is the real ingestion instant, and a second backtest run writes a **new vintage** rather than overwriting; an `AsOf` read pinned to the older origin still returns the older values
- [ ] A `backfilled_holdout` row is never returned by `/v1/forecast/day-ahead` under any query — asserted by a test, not by convention
- [ ] The existing served path is unchanged: rows it writes carry `origin_kind = 'served'`

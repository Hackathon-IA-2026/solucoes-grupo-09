# The modelling service

Python 3.12, uv, FastAPI, LightGBM, OR-Tools. `docs/specs/forecaster.md` is the
authority on the model, `flex-optimizer.md` on the MILP, `replay.md` on the Time
Machine. Run `bun run check:ml` (ruff + mypy + pytest) when you touch it.

## Lanes, gates and artifacts

A **lane** is a feature set, a gate profile and a threshold in one identifier:
`dessem_free_v1__gate_late__thr5`. `gate_early` ⇄ the 00Z weather run,
`gate_late` ⇄ 12Z. Only the 5 MW threshold is ever promoted.

A lane's state on `/v1/meta` is `promoted` / `present_unpromoted` / … with a
`usable` flag beside it, and **both matter**: a promoted artifact the hot-swap
gate marked invalid against the live feature contract serves nothing. Reading
either alone puts a caller on a lane that cannot answer.

Never build a lane name in a client. `/v1/meta` knows which exist; a constructed
string is a second source that drifts. The gateway refuses to default one for
the same reason.

## The gate decides, and it says why

A retrain fits, evaluates on identical folds, and then the **gate** promotes or
refuses with a recorded reason. `serving_smoke` compares the live feature
function's output against training: a column NULL in 100% of serving rows
against 0–83% in training, over a 5% ceiling, is *an upstream dataset has gone
quiet* and the artifact is refused. That sentence is on `/v1/meta` as
`unusable_reason` — read it before theorising.

The incumbent's risk edges are **held** unless the pool breaks them, because a
named risk class that moves weekly is worse than one three points off. Hand
`derive_risk_bins` a `RiskBins`, not the `RiskBinDecision` that wraps it — that
mistake was annotated `Any`, type-checked, and killed every Friday retrain until
`test_incumbent_risk_bins.py` was written.

## The baseline ladder is the claim

Rung 0 prevalence, rung 1 the mandatory same-hour 7-day baseline, … rung 4
LightGBM, **every rung on identical folds, rows, gate and threshold** — so "AI
added value" is a measured delta and not a chart. Pair rungs only *within* one
`(run, fold_id, vintage_fidelity)` group: two rungs scored on different rows are
not a delta.

## Reads

- `feature_rows(...)` is the **training** read: sixty-odd columns with lags and
  rolling windows, per row. Do not reach for it to answer a product question —
  it is why `/v1/similar-days` first shipped timing out.
- Anything else goes through `canonical_reads.py`, inside a transaction, with
  the axes written. See [`database.md`](database.md).
- `similar_days.py` is the pattern for a product read from this service: two
  aggregate queries over canonical views, grouped in Postgres.

## The optimizer

The objective is denominated in **MWh-equivalents and never in money**: R$
enters once, after the solve, as a labelled display multiplier. KPIs come from
the simulator re-deriving physics, never from the objective value.

Every plan is checked against NT DOP 0022 §5.1.2's ordem de corte
(`optimizer/conformity.py`) and a plan that would act outside category IV is
**refused**, not captioned.

## Absences

`_refusal(status, code, message, details)` — the shape `ml-proxy.ts` reads the
code out of. The gateway admits the code into its closed enum and discards the
body, so the status and the identifier are what must survive the trip.

Put in the details whatever turns "no" into something an operator can act on.
`/v1/similar-days` carries `latest_programmed_day` because "tomorrow is not
published yet" and "ONS has published nothing for four days" are different
states and only the second is anybody's to chase.

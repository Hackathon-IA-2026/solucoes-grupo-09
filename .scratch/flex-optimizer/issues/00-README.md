# Flex-optimizer + Replay — issue set

Sliced together from `docs/specs/flex-optimizer.md` and `docs/specs/replay.md`,
because they share a simulator. Nineteen tickets: nine here, ten in
`.scratch/replay/issues/`. Each is a tracer bullet — narrow, vertical, verifiable on
its own.

**The one thing this graph exists to make structural.** The optimizer spec's
"single most important line" is that the function scoring a live plan and the
function scoring a replayed plan are *the same function, imported, not
reimplemented*. That is not a convention here, it is an edge: **Flex-optimizer 02**
builds the simulator and carries the repository-wide structural test that exactly one
implementation of the execution rule exists; **Replay 03**, **Replay 08** and
**Forecaster 11** are all blocked on it and all import it. A backtest number and a
forecast number are the same kind of number because of that edge and nothing else.

**The posture is decided and no ticket re-opens it.** The optimizer plans against
P50, the product promises the P10 edge, the user is never asked, and the Mitigate
prototype's basis toggle comes out (Flex-optimizer 07, 08). The `E[Y]` second arm is
*measurement*: Flex-optimizer 09 makes the planning basis an internal parameter and
makes it unreachable from the public surface; Forecaster 11 runs both arms through
this simulator and publishes both. v1 ships P50.

## Flex-optimizer

| # | Title | Blocked by |
|---|---|---|
| 01 | The MILP, proved against the research's own numbers | — |
| 02 | The one simulator, and the execution rule it implements | 01 |
| 03 | A scenario is a URL: canonical encoding, one schema, two languages | — |
| 04 | A nonsensical scenario is refused, never quietly corrected | 03 |
| 05 | The second asset: a shiftable load that always gives the energy back | 01, 04 |
| 06 | One HTTP request, no job id, and a number traceable to its run | 01, 04 |
| 07 | Plan on P50, promise the P10 edge, never ask the user | 02, 04, 06 + **Forecaster 14** |
| 08 | The Mitigate screen: one plan, one promise, and the rule that makes it honest | 03, 07 |
| 09 | The planning basis becomes an internal parameter | 07 + **Forecaster 14** |

## Replay

| # | Title | Blocked by |
|---|---|---|
| 01 | Stop throwing away the out-of-fold forecasts, and make them unservable | **Forecaster 03, 09, 14**; feature spec's `gate_at` |
| 02 | Which days are replayable, and why the others are refused | 01 + **Forecaster 02, 03** |
| 03 | One replay, end to end: same posture, same simulator, scored on what happened | 01, 02, **Flex-optimizer 02, 07** + **Forecaster 14** |
| 04 | Perfect foresight as a fenced upper bound, and the observed-only view | 03 |
| 05 | Vintage is a second, different honesty axis — and it gets measured | 03 + **Forecaster 03** |
| 06 | The replay endpoint: the optimizer's transport, and a link that still means what it meant | 03, **Flex-optimizer 03, 04, 06** |
| 07 | The featured days are a query, and one is a day WattSteer got wrong | 02, 03, **Flex-optimizer 03** |
| 08 | The Backtest: many replays, the same code, no averaging across a caveat | 03, 05, **Flex-optimizer 03** + **Forecaster 03** |
| 09 | Floor coverage becomes a guardrail on the hot-swap | 08 + **Forecaster 13** |
| 10 | The Time Machine screen: the honesty block above the numbers | 04, 05, 06, 07 + **Forecaster 14 (day-grain, see gap below)** |

## The combined graph

```
FLEX-OPTIMIZER
  01 ──┬──► 02 ──┐
       │         │
  03 ──┴► 04 ─┬──┼──► 05
              │  │
              └──┴──► 06 ──► 07 ──┬──► 08
                                  └──► 09 ──► (Forecaster 11)
                       ▲
              Forecaster 14

REPLAY
  Forecaster 03,09,14 ──► R01 ──► R02 ──► R03 ──┬──► R04 ──┐
  Forecaster 02 ─────────────────► R02          ├──► R05 ──┼──► R10
  FO 02, FO 07 ──────────────────────────► R03  ├──► R06 ──┤
  FO 03, FO 04, FO 06 ───────────────────► R06  ├──► R07 ──┘
                                                └──► R08 ──► R09 ──► (Forecaster 13)
```

## Cross-spec edges, listed

| From | To | What crosses |
|---|---|---|
| Forecaster 14 | Flex-optimizer 07 | a served, persisted hour-wise P10/P50/P90 profile at a pinned `ForecastOrigin` |
| Forecaster 14 | Flex-optimizer 09 | `E[Y]` as a served per-hour field |
| Forecaster 03, 09, 14 | Replay 01 | the fold calendar, the backtest that computes out-of-fold predictions, and the `Forecast` / `ForecastOrigin` rows the new `origin_kind` attaches to |
| Forecaster 02, 03 | Replay 02 | artifact cards recording train and calibration windows; F1's start date |
| Forecaster 03 | Replay 05, 08 | `VintageFidelity` per fold, and the straddling-fold split |
| Forecaster 13 | Replay 09 | the hot-swap gate the floor-coverage veto plugs into |
| Flex-optimizer 02 | Replay 03, Replay 08, Forecaster 11 | **the simulator** — imported, never reimplemented |
| Flex-optimizer 03 | Replay 06, 07, 08, Forecaster 11, 18 | the canonical scenario transport and the single published `REFERENCE_FLEET` |
| Flex-optimizer 04 | Replay 06 | the shared validation table — the same blob is accepted or rejected by both endpoints |
| Flex-optimizer 06 | Replay 06 | rate limit, cache discipline, failure posture |
| Flex-optimizer 07 | Replay 03 | the P50-plan / P10-promise path a replay reproduces |
| Flex-optimizer 09 | Forecaster 11 | planning basis as an internal parameter, so the `E[Y]` arm can be built |
| Replay 09 | Forecaster 13 | floor coverage as a comparative guardrail (−5 points vs incumbent) |

## What can start immediately, in parallel

**Flex-optimizer 01 and Flex-optimizer 03.** They share nothing:

- **01** is the MILP against fixture profiles — no transport, no HTTP, no forecast.
  It is the highest-risk ticket in either graph and every silent failure mode lives
  in it, so it should be staffed first regardless of what else is running.
- **03** is the schema, the canonical encoding and `packages/core` — no solver.

Everything else in the optimizer graph is downstream of one of those two.

**Replay 01** can also start immediately *if* the forecaster graph has reached 09 and
14; it has no dependency on any optimizer ticket. If the forecaster graph has not got
there, nothing in the Replay set can start, and the front is the two optimizer
tickets above.

**The widest parallel front** is after **Replay 03**: five tickets open at once —
Replay 04, 05, 06, 07 and 08 — sharing only the replay result object. That is the
point in the Replay graph worth staffing.

On the optimizer side the equivalent is after **Flex-optimizer 07**: 08 and 09 are
independent, and 05 has been available since 04.

## One gap between the issue sets, flagged rather than silently absorbed

`replay.md` names a **hand-back it owes the forecaster**: day-grain ensemble
quantiles (day total P10/P50/P90, peak band, day occurrence) must be *persisted*
alongside the hourly `Forecast` rows, or the Replay screen cannot draw a day band
without summing quantiles — which both specs forbid as a UI invariant violation.
Forecaster 07 *computes* those figures and Forecaster 14 *serves* them, but Forecaster
14's persistence list is hour-grain only: `p`, the three quantiles, the expectation
and the technology split. **Nothing in either issue set persists the day-grain
figures.** Replay 10 carries it as an external blocker; the fix belongs in Forecaster
14 and is a few columns on a companion row, not a contract change.

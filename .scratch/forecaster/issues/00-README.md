# Forecaster — issue set

Sliced from `docs/specs/forecaster.md`. Twenty tickets, each a tracer bullet:
narrow, vertical, verifiable on its own.

**External blocker, named once:** the **feature function** — the vector, the two
feature sets, the publication gate profiles, the label and the threshold
argument — is a separate spec being sliced in parallel into
`.scratch/feature-engineering/issues/`. Nothing here specifies it; tickets 03,
04 and everything downstream of 04 need it to exist. Tickets 01 and 02 do not.

## The tickets

| # | Title | Blocked by |
|---|---|---|
| 01 | The mixture composition, as arithmetic | — |
| 02 | Artifact lanes, the promotion log, and what "current" means | — |
| 03 | The fold calendar as data, and fold discipline that is asserted | — |
| 04 | Train the hurdle on one fold and get a band out | 01, 03 |
| 05 | A stated 80% means 80%, and the risk classes come from the curve | 04 |
| 06 | The P10 carries a coverage statement | 04 |
| 07 | Day totals and peak power, from a path ensemble that nothing sums | 05, 06 |
| 08 | A national band that is not a sum of medians | 07 |
| 09 | The metrics table and the baseline ladder, on identical folds | 03, 05, 06 |
| 10 | Measure whether the optimizer's posture collapses | 09 |
| 11 | Score two planning arms, publish both | 09 (+ the optimizer's simulator) |
| 12 | The shuffled-label control | 09 |
| 13 | The hot-swap gate | 02, 09 |
| 14 | Serve the real band, refuse when there is none, and keep what was said | 02, 07 |
| 15 | The weekly retrain runs by itself, and reproduces itself | 13, 14 |
| 16 | The weather lead-time A/B | 09 |
| 17 | The threshold sweep | 02, 09 |
| 18 | The DESSEM A/B, priced in MWh of promised floor | 09, 11 |
| 19 | Serve two artifacts: the morning view and the evening view | 13, 14 |
| 20 | The transformer benchmark, run once and never promoted | 09, 13 |

## Dependency graph

```
01 ─┐
    ├─► 04 ─┬─► 05 ─┬─► 07 ─┬─► 08
03 ─┘       └─► 06 ─┘       └─► 14 ─┬─► 15
                                    └─► 19
03,05,06 ──► 09 ─┬─► 10                ▲
                 ├─► 11 ──► 18         │
                 ├─► 12              13 ┘
                 ├─► 16
                 ├─► 17
                 └─► 13 ──► 20
02 ──► 13, 14, 17
```

## What can start immediately, in parallel

**01, 02 and 03.** They share no code and no data:

- **01** is fixture arithmetic — no model, no database, no features.
- **02** is the volume, the lane layout and the promotion log — no model at all.
- **03** is the fold calendar and its assertions; only its row-identity check
  waits on the feature function.

## The widest parallel front

Once **09** lands, six tickets open at once and share nothing but the metrics
harness: **10, 11, 12, 13, 16, 17**. That is the point in the graph worth
staffing.

`14` does not wait on `09` — serving needs the artifact store and the ensemble,
not the backtest — so the serving path and the evaluation path can be built
side by side after `07`.

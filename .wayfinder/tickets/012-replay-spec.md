---
id: "012"
title: Replay engine spec — the Time Machine
type: wayfinder:grilling
status: closed
assignee: spec-agent
blocked_by: ["009", "011"]
---

## Question

How does WattSteer re-run a historical day honestly?

IDEA.md §34 gives the five steps: restrict to D-1 information, forecast,
recommend, reveal what actually happened, simulate the portfolio.

- **The integrity question.** A model trained on 2023→now has seen the day being
  replayed. A replay using that model is not a real counterfactual. Options:
  train a fold-specific model excluding the replayed period, restrict replay to
  the walk-forward test folds only, or label the result honestly. Pick one and
  make the UI say what it is.
- **The vintage question.** For days before ingestion go-live there is no true
  point-in-time view, so replay uses revised data. What does the screen say
  about that?
- Which days are replayable — a curated set of notable events, or any date?
- Is a replay computed on demand or precomputed and stored?
- The simulation: the optimizer runs against the *forecast*, but the avoided
  energy must be measured against the *actual*. Define that arithmetic exactly,
  including what happens when the forecast underestimates.
- Output contract feeding the §45 / §47 screens: actual MWh, forecast P50/P90,
  absorbed MWh, remaining, avoided, reduction %.

Use `/grilling`.

## Resolution

Spec: [`docs/specs/replay.md`](../../docs/specs/replay.md).

**The integrity question — options 1 and 2 are the same option.** "Train a
fold-specific model excluding the replayed period" and "restrict replay to the
walk-forward test folds" differ only in granularity, and `forecaster.md`'s fold
calendar has already fixed the granularity at a quarter. So the real choice was
binary, and it is decided: **integrity is a precondition, not a label.** Every
replay is served by an artifact whose training *and* calibration windows exclude
the replayed day, asserted at read time against the artifact card. Two
provenances qualify — `served` (the `Forecast` rows the live path already
persists) and `fold_holdout` (the out-of-fold predictions the backtest already
computes and currently discards, now persisted). Days in the pre-F1 training
block, 2024-04-01 → 2025-03-31, are **refused, not labelled**: they get an
observed-only view with the perfect-foresight bound and no WattSteer number.
Option 3 survives as a supplement for the vintage question, where nothing else
is possible, and is explicitly rejected for the in-sample question, where
something else is. The cost — a year of the window — is stated rather than
hidden.

A consequence for the screen: the prototype's `inTrainingWindow` compares the
date against the *serving* artifact's training cut, which is the right question
asked of the wrong artifact. Under this spec no replayable day is in-sample, the
`IN-SAMPLE` warning branch is unreachable, and the badge becomes a **provenance**
statement naming the artifact and its windows.

**The vintage question — a different problem, not the same one twice.**
In-sample-ness is about the model's information set and is fixable by
construction; vintage is about the data's and can never be repaired. The caveat
is made *proportionate* rather than blanket: `revision_optimistic` affects the
settled actuals and the lagged-actual features, and explicitly **exempts the
weather run, DESSEM and the ONS programming**, which are cut on `published_at`
and are genuinely point-in-time even in backfill. And it is measured, not
asserted — `revision_premium_recovered_mwh`, the MWh analogue of the
forecaster's `revision_premium_qloss`; until it exists the screen says
"unmeasured" in those words. The two axes are collinear in v1 (every
`fold_holdout` day is `revision_optimistic`, every `served` day is
`point_in_time`), which is exactly why a merged badge is refused: it would be
observationally correct now and wrong the moment F7 opens on a post-go-live
quarter.

**Which days.** Both. Any held-out date is addressable by URL under a published
`replayable(d)` predicate; the screen's shortlist is a **deterministic query,
not a hand-picked list** — top days by observed total, the largest forecast
error, one day per fidelity and per provenance class, and mandatorily **the day
with the largest shortfall against its own promised floor**. Selecting featured
days on outcome is the same failure the shuffled-label control catches one layer
down, so a test asserts the bad-day clause is present and non-empty.

**Precomputed or on demand — split at the seam.** The **forecast is
precomputed** (artifact load, `gate_at` feature build, mixture composition,
500-member ensemble) and persisted as `Forecast` rows; the **plan and every KPI
are computed on demand** (3.15 ms MILP + four simulator passes). So changing the
fleet re-plans and never re-forecasts, and a replay contains no model in the
request path at all. Cache key mirrors the optimizer's, plus `target_date`.

**The arithmetic, exactly.** Plan on `f50` of the pinned D−1 vintage; score
`f10`, `f50`, `f90` **and the observed** with the one imported simulator;
headline on the observed. `actual_mwh = Σ a[t]` is always the denominator;
absorbed ≡ recovered ≡ avoided is one quantity with one name; `reduction` is
`null` unless some hour reaches `threshold_mw`. The asymmetry the ticket asked
for: over-forecasting is clipped by the execution rule (`executed_charge ≤ a[t]`)
and the shortfall is reported, with SOC recomputed from the *executed* dispatch;
**under-forecasting leaves real curtailment on the table and the simulator must
not take it** — absorbing it would be intraday re-optimisation against
information the plan did not have, inflating recovery on exactly the days the
forecast was worst. So under-forecasting shows up as a **lower reduction
percentage, never a smaller actual**, and a bad forecast can only hurt the
headline. A worked three-hour example ships as an asserted fixture
(160/240 = 66.7 %, floor 60, floor met). Perfect foresight is fenced under
`upper_bound` with `forecast_value_gap_mwh`, and it is the only thing offered on
an observed-only day.

**Floor coverage, and the map's open gate item.** `floor_met` per day,
`floor_coverage` per fold/subsystem/fidelity, never averaged across fidelities.
The floor is not a per-day theorem — the simulator's monotonicity holds only
under pointwise domination — so it is an empirical claim the product checks. The
gate threshold, deferred here by two specs, is **closed with no absolute
constant**: floor coverage is a comparative guardrail in the hot-swap (a
candidate more than 5 points below the incumbent on the shared fold is vetoed),
in the same constant-free shape as the forecaster's gate.

**Output contract** carries `planning_basis: "p50"` **and** `scored_on:
"observed"`, because a Replay evaluates the domain model's §6 scalars on the
observed realisation while an `OptimizationResult` evaluates them on the
planning envelope — same names, different realisation, so the realisation is
named on the object. `day_total` comes from the path ensemble and never from
summing the hourly band. `dispatch` (scheduled) and `executed` are two series.
The denominator is the whole local day, not the episode.

**Hand-back to ticket 009**, small and load-bearing: persist day-grain ensemble
quantiles alongside the hourly `Forecast` rows, and persist the backtest's
out-of-fold predictions with `origin_kind = 'backfilled_holdout'`. Both are
computed already and both are discarded.

**Six calls listed for the dev**, the first being the central one: pre-F1 days
are refused rather than labelled, at a cost of a year of the window. Four
contradictions with the prototype are named rather than smoothed — the
wrong-artifact `inTrainingWindow`, the summed forecast band, the episode-total
denominator, and the reference fleet inheriting Mitigate's invalid flexible
load.

# 09 — Floor coverage becomes a guardrail on the hot-swap, and carries no invented constant

**What to build:** a candidate forecasting artifact that would quietly make WattSteer's
promised floor less reliable is vetoed at the weekly hot-swap — and the veto is a
comparison against the incumbent, not a bar someone made up before the first honest
numbers existed.

This closes the map's open backtest-gate item, which two specs deferred to this one:

> Floor coverage is a **comparative guardrail** in the weekly hot-swap: a candidate
> artifact is vetoed if its floor coverage on the shared newest fold, computed against
> the published reference fleet, is more than **5 percentage points** below the
> incumbent's. It is a veto and never the decision, so a wrong constant blocks a swap
> rather than choosing one. **No absolute floor is set**, because an hour-wise P10
> envelope has no day-level nominal level to compare against — the joint probability
> that all 24 hours land at or above their own P10 is not 90 %, is not computed, and is
> not claimed.

That shape matters as much as the number: it is the same constant-free construction the
forecaster's gate uses, and it is placed where a wrong value costs a promotion rather
than choosing one. The −5 points is judgement, and the first two `point_in_time` folds
should be used to check it is not so tight that nothing ever promotes.

The comparison is only meaningful if both sides are computed against the same fleet, so
the guardrail reads `REFERENCE_FLEET` and stamps it on the decision alongside the fold
and the fidelity it was decided on.

The gate that consumes this is the forecaster's; this ticket supplies the metric, the
comparison and the veto, and wires them in.

**Blocked by:** 08. **Cross-spec, external: Forecaster 13** (the hot-swap gate this
guardrail plugs into, whose ordered check list and its own guardrail block it joins).

**Status:** done

- [x] Floor coverage for candidate and incumbent is computed on the **shared newest
      fold**, against `REFERENCE_FLEET`, at the same `VintageFidelity`
- [x] A candidate more than 5 percentage points below the incumbent is vetoed
- [x] The guardrail is a veto and never the promotion decision; a candidate cannot be promoted *because* its floor coverage is higher
- [x] No absolute floor-coverage bar exists anywhere in the code
- [x] The decision record names the fold, the fidelity, the fleet and both coverages
- [x] Cold start with no incumbent does not silently pass: the veto is recorded as not applicable rather than as satisfied

---

## What was built

`apps/ml/src/wattsteer_ml/replay/floor_guardrail.py` — the metric, the
comparison and the veto — wired into check 6 of the hot-swap gate
(`apps/ml/src/wattsteer_ml/evaluation/gate.py`), which forecaster 15's weekly
driver (`retrain.py` → `run_gate`) already runs once per lane.
`apps/ml/tests/test_floor_coverage_guardrail.py` is the acceptance suite.

**Every constant it applies, and where each came from.** There is exactly one:
`FLOOR_COVERAGE_SLACK = 0.05`, the five percentage points written in
`docs/specs/replay.md` ("Floor coverage, and the map's open gate item") and
restated in this ticket. It is only ever *subtracted from a measured incumbent
coverage* — `candidate ≥ incumbent − slack`, per subsystem — so there is no
value of it that could promote anything, only block. `test_the_module_publishes_
exactly_one_numeric_constant` pins that it is the module's only numeric
constant and that it appears in exactly one expression. Everything else the
guardrail uses is read rather than chosen: the fleet is `REFERENCE_FLEET`
through `PUBLISHED_FLEET`, the planning basis is the optimizer's `PLANNING_BASIS`
imported as `SHIPPED_BASIS`, the horizon is `HORIZON_HOURS`, the floor is the
simulator's `recovered_floor_mwh`, and the fold, the fidelity and the row set
all come off the gate's own deciding segment.

**The floor event has one definition.** `replay/scoring.py` gained
`floor_was_met(band, observed)`; `ReplayScores.floor_met` now delegates to it and
so does this guardrail, so a Backtest's `floor_coverage` and the gate's count the
same event. No arithmetic on hours was written here.

## Two readings this had to choose between, and the choice is stated

- **What the candidate's floor coverage is measured over.** A `Backtest` is many
  `Replay`s of *published* forecast rows, and a candidate at the gate has
  published nothing — there is no row to replay until after the swap this
  guardrail is deciding. So both coverages are computed from the two artifacts'
  **composed hours on the deciding fold segment**: the very sequences the paired
  bootstrap already refuses unless they carry identical keys, in identical order,
  against identical labels. That is the same construction as the forecaster's
  `Δ recovered_floor_mwh`, and it is deliberately not the Backtest's number —
  `FloorCoverageProvenance` stamps `floor_coverage_source: fold_evaluation` for
  exactly that reason, in the same shape as `correction_regime`,
  `background_source`, `collapse_source`, `arm_source` and `lead_time_source`.
- **Per subsystem, never pooled.** `replay.md` puts floor coverage at fold ×
  subsystem × fidelity grain and `replay/backtest.py` refuses to pool it, because
  a share over two subsystems averages two different fleets' worth of
  curtailment. So the guardrail is one rail per subsystem — `floor_coverage[NE]`,
  beside the existing `pr_auc[NE]` — and any one of them falling is the veto.

## What the gate had to acquire

`Guardrail` gained a third state. It was two-valued, and an unmeasurable
guardrail *vetoes* — which is right for `ece` and wrong for a **comparative**
guardrail with no incumbent. A cold start has nothing to be five points below, so
`applicable=False` is recorded and `Guardrail.__post_init__` refuses to let such
a rail also claim `passed=True`. Only `Guardrail.vetoes` is read by the decision,
so a not-applicable rail can neither block a swap nor claim to have cleared one.

## What is **not** done, and cannot be yet

> The −5 points is judgement, and the first two `point_in_time` folds should be
> used to check it is not so tight that nothing ever promotes.

**This check has not been performed and no number here stands in for it.** There
are no `point_in_time` folds yet — a fold is point-in-time only past ingestion
go-live — and forecaster 15 recorded the structural consequence that gates the
rest: check 4's sixty-test-day floor plus a quarterly live edge means promotion
is only possible in roughly the last third of each quarter. So the first two
point-in-time folds are two quarters of live ingestion away, and until they exist
the honest statement is that **the constant is spec'd but unvalidated against
data**. It is placed where being wrong costs a promotion rather than causing one,
which is the whole reason it was safe to ship undated. When those folds land, the
thing to measure is the distribution of `incumbent − candidate` floor coverage
across weekly runs: if it is routinely wider than 0.05 while `qloss` improves,
the slack is too tight and the number — not the shape — is what changes.

Two related notes for whoever picks that up:

- Long runs of weekly refusals naming `freshness_and_coverage` are the system
  working, not a guardrail failure. Do not read them as evidence about this
  constant; the floor guardrail is check 6 and never runs on those weeks.
- The guardrail holds no cross-lane state — it is computed from the hours of the
  two artifacts it is handed — so forecaster 19's independence property is
  preserved by construction rather than by care. There is a test for it anyway.

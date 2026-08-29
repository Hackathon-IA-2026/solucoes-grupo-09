# 09 — The planning basis becomes an internal parameter, so the alternative can be measured

**What to build:** the MILP builder can be handed *any* named planning envelope —
P50 today, `E[Y]` for measurement — while the public product still ships exactly one
plan built on P50, with no way for a request to ask for anything else.

This is the structural half of a decision that was just taken: the backtest scores a
**second planning arm against `E[Y]`** through this spec's simulator, unchanged, and
publishes both arms' `recovered_floor_mwh`. v1 still ships the P50 plan; the second
arm is measurement, not a product option. This ticket makes the arm *possible* and
makes exposing it *impossible*; the Replay graph's ticket 10 runs it.

The reason the arm exists is an asymmetry the P50 choice was not made for. The
execution rule makes over-planning nearly free — an asset charges the scheduled
amount or what is actually being curtailed, whichever is smaller — while a plan that
is blind in an hour cannot act in it at all. And the forecaster's arithmetic says a
P50-planned dispatch sees zero offered energy in every hour more likely than not to
be quiet, so the plan's shape is decided by the *classifier's* operating region
rather than by the magnitude model. `E[Y] > P50` exactly when `p < 0.5` — the
expectation is non-zero in precisely the hours where the P50 plan goes blind. The
objection that killed scenario-weighting does not apply: an hour-wise quantile
envelope is not a physically realisable day, whereas `E[Y]` is a genuine expectation
and adds across hours legitimately.

The scope here is narrow and entirely about the seam: the builder takes the envelope
as an argument, the result records which one it was in `planning_basis`, and the
simulator and every KPI definition are untouched — the whole point is that the two
arms are comparable because they differ in exactly one input.

**Blocked by:** 07. **Cross-spec, external: the Forecaster spec must serve `E[Y]`
as a persisted per-hour field alongside the quantiles.**

**Status:** ready-for-agent

- [ ] The builder accepts the planning envelope as a parameter; nothing else in the model, the simulator or the KPI definitions changes between arms
- [ ] `planning_basis` on the result names the envelope actually used
- [ ] A test asserts no request body key, query parameter or scenario field can select the planning basis, and that the public endpoint always returns `"p50"`
- [ ] Both arms score through the same simulator function — the one from ticket 02, imported
- [ ] Building the same scenario twice on the same envelope is deterministic, so an arm difference is attributable to the envelope and to nothing else

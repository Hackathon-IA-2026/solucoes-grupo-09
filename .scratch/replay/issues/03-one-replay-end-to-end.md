# 03 — One replay, end to end: same posture, same simulator, scored on what happened

**What to build:** for a held-out day and a user-supplied fleet, WattSteer shows what
it would have said at D−1, what it would have told the fleet to do, and what that
plan would actually have recovered against the day that happened — with the floor it
promised at D−1 sitting beside the result and a boolean saying whether it was met.

**A replay never runs a model.** The forecast is a lookup of pinned rows; the plan and
every KPI are computed on demand, because the MILP is 3.15 ms and four simulator
passes are free. So changing the fleet re-plans and **never** re-forecasts, and no
interaction can change what the model said at D−1 — which is the property that makes a
replay a replay.

**Step 1 — plan.** One MILP, the live builder, unchanged:

```
plan = optimize(curt = f50, S)          planning_basis = "p50"
```

The P50 of the pinned D−1 vintage, resolved through `AsOf(published_at)`. Not P10, not
the revised forecast, not the actuals.

**Step 2 — score four realisations with one function.** The simulator from the
Flex-optimizer spec, **imported, not reimplemented**, executed once per realisation
`r ∈ {f10, f50, f90, a}`, where `a[t]` is the observed `constrained_off_mwh` read
`AsOf(now)`.

**Step 3 — the headline, on the observed realisation.** The denominator is
`Σ_t a[t]`, always. `avoided_energy_mwh ≡ recovered_mwh ≡ absorbed_mwh` — one quantity
with three names, and the screen renders one headline for it. `reduction` is `null`
unless some hour reaches `threshold_mw`.

**Step 4 — the promise, checked.** `recovered_floor_mwh = Σ_t absorb_p10[t]` is what
was promised at D−1; `floor_met = recovered_mwh ≥ recovered_floor_mwh`, with the
margin reported.

**The two directions of forecast error are not symmetric, and this is the ticket's
real content.** When the forecast over-estimates, the execution rule clips charging to
what was really there: nothing is imported and the shortfall is real and reported.
Second-order and easy to miss — the battery is now emptier than the plan assumed, so a
later scheduled discharge may itself be clipped by available SOC, which is why the
simulator must recompute SOC from the executed dispatch. When the forecast
**under**-estimates, there is real curtailment sitting in the hour that the plan never
asked for, and the simulator **must not take it**:

> `absorb[t]` is bounded by `Δ[t]`, which derives from the **scheduled** dispatch.
> Absorbing up to `min(headroom, a[t])` would be an intraday re-optimisation against
> information the plan did not have. It is hindsight, and it would inflate recovered
> energy on exactly the days the forecast was worst.

The unabsorbed excess flows straight into `remaining_mwh`, so **under-forecasting shows
up as a lower reduction percentage, never as a smaller actual.** A bad forecast cannot
flatter a replay through the percentage; it can only hurt it.

The contract carries `scored_on: "observed"` beside `planning_basis: "p50"`, because
the top-level domain-model scalars mean something different here than in an
`OptimizationResult`: there they are evaluated on the planning envelope, here on the
observed realisation. Same field names, different realisation — so the realisation is
named on the object and no reader has to infer it. Without that field the two results
are a trap. The denominator is the **whole local day**, not the episode; episodes are a
read-time view carried for narration, with their `threshold_mw` and `max_gap_hours`
on the result so the run of hours shown is traceable to the parameters that produced it.

**Blocked by:** 01, 02; **Flex-optimizer 02** (the simulator — this is the import that
makes a backtest number and a forecast number the same kind of number), **Flex-optimizer
07** (the P50-plan / P10-promise path this replays). **Cross-spec, external: the
Forecaster spec's persisted hour-wise band.**

**Status:** ready-for-agent

- [ ] A structural test asserts Replay's scoring path calls the optimizer package's `simulate`, and that exactly **one** implementation of the execution rule exists in the repository — a grep/AST-level check, in the default test path, because a second copy is the failure no unit test sees
- [ ] *Under-forecast* fixture (`a = 2·f50`): absorption is unchanged from the `f50` scoring, the entire excess lands in `remaining_mwh`, `actual_mwh` is the observed total, and avoidability falls by roughly half
- [ ] *Over-forecast* fixture (`a = 0.5·f50`): every hour's absorption is clipped to `a[t]`, the SOC trajectory is recomputed from the executed dispatch, and no hour imports
- [ ] *All-zero actual*: recovered is exactly 0, nothing is imported, `avoidability` is `null`
- [ ] The spec's worked example ships as a fixture with its numbers asserted: 160 / 240 = 66.7 %, floor 60, floor met
- [ ] `simulate(optimize(r, S), r).recovered_mwh` equals the MILP's own absorbed quantity within 1e-6 for any realisation
- [ ] The result carries `scored_on`, `planning_basis`, `execution_rule`, `floor_met` and `floor_margin_mwh`, plus `scored` for p10 / p50 / p90 / observed
- [ ] `dispatch` (scheduled, on the P50 envelope) and `executed` (against the observed) are two distinct series and are equal only when the realisation equals the planning basis
- [ ] The denominator is the day total; a change to `threshold_mw` moves which episodes are drawn and never moves the percentage
- [ ] The forecast is a pinned-row lookup: no joblib load, no feature build and no ML-service forecast call in the request path

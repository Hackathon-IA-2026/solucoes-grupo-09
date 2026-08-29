# 02 — The one simulator, and the execution rule it implements

**What to build:** WattSteer can take any dispatch plan and any named realisation
of a day and say honestly what the fleet would have absorbed — and there is
exactly **one** piece of code in the repository that knows how to do it.

This is the ticket the product's central proof rests on. The plan comes from the
MILP; every KPI comes from here. The objective value is never a KPI — it carries
the throughput penalty and is not a physical quantity. It is returned under
`solver.objective` for debugging and is never rendered.

The execution rule is the mechanism that makes planning optimistically coherent,
and it is stated in the contract as well as implemented here:

> The plan is a schedule of *intended* dispatch. On the day, an asset charges the
> scheduled amount **or the amount actually being curtailed, whichever is
> smaller**, and discharges the scheduled amount or what its state of charge
> actually permits, whichever is smaller.

```
for each hour t:
    executed_charge    = min(plan.ch[t], headroom(soc), realisation[t])
    executed_discharge = min(plan.dis[t], available(soc))
    Δ[t]               = executed_charge − executed_discharge
                         + plan.up[t] − plan.down[t]
    absorb[t]          = max(0, min(Δ[t], realisation[t]))
    soc               += ηc·executed_charge − executed_discharge/ηd
```

Two things the prototype's `evaluatePlan` does not do and must: **recompute the
state of charge from the executed dispatch** rather than carrying the planned
trajectory — today it clips absorption but not SOC, so on a small day it reports a
battery filling up on energy it never received — and **clip discharge to the
available SOC**, which is what makes the trajectory physical on a realisation the
plan was not built for. The prototype is corrected in the same change, because the
two are supposed to be the same function.

The KPI definitions live here and nowhere else:

```
baseline_mwh   = Σ_t  curt[t]        on the realisation being scored
recovered_mwh  = Σ_t  absorb_sim[t]
remaining_mwh  = baseline_mwh − recovered_mwh
avoidability   = recovered_mwh / baseline_mwh
```

`baseline_mwh` is **not** filtered by `threshold_mw` — the threshold is a property
of the `CurtailmentHour` label and has nothing to do with what a battery can
absorb; filtering the denominator by it would make the Avoidability Score move
when someone changes an episode-detection parameter. The threshold instead gates
*whether the ratio is defined*: `avoidability` is `null` unless the realisation
being scored contains at least one hour at or above `threshold_mw`. Evaluated per
realisation, so a `null` at P10 beside a real number at P50 is legitimate. Avoided,
recovered and absorbed energy are **one quantity with one name**.

**Blocked by:** 01 — the plan shape and the efficiency split come from the builder.

**Status:** done

- [ ] One function, in one place, imported by the live path, by Replay and by the tests; a structural check (grep/AST level, in the default test path) asserts exactly one implementation of the execution rule exists in the repository
- [ ] Monotonicity, property-based: if a realisation `r ≥ P10` pointwise then `recovered(plan, r) ≥ recovered(plan, P10)` — the floor is a floor over the band, not a hope
- [ ] The state of charge never leaves its bounds under any realisation, and is recomputed from the executed dispatch
- [ ] Absorbed never exceeds offered; `avoidability ∈ [0, 1]` by construction, asserted, or `null`
- [ ] A plan built on P50 and executed against an all-zero realisation absorbs exactly **zero** and imports **nothing**
- [ ] `avoidability` is `null`, never `0`, when the scored realisation has no hour at or above `threshold_mw`; the threshold never enters the ratio
- [ ] `simulate(optimize(r, S), r).recovered_mwh` equals the MILP's own absorbed quantity within 1e-6 for any realisation `r` — the plan and the simulator agree
- [ ] `stored_at_horizon_end_mwh` and `round_trip_loss_mwh` are computed here, because "recovered" is not "delivered"
- [ ] The prototype's `evaluatePlan` is replaced by this function rather than left beside it

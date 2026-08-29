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

**Status:** ready-for-agent

- [ ] Floor coverage for candidate and incumbent is computed on the **shared newest
      fold**, against `REFERENCE_FLEET`, at the same `VintageFidelity`
- [ ] A candidate more than 5 percentage points below the incumbent is vetoed
- [ ] The guardrail is a veto and never the promotion decision; a candidate cannot be promoted *because* its floor coverage is higher
- [ ] No absolute floor-coverage bar exists anywhere in the code
- [ ] The decision record names the fold, the fidelity, the fleet and both coverages
- [ ] Cold start with no incumbent does not silently pass: the veto is recorded as not applicable rather than as satisfied

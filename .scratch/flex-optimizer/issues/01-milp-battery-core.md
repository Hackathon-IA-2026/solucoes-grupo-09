# 01 — The MILP, proved against the research's own numbers

**What to build:** given an hourly curtailment profile for one `Subsystem` and one
`Battery`, WattSteer produces a 24-hour dispatch schedule — charge, discharge and
state of charge per local hour — that a real inverter could execute, and it
reproduces the number the research measured rather than a plausible one.

This is the tracer bullet for the whole engine, and the reason it goes first is
that every failure mode here is silent: the model stays feasible, the status says
`OPTIMAL`, and the headline is *better*. So this ticket is judged by the
regressions it makes impossible, not by the dispatch it returns.

The formulation is §2 of `docs/research/optimizer-formulation.md` verbatim — its
variables, its (B1)–(B8) and its (C1)–(C5). Four choices that file leaves to the
implementer are fixed by the spec and belong here: **(B7)–(B8) ship**, one binary
per battery per period; the Chen–Baldick tightening (B3a)/(B3b) is *not*
implemented; there is **no terminal state-of-charge constraint**; and the horizon
is the 24 hours whose local civil date in `America/Sao_Paulo` is the Scenario's
`target_date`, derived from the IANA zone rather than a fixed offset and asserted
to be exactly 24. Storage stays UTC; local indexing exists only at the model
boundary.

Two corrections to IDEA.md are load-bearing and are what this ticket exists to get
right. First, the round-trip efficiency splits: the loss enters the SOC balance
asymmetrically, `×ηc` in and `÷ηd` out, and the builder derives `ηc = ηd = √RTE`
from the single number a datasheet prints. Second, the absorbed quantity is the
**net** increase in flexible demand, and its sign split is a *build-time* branch
on the parameter `curt[t]`:

```
Δ[t]  = Σ_b ( ch[b,t] − dis[b,t] ) + Σ_l ( up[l,t] − down[l,t] )      (C1)
absorb[t] ≤ Δ[t]                                                       (C4)
```

Writing that as an unconditional `absorb[t] ≤ Δ[t]` with `absorb[t] ≥ 0` silently
implies `Δ[t] ≥ 0` in every hour and yields a feasible, plausible plan in which the
battery **never discharges**. That is the exact bug the research hit.

The objective is denominated in MWh-equivalents and never in money:

```
minimise   Σ_t ( curt[t] − absorb[t] )                       … c_curt = 1
         + Σ_b Σ_t  δ_b · ( ch[b,t] + dis[b,t] ) · Δt

δ_b = ρ · k_b / (2 + k_b) ,   k_b = (1 − RTE_b) / RTE_b ,   ρ = 1.5
```

`δ_b` is a tie-breaker anchored on the research's §4.3 venting threshold, not a
degradation model; `ρ` is configuration (`WATTSTEER_DEG_PENALTY_RHO`), never a
scenario input. `c_energy` is dropped outright: (C2)/(C5) already forbid buying
grid energy, so a price on it would price a quantity the constraints force to zero.

Solver: OR-Tools' `linear_solver` wrapper, backend from `WATTSTEER_MILP_BACKEND`,
default `SCIP`, `HIGHS` permitted. **`CBC` is refused at startup with a fatal
error** — it aborts the whole Python process on a duplicate variable name, which
in a worker is a crash and not an exception. **CP-SAT is not a configuration
option at all**: the SOC balance over the integers becomes a divisibility
constraint and it fails silently, not loudly.

**Blocked by:** None — can start immediately. The forecast profile is a fixture at
this stage; wiring it to a real `Forecast` is ticket 07.

**Status:** done

- [ ] The research's reference case (`curt = [0]×10, 20, 70, 110, 90, 30, 10, [0]×8`, one 100 MW / 250 MWh battery, `ηc = ηd = 0.959`, SOC 20 % initial, bounds 5–95 %) returns `OPTIMAL` with **95.4 MWh** remaining at `ρ = 0`
- [ ] At the shipped `ρ = 1.5` the same case is within 0.1 MWh of 95.4 — the penalty breaks ties and never buys off a real MWh
- [ ] The venting regression: the same model solved as an LP with (B7)–(B8) omitted and `ρ = 0` is *strictly better* by ≈ 15 MWh and charges and discharges simultaneously in five hours. This test fails if anyone relaxes the binaries away
- [ ] The LP cross-check at the shipped weights: the relaxation's objective equals the MILP's and no hour has simultaneous charge and discharge
- [ ] `δ_b · (1 + RTE_b) < 1` is asserted at build time for every battery, as a WattSteer bug and not a bad request
- [ ] The sign-split test: on a profile whose curtailment ends before the day does, the battery net-discharges in at least one hour
- [ ] The netting test: total absorbed energy never exceeds what the fleet can physically hold; the charge-only objective violates it
- [ ] The no-import tests: `Δ[t] ≤ curt[t]` in every hour and `Δ[t] ≤ 0` in every hour with no curtailment
- [ ] An asset outside its `available_from`/`available_to` window has every decision variable fixed to zero; a battery's SOC simply persists
- [ ] Every MILP variable has a unique name, asserted; the solution is extracted into plain Python objects before the `MPSolver` goes out of scope
- [ ] `CBC` fails at startup; `SAT` / `CP_SAT` are rejected by the backend allow-list; `ortools_version` and `scip_version` are read at runtime, not hard-coded
- [ ] The reference case solves in under 500 ms in CI — a loose guard against an accidental `O(T²)` builder, not a benchmark

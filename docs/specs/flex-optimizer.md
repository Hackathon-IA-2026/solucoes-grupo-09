# Spec — WattSteer Flex Optimizer

> The third engine: a day-ahead curtailment forecast plus a user-supplied
> flexibility fleet → a dispatch plan, an honest recovery number, and an
> Avoidability Score.
>
> **Evidence base.** The formulation, the solver choice and every timing claim
> below come from [`../research/optimizer-formulation.md`](../research/optimizer-formulation.md),
> which was **built and measured, not argued**, and which remains the authority.
> This spec *decides*; it does not re-derive. Where a number appears here
> (3.15 ms, 16 %, `c_deg > c_curt·k/(2+k)`) it is quoted from that file.
>
> **Naming authority.** [`../domain-model.md`](../domain-model.md) §6 owns
> `FlexibilityAsset`, `Scenario`, `OptimizationResult`, `Replay` and
> `avoidability`. Where this spec and the domain model disagree, the domain
> model wins; the two deliberate extensions this spec adds to §6's shapes are
> listed in [Further Notes](#further-notes).
>
> **Companion specs.** [`data-platform.md`](data-platform.md) supplies the
> curtailment forecast this engine consumes and owns everything about how it got
> there. The **Forecaster spec** (ticket 009) owns the P10/P50/P90 profile's
> production and calibration; this spec consumes it as a contract. The **Replay
> spec** (ticket 012) owns the Time Machine, but the comparability rule it must
> obey is *decided here* and is not negotiable there. The **API surface**
> (ticket 013) may re-path the endpoints; the request/response contract is fixed
> here.
>
> Ticket: [`011-optimizer-spec.md`](../../.wayfinder/tickets/011-optimizer-spec.md).
> Map: [`../../.wayfinder/map.md`](../../.wayfinder/map.md).
> Status: **ready-for-agent**. Nothing here is left open. The three judgement
> calls most worth a second opinion are listed at the end.

## Problem Statement

WattSteer's first two engines tell an operator that ~400 MWh of wind will be
constrained off in the Northeast tomorrow, and why. That is a better forecast of
a loss, not a way out of it. The third engine has to answer the question the
first two provoke: **given a battery and a shiftable load, how much of that is
recoverable, and what exactly should the assets do?**

Four things make this harder than "run a solver".

**The obvious relaxation is wrong, and wrong in the flattering direction.** The
standard folklore — that round-trip losses make simultaneous charge and
discharge unprofitable, so the mutual-exclusion binaries can be dropped and the
MILP becomes an LP — is a *price-dependent* property, and curtailment is exactly
the regime where the price condition fails. Measured on the reference profile,
the LP claimed **16 % more recovered energy than the battery can physically
hold**, by charging and discharging simultaneously in five of six curtailment
hours to vent stored energy and free headroom. The energy it vented went
nowhere the objective could see. An LP here would overstate the product's
central claim by 16 %, in the direction that sells it.

**The objective as sketched double-counts.** IDEA.md §28's
`minimize Σ curtailment_remaining[t]` is under-specified: read naively, the
absorbed quantity is the charge alone, discharging in an oversupply hour is
free, and the model reports absorbing more than the asset can hold — the same
error as the LP, arrived at from a different direction. IDEA.md §29 has a second
defect: a single `efficiency` term, where the loss enters the state-of-charge
balance asymmetrically and must be two numbers.

**The forecast is a band and the plan is one plan.** The optimizer is handed
P10/P50/P90 per hour and must emit a single dispatch. Which point of the band it
optimises against is not a solver question — the research established that all
four candidate postures fit the same model and the same latency budget — it is a
question about **what the product promises a user about a forecast it knows is
uncertain**. The screens prototype exposed the choice as a user toggle and
flagged that as probably wrong. It is wrong: it hands the user a modelling
question, and it makes two runs of the product non-comparable, because both the
plan *and* the number change.

**And there is no fleet.** ONS publishes no flexibility-asset registry. Every
asset parameter is a user-supplied what-if, arriving over a public,
unauthenticated endpoint with no accounts behind it, into a process that runs a
branch-and-bound solver. The scenario has to be carried, validated, bounded and
shared without inventing storage or identity.

## Solution

A mixed-integer linear program, built per request, solved synchronously in
single-digit milliseconds, and reported through a separate simulator that is the
only thing allowed to produce a KPI.

The model is the research's §2 verbatim: batteries with a real binary per
period for charge/discharge mutual exclusion, shiftable load in Zerrahn &
Schill's double-indexed form which needs no binaries and conserves daily energy
by construction, coupled to the forecast through a net-flexible-demand quantity
that nets discharge out and cannot import from the grid. OR-Tools' linear-solver
wrapper with SCIP; HiGHS as a configured fallback; CBC refused at startup;
CP-SAT structurally disqualified.

Three decisions turn that model into a product.

**The optimizer never sees money.** The objective is denominated in
MWh-equivalents: unabsorbed curtailment at unit weight, plus a small,
dimensionless battery-throughput penalty whose only job is to break ties between
dispatches that recover the same energy. There are no Brazilian cost values to
find because none is needed. R$ enters exactly once, *after* the solve, as a
labelled display multiplier on recovered energy.

**The plan is optimistic and the promise is conservative.** The MILP is built
against P50. The plan is then executed and scored by a simulator with an
explicit execution rule — *charge what is actually being curtailed, never more*
— which makes importing from the grid impossible by construction rather than by
pessimism. The plan is scored against all three envelopes with one shared
evaluator, and **the number the product promises is the P10 edge**. The user is
never asked to choose a quantile.

**Every KPI is computed by that simulator, never read off the objective.** The
objective value carries a throughput penalty and is not a physical quantity.
Recovered energy, remaining curtailment and avoidability come from simulating
the plan against a named realisation, and Replay is required to call the same
function on observed data. That single shared code path is what makes a backtest
comparable to a forecast, and it is the product's central proof.

## User Stories

**The plan itself**

1. As an operator, I want to see hour-by-hour what each asset should do, so that
   the recommendation is actionable rather than a headline number.
2. As an operator, I want the battery's state of charge drawn alongside the
   dispatch, so that I can see why it stopped charging when it did.
3. As an operator, I want the plan to never charge from the grid, so that
   "recovered renewable energy" means energy that would otherwise have been
   spilled and nothing else.
4. As an operator, I want a charge and a discharge in the same hour to be
   impossible, so that the plan describes something a real inverter can do.
5. As an operator, I want a flexible load's shifted energy always given back
   within its shift window, so that "shifted" never quietly means "avoided".
6. As an operator, I want a load never shed by more power than the process
   actually draws, so that the plan does not shed load that does not exist.
7. As an operator, I want assets honoured only inside their availability
   window, so that a battery contracted for 11:00–18:00 is not dispatched at
   03:00.
8. As an engineer, I want the absorbed quantity to be the *net* increase in
   flexible demand, so that discharging in an oversupply hour cannot be counted
   as absorption.
9. As an engineer, I want the battery able to net-discharge in some hour of the
   day, so that the sign-split bug the research hit — a model that stays
   feasible, looks plausible, and silently never discharges — cannot recur.

**Uncertainty and what is promised**

10. As a user, I want one plan and one promise, so that I am not asked to pick
    a forecast quantile in order to get an answer.
11. As a user, I want the headline recovery figure to be the amount the plan
    achieves on the *low* edge of the forecast band, so that the number I quote
    to someone else is a floor rather than a median dressed as a fact.
12. As a user, I want the median and high realisations shown next to the floor,
    so that a conservative promise does not hide the upside.
13. As a user, I want the share of curtailment avoided shown as a band whose
    *worst* value sits at P90, so that the arithmetic of a fixed fleet covering
    a bigger event is visible rather than surprising.
14. As a user, I want the screen to state the execution rule — the assets
    absorb what is actually curtailed, never more — so that "planned against
    P50" is not read as "assumes P50 comes true".
15. As a sceptic, I want it stated that an hour-wise P10 profile is **not** a
    90 % confidence statement about the day, so that the floor is not oversold.
    Quantiles do not add, and the joint probability that every hour lands at or
    above its own P10 is neither 90 % nor claimed.
16. As a future maintainer, I want the two uncertainty postures we did *not*
    ship recorded with the precise evidence each is waiting on, so that
    upgrading is a decision with a trigger rather than a rediscovery.

**Assets and validation**

17. As a user, I want to describe a battery with power, energy, round-trip
    efficiency and initial state of charge, so that the parameters match the
    spec sheet I am reading from.
18. As a user, I want a single round-trip efficiency input, so that I am not
    asked for two numbers a datasheet does not print — while the model splits it
    into charge and discharge efficiencies internally.
19. As a modeller, I want to supply asymmetric charge and discharge
    efficiencies when I actually have them, and to be rejected if I supply only
    one of the pair.
20. As a user, I want a flexible load described by its shiftable power, its
    shift window and its daily energy, matching IDEA.md §31's freezer.
21. As a user, I want an invalid asset rejected with a specific reason, so that
    a nonsensical scenario never returns a plausible plan.
22. As a user, I want an initial state of charge outside its own SOC bounds to
    be an error rather than silently clamped, so that the plan is never
    computed for a battery I did not describe.
23. As a developer, I want the asset schema to be a sum type on `asset_type`,
    so that a battery cannot arrive carrying `max_shift_mw`.
24. As a developer, I want adding `EV`, `DataCentre`, `Electrolyzer` or `HVAC`
    later to be a new variant plus a new constraint block, with no change to the
    common fields, the transport, the result shape or the simulator.
25. As the operator of a public endpoint, I want hard caps on asset count and
    on every magnitude, so that a hand-edited URL cannot hand the solver an
    unbounded problem.

**Carrying and sharing a scenario**

26. As a user, I want to share the URL of a scenario I built and have the
    recipient see exactly the same plan, without an account existing.
27. As a user, I want my browser's back button and a bookmark to work on a
    scenario, because the scenario *is* the URL.
28. As a developer, I want the encoded scenario to be version-tagged, so that a
    schema change makes an old link fail loudly rather than parse into a
    different scenario.
29. As a developer, I want the canonical encoding to be byte-stable under key
    reordering and float formatting, so that a cache key means what it says.
30. As an operator of the service, I want identical scenarios against the same
    forecast vintage served from cache, and the cache to be legitimately
    evictable at any time with no user-visible loss.

**Results and KPIs**

31. As a user, I want MWh recovered and % curtailment avoided as the two
    headline numbers, and R$ only as a labelled scenario with its assumed
    R$/MWh on screen.
32. As a user, I want changing the assumed R$/MWh to change the money and
    *nothing else*, so that the recommendation is visibly not a function of a
    price I made up.
33. As a user, I want avoidability to read "—", not "0 %", on a day with
    nothing to avoid, because zero would mean "nothing could be avoided" rather
    than "there was nothing to avoid".
34. As a user, I want to see how much energy is still sitting in the battery at
    the end of the horizon and how much was lost to round-trip efficiency, so
    that "recovered" is not silently read as "delivered".
35. As an engineer, I want the solver backend, status, wall time and library
    versions returned with every result, so that a number on a screen can be
    traced to the run that produced it.
36. As an engineer, I want a non-optimal solve to be an error rather than a
    rendered incumbent, so that no screen ever shows a lower bound formatted as
    a fact.

**The endpoint**

37. As a client, I want the optimizer to answer inside one HTTP request with no
    job id, no polling and no "your scenario is being computed" screen, because
    Mitigate is a what-if tool and a slider must move the chart.
38. As an operator, I want a per-IP rate limit on the solver endpoint, so that
    a public unauthenticated MILP is not a free compute service.
39. As an operator, I want the request rejected on size and shape *before* a
    model is built, since model construction, not solving, dominates the
    request.
40. As an operator, I want an infeasible result treated as a bug in WattSteer
    and logged with the scenario hash, because the do-nothing dispatch is always
    feasible by construction and therefore infeasibility can only mean
    validation let something through.

**Replay comparability**

41. As a product owner, I want Replay to build its plan with the same posture
    and score it with the same code as the live path, so that a backtest number
    and a forecast number are the same kind of number.
42. As a product owner, I want Replay to score the plan against what actually
    happened as a fourth realisation, and to report whether the promised floor
    was met, so that the floor is a claim the product checks rather than
    asserts.
43. As a product owner, I want a perfect-foresight solve available in Replay
    **only** as an explicitly labelled upper bound, so that hindsight never
    leaks into a recovery claim.
44. As a product owner, I want the plan built against the forecast vintage that
    existed at D−1, carrying its `VintageFidelity`, so that a replayed day
    before ingestion go-live is visibly revision-optimistic.

## Implementation Decisions

### Where it runs

The optimizer lives in `apps/ml` (Python/FastAPI), which already owns
OR-Tools, reads Postgres directly and never writes. `apps/api` (Elysia) is the
only public surface: it validates the scenario, resolves the forecast vintage,
applies the rate limit, checks the cache and proxies. The ml service is not
publicly routable. This is the charting-session ownership boundary and nothing
here changes it.

**No queue, no job, no `OptimizationJob` noun.** The research measured 3.15 ms
at real size, 33.7 ms at 10 batteries + 10 loads and 63.2 ms at 96 periods. The
endpoint is synchronous.

**The FastAPI handler is a `def`, not an `async def`**, so the solve runs on the
threadpool and a worst-case 2 s solve cannot block the event loop. Each solve
calls `SetNumThreads(1)`: per-request CPU stays bounded under concurrency, and
at these sizes parallel branch-and-bound buys nothing.

### The horizon and its clock

`T = 24` hourly periods, `Δt = 1 h`, so MW and MWh are numerically
interchangeable. The horizon is the 24 hours whose **local civil date in
`America/Sao_Paulo`** is the Scenario's `target_date`, indexed `t = 0…23` by
local hour. Storage and every `valid_time` remain UTC; the local indexing exists
only at the model boundary, because "the battery is available 11:00–18:00" is a
statement an operator makes in Brasília time. The window opens 2024-04, entirely
after Brazil's last DST transition, so no 23- or 25-hour day exists in range;
the builder still derives the hours from the IANA zone rather than a fixed
offset, and asserts it received exactly 24.

The model itself is period-agnostic. Nothing below assumes 24; a 96-period
15-minute horizon is a parameter change, and the research measured it at 63 ms.
v1 ships 24.

### The formulation

**Exactly §2 of the research**, with its variables, its (B1)–(B8), its
(D1)–(D4), and its (C1)–(C5). It is not restated here; the research file is the
authority and should be read, not summarised. What this spec fixes is the
handful of choices §2 leaves to the implementer:

- **(B7)–(B8) ship.** One binary per battery per period. This is settled by
  measurement and is the load-bearing decision of the whole engine.
- **(B3a)/(B3b), the Chen–Baldick tightening, are not implemented.** They buy
  nothing at 3 ms. They are named here so a future session growing the horizon
  knows where to look first.
- **(D5), the recovery-time constraint, is implemented but off by default** —
  emitted only when an asset supplies `recovery_time_hours`. It is integer-free.
- **Shift losses (Zerrahn & Schill's eq. 7′) are not implemented.** A shiftable
  load in v1 is lossless. Adding `shift_efficiency` later is a coefficient on
  the left of (D1) and nothing else.
- **One subsystem per scenario.** `curt[t]` is a subsystem-level series; an
  asset in a different subsystem cannot absorb it. Mixed-subsystem scenarios are
  rejected, not summed.
- **No terminal state-of-charge constraint.** Requiring the battery to return
  to its initial SOC would penalise absorption on the day being planned in order
  to serve a day the horizon does not cover. The consequence is made visible
  instead: the result reports `stored_at_horizon_end_mwh`.

**IDEA.md correction 1 — `efficiency` splits into `ηc` and `ηd`.** The loss
enters (B1) asymmetrically: `×ηc` on the way in, `÷ηd` on the way out. The
user-facing input stays the single number a datasheet prints,
`round_trip_efficiency`, and the builder sets `ηc = ηd = √RTE` — 0.92 becomes
0.959. An asset may instead supply `charge_efficiency` **and**
`discharge_efficiency`; supplying one without the other is a validation error,
and supplying either alongside `round_trip_efficiency` is also an error. `RTE`
is then derived as `ηc·ηd` and never stored twice. The prototype's
`optimize.ts` already splits symmetrically; the ml builder must match it exactly
so the two never disagree about a 92 % battery.

**IDEA.md correction 2 — discharge is netted into the absorbed quantity.**
`Δ[t]` is (C1): the net increase in flexible demand — charge minus discharge,
plus up-shift minus down-shift — and `absorb[t] ≤ Δ[t]` is (C4). Counting charge
alone lets the model charge at full power in every curtailment hour while
discharging to stay in range, and report absorbing more than the fleet can hold.
The sign split of (C2)/(C5) is a **build-time** branch on the parameter
`curt[t]`, introduces no binaries, and must not be written as an unconditional
`absorb[t] ≤ Δ[t]` with `absorb[t] ≥ 0` — that silently implies `Δ[t] ≥ 0`
everywhere and produces a feasible, plausible plan in which the battery never
discharges. Both have tests.

**The converse is intended and is worth stating, so nobody later "fixes" it.**
With the sign split applied correctly, `Δ[t] ≥ 0` still holds in every hour
where `curt[t] > 0` — that is what `absorb[t] ≥ 0` and `absorb[t] ≤ Δ[t]`
together mean there — so the battery cannot *net*-discharge during a curtailment
event, only outside one. That is the physical claim: an asset absorbing spilled
energy in a given hour is not simultaneously exporting in that hour. What the
sign split buys is freedom in the **zero-curtailment** hours, where `Δ[t]` is
unconstrained in sign and the battery is free to discharge. The bug above is
`Δ[t] ≥ 0` leaking into *those* hours; the same inequality inside a curtailment
hour is the model working.

### The objective — decided

```
minimise   Σ_t ( curt[t] − absorb[t] )                       … c_curt = 1
         + Σ_b Σ_t  δ_b · ( ch[b,t] + dis[b,t] ) · Δt
```

**`c_curt` is 1, by construction, and the objective is denominated in
MWh-equivalents.** The realistic objective of IDEA.md §28 ships in *shape* —
there is a second term and it is a battery-throughput cost — but not in
*currency*. The map correctly recorded that none of `c_curt`, `c_deg`,
`c_energy` has an obvious Brazilian value. The resolution is not to go and find
one. It is that **the optimizer must not be denominated in money at all**:

- The headline KPI is a physical quantity (MWh recovered). An objective in R$
  would make the recommendation itself a function of a price WattSteer invented,
  and the map's standing rule is that R$ appears only as a labelled scenario.
  A user who changes the assumed R$/MWh and watches the *dispatch* change would
  be right to distrust everything else on the screen.
- Curtailment compensation and pricing in Brazil are live regulatory questions.
  A number picked to fill a coefficient slot would be an invented fact sitting
  underneath every recommendation.

So `economic_assumptions.brl_per_mwh` (default **180**, published as
`BRL_PER_MWH` in `packages/core/src/constants.ts`, the single place it is
written down) is a
**post-solve display multiplier on `avoided_energy_mwh`** and never enters the
model. Changing it changes the money and nothing else. This is asserted by a
test.

> **Corrected in api-surface 27.** This sentence named
> `apps/web/src/lib/economics.ts` as "the single place it is written down". That
> file no longer exists, and while it did, the claim was the live bug
> `api-surface.md` §`packages/core` was written to close: the optimizer that
> needs this number is **Python**, and a constant in `apps/web` is one it cannot
> read. api-surface 03 moved it to `BRL_PER_MWH` in
> `packages/core/src/constants.ts` and published it to `apps/ml` through
> `packages/core/fixtures/published-constants/`, so "the single place" is true
> now in a way it was not then.

**`c_energy` is dropped, and the reason is structural rather than a deferral.**
(C2) caps `Δ[t]` at `curt[t]` and (C5) forbids `Δ[t] > 0` where there is no
curtailment, so the plan is *incapable* of buying grid energy. At the optimum
`absorb[t] = Δ[t]` in every curtailment hour, which makes the research's energy
term `Σ_t c_energy[t]·(Δ[t] − absorb[t])` a price on a quantity the constraints
already force to zero. A price term earns its place only if a later ticket
relaxes (C2) to permit paid grid charging — i.e. adds energy arbitrage, which is
[out of scope](#out-of-scope).

**`δ_b`, the throughput penalty, is dimensionless and anchored on the venting
threshold:**

```
δ_b = ρ · k_b / (2 + k_b)        with  k_b = (1 − RTE_b) / RTE_b ,  ρ = 1.5
```

That is the research's §4.3 threshold, per battery, from that battery's own
efficiency, multiplied by a safety factor. At RTE 0.92 it is 0.0628 — about 6 %
of the value of a recovered MWh. Four things about this choice:

1. **It is a tie-breaker, not a cost estimate**, and the spec says so rather
   than dressing it as battery chemistry. Its job is to make the optimizer
   prefer, among dispatches that recover the same energy, the one that cycles
   the battery less. Without it the model is indifferent to pointless cycling
   and will emit a needlessly ugly plan.
2. **It cannot buy off a real MWh.** Absorbing one MWh costs at most
   `δ·(1 + RTE)` in throughput penalty; the invariant `δ_b · (1 + RTE_b) < 1`
   must hold for every battery and is asserted at build time. At ρ = 1.5 it
   holds across the whole efficiency range the UI permits.
3. **It is defined relative to the threshold rather than as a fixed constant**
   precisely so it stays above it at every RTE the UI allows. A flat 0.05 would
   sit *below* the venting threshold for any battery under ~90 % round-trip, and
   the LP cross-check in the test suite would then fail for a legitimate reason,
   which is the worst kind of failing test.
4. **Correctness does not depend on it.** The binaries ship. If a later ticket
   sets `ρ = 0` while the weights are being argued about, the model is still
   right. That was the point of shipping them.

`ρ` is configuration (`WATTSTEER_DEG_PENALTY_RHO`), not a scenario input: it is
a modelling knob, not something a user has an opinion about.

### The uncertainty posture — decided

**The optimizer plans against P50. The product promises the P10 edge. The user
is never asked.** The basis toggle in the Mitigate prototype comes out.

The mechanism that makes this coherent is an **execution rule**, stated in the
contract and implemented in the simulator:

> The plan is a schedule of *intended* dispatch. On the day, an asset charges
> the scheduled amount **or the amount actually being curtailed, whichever is
> smaller**, and discharges the scheduled amount or what its state of charge
> actually permits, whichever is smaller.

That rule is not a modelling convenience; it is how a curtailment-following
asset physically behaves, and it is the difference between an operating plan and
a market commitment. Under it, the failure mode the research warns about in
Option A — plan on P50, day comes in small, battery charges from energy that was
never curtailed and the reported recovery is fiction — **cannot occur**. The
asset absorbs less; the reported number falls; nothing is imported and nothing
is overstated.

Which is why the conservatism belongs in the *claim* and not in the *plan*:

- **Planning on P10 collapses.** The forecaster is a hurdle model — an
  occurrence classifier times a magnitude regression — so the hour-wise P10 is
  legitimately **zero** in any hour whose occurrence is uncertain, which is most
  of them on most days. A P10-planned dispatch is then forbidden by (C5) from
  charging in exactly the hours the day turns out to be about, and the
  "conservative plan" is the do-nothing plan. The fleet is never used, the
  demo shows 0 MWh, and the product's answer to "how much is recoverable" is
  "possibly nothing" — which is a true statement about the *forecast* smuggled
  in as a statement about the *fleet*. Option B's cost is not the research's
  "systematically under-uses the assets"; at a hurdle forecaster it is total
  collapse. This is a falsifiable prediction and the forecaster ticket should
  check it against real P10 profiles.
- **Robust budget-Γ needs a Γ.** It stays linear and costs ~50 variables, and
  it is genuinely attractive — but Γ is not observable from the forecaster's
  output, and choosing it honestly needs backtest evidence that only Replay can
  produce and does not yet. Shipping a Γ chosen by taste would put an invented
  parameter under the headline number, which is the thing the objective decision
  above went out of its way to avoid.
- **Scenario-based needs paths, and the quantile envelopes are not paths.**
  Attaching probabilities `π_s` to the P10/P50/P90 profiles and taking an
  expectation would assert that the hour-wise upper envelope is a physically
  realisable day with probability mass. It is not — quantiles do not add, which
  ticket 014 already made a UI invariant — and doing it inside the objective
  would be the same error one layer down, where no test would see it. Real
  scenario paths require a change to the forecaster's output contract (ticket
  009) or a copula/block-bootstrap over residuals. Recorded as the upgrade path
  with that precondition named.

**The `E[Y]` arm is carried alongside, and this is why.** The execution rule
above makes over-planning nearly free — an asset charges the scheduled amount or
what is actually being curtailed, whichever is smaller — so a plan that is too
ambitious is not used, while a plan that is blind in an hour cannot act in it at
all. The costs are not symmetric, and P50 sits on the cautious side of an
asymmetry it was not chosen for. `forecaster.md` therefore scores a second
planning arm against `E[Y]` through this spec's simulator, unchanged. v1 still
ships the P50 plan; the second arm exists so that the number deciding the
posture and the evidence for its replacement arrive together.

**What the three envelopes are used for, then, is scoring, not planning.** The
plan is simulated against P10, P50 and P90 by one shared function, exactly as
the prototype already does, and the result carries all three. Two consequences
the screens must respect:

- **`recovered_floor_mwh` — the P10-simulated recovery — is the number the
  product quotes in prose.** The band is drawn; the floor is what the sentence
  says.
- **The floor is an hour-wise statement, not a day-level confidence.** The
  screen and this spec both say so. The plan is feasible against the hour-wise
  P10 envelope; the joint probability that all 24 hours land at or above their
  own P10 is not 90 %, is not computed, and is not claimed.

**What Replay must do to stay comparable** — not a suggestion to ticket 012, a
constraint on it:

1. **Same posture.** Replay builds its plan against the **P50 of the D−1
   vintage** of the pinned run, resolved through `AsOf(published_at)`. Not P10,
   not the revised forecast, not the actuals.
2. **Same code.** The simulator that scores a live plan and the one that scores
   a replayed plan are the same function, imported, not reimplemented. If the
   execution rule ever changes it changes in one place. This is the single most
   important line in this section: a backtest that scores a P50-optimised
   dispatch while serving runs something else produces non-comparable "MWh
   recovered" numbers and quietly breaks the product's central proof.
3. **Observed is a fourth realisation.** Replay scores the same plan against the
   observed profile, using the same simulator, and reports it beside the P10
   floor that was promised. **Floor coverage** — the share of replayed days
   where observed-scored recovery ≥ the promised floor — is a first-class
   **Backtest** metric, in `domain-model.md`'s sense: the aggregate over many
   Replays, owned by `replay.md`, not the forecaster's fold evaluation. Its gate
   threshold belongs to the hot-swap gate; the metric itself is required here.
4. **Perfect foresight is a labelled upper bound, never a recovery claim.**
   Replay may re-solve the MILP with `curt[t]` = observed, and must present the
   result as "the best any plan could have done knowing the answer", visually
   and semantically separate from what WattSteer's plan achieved.
5. **The vintage travels with the number.** `forecast_origin` and
   `VintageFidelity` are on the result; a replayed day before ingestion go-live
   is `revision_optimistic` and says so.

### The asset schema

A sum type on `asset_type`, per the domain model — not one wide struct with
mutually-exclusive nullable fields, which is what stops a battery arriving with
a `max_shift_mw`.

**Common to every variant.** `asset_type`, `label`, `subsystem`,
`max_power_mw`, `available_from`, `available_to`. Availability is `"HH:MM"`
in `America/Sao_Paulo` on `target_date`, minutes must be `"00"`, half-open
`[from, to)`, defaulting to the whole day; outside the window every decision
variable for that asset is fixed to zero (a battery's SOC simply persists).

```jsonc
// battery
{
  "asset_type": "battery",
  "label": "Battery",
  "subsystem": "NE",
  "max_power_mw": 100,              // inverter limit on charge + discharge  (B6)
  "energy_capacity_mwh": 300,
  "round_trip_efficiency": 0.92,    // or charge_efficiency + discharge_efficiency
  "initial_state_of_charge": 0.20,  // fraction of capacity
  "min_state_of_charge": 0.05,      // optional, default 0.05
  "max_state_of_charge": 0.95,      // optional, default 0.95
  "max_charge_mw": 100,             // optional, default max_power_mw     (B4)
  "max_discharge_mw": 100,          // optional, default max_power_mw     (B5)
  "available_from": "00:00",
  "available_to": "24:00"
}

// shiftable_load
{
  "asset_type": "shiftable_load",
  "label": "Flexible load",
  "subsystem": "NE",
  "max_power_mw": 70,               // connection limit
  "max_shift_mw": 50,               // shiftable portion; ≤ max_power_mw   (D2)(D3)
  "shift_window_hours": 3,          // L                                   (D1)
  "daily_energy_mwh": 1200,
  "recovery_time_hours": null,      // optional; emits (D5) when present
  "available_from": "00:00",
  "available_to": "24:00"
}
```

**`daily_energy_mwh` is a validation input, not a constraint** — and this is the
resolution of IDEA.md §31's `required_daily_energy`. Zerrahn & Schill's (D1)
conserves the load's daily energy *by construction*, because every up-shift is
compensated by down-shifts within `L` hours. Adding a daily-energy equality
would be redundant and would make an infeasible model much harder to diagnose.
What the daily energy *does* buy is the one physical check the formulation
cannot make for itself: **a load cannot be shed by more power than it draws.**
With no baseline profile supplied, the flat baseline is `daily_energy_mwh / 24`,
so `max_shift_mw ≤ daily_energy_mwh / 24` is required. (The prototype's default
fixture — 70 MW of shift against 1200 MWh/day, a 50 MW baseline — fails this
check. See the calls at the end.)

**Extension to `EV`, `DataCentre`, `Electrolyzer`, `HVAC`** is a new variant, a
new constraint block, and a new entry in the coupling sum (C1). The common
fields, the transport, the result shape, the simulator and the KPI definitions
do not move. v1 implements none of them.

### Validation

Validation runs in the **Elysia gateway, before the request reaches the
solver**, because model construction dominates the request and a rejected
scenario should never build one. It is re-asserted in the ml service, which
trusts nothing it did not validate itself. **Nothing is coerced** — the
data-platform spec's posture, for the same reason: a clamped input produces a
plan for a battery the user did not describe.

| Code | Rule |
|---|---|
| `SCENARIO_VERSION_UNSUPPORTED` | `v` is not `1` |
| `SCENARIO_TOO_LARGE` | encoded blob > 4096 bytes, or > 20 assets |
| `ASSET_TYPE_UNKNOWN` | `asset_type` ∉ {`battery`, `shiftable_load`} |
| `SUBSYSTEM_MISMATCH` | an asset's `subsystem` ≠ the scenario's |
| `FIELD_NOT_ON_VARIANT` | a field belonging to the other variant is present |
| `MAGNITUDE_OUT_OF_RANGE` | `max_power_mw` ∉ (0, 10 000]; `energy_capacity_mwh` ∉ (0, 100 000]; `daily_energy_mwh` ∉ (0, 100 000] |
| `RTE_OUT_OF_RANGE` | `round_trip_efficiency` ∉ [0.50, 1.00) |
| `EFFICIENCY_PAIR_INCOMPLETE` | exactly one of `charge_efficiency` / `discharge_efficiency` given, or either given alongside `round_trip_efficiency` |
| `SOC_BOUNDS_INVALID` | not `0 ≤ min_state_of_charge < max_state_of_charge ≤ 1` |
| `SOC_INITIAL_OUT_OF_BOUNDS` | `initial_state_of_charge` outside `[min, max]` — an error, never a clamp |
| `POWER_LIMIT_INCONSISTENT` | `max_charge_mw` or `max_discharge_mw` > `max_power_mw` |
| `SHIFT_EXCEEDS_CONNECTION` | `max_shift_mw` > `max_power_mw` |
| `SHIFT_EXCEEDS_BASELINE` | `max_shift_mw` > `daily_energy_mwh / 24` |
| `SHIFT_WINDOW_OUT_OF_RANGE` | `shift_window_hours` ∉ [1, 8] |
| `RECOVERY_TIME_OUT_OF_RANGE` | `recovery_time_hours` present and ∉ [1, 24] |
| `AVAILABILITY_INVALID` | not `"HH:00"`, or `to ≤ from` |
| `TARGET_DATE_OUT_OF_RANGE` | before the data window opens (2024-04) or after tomorrow |
| `FORECAST_UNAVAILABLE` | no forecast exists for that subsystem/date/origin — **404, not 422**; see below |
| `ECONOMIC_ASSUMPTION_OUT_OF_RANGE` | `brl_per_mwh` ∉ (0, 10 000] |

**`FORECAST_UNAVAILABLE` is the one row in this table that is not a 422.** Every
other code here says the submitted scenario is not physical, and 422 is the right
answer to that. This one says the scenario was fine and we have nothing to plan
against — so `errors.ts` publishes it at **404**, as one of the four no-forecast
states, and a 422 would be telling the caller their request was malformed when
it was not. The table is a list of refusal *codes*, not an assertion that they
all share a status.

Every code is bilingual at the UI layer, per the i18n spec: **the API returns
codes, never translated strings.**

The magnitude caps exist because the endpoint is public and unauthenticated.
They are generous — an order of magnitude above any real Brazilian BESS — and
their job is to bound the solver, not to model the market.

**Two invariants asserted at build time**, failing as `500` rather than `422`
because they indicate a WattSteer bug and not a bad request: `δ_b·(1+RTE_b) < 1`
for every battery, and every MILP variable having a unique name (CBC aborts the
whole process on a duplicate; SCIP does not, but a duplicate name makes every
model dump unreadable, and the check is free).

### Carrying a Scenario without accounts

Settled by the domain model and made concrete here.

```jsonc
{
  "v": 1,
  "subsystem": "NE",
  "target_date": "2026-08-29",
  "forecast_origin": "2026-08-28T12:00:00Z",   // optional; latest if omitted
  "assets": [ /* … */ ],
  "economic_assumptions": { "brl_per_mwh": 180 }
}
```

**Canonical form**: JCS-style — object keys sorted lexicographically, no
insignificant whitespace, numbers emitted in the shortest round-tripping form,
no trailing zeros. **Transport**: base64url of the canonical UTF-8 bytes, capped
at 4096 bytes, carried as `?s=`. The same bytes appear in the `POST` body. The
URL is the storage; there is nothing to persist and no identity to invent.

**`v` is mandatory and rejected if unknown.** A schema change bumps it, and an
old link then fails loudly rather than parsing into a subtly different scenario.
This is the difference between a shareable URL and a time bomb.

**Cache** — a cache, not persistence, evictable at any time with no user-visible
loss. Redis, key
`opt:v1:<sha256(canonical scenario)>:<resolved forecast_origin>:<optimizer_build>`,
TTL 24 h. The forecast origin is in the key because a superseding 12Z run must
not be served an 00Z plan; `optimizer_build` is in the key because a deploy that
changes the formulation must not serve yesterday's plan under today's code.

### The interface

```
POST /v1/optimize          body: the Scenario object
GET  /v1/optimize?s=<blob> for deep links and shares
```

Both paths decode to the identical canonical bytes. Ticket 013 may re-path
these; the contract below is fixed.

```jsonc
{
  "scenario_hash": "sha256:…",
  "forecast_origin": "2026-08-28T12:00:00Z",
  "vintage_fidelity": "point_in_time",
  "threshold_mw": 5,
  "planning_basis": "p50",
  "execution_rule": "follow_curtailment",

  // domain-model scalars, on the planning envelope
  "baseline_curtailment_mwh": 397.0,
  "optimized_curtailment_mwh": 245.2,
  "avoided_energy_mwh": 151.8,
  "avoidability": 0.382,              // or null

  // the promise
  "recovered_floor_mwh": 84.1,        // = scored.p10.recovered_mwh

  "scored": {
    "p10": { "baseline_mwh": …, "remaining_mwh": …, "recovered_mwh": …, "avoidability": … },
    "p50": { … },
    "p90": { … }
  },

  "dispatch": [ { "hour_local": 13, "offered_mwh": 110.0,
                  "battery_charge_mw": 100.0, "battery_discharge_mw": 0.0,
                  "state_of_charge_mwh": 231.4,
                  "load_shift_up_mw": 10.0, "load_shift_down_mw": 0.0,
                  "absorbed_mwh": 110.0 } ],

  "stored_at_horizon_end_mwh": 96.3,
  "round_trip_loss_mwh": 11.4,
  "economic_scenario": { "brl_per_mwh": 180, "brl": 27324 },

  "solver": { "backend": "SCIP", "status": "OPTIMAL", "wall_time_ms": 3.2,
              "objective": 251.7, "ortools_version": "9.15.6755",
              "scip_version": "9.x" }
}
```

`dispatch` and `state_of_charge` are the **scheduled** plan on the planning
envelope, and the screen labels them so. The per-realisation numbers come from
the simulator.

**`stored_at_horizon_end_mwh` and `round_trip_loss_mwh` exist because
"recovered" is not "delivered."** Absorbed energy is metered at the grid
boundary: it is renewable energy that would have been spilled and instead flowed
into an asset. What the asset later delivers is smaller by the round-trip loss,
and some of it is still in the battery when the horizon ends. Reporting only the
absorbed figure without those two would be technically true and quietly
flattering, which is the class of error this project has repeatedly ruled out.

**Failure posture** for a public unauthenticated endpoint running a solver:

| Condition | Status | Code |
|---|---|---|
| validation | `422` | the code from the table above |
| rate limit exceeded | `429` | `RATE_LIMITED`, with `Retry-After` |
| solver `FEASIBLE` (gap unclosed at the time limit) | `503` | `SOLVER_GAP_UNCLOSED` |
| solver `NOT_SOLVED` / time limit hit | `504` | `SOLVER_TIMEOUT` |
| solver `INFEASIBLE` / `UNBOUNDED` / `ABNORMAL` | `500` | `SOLVER_BUG` + scenario hash logged |
| ml service unreachable | `502` | `OPTIMIZER_UNAVAILABLE` |

`SetTimeLimit(2000)`; gateway timeout 5 s. **A non-`OPTIMAL` status is never
rendered.** A `FEASIBLE` MILP result means the gap was not closed, so the
Avoidability Score would be a lower bound rather than a number, and there is no
honest way to put a lower bound in a box labelled with a percentage.

**`INFEASIBLE` is a WattSteer bug, not a user error**, and the reason is a
property worth stating: the do-nothing dispatch — all charge, discharge, shift
and absorb at zero — satisfies every constraint in the model, provided
validation has guaranteed `min_soc ≤ initial_soc ≤ max_soc`. The model is
therefore feasible by construction for every scenario that passes validation.
If the solver ever says otherwise, validation let something through. Hence
`500`, and hence the scenario hash in the log.

**Rate limit**: per-IP token bucket at the gateway, 30 requests/minute burst 10,
on the existing Elysia rate-limit plugin. A slider drag is debounced client-side
and hits the cache in any case.

**Untrusted input hygiene.** The scenario is attacker-controlled: `label` is
capped at 64 characters and is echoed back but never interpolated into SQL, a
log format string, or a chart tooltip without escaping. No scenario field ever
reaches a query as anything but a bound parameter.

### Solver configuration

`ortools >= 9.7` pinned (which ships SCIP ≥ 8.0.3, the Apache-2.0 release), via
`ortools.linear_solver.pywraplp`. Backend from `WATTSTEER_MILP_BACKEND`,
default `SCIP`, permitted values `SCIP` and `HIGHS`. **`CBC` is refused at
startup with a fatal error** — it aborted the entire Python process on a
duplicate variable name during the research, which in a FastAPI worker is a
crash and not an exception, and EPL 2.0 adds obligation for zero benefit.
**CP-SAT is not a configuration option at all**: it is structurally wrong here,
and it fails silently — `CreateSolver("SAT")` reports the model infeasible,
while a hand-written native model returns `OPTIMAL` with a dispatch that is
worse by a factor of two, because the SOC balance over the integers becomes a
divisibility constraint.

Two operational rules from the research, both cheap and both defending against
a segfault or a process abort rather than a wrong number:

- Every variable gets a unique name, asserted.
- The solution is extracted into plain Python objects **before** the `MPSolver`
  goes out of scope. `MPVariable::solution_value()` segfaults after its solver
  is garbage-collected; no helper returns variable handles.

The reported `ortools_version` and `scip_version` are read at runtime, not
hard-coded, so the Apache-2.0 licensing claim stays checkable.

### Avoidability — the exact definition

```
baseline_mwh   = Σ_t  curt[t]                    on the realisation being scored
recovered_mwh  = Σ_t  absorb_sim[t]              from the simulator
remaining_mwh  = baseline_mwh − recovered_mwh
avoidability   = recovered_mwh / baseline_mwh
```

Five decisions inside those four lines:

1. **"Baseline" means no action at all**, and on this problem that is
   *identical* to the forecast profile: a scenario with no assets yields
   `Δ[t] = 0` and `absorb[t] = 0` at every hour. So `baseline_mwh` is the sum of
   the forecast curtailment over the horizon, `recovered_mwh` equals
   `Σ absorb[t]` exactly, and "avoided energy", "recovered energy" and "absorbed
   energy" are **one quantity with one name** in the result:
   `avoided_energy_mwh` at the top level, `recovered_mwh` inside `scored`,
   identical by construction.
2. **The baseline is not filtered by `threshold_mw`.** The threshold is a
   property of the *label* — what counts as a `CurtailmentHour`, what bounds a
   `CurtailmentEpisode` — and has nothing to do with what a battery can absorb.
   Filtering the denominator by it would make the Avoidability Score move when
   someone changes an episode-detection parameter. `threshold_mw` still travels
   on the result, because it names the episodes the screen draws beside the
   score, and the spec says explicitly that it is not applied to the
   denominator.
3. **Baseline-zero, and baseline-near-zero, both yield `null`.** The domain
   model settles zero: `null`, never `0`, because a zero reads as "nothing could
   be avoided" rather than "there was nothing to avoid". Near-zero needs a rule
   too — a day with 0.3 MWh of forecast curtailment, fully absorbed, would
   otherwise render a triumphant "100 % avoided" off noise. The rule, using a
   parameter that already exists rather than inventing one:

   > `avoidability` is `null` unless the realisation being scored contains at
   > least one hour at or above `threshold_mw` — that is, unless the day
   > contains at least one `CurtailmentHour` at the grain in force.

   The threshold thereby gates *whether the ratio is defined*, while never
   entering the ratio itself. It is evaluated per realisation, so a result may
   legitimately carry `scored.p10.avoidability = null` beside a real number at
   P50: on the low edge of the band there may be no curtailment to avoid. The
   UI already renders `—` with the "undefined, not zero" explanation.
4. **`avoidability ∈ [0, 1]` by construction**, since `absorb[t] ≤ curt[t]`.
   Asserted, so a future change to the simulator cannot produce 104 %.
5. **The KPIs come from the simulator, never from the objective value.** The
   objective carries the throughput penalty and is not a physical quantity. It
   is returned for debugging under `solver.objective` and is never rendered.

### The simulator

One function, in one place, imported by the live path, by Replay, and by the
tests. Given a plan and a realisation:

```
for each hour t:
    scheduled_charge    = plan.ch[t]
    executed_charge     = min(scheduled_charge, headroom(soc), realisation[t])
    executed_discharge  = min(plan.dis[t], available(soc))
    Δ[t]                = executed_charge − executed_discharge
                          + plan.up[t] − plan.down[t]
    absorb[t]           = max(0, min(Δ[t], realisation[t]))
    soc                += ηc·executed_charge − executed_discharge/ηd
```

Two things the prototype's `evaluatePlan` did not do, and had to:
**recompute the state of charge from the executed dispatch** rather than
carrying the planned SOC (it clipped absorption but not SOC, so on a small day
the reported battery filled up on energy it never received), and **clip
discharge to the available SOC**, which is what makes the trajectory physical on
a realisation the plan was not built for. Both are in
`apps/ml/src/wattsteer_ml/optimizer/simulator.py` — the two lines above are its
own — and the prototype is gone rather than corrected: `api-surface.md` decision
6 deleted `evaluatePlan` outright, so there is one implementation of this rule
and `test/one-execution-rule.test.ts` counts it.

The simulator has a monotonicity property that the floor promise rests on and
that a property test asserts: **if realisation `r ≥ P10` pointwise, then
`recovered(plan, r) ≥ recovered(plan, P10)`.** The floor is a floor over the
band, not a hope.

## Testing Decisions

**What makes a good test here.** The formulation's failure modes are silent —
a feasible model that never discharges, an `OPTIMAL` status over a mutilated
feasible set, a 16 % overstatement that looks like a good day. So the tests
assert *numbers the research measured* and *properties the formulation
guarantees*, not that a function exists.

**Seam 1 — the formulation, against the research's own measurements.** The
reference case is IDEA.md §27: `curt = [0]×10, 20, 70, 110, 90, 30, 10, [0]×8`,
one 100 MW / 250 MWh battery, `ηc = ηd = 0.959`, SOC 20 % initial, bounds
5–95 %.

1. With `ρ = 0`, remaining curtailment is **95.4 MWh** (SCIP, `OPTIMAL`). This
   is the research's measured value and the regression anchor for the whole
   engine.
2. With the default `ρ = 1.5`, remaining curtailment is within 0.1 MWh of that.
   This is the test that proves the throughput penalty is a tie-breaker and
   never buys off a real MWh.
3. **The venting regression.** Solve the same model as an LP with (B7)–(B8)
   omitted and `ρ = 0`: assert the LP objective is *strictly better* than the
   MILP's by ≈ 15 MWh, and that the LP dispatch charges and discharges
   simultaneously in five hours. This test exists to fail if someone ever
   "optimises" the binaries away, and it documents *why* they are there in a
   form a future session cannot misread.
4. **The LP cross-check at the shipped weights.** With the default `ρ`, the LP
   relaxation's objective equals the MILP's and no hour has simultaneous
   charge and discharge. A non-zero gap here means the weights have drifted into
   the pathological regime, which is exactly what you want to be told.
5. **The sign-split test.** In a profile whose curtailment ends before the day
   does, the battery *must* net-discharge in at least one hour. This is the bug
   the research hit while building the benchmark: the model stayed feasible and
   returned a plausible dispatch in which the battery simply never discharged.
6. **The netting test.** Total absorbed energy never exceeds what the fleet can
   physically hold: `Σ absorb ≤ (S̄ − S⁰)/ηc + Σ_t dis[t]·(…)` plus the load's
   shifted energy. The naive charge-only objective violates this.
7. **The no-import tests.** `Δ[t] ≤ curt[t]` in every hour, and `Δ[t] ≤ 0` in
   every hour with no curtailment.
8. **Zerrahn & Schill properties.** Daily energy conserved to 1e-9; a down-shift
   never lands more than `L` hours from the up-shift it compensates (the
   "undue recovery" failure the single-index formulation permits); no hour sheds
   more than the flat baseline; with `recovery_time_hours` set, (D5) binds.
9. **CP-SAT is not reachable.** A test asserts the backend allow-list rejects
   `SAT`/`CP_SAT` and that startup fails on `CBC`.

**Seam 2 — the simulator, property-based.** Random plans against random
realisations: monotonicity (`r ≥ P10` pointwise ⇒ recovery no lower); SOC never
leaves its bounds under any realisation; absorbed never exceeds offered;
`avoidability ∈ [0,1]` or `null`; `recovered_floor_mwh == scored.p10.recovered_mwh`
always. Plus the negative case that motivates the whole posture: a plan built on
P50 and executed against an all-zero realisation absorbs **zero** and imports
**nothing**.

**Seam 3 — validation, one case per code**, each asserting rejection rather than
coercion. Explicitly: an out-of-bounds initial SOC is a `422`, not a clamp; one
half of an efficiency pair is a `422`; the prototype's 70 MW-shift / 1200 MWh
load is a `422` under `SHIFT_EXCEEDS_BASELINE`.

**Seam 4 — feasibility invariant, property-based.** Generate valid scenarios at
random and assert the solver returns `OPTIMAL` every time. Backed by a direct
test that the do-nothing dispatch satisfies every constraint. Together these
justify treating `INFEASIBLE` as a `500`.

**Seam 5 — the transport.** Canonical-encoding round trip; hash stability under
key reordering and under equivalent float spellings (`0.92` vs `0.920`);
`v: 2` rejected; a 5 KB blob rejected; a cache hit returning byte-identical
output; a changed `forecast_origin` or `optimizer_build` missing the cache.

**Seam 6 — contract parity between TypeScript and Python.** The Scenario and
OptimizationResult shapes live as one JSON Schema in `packages/core`; both sides
assert against it in their own test suites. The prototype's `optimize.ts` types
and the ml service's models drifting apart is the most likely way this engine
breaks quietly, since both look right in isolation.

**Seam 7 — a loose performance guard.** The reference case solves in under
500 ms in CI. The measured value is 3.15 ms; the guard is two orders of
magnitude loose because it is defending against an accidental `O(T²)` model
build or a switch to PDLP, not measuring a machine. Model construction, not
`Solve()`, dominates the request — if the endpoint is ever slow, profile the
builder first.

**Acceptance gate.** Default `bun test` and the ml service's `pytest` pass with
no network. The reference case reproduces 95.4 MWh. The venting regression
fails if the binaries are removed. A scenario URL survives a round trip through
the browser and returns a byte-identical plan.

## Out of Scope

- **Robust budget-Γ and scenario-based stochastic optimisation.** Recorded as
  the upgrade path with explicit triggers: Γ needs calibration evidence from
  Replay; scenarios need temporally coherent paths from the forecaster. Neither
  exists yet, and both fit the same model and latency budget when they do.
- **Energy arbitrage and any form of paid grid import.** (C2)/(C5) forbid it,
  which is what makes `c_energy` unnecessary. Relaxing them is a different
  product.
- **Ancillary services, capacity markets, settlement.** No revenue stacking.
- **A degradation model.** `δ_b` is a tie-breaker anchored on a computed
  threshold, explicitly not a cycle-life or calendar-ageing model.
- **Network constraints.** No power flow, no nodal limits, no locational
  feasibility beyond "the asset is in the subsystem". A battery in the Northeast
  absorbs Northeast curtailment; where in the Northeast is not modelled.
- **Multi-day and rolling horizons, and terminal SOC targets.** Day-ahead only,
  per the map. The end-of-horizon stored energy is reported instead.
- **Intraday re-optimisation.** Day-ahead is the only horizon at which these
  assets can be dispatched, and it is the only horizon the forecaster serves.
- **Sub-hourly periods.** The model is period-agnostic and 96 periods was
  measured at 63 ms; v1 ships 24.
- **`EV`, `DataCentre`, `Electrolyzer`, `HVAC`.** The schema accepts them; v1
  implements none.
- **Asset persistence, saved portfolios, accounts.** The URL is the storage.
- **Carbon.** Nothing in `OptimizationResult` supports a CO₂ claim and none is
  offered.
- **The forecast itself** — its hurdle model, its quantiles, its calibration.
  Consumed here as a contract; owned by the Forecaster spec.
- **The Time Machine's screens and its backtest aggregation.** Owned by the
  Replay spec; only the comparability rule is fixed here.

## Further Notes

**The engine's defining risk is a flattering number, and the design response is
to compute KPIs somewhere other than the optimizer.** Every silent failure the
research found — the LP's venting, CP-SAT's divisibility trap, the unconditional
sign split, the charge-only absorbed quantity — produces a *plausible dispatch
with a better headline*. None of them crashes. The structural defence is that
the objective value is never a KPI: the plan comes from the MILP, the numbers
come from a simulator that re-derives them from physics, and the two agreeing is
a test rather than an assumption.

**Two extensions to the domain model's §6 shapes**, both additive, both flagged
so the naming authority can absorb or reject them:

1. `OptimizationResult` gains `scored` (per-realisation block),
   `recovered_floor_mwh`, `stored_at_horizon_end_mwh`, `round_trip_loss_mwh`,
   `planning_basis`, `execution_rule` and `solver`. The §6 scalars keep their
   names and meanings, evaluated on the planning envelope.
2. `FlexibilityAsset`'s `available_from` / `available_to` are fixed as `"HH:00"`
   strings in Brasília local time on `target_date`, per IDEA.md §32's shape;
   `Battery` gains optional `min`/`max_state_of_charge`, `max_charge_mw`,
   `max_discharge_mw`, `charge_efficiency`, `discharge_efficiency`;
   `ShiftableLoad` gains optional `recovery_time_hours` and the required common
   `max_power_mw` beside `max_shift_mw`.

**Two things the map's "Not yet specified" list can now be struck from, and one
it cannot.** The optimizer objective weights are settled — not by finding
Brazilian values, but by establishing that the objective must not be
denominated in money, which dissolves the question. The uncertainty posture is
settled. What remains open and belongs elsewhere is the **backtest gate
threshold** for floor coverage, which cannot be set before Replay produces the
first honest numbers.

**The prototype's P50/P10 toggle was the right question asked in the wrong
place.** It is worth recording why, because the instinct that produced it is a
good one: the screen was refusing to hide a modelling choice from the user. But
the choice it exposed was not a preference — it was a defect in the framing.
Once the execution rule is stated, planning optimistically has no downside worth
protecting the user from, and the honest conservatism moves to the claim, where
one number can be quoted without a caveat. The toggle comes out; the sentence
about the execution rule goes in.

### Calls the dev should review

1. **Planning on P50 rather than P10** — the reversal of the prototype's
   conservative option, on the argument that a hurdle forecaster makes the
   hour-wise P10 zero in most hours and collapses the plan to do-nothing. The
   argument is falsifiable and should be checked against the first real P10
   profiles the forecaster emits. If P10 turns out not to collapse, the choice
   is worth revisiting — planning *and* promising on P10 would be simpler.
2. **The objective is not denominated in money, and `c_energy` is dropped
   outright.** This makes the map's open item disappear rather than answering
   it. If a future product decision wants price-aware dispatch, this is the
   decision that has to be reopened first.
3. **`δ_b = 1.5 · k_b/(2+k_b)`, per battery, from its own efficiency.** A
   defensible construction rather than a measured value, chosen so the LP
   cross-check stays meaningful across the whole efficiency range the UI allows.
4. **Avoidability is `null` unless the day contains at least one hour at or
   above `threshold_mw`.** This gives `threshold_mw` a second job — gating
   whether the ratio is defined — while keeping it out of the ratio. It reuses
   a committed parameter instead of inventing a floor, but it does mean two
   surfaces now depend on that number.
5. **The prototype's default flexible load becomes invalid** under
   `SHIFT_EXCEEDS_BASELINE`: 70 MW of shift against 1200 MWh/day is a 50 MW
   baseline. The rule is right — a freezer cannot shed more than it draws — so
   the fixture moves. **It becomes 1,700 MWh/day with 50 MW of shift**, which is
   also `packages/core`'s published `REFERENCE_FLEET` (see `replay.md`, "the
   reference fleet is one constant in one place"). Neither of the two repairs
   this spec originally offered was taken, because both sit on the validity
   boundary — 70 MW against 1,700 is 98.8 % of the cap and 50 MW against 1,200
   is exactly 100 % — and a constant that floor coverage, `Δ
   recovered_floor_mwh`, the featured-days list and the hot-swap guardrail are
   all measured against must not be one rounding away from a `422`. Taking the
   energy from one repair and the shift from the other leaves it at 71 % of the
   cap.
6. **The prototype's `evaluatePlan` clipped absorption but not state of charge**,
   so on a realisation below the planning basis it reported a battery filling up
   on energy it never received. The simulator specified here fixes it. The
   resolution was not a correction but a deletion: since the two were supposed
   to be the same function, `api-surface.md` decision 6 removed the second copy
   and pointed Mitigate at `/v1/optimize`.

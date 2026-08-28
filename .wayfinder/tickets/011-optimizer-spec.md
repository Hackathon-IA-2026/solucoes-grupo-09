---
id: "011"
title: Flex optimizer spec — objective, constraints, asset schema
type: wayfinder:grilling
status: closed
assignee: spec-agent
blocked_by: ["003", "006"]
---

## Question

What exactly does the optimizer solve?

- **Objective** (§28): the simple form minimises remaining curtailment; the
  realistic form adds battery degradation and energy cost. Which ships, and if
  the realistic one, where do Brazilian values for those costs come from? This
  is currently fog on the map — the ticket may resolve it or sharpen it.
- **Two IDEA.md corrections the research found, to fold in rather than debate:**
  §29's single `efficiency` must split into separate charge and discharge
  efficiencies `ηc`/`ηd`; and §28's `minimize Σ curtailment_remaining[t]` is
  under-specified — discharge must be netted into the absorbed quantity, or the
  model reports absorbing more energy than the battery can physically hold.
- **Uncertainty**: optimise against P50, or against the band? The research
  named four — P50, conservative P10, Bertsimas–Sim budget-Γ robust (stays
  linear, ~+50 vars), and scenario-based two-stage (binaries need not multiply
  if the mode is first-stage) — and established that all four fit the same model
  and the same latency budget. So this is **a product decision, not a solver
  decision**: what should the optimizer promise a user about a forecast it knows
  is uncertain? Decide it here.
- **Asset schema** (§32): the common shape, the per-type extensions, validation,
  and how it is carried in a product with no accounts — request body, URL state,
  or a shareable scenario id.
- **Constraints**: SOC dynamics and efficiency (§29), power limits, charge and
  discharge exclusivity, availability windows, and for flexible load the shift
  limit plus the required daily energy.
- **Avoidability Score** (§33): its exact definition, and what it does when
  baseline curtailment is zero or near-zero.
- **Interface**: **synchronous, decided** — the research measured 3.2 ms at
  real size, 34 ms at 10 BESS + 10 loads, 63 ms at 96 periods. What remains is
  the input and output contract, and the timeout/failure posture for a public
  unauthenticated endpoint that runs a solver.
- What "baseline" means precisely — no action at all, or the forecast profile.

Use `/grilling`.

---

## Resolution

Spec: [`docs/specs/flex-optimizer.md`](../../docs/specs/flex-optimizer.md).
Nothing is deferred; the five questions the ticket demanded be decided are
decided.

**The objective — the optimizer never sees money.** The realistic form of
IDEA.md §28 ships in shape but not in currency: `c_curt = 1`, so the objective
is denominated in MWh-equivalents, plus a dimensionless battery-throughput
penalty `δ_b = ρ·k_b/(2+k_b)` with `ρ = 1.5`, computed per battery from its own
efficiency and anchored on the research's venting threshold. There are no
Brazilian cost values to find because none is needed — and denominating the
objective in R$ would make the *recommendation* a function of a price WattSteer
invented, which the map's R$-only-as-a-labelled-scenario rule forbids.
`brl_per_mwh` (180) is a post-solve display multiplier and changes the money and
nothing else. **`c_energy` is dropped structurally, not deferred**: (C2)/(C5)
make grid import infeasible, so an energy price would price a quantity the
constraints already force to zero. `δ_b` is stated as a tie-breaker, not a
degradation model, and the invariant `δ_b·(1+RTE_b) < 1` — it can never buy off
a real MWh — is asserted at build time.

**Uncertainty — plan on P50, promise the P10 edge, don't ask the user.** The
prototype's basis toggle comes out. The pivot is an explicit **execution rule**
that ships in the contract and the simulator: an asset charges the scheduled
amount or what is actually being curtailed, whichever is smaller. Under it the
Option-A failure the research warns about — plan on P50, day comes in small,
battery charges from energy that was never curtailed — cannot occur, so
optimism in the plan is free and conservatism belongs in the claim. Planning on
P10 was rejected on a stronger ground than the research's "under-uses the
assets": at a hurdle forecaster the hour-wise P10 is zero in most hours, (C5)
then forbids charging in exactly those hours, and the conservative plan is the
do-nothing plan. Robust-Γ is deferred with a named trigger (Γ needs Replay's
calibration evidence); scenario-based is deferred with a named trigger
(coherent paths from ticket 009) *and* a warning that attaching probabilities to
the P10/P50/P90 envelopes would be the "quantiles do not add" error one layer
below where any test could see it. The floor is stated as an hour-wise
statement, explicitly **not** a 90 % day-level confidence.

**Replay's comparability rule is fixed here, not left to ticket 012**: same
posture (P50 of the D−1 vintage), the *same simulator function* imported rather
than reimplemented, observed as a fourth realisation, **floor coverage** as a
first-class Backtest metric, and perfect foresight permitted only as an
explicitly labelled upper bound.

**The two IDEA.md corrections are folded in.** §29's single `efficiency` splits
into `ηc`/`ηd` with `ηc = ηd = √RTE` from the one number a datasheet prints
(asymmetric pairs accepted, half a pair rejected); §28's absorbed quantity is
the *net* flexible demand increase (C1)/(C4), with the build-time sign split of
(C2)/(C5) and a test against the unconditional form that silently forbids the
battery from ever discharging.

**Asset schema, validation, carriage.** A sum type on `asset_type` with
`"HH:00"` Brasília availability windows; 18 named validation codes, rejecting
never coercing, enforced at the gateway before a model is built; magnitude caps
because the endpoint is public. `daily_energy_mwh` is settled as a **validation
input, not a constraint** — Zerrahn & Schill conserves daily energy by
construction, so §31's `required_daily_energy` does its work as
`max_shift_mw ≤ daily_energy_mwh/24`, the one physical check the formulation
cannot make for itself. Scenario carriage is the domain model's URL encoding
made concrete: JCS-canonical JSON, base64url, ≤ 4096 bytes, mandatory `v: 1`,
Redis cache keyed by scenario hash + resolved forecast origin + optimizer build.

**Avoidability.** Baseline is no action at all, which on this problem *is* the
forecast profile, so avoided = recovered = `Σ absorb` exactly. The denominator
is **not** filtered by `threshold_mw` — the threshold is a label parameter, and
letting it move the score would couple the KPI to episode detection. Zero and
near-zero are both handled by one rule that reuses an existing committed
parameter instead of inventing a floor: **`avoidability` is `null` unless the
realisation contains at least one hour at or above `threshold_mw`**, evaluated
per realisation, so `scored.p10.avoidability` may legitimately be null beside a
number at P50. `avoidability ∈ [0,1]` is asserted.

**Interface.** Synchronous `POST /v1/optimize` plus `GET ?s=` for shares;
`SetTimeLimit(2000)`, `SetNumThreads(1)`, sync `def` handler on the threadpool;
non-`OPTIMAL` is never rendered; `FEASIBLE` → 503, timeout → 504, `INFEASIBLE` →
**500 with the scenario hash logged**, because the do-nothing dispatch is
feasible by construction for every scenario that passes validation, so
infeasibility can only mean validation let something through. CBC refused at
startup, CP-SAT not a configuration option.

**Six calls listed for the dev**, including two that land on the prototype: its
default flexible load (70 MW of shift against 1200 MWh/day) becomes invalid
under `SHIFT_EXCEEDS_BASELINE`, and its `evaluatePlan` clips absorption but not
state of charge, so on a low realisation it reports a battery filling up on
energy it never received.

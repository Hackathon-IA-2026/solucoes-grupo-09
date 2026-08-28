---
id: "011"
title: Flex optimizer spec — objective, constraints, asset schema
type: wayfinder:grilling
status: open
assignee:
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

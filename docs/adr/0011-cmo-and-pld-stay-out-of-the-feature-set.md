# ADR-0011 — CMO and PLD stay out of the feature set

**Status:** accepted · 2026-09-18

## Context

A reviewer's pipeline diagram lists price — CMO, and the PLD derived from it —
among the ONS inputs the model should consume, beside load, generation, wind,
solar and MMGD. Price is an obvious candidate: curtailment and the shadow price
of energy are the same constraint seen from two sides, and a price series is
hourly, public and free.

It is excluded, and it has been excluded since the feature spec was written.
`docs/specs/feature-engineering.md` §1634 and `docs/specs/forecaster.md` §1559
both record it; this ADR exists because the decision keeps being re-proposed by
people reading the dataset catalogue rather than the specs, and because a
decision that has to be re-argued every time is one nobody can rely on.

## Decision

**`cmo-semi-horario` and any series derived from it are not features.**

The reason is leakage, and it is structural rather than a matter of degree.

`cmo-semi-horario` is the **DESSEM run's own output**. The same optimisation
that produces the day-ahead dispatch this product already consumes —
`dessem_demand_mwh`, `dessem_residual_load_mwh`, the generation block — also
produces the shadow price on each constraint, and the published CMO is that
shadow price. A constraint binding hard enough to curtail renewables is a
constraint with a distinctive price signature, so a model handed the price is
being handed a summary of the answer computed by the same solver whose inputs it
is supposed to be learning from.

That is not the usual "this feature is a bit too informative". The published
CMO for hour *h* of day D is available at the same gate as the rest of the
DESSEM block, so it passes every availability check the feature contract makes.
Nothing in `feature_rows` would refuse it. It would improve every offline
metric, pass the gate, get promoted, and then perform exactly as well in
production as it did in backtest — because it is genuinely available — while
what the model had actually learned was to read DESSEM's own opinion about the
day rather than the conditions that produced it.

The failure mode that follows is the expensive one: the product would be
accurate and **useless as an explanation**. "Why will the NE curtail tomorrow?"
would be answered, underneath, by "because DESSEM priced it that way", which is
a restatement and not a cause. Every driver attribution, every analogue, every
sentence in Explicar would be built on it.

## What would change this

The exclusion rests on one factual claim: that the published CMO is the DESSEM
run's output and not an independently formed price. `feature-engineering.md`
§1699 states it as an *open question* and it is still open. If ONS's
documentation, or a measurement against a run whose inputs we hold, establishes
that the published series is formed after and independently of the dispatch this
product reads, the argument above collapses and the feature should be
reconsidered on its merits.

Until then a price feature is not a modelling choice to weigh; it is a defect
with good metrics.

## Consequences

- No price series is ingested. There is no `cmo` table, no adapter and no
  canonical view, which is the form this decision takes in the schema: a feature
  nobody can build is stronger than one everybody agrees not to.
- The economic figure the product does publish — `economic_scenario.brl` on an
  optimization result — is a **display multiplier applied after the solve**, at
  a stated `brl_per_mwh`, and never an input. `optimizer/result.py` says so
  where it is computed and `milp.py` states that the objective is denominated in
  MWh-equivalents and never in money.
- EAR and ENA are absent for a different and much duller reason: no ingestion
  exists, and neither has been argued for or against. They are not covered by
  this ADR.

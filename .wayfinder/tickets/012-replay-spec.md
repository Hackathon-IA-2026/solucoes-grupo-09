---
id: "012"
title: Replay engine spec — the Time Machine
type: wayfinder:grilling
status: open
assignee:
blocked_by: ["009", "011"]
---

## Question

How does WattSteer re-run a historical day honestly?

IDEA.md §34 gives the five steps: restrict to D-1 information, forecast,
recommend, reveal what actually happened, simulate the portfolio.

- **The integrity question.** A model trained on 2023→now has seen the day being
  replayed. A replay using that model is not a real counterfactual. Options:
  train a fold-specific model excluding the replayed period, restrict replay to
  the walk-forward test folds only, or label the result honestly. Pick one and
  make the UI say what it is.
- **The vintage question.** For days before ingestion go-live there is no true
  point-in-time view, so replay uses revised data. What does the screen say
  about that?
- Which days are replayable — a curated set of notable events, or any date?
- Is a replay computed on demand or precomputed and stored?
- The simulation: the optimizer runs against the *forecast*, but the avoided
  energy must be measured against the *actual*. Define that arithmetic exactly,
  including what happens when the forecast underestimates.
- Output contract feeding the §45 / §47 screens: actual MWh, forecast P50/P90,
  absorbed MWh, remaining, avoided, reduction %.

Use `/grilling`.

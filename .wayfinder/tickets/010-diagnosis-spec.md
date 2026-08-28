---
id: "010"
title: Diagnosis engine spec — SHAP, domain rules, LLM renderer
type: wayfinder:grilling
status: closed
assignee: spec-agent
blocked_by: ["009"]
---

## Question

How does WattSteer explain a prediction without overclaiming?

- SHAP over a hurdle model explains *two* models. Is the attribution shown for
  occurrence, for magnitude, or for the composed expectation?
- Raw features are many; the screen shows five drivers (§43). How are features
  grouped into human-legible drivers (renewable/load ratio, export stress, low
  demand, solar ramp, weekend) and how are contributions aggregated into groups
  without lying about sign?
- SHAP values are per-instance; the Explain screen is per-day-per-subsystem.
  Aggregate across the 24 hours, or show the peak hour?
- **Domain rules** (§25) — what are they, and what happens when a rule and SHAP
  disagree? This is the part that is currently fog; the ticket may only be able
  to define the arbitration mechanism, leaving the rule content to a later pass.
- **The §26 boundary.** The product says "Diagnosis", never "Causal AI". Where
  does that wording get enforced — copy review, or a documented rule?
- **LLM renderer contract**: exact input JSON, the constraint that it may not
  introduce any fact not present in its input, the template fallback when the
  call fails, caching key, and which model. It renders; it never decides.

Use `/grilling`.

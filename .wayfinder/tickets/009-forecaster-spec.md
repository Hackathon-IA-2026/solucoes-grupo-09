---
id: "009"
title: Forecaster spec — hurdle model, quantiles, calibration, backtest protocol
type: wayfinder:grilling
status: open
assignee:
blocked_by: ["008"]
---

## Question

How is the day-ahead forecaster built, trained and evaluated?

- **Hurdle structure** (§13): occurrence classifier + magnitude regression on
  positives only. How are the two composed into a single expected MW, and how
  does that composition propagate uncertainty?
- **Quantiles** (§14): P10/P50/P90 per hour. Quantile regression, conformal
  prediction, or an ensemble spread? They differ in how honest the interval is.
- **Calibration** (§19): Platt vs isotonic, and where the reliability curve is
  computed and surfaced.
- **Reason-code model** (§13, Model C): ENE / CNF / REL classification — only
  if ticket 001 confirms the labels exist at usable grain. If not, this is ruled
  out of scope rather than deferred.
- **Baseline ladder** (§15): which baselines, in order — same-hour 7-day mean,
  logistic regression, random forest, LightGBM — and the metrics table format.
- **Metrics** (§18): PR-AUC, F1, recall, precision, Brier. Which is *the* number
  the gate uses.
- **Backtest protocol** (§20–21): walk-forward fold boundaries over 2023→now,
  and how the revision-optimistic label is applied to folds before ingestion
  go-live.
- **The weather lead-time A/B**, which the research left for the pipeline: train
  twice — once on archive weather, once on lead-matched Single Runs weather —
  and evaluate both on the lead-matched features, which is what serving actually
  provides. One extra training run. It settles whether the measured dispersion
  gap survives capacity-weighted aggregation, and the answer directly affects
  how honest the P10/P90 intervals are.
- **The DESSEM A/B** is a headline result, not a footnote: DESSEM-free over the
  full window versus DESSEM-augmented over 2025-05→now. The two are trained on
  different windows, so the comparison is not apples-to-apples — decide how to
  make it fair (evaluate both on the shared window) and how to report it.
- **Transformer benchmark** (§17): what gets compared, and the explicit
  agreement that it stays a benchmark and does not become the served model.
- Where the trained artifact lives, what metadata travels with it, and what the
  hot-swap gate checks.

Use `/grilling`.

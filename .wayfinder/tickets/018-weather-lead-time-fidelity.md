---
id: "018"
title: Weather lead-time fidelity — does the training archive overstate day-ahead skill?
type: wayfinder:research
status: closed
assignee: research-agent
blocked_by: []
---

## Question

Surfaced by **Weather source and regional aggregation**, and flagged there as
the load-bearing risk in that decision.

Open-Meteo's Historical Forecast API is a stitch of the *initial* hours of
successive model runs. That makes it closer to an analysis than to a genuine
D-1 forecast. WattSteer trains on it but serves a real 24–48 h lead time, so
the model may learn on weather that is systematically more accurate than the
weather it will actually receive — inflating backtest skill in a way no
walk-forward split would catch, because the leak is in the feature, not the
split.

Establish:

- the magnitude of the gap: for a sample of days and points, compare the
  archive's value for hour H against what a real D-1 run predicted for hour H.
  The falsification test is already written up in
  `docs/research/weather-sources.md` — run it, do not redesign it.
- whether Open-Meteo's Previous Model Runs / Single Runs APIs expose true
  fixed-lead-time history, since the prior research did not evaluate them
- if they do: coverage back to 2023, variable parity with the Forecast API,
  rate limits, and the storage cost of keeping a lead-time dimension
- if they do not: what the honest alternatives are — accept and label the
  optimism, degrade the archive deliberately, or drop weather from training
  while keeping it at serve time (noting that last one reintroduces the exact
  train/serve skew the weather decision was made to avoid)

**Why this matters enough to be its own ticket:** if the gap is large, every
metric the forecaster reports is overstated, and the map's standing preference
is that nothing on screen is indefensible to an engineer.

Append findings to `docs/research/weather-sources.md` or write a sibling file,
and link it from this ticket.

## Resolution

Findings: [`docs/research/weather-lead-time.md`](../../docs/research/weather-lead-time.md).

**The gap is real and material, and the fix exists.** Measured on 2026-08-28
over 6 points × 4 two-week windows spanning 2024-04 → 2026-08 (8,064
point-hours) plus 642 archived ECMWF IFS HRES runs.

- The Historical Forecast API **is** `_previous_day0` — bit-identical on every
  value tested. The ticket's premise holds exactly.
- With the model pinned so both sides are ECMWF IFS HRES, the training feature
  and the true D−1 forecast differ by **RMSE 4.38 km/h on `wind_speed_120m`
  against a field sd of 8.87** (r = 0.88; on hour-of-day anomalies r = 0.86).
  Bias is ~zero — it is a **dispersion gap, not an optimism bias**. Through a
  turbine power curve that is **4.5 CF percentage points** of MAE. Roughly
  **20–26% of the weather-driven variance a model learns from the archive is
  not present at serve time**; on anomalies, 27% for wind and 47% for solar.
- Scored against ERA5, the archive genuinely is the better weather (RMSE 4.82
  vs 5.25) — and it is **closer to ERA5 than to its own model's D−1 forecast**.
  The clearest statement of what the archive is.
- The harm lands hardest on the **P10/P50/P90 intervals**, which WattSteer
  ships: the model is taught the weather feature is more trustworthy than it is.

**The fix is the Single Runs API, not the Previous Model Runs API.** Previous
Runs' fixed-lead offsets for **ECMWF IFS start only 2025-10-01** (11 of 29
months) despite docs claiming "January 2024"; ICON/GFS do cover the window but
cost ~3% RMSE. Single Runs serves individual **ECMWF IFS HRES runs from
2024-03-14**, clearing the window start by 18 days, with **better variable
parity than the archive** (which nulls `wind_speed_180m`, `cape`,
`boundary_layer_height` under ECMWF). Backfill is **880 HTTP requests / ~30 min**
with 20 centroids batched per request, and **zero extra storage** at one fixed
lead. It also gives the weather table a genuine `publication_time`, which the
stitched archive cannot have.

**Trap found, and it would have corrupted this measurement.** Under
`best_match`, Previous Runs resolves `_previous_day0` to **ECMWF IFS** and
`_previous_day1` to **DWD ICON** — different model, different lead, no null, no
warning. `best_match` also blends models *per variable* within the archive
itself. This turns the map's "model pinning policy for weather" item from a
stability concern into a correctness one: **pin `models=ecmwf_ifs` everywhere**.

**Correction to prior research:** the whole historical family — Historical
Weather, Historical Forecast, Previous Model Runs, Single Runs — requires the
**Professional** plan, not Standard. The commercial cliff in the map's notes is
steeper than recorded.

**Acceptance test for the change** (not run here, needs the pipeline): train the
same model twice — once on the archive, once on the lead-matched feature — and
evaluate both on the lead-matched feature. One extra training run.

**Most likely thing to change the size of this number:** the measurement is
per-point, but the feature is a capacity-weighted aggregate over 12–20
centroids. Aggregation will raise train↔serve r, so the figures above are an
**upper bound on the harm**. Recompute once the plant registry (ticket 019)
gives real centroids.

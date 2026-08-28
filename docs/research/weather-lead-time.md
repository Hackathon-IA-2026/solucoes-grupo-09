# Weather lead-time fidelity: does the training archive overstate day-ahead skill?

**Question** (ticket [018](../../.wayfinder/tickets/018-weather-lead-time-fidelity.md)). WattSteer's chosen weather pairing — Open-Meteo **Historical Forecast API** for training, **Forecast API** for serving ([`weather-sources.md`](weather-sources.md)) — trains on an archive that Open-Meteo builds by stitching the *initial hours* of successive model runs. That is closer to an analysis than to a genuine D−1 forecast. If the gap is material, every backtest metric WattSteer reports is overstated, and no walk-forward split catches it, because the leak is in the feature rather than in the split.

**Research date: 2026-08-28.** Every number below was measured on that date against the production Open-Meteo endpoints, not read off a documentation page. The measurement sample is **6 points across the Brazilian wind/solar fleet × 4 two-week windows spanning 2024-04 → 2026-08 = 8,064 point-hours** per comparison, plus **642 individual ECMWF IFS HRES model runs** pulled from the Single Runs API.

---

## The short answer

1. **The gap is real and material, and it is not a bias — it is a dispersion gap.** With the model pinned so that both sides are ECMWF IFS HRES, the training feature and the feature that will actually be served at D−1 differ by **RMSE 4.38 km/h on `wind_speed_120m`, against a field standard deviation of 8.87 km/h** — 49% of the field's own spread — with a **train↔serve correlation of r = 0.88**. Bias is negligible (−0.10 km/h). Translated through a turbine power curve that is **MAE 4.5 capacity-factor percentage points**.

2. **The archive really is the better weather.** Scored against ERA5 as a common yardstick, the Historical Forecast archive beats the true D−1 forecast on the same variable and the same points: **RMSE 4.82 vs 5.25 km/h**. The archive is closer to a reanalysis than it is to the forecast that will be served. That is the leak, measured.

3. **The practical harm lands hardest on the P10/P50/P90 intervals, not on the point forecast.** ~20–26% of the weather-driven variance a model learns from the archive is simply absent at serve time. Training on the over-accurate feature does not just inflate the headline metric; it teaches the model that the weather feature is more trustworthy than it is, which produces prediction intervals that are systematically too narrow. WattSteer ships intervals as a headline artifact.

4. **The fix exists and is cheap — but not the one the ticket expected.** The **Previous Model Runs API is the wrong tool for this window**: for ECMWF IFS — the model `best_match` and the Historical Forecast archive actually use over Brazil — its fixed-lead-time offsets do not begin until **2025-10-01**, covering only 11 of the 29 months of the training window. The **Single Runs API is the right tool**: it serves individual **ECMWF IFS HRES runs back to 2024-03-14**, which covers the whole 2024-04 → now window with two weeks to spare. Backfilling the lead-matched feature is **~880 HTTP requests**, about 30 minutes of wall clock, and **zero extra storage** if you serve a single fixed lead.

5. **A trap that would have silently corrupted this very measurement.** Under `best_match`, the Previous Runs API resolves `_previous_day0` to **ECMWF IFS** and `_previous_day1` to **DWD ICON** — a different model at a different lead — without a null, a warning, or a field in the response saying so. Measuring the "lead-time gap" with `best_match` overstates it by ~25% because it is partly an inter-model gap. Pin `models=ecmwf_ifs` on every endpoint.

---

## 1. First, confirm what the training archive actually is

The ticket's premise is that the Historical Forecast API is a stitch of the initial hours of successive runs. That is testable directly: the Previous Runs API exposes `_previous_day0`, documented as "the current model run (equivalent to the live Forecast API)" ([Previous Runs API docs](https://open-meteo.com/en/docs/previous-runs-api)).

Comparing the two endpoints over the full 8,064-point-hour sample:

| variable | n | MAE | bias | r |
|---|---|---|---|---|
| `wind_speed_120m` | 8,064 | 0.0000 | 0.0000 | 1.000000 |
| `wind_speed_100m` | 8,064 | 0.0000 | 0.0000 | 1.000000 |
| `shortwave_radiation` | 8,064 | 0.0000 | 0.0000 | 1.000000 |

**Bit-identical on every value.** The Historical Forecast API *is* `_previous_day0`. The premise holds exactly: what WattSteer would train on is the shortest-lead slice of each run, and the API offers `_previous_day1` … `_previous_day7` as the longer-lead alternatives.

A second confirmation, from the other direction: `historical-forecast-api` with `models=ecmwf_ifs` returns values **identical** to `historical-forecast-api` with no `models=` parameter, on all three variables over all 8,064 hours (max |diff| = 0.0). So over Brazil, for these variables, the archive is ECMWF IFS HRES.

---

## 2. The trap: `best_match` silently changes model between lead offsets

The prior research left open "which model `best_match` actually selects over Brazil" ([`weather-sources.md` open questions](weather-sources.md)). Probing the Previous Runs API at (−12.5, −41.5) for 2024-04-10, first three hours of `wind_speed_120m`:

| `models=` | `_previous_day0` | `_previous_day1` |
|---|---|---|
| `best_match` | 20.1, 21.5, 17.3 | 11.2, 10.1, 8.6 |
| `ecmwf_ifs` | **20.1, 21.5, 17.3** | **null, null, null** |
| `icon_seamless` | 10.0, 10.2, 9.1 | **11.2, 10.1, 8.6** |
| `gfs_seamless` | 9.6, 8.3, 7.2 | 9.5, 8.7, 7.9 |
| `ecmwf_ifs025` | null (units `"undefined"`) | null |

So under `best_match`, day 0 is **ECMWF IFS** and day 1 is **DWD ICON**. Open-Meteo does not error, does not null, and does not name the model in the response — it silently substitutes a different model when the preferred one has no archive at that lead. Anyone who measures "the lead-time gap" with `best_match` measures an ECMWF-vs-ICON gap stacked on top of the real one.

The same substitution happens **across variables**, not only across leads. At the same point and date, Historical Forecast API:

| variable | `models=ecmwf_ifs` | `best_match` |
|---|---|---|
| `wind_speed_120m` | 24/24 non-null | 24/24 non-null (identical) |
| `wind_speed_180m` | **0/24 — all null** | 24/24 non-null |
| `cape` | **0/24 — all null** | 24/24 non-null |
| `boundary_layer_height` | 0/24 — all null | 0/24 — all null |

So a `best_match` feature vector over Brazil is a **per-variable blend of models**: ECMWF for 120 m wind, something else for 180 m wind and CAPE. This sharpens the map's existing "model pinning policy for weather" item from a stability concern into a correctness one — and it is exactly the class of silent-null failure the prior research found on the ERA5 endpoint, in a nastier form, because here the fallback returns *plausible numbers* rather than nulls.

**Every measurement in the rest of this document pins `models=ecmwf_ifs`.**

---

## 3. The falsification test, run

`weather-sources.md` specifies the test:

> compare, for the same target hours, the Historical Forecast API values against Forecast API values *captured live at D−1* over several weeks; a systematic gap means the training set is easier than reality.

Capturing live at D−1 over several weeks is not available inside one session. The **Single Runs API** makes the identical comparison retrospectively and over a far longer baseline: `&run=` retrieves the complete output of a named model run, so the forecast that a real D−1 pipeline would have received is recoverable exactly, not simulated ([Single Runs API docs](https://open-meteo.com/en/docs/single-runs-api)).

**Design.** Same 6 points, same 4 windows. Target = the 24 hours of Brasília local day D (03:00 Z on D to 02:00 Z on D+1 — matching ONS's `din_instante`, which the ONS research established is Brasília local civil time). Served feature = the ECMWF IFS HRES run initialised at D−1 00 Z and at D−1 12 Z, both pinned. Training feature = Historical Forecast API for the same target hours, pinned to the same model. 642 runs retrieved; comparison table below.

| run cycle | variable | n | lead h | field sd | bias | MAE | RMSE | r | RMSE/sd |
|---|---|---|---|---|---|---|---|---|---|
| D−1 00 Z | `wind_speed_120m` | 7,272 | 27–50 | 8.83 | −0.156 | 3.399 | 4.758 | 0.8599 | 0.539 |
| D−1 00 Z | `wind_speed_100m` | 7,272 | 27–50 | 8.66 | −0.152 | 3.330 | 4.663 | 0.8599 | 0.539 |
| D−1 00 Z | `shortwave_radiation` | 7,272 | 27–50 | 299.61 | −0.294 | 33.799 | 81.051 | 0.9633 | 0.271 |
| D−1 12 Z | `wind_speed_120m` | 7,272 | 15–38 | 8.87 | −0.095 | 3.077 | 4.375 | 0.8833 | 0.493 |
| D−1 12 Z | `wind_speed_100m` | 7,272 | 15–38 | 8.69 | −0.092 | 3.014 | 4.286 | 0.8833 | 0.493 |
| D−1 12 Z | `shortwave_radiation` | 7,704 | 15–38 | 300.42 | −1.756 | 30.085 | 74.692 | 0.9692 | 0.249 |

Units: km/h for wind, W/m² for radiation.

**Read it carefully.** The bias is essentially zero — the archive is not systematically windier or sunnier. The gap is entirely dispersion: the served feature is a *noisy realisation* of the trained one, with noise about half the size of the field's own standard deviation.

The `shortwave_radiation` r = 0.96 is flattering and should not be quoted: it is dominated by the deterministic day/night cycle. Restricted to daylight hours (archive GHI > 20 W/m²):

| run cycle | n | daylight sd | bias | MAE | RMSE | r | RMSE/sd |
|---|---|---|---|---|---|---|---|
| D−1 00 Z | 3,576 | 279.5 | −0.55 | 68.57 | 115.57 | 0.9137 | 0.414 |
| D−1 12 Z | 3,784 | 280.1 | −3.55 | 61.11 | 106.57 | 0.9275 | 0.381 |

And with the per-site, per-hour-of-day climatology removed — i.e. looking only at the *anomaly*, which is the part a model can actually learn something from beyond the diurnal and seasonal shape:

| run cycle | variable | anomaly sd | RMSE | r | r² retained |
|---|---|---|---|---|---|
| D−1 00 Z | `wind_speed_120m` | 7.87 | 4.68 | 0.8247 | **0.680** |
| D−1 00 Z | `shortwave_radiation` | 103.77 | 79.58 | 0.6850 | **0.469** |
| D−1 12 Z | `wind_speed_120m` | 7.89 | 4.29 | 0.8559 | **0.733** |
| D−1 12 Z | `shortwave_radiation` | 101.99 | 73.39 | 0.7245 | **0.525** |

**On the anomaly — the part that matters for forecasting a ramp — roughly a third of the wind signal and half the solar signal the model learns from the archive is not present in the D−1 forecast it will be served.**

### Stability

The gap does not drift over the training window and is not an artifact of one site:

| window | n | sd | bias | MAE | RMSE | r |
|---|---|---|---|---|---|---|
| 2024-04 | 1,998 | 8.09 | −0.169 | 3.285 | 4.367 | 0.8636 |
| 2025-01 | 1,998 | 7.75 | +0.488 | 3.552 | 4.982 | 0.7988 |
| 2025-08 | 1,278 | 8.76 | −0.324 | 2.410 | 3.549 | 0.9226 |
| 2026-08 | 1,998 | 8.38 | −0.459 | 2.818 | 4.209 | 0.8744 |

| site | n | sd | bias | MAE | RMSE | r |
|---|---|---|---|---|---|---|
| BA-Chapada (−12.50, −41.50) | 1,212 | 6.39 | −0.265 | 2.438 | 3.420 | 0.8683 |
| BA-Solar (−14.60, −43.10) | 1,212 | 8.03 | −0.758 | 3.170 | 4.342 | 0.8692 |
| CE-Interior (−4.60, −40.60) | 1,212 | 6.75 | +0.870 | 3.710 | 5.086 | 0.7207 |
| PI-Serra (−8.60, −41.10) | 1,212 | 9.96 | −0.406 | 2.710 | 3.829 | 0.9294 |
| RN-Coast (−5.20, −36.60) | 1,212 | 8.01 | −0.217 | 3.343 | 4.726 | 0.8328 |
| RS-South (−30.20, −53.20) | 1,212 | 9.39 | +0.205 | 3.088 | 4.629 | 0.8767 |

(All `wind_speed_120m`, D−1 12 Z run.) Worst site r = 0.72, best 0.93. No time trend — the earlier impression from a `best_match` run that "2026 looks fine" was entirely the model-substitution artifact of §2.

### RMSE by lead hour

Pooling both cycles, `wind_speed_120m`, selected leads:

| lead | n | RMSE | r |
|---|---|---|---|
| 15 h | 306 | 4.010 | 0.9085 |
| 22 h | 306 | 3.208 | 0.9421 |
| 24 h | 306 | 3.306 | 0.9438 |
| 30 h | 612 | 4.314 | 0.8692 |
| 36 h | 588 | 4.368 | 0.8952 |
| 44 h | 306 | 6.580 | 0.7054 |
| 50 h | 282 | 5.484 | 0.8301 |

Degradation with lead is monotone-ish but noisy at this sample size, and superimposed on a diurnal cycle (lead and hour-of-day are locked together within a run cycle, so these two effects cannot be separated here). The useful takeaway is the range: the late hours of day D, at 44–50 h lead from the 00 Z run, are appreciably worse than the early hours — which argues for the 12 Z cycle if the product's decision gate permits it.

---

## 4. Is the archive actually *better*, or just *different*?

The dispersion gap alone does not prove the archive is the easier weather — two forecasts can disagree while being equally wrong. Scoring all candidates against ERA5, which is an independent reanalysis on its own grid (a common yardstick, not truth):

| series | n | bias | MAE | RMSE | r |
|---|---|---|---|---|---|
| **ECMWF archive** (Historical Forecast — what we train on today) | 8,064 | +0.596 | 3.654 | **4.816** | **0.8480** |
| **ECMWF true D−1 12 Z run** (Single Runs — what we serve) | 7,272 | +0.658 | 4.048 | **5.248** | **0.8273** |
| ICON `_previous_day0` (analysis-like) | 8,064 | −0.203 | 3.890 | 5.030 | 0.8405 |
| ICON 24 h lead (`_previous_day1`) | 8,064 | +0.448 | 4.181 | 5.400 | 0.8241 |
| ICON 48 h lead (`_previous_day2`) | 8,064 | +0.425 | 4.367 | 5.596 | 0.8130 |

All `wind_speed_100m` in km/h — the only hub-adjacent height ERA5 carries, since ERA5 nulls 80/120/180 m (established in the prior research and re-confirmed here).

**Yes: the archive is measurably better.** RMSE 4.82 vs 5.25, r 0.848 vs 0.827. The training feature is ~9% more accurate than the served feature.

And note the decisive comparison: **RMSE(archive, ERA5) = 4.82 is smaller than RMSE(archive, its own D−1 forecast) = 4.38–4.76.** The archive is about as close to an independent reanalysis as it is to the forecast produced by its own model one day earlier. That is the clearest single statement of what the archive is: an analysis-flavoured product, not a day-ahead forecast.

Two honest framings of the magnitude, both true:

- **"Only 9%."** As a *feature quality* statement, the archive is 9% lower-RMSE than the D−1 forecast. On its own that sounds tolerable.
- **"20–26% of the learned signal is missing."** As a *train/serve* statement, the specific realisations differ by r = 0.88 (0.86 on anomalies), so under the standard errors-in-variables argument roughly 1 − r² ≈ 22% of the weather-driven variance a linear model learns from the archive is not delivered at serve time. On anomalies it is 27% for wind and 47% for solar.

These are consistent, because the two error fields are largely independent. The second framing is the one that bears on the ticket's question, because a model is fitted against the *values* it sees, not against the endpoint's average quality.

### Translated into energy terms

Passing both series through a standard IEC-class power curve (cut-in 3 m/s, rated 12 m/s, cut-out 25 m/s, hub 120 m), the archive-vs-served discrepancy in capacity factor:

| run cycle | n | mean CF | CF sd | bias | MAE | RMSE | r |
|---|---|---|---|---|---|---|---|
| D−1 00 Z | 7,272 | 0.132 | 0.167 | −0.0064 | **0.0496** | 0.0857 | 0.8782 |
| D−1 12 Z | 7,272 | 0.133 | 0.169 | −0.0057 | **0.0447** | 0.0786 | 0.8955 |

**4.5–5.0 capacity-factor percentage points of mean absolute discrepancy** between the weather the model is trained on and the weather it will get. This is an illustrative translation, not a claim about curtailment — the power curve is generic and unweighted — but it puts the gap in a unit the map's "nothing on screen you can't defend to an engineer" standard can be argued about.

---

## 5. The two candidate fixes, evaluated

### 5a. Previous Model Runs API — the expected fix, and why it does not fit this window

`https://previous-runs-api.open-meteo.com/v1/forecast`. Variables carry a `_previous_dayN` suffix; the docs state "`_previous_day1` is the value that was predicted 24 hours before valid time, `_previous_day2` 48 hours before, and so on up to day 7", and "Most models are archived from January 2024" ([docs](https://open-meteo.com/en/docs/previous-runs-api)).

**The documented start date does not hold for the models that matter over Brazil.** Measured availability of `wind_speed_120m_previous_day1` at (−12.5, −41.5), pinned:

| `models=` | first date with non-null `_previous_day1` | evidence |
|---|---|---|
| `ecmwf_ifs` | **2025-10-01** | 0/24 on every probe from 2024-04-10 through 2025-09-30; 24/24 from 2025-10-01 |
| `icon_global` | **between 2024-02-01 and 2024-03-01** | 0/24 on 2024-02-01; 24/24 on 2024-03-01 |
| `gfs_global` | between 2024-01-05 and 2024-04-10 | 0/24 on 2024-01-05; 24/24 on 2024-04-10 |

So:

- For **ECMWF IFS** — the model the archive and `best_match` actually use over Brazil — fixed-lead history begins **2025-10-01**, covering only 11 of the 29 months of the 2024-04 → now window. Using it would cap training at ~11 months, the same "shorter window vs. cleaner feature" trade the map already made explicit for DESSEM.
- For **ICON** and **GFS**, coverage does span the window (`icon_global` verified non-null at 2024-03-01, 2024-04-10, 2024-05-15, 2024-09-15, 2025-03-15, 2025-09-15, 2026-03-15, 2026-08-20). But switching the whole pipeline to ICON costs accuracy: from §4, ICON at 24 h lead scores RMSE 5.40 against ERA5 versus ECMWF's 5.25 at a comparable lead, and ICON's day-0 (5.03) is worse than ECMWF's day-0 (4.82).

The API is also **coarse in the wrong way for this product**: it aligns to *whole-day* offsets, so `_previous_day1` means "24 h before valid time" for every hour. A real day-ahead pipeline issues one forecast covering all 24 hours of D, so its lead varies from ~15 h to ~38 h across the day. The Previous Runs API cannot express that; it is built for "computing the mean absolute error of all `_previous_day3` forecasts against ERA5 over a calendar year", which the docs say outright. For a *skill-degradation study* it is the right tool; for *building the serving feature* it is not.

**Verdict: useful for diagnostics, not the fix.**

### 5b. Single Runs API — the actual fix

`https://single-runs-api.open-meteo.com/v1/forecast`, with a required `&run=` parameter giving the run's UTC initialisation datetime. The docs are unusually direct about why it exists:

> The operational Open-Meteo Forecast API stitches the most recent run of each model into a seamless, continuously updated time-series. That approach is ideal for end-user applications but discards the individual run structure required for research, post-processing, and backtesting workflows. The Single Runs API preserves this structure.
> — [Single Runs API docs](https://open-meteo.com/en/docs/single-runs-api)

**Coverage — measured, not read.**

| claim | measured |
|---|---|
| ECMWF IFS HRES from 2024-03-14 | `run=2024-03-10T00:00` → error "model run is not available"; `run=2024-03-14T00:00` → 48/48 non-null. **Exact, and it clears the 2024-04-01 window start by 18 days.** |
| Other models from 2026-04-02 | `models=icon_global&run=2024-04-09T00:00` → "not available". Consistent. |
| Run cycles | 00 Z and 12 Z available throughout. **06 Z and 18 Z are not available in 2024** (`2024-04-01T06:00`, `2024-06-01T06:00` → error) but are available from at least 2025-01-01. |
| Default model | `ncep_gfs025`, **not** `best_match` — and unavailable in 2024. Always pass `models=ecmwf_ifs`. |
| Gaps | **The archive is not gapless.** Across 112 run-slots sampled, 5 were missing, all clustered: 2025-08-05 00 Z, 2025-08-06 00 Z, 2025-08-08 00 Z, 2025-08-08 12 Z, 2025-08-09 00 Z. 4.5% of slots in that sample. Ingestion must tolerate a missing run and fall back to the previous available cycle, recording which run it used. |

**Variable parity.** Same point, same date, 25 candidate variables, `models=ecmwf_ifs`:

| variable | Single Runs | Forecast API | Historical Forecast |
|---|---|---|---|
| `temperature_2m`, `surface_pressure`, `relative_humidity_2m` | ✅ | ✅ | ✅ |
| `cloud_cover`, `_low`, `_mid`, `_high` | ✅ | ✅ | ✅ |
| `shortwave_radiation`, `direct_radiation`, `diffuse_radiation`, `direct_normal_irradiance`, `global_tilted_irradiance` | ✅ (47/48) | ✅ | ✅ |
| `wind_speed_10m` / `_80m` / `_100m` / `_120m` | ✅ | ✅ | ✅ |
| `wind_speed_180m` | ✅ | ✅ | ❌ **all null** |
| `wind_direction_10m` / `_100m` / `_120m` | ✅ | ✅ | ✅ |
| `wind_gusts_10m`, `precipitation` | ✅ (47/48) | ✅ | ✅ |
| `cape` | ✅ | ✅ | ❌ **all null** |
| `boundary_layer_height` | ✅ | ✅ | ❌ **all null** |
| `temperature_120m` | ❌ null | ❌ null | ❌ null |

**Parity is not merely preserved — it improves.** For ECMWF pinned, the Historical Forecast archive nulls `wind_speed_180m`, `cape` and `boundary_layer_height`; Single Runs carries all three. `temperature_120m` is null on all three endpoints for this model and must not be specified.

The `47/48` entries are a real edge case, not noise: accumulated and time-averaged variables (radiation, precipitation, gusts) have no value at the run's own hour 0, because there is no preceding accumulation window. For a D−1 run the target hours are at lead ≥ 15 h, so this never bites — but a naive "fetch the run, write all rows" ingest would write one NULL per run per accumulated variable.

**Multi-location batching works**, and this is what makes the backfill cheap. Comma-separated `latitude` / `longitude` returns a JSON array, one object per location:

- 3 locations → array of 3, each snapped to its own grid cell.
- **20 locations × 12 variables × 3 forecast days in one request: 84 KB, 10.5 s, zero all-null series.**

**Rate limits and throughput.** The free tier is documented at 600 calls/min, 5,000/hour, 10,000/day, 300,000/month, with fractional weighting — "requests for data covering more than 10 weather variables or extending over a period of more than 2 weeks for a single location are considered multiple API calls" ([pricing](https://open-meteo.com/en/pricing)). Measured against `single-runs-api` on the free tier: **60 single-location requests at 6-way concurrency took 19.4 s (3.1 req/s), median latency 1.85 s, and produced HTTP 429s** — the nominal 600/min is not achievable against this endpoint in practice. No `X-RateLimit-*` or `Retry-After` headers are returned; back-off must be driven by the 429 status alone. Single Runs is explicitly slower by design: "Data is served from a dedicated archive storage system, so response times may be higher than the real-time forecast API."

**Backfill cost.**

- Window 2024-04-01 → 2026-08-28 = **880 days**.
- One D−1 12 Z run per target day, 20 centroids and ~12 variables batched into a single request = **880 HTTP requests**.
- At the measured 10.5 s per 20-location request: **~2.6 h serial, ~30 min at 3-way concurrency** (higher concurrency draws 429s).
- Weighted call units, conservatively counting each location separately and applying the >10-variable multiplier: 880 × 20 × 1.2 ≈ **21,000 units** — three days against the free tier's 10,000/day, or 2% of a single Professional month.
- Ongoing: **1–2 requests per day**.

**Licence and tier — a correction to the prior research.** `weather-sources.md` records "the Historical Forecast API is listed as available on Standard and above". The pricing page's own FAQ says otherwise, in prose:

> Using the Standard API Plan can I use historical, climate and ensemble data? — Historical, climate, ensemble, and satellite radiation APIs require the **Professional API Plan** or higher.
> — [pricing](https://open-meteo.com/en/pricing)

The feature matrix groups Historical Weather, Historical Forecast, **Previous Model Runs and Single Runs** into the same block, and the check pattern next to that block reads ✅ / ❌ / ✅ / ✅ across Free / Standard / Professional / Enterprise — consistent with the FAQ. **Treat the whole historical family, Single Runs included, as Professional-tier or above the moment WattSteer monetises.** The free tier remains non-commercial-only, unchanged; the commercial cliff in the map's notes is now steeper than recorded (Professional, not Standard). Actual prices are still rendered client-side and were not readable — see open questions.

**Storage cost of a lead-time dimension.**

The key structural point: **if the pipeline commits to one fixed lead (the D−1 12 Z run), no lead dimension is needed at all.** You replace the archive column with a lead-matched column of exactly the same shape. Storage is unchanged.

The dimension is only needed if you want several leads — for lead-aware features, for the "how does skill decay" diagnostic, or to hedge on the decision gate. Concretely, for 20 centroids × 880 days × 24 h = 422,400 point-hours, 12 float variables:

| layout | 1 lead | 7 leads |
|---|---|---|
| Wide (one row per point-hour, 12 float8 columns + keys) ≈ 140 B/row | ~59 MB + ~15 MB index | ~415 MB + ~105 MB index |
| Long (`point, valid_time, variable, lead, value`) ≈ 60 B/row | ~304 MB + index | ~2.1 GB + index |

Even the pessimistic corner is a rounding error against a Railway Postgres volume. **Storage is not a constraint on this decision; the wide layout at one lead is free.**

Note the bitemporal fit: the map already requires `event_time` / `publication_time` / `data_version`. A single-run feature has a genuine, defensible `publication_time` — the run's initialisation time plus the documented 4–6 h dissemination delay for global models — where the stitched archive has none. **This fix makes the weather table honestly bitemporal, which the current design cannot be.**

---

## 6. What to do

**Recommended: switch the training feature to the Single Runs API, pinned to ECMWF IFS HRES, at the same lead the product will actually serve.**

Concretely:

1. Pin `models=ecmwf_ifs` on **all three** endpoints — Forecast, Historical Forecast, Single Runs. Never ship `best_match` (§2). Treat a model change as a retrain trigger, as `weather-sources.md` already recommends, and validate each variable for nulls at pin time rather than assuming.
2. Choose the decision gate explicitly, and derive the run from it. The D−1 **12 Z** run (09:00 Brasília, disseminated ~18 Z / 15:00 Brasília) is measurably better than the 00 Z run at every metric here and is compatible with a late-afternoon day-ahead gate. If the gate must be earlier, use 00 Z and accept RMSE 4.76 instead of 4.38.
3. Backfill 2024-04-01 → now: 880 requests, ~30 min, one D−1 run per target day, 20 centroids batched per request. Tolerate missing runs (§5b) by falling back to the previous available cycle and **recording which run was used** — that field is the `publication_time` the bitemporal schema wants.
4. At serve time, call the **Single Runs API with the same `run=`** rather than the Forecast API. This is the strong form of the no-skew argument that `weather-sources.md` set as the bar: same model, same grid, same post-processing, *and now the same lead time*. Using the Forecast API at serve time would re-introduce a smaller version of the same skew, because its "most recent run" is not the run the training set was built from.
5. Keep the Historical Forecast archive ingested **alongside**, not instead. It is the natural verification target — it is the best available estimate of what the weather actually did on the same grid — and the diagnostic in §4 (archive vs served, scored against the archive or ERA5) becomes a standing model-health metric rather than a one-off.

**Cost of the recommendation:** one extra endpoint, ~880 backfill requests, one extra column (`run_init_time`), and a Professional-tier subscription at commercialisation instead of Standard. No loss of window, no loss of variables, no storage growth.

### The alternatives, honestly

The ticket asked for these if the fix did not exist. It does, so these are the fallbacks, ranked:

- **Accept and label the optimism.** Cheapest, and consistent with the map's honesty-about-vintage value — but the label would have to say "reported skill is overstated by an amount we measured at roughly a fifth to a quarter of the weather-driven variance", which is a hard thing to put on a screen and still meet "nothing on screen you can't defend to an engineer". It also does not fix the interval calibration, which is the harm that actually shows in the product.
- **Degrade the archive deliberately** — add noise to the training feature to match the measured D−1 error. This is worse than it sounds: the D−1 error is not white, it is spatially and temporally correlated (weather systems arrive early or late as a whole), and injecting independent noise would teach the model a different wrong thing. Rejected.
- **Use the Previous Model Runs API with ICON or GFS** for the whole window. Second-best, and a genuine option: it covers 2024-04 → now, needs no run-level bookkeeping, and `_previous_day1`/`_previous_day2` bracket the real lead range. Costs ~3% RMSE against ECMWF and gives whole-day lead granularity instead of the true varying lead.
- **Use the Previous Model Runs API with ECMWF** and shorten the window to 2025-10 → now. Rejected on the same grounds the map used for DESSEM: an 11-month window trades one skew for another.
- **Drop weather from training, keep it at serve time.** Still the worst option, for the reason the map already gives — it re-creates the exact train/serve skew the weather decision exists to avoid, only larger.

---

## 7. Risks, and what would falsify this

- **The measurement points are mine, not the fleet's.** The 6 coordinates were chosen by rough geography, before the plant registry (ticket 019) exists. The gap could be larger or smaller at the real capacity-weighted centroids, particularly on the RN/CE coast where sea-breeze timing errors concentrate. Falsifier: recompute §3 at the SIGA-derived centroids once they exist; a materially different r would change the size of the claim, though not its direction.
- **Aggregation may shrink the gap.** WattSteer's feature is a capacity-weighted average over 12–20 centroids, not a single point. Forecast errors are spatially correlated but not perfectly, so the aggregate's train/serve r will be **higher** than the per-point 0.88 measured here. **This measurement is therefore an upper bound on the harm at the feature level**, and the honest headline number should be recomputed on the aggregate. Falsifier: build the weighted aggregate for both series and find r > 0.95, at which point "accept and label" becomes defensible.
- **The errors-in-variables translation is a linear-model argument.** The forecaster is a hurdle model with a gradient-boosted magnitude stage; the 1 − r² ≈ 22% attenuation is indicative, not a theorem for trees. Falsifier: once the pipeline exists, train the same model twice — once on the archive, once on the lead-matched feature — and evaluate both on the lead-matched feature. That is the definitive experiment and it costs one extra training run. **It should be the acceptance test for this change.**
- **Single Runs is a young product with visible gaps.** 4.5% of run-slots missing in the sampled fortnight of 2025-08, 429s at modest concurrency, no rate-limit headers, and "others from 2026-04-02" meaning ECMWF is the only model with real depth. If Open-Meteo reorganises this endpoint, the backfill is 30 minutes to redo but the serving path breaks. Mitigation: the AGPL self-hosting escape hatch noted in the prior research applies here too, and the Historical Forecast archive remains as a degraded fallback.
- **The ERA5 yardstick is on a different grid.** ERA5 snapped to (−12.5, −41.5) exactly; the forecast models snapped to (−12.548, −41.501). Some of the RMSE in §4 is representativeness error, common to all rows, which compresses the *relative* differences between them. It does not affect §3, where both sides are on the identical grid cell.
- **The power-curve translation is generic.** Cut-in/rated/cut-out values are illustrative for an IEC class, not the Brazilian fleet's, and no air-density correction was applied. The 4.5 CF-point figure is indicative.

---

## Open questions / could not confirm

- **The live-capture arm of the original falsification test was not run.** `weather-sources.md` specified comparing the archive against Forecast API values *captured live at D−1 over several weeks*. I ran the retrospective equivalent using archived runs, which is a longer and cleaner baseline, but it assumes the Single Runs archive faithfully reproduces what the live Forecast API served at the time. **I could not verify that assumption**, because there is no live D−1 capture to check it against. A cheap standing check: log the Forecast API's day-ahead output daily from go-live, and after a month compare it against the Single Runs record of the same run.
- **Why ECMWF `_previous_day1` starts exactly 2025-10-01** while the docs say "most models from January 2024" and `icon_global` starts around 2024-03. Not explained anywhere I fetched. The docs do offer "Additional historical coverage can be reconstructed on request, subject to upstream availability from the originating weather service" — **worth an email to info@open-meteo.com before committing to the Single Runs route**, since a backfilled `_previous_dayN` for ECMWF would be simpler to consume than 880 individual runs.
- **Whether `best_match`'s day-0 model over Brazil is stable across the whole window and across variables.** Verified as `ecmwf_ifs` at one point on two dates for wind and radiation, and verified *not* to be ECMWF for `wind_speed_180m` and `cape`. The full selection rule for South America is documented nowhere I could find. This is the same open question the prior research raised, now partly answered and partly worse than feared.
- **Exact start dates of `_previous_day1` for `gfs_global`** — bracketed to between 2024-01-05 and 2024-04-10, not narrowed further.
- **The precise cutover date for 06 Z / 18 Z ECMWF single runs** — absent at 2024-04-01 and 2024-06-01, present at 2025-01-01. Not narrowed. Irrelevant if the pipeline uses 00 Z or 12 Z.
- **Paid-tier prices in currency.** Still rendered client-side; the fetched HTML carries tier names, call budgets and the feature matrix but no numbers. Unchanged from the prior research.
- **The pricing feature matrix's row-to-column alignment.** The HTML flattens the matrix such that mapping ✅/❌ marks to rows requires inference. The FAQ prose ("historical, climate, ensemble, and satellite radiation APIs require the Professional API Plan or higher") is unambiguous and is what I have relied on; the matrix is consistent with it but is not independent confirmation. Confirm with Open-Meteo before budgeting.
- **Whether multi-location requests are billed per location.** The call-weighting rules published are per-variable and per-time-range only; nothing states how a 20-location request is counted. The backfill estimate above assumes the pessimistic 20× and is still cheap, so this does not change the recommendation — but it changes the ongoing serving budget by a factor of 20.
- **Whether the gap survives capacity-weighted aggregation.** Flagged under risks; genuinely unknown until the centroids exist. This is the single most likely thing to change the size of the headline number.
- **`boundary_layer_height` is null on all Open-Meteo endpoints for `ecmwf_ifs` at the tested point** but non-null for other models. Whether that is a Brazil-specific gap, an ECMWF-specific gap, or a variable Open-Meteo does not derive for IFS was not determined.

---

## Reproducing this

Every measurement is a plain HTTP GET. The three that carry the argument:

```bash
# 1. The archive IS previous_day0 (expect bit-identical values)
curl -s "https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=-12.5&longitude=-41.5\
&hourly=wind_speed_120m&start_date=2024-04-10&end_date=2024-04-10&timezone=GMT&models=ecmwf_ifs"
curl -s "https://previous-runs-api.open-meteo.com/v1/forecast?latitude=-12.5&longitude=-41.5\
&hourly=wind_speed_120m_previous_day0&start_date=2024-04-10&end_date=2024-04-10&timezone=GMT&models=ecmwf_ifs"

# 2. best_match silently swaps ECMWF -> ICON between lead offsets
curl -s "https://previous-runs-api.open-meteo.com/v1/forecast?latitude=-12.5&longitude=-41.5\
&hourly=wind_speed_120m_previous_day0,wind_speed_120m_previous_day1\
&start_date=2024-04-10&end_date=2024-04-10&timezone=GMT"            # best_match: 20.1 then 11.2
curl -s "...&models=ecmwf_ifs"                                       # 20.1 then null
curl -s "...&models=icon_seamless"                                   # 10.0 then 11.2

# 3. The true D-1 forecast, recoverable exactly, back to 2024-03-14
curl -s "https://single-runs-api.open-meteo.com/v1/forecast?latitude=-12.5&longitude=-41.5\
&hourly=wind_speed_120m,shortwave_radiation&run=2024-04-09T12:00&forecast_days=3\
&timezone=GMT&models=ecmwf_ifs"
```

Sample used for the statistics: points (−12.50, −41.50), (−5.20, −36.60), (−4.60, −40.60), (−8.60, −41.10), (−14.60, −43.10), (−30.20, −53.20); windows 2024-04-08…21, 2025-01-06…19, 2025-08-04…17, 2026-08-01…14.

**Attribution:** Open-Meteo data is CC BY 4.0 and the free tier is non-commercial only ([terms](https://open-meteo.com/en/terms)).

---
id: "002"
title: Weather source and regional aggregation
type: wayfinder:research
status: closed
assignee: research-agent
blocked_by: []
---

## Question

Which weather source gives WattSteer both historical reanalysis (for training
and backtests) and day-ahead forecast (for serving), on the same variables, so
there is no train/serve skew?

Establish:

- whether Open-Meteo covers Brazil with both the historical archive and the
  forecast API, on the same variable set and the same grid
- the variables available for solar (shortwave/direct/diffuse irradiance, cloud
  cover, temperature) and for wind (wind speed at 10m and at 100m, direction,
  pressure) — and whether hub-height wind is available or must be extrapolated
- licensing and rate limits for a scheduled, non-commercial-then-commercial use
- the alternatives worth naming: INMET, ERA5 via Copernicus, NASA POWER —
  and where each falls short on the forecast side
- how to aggregate points to a subsystem: which representative locations for
  NE (Bahia, RN, Ceará, Piauí, Pernambuco) and for the other subsystems, and
  whether capacity-weighted aggregation needs a plant location registry
- the storage cost of hourly weather for ~10–20 points, 2023→now

Record findings as a Markdown file in the repo and link it from this ticket.

## Resolution

**Open-Meteo**, using the **Historical Forecast API** for training/backtests and the
**Forecast API** for day-ahead serving — not the ERA5-backed Historical Weather API.
It is the only candidate that passes the no-skew constraint: ERA5 and NASA POWER
publish no forecast, and INMET's forecast is qualitative municipal text with no
irradiance and no numeric wind speed. Parity was verified live — for the same hour
and point, both endpoints returned bit-identical values across the solar and wind
variable set, including native `wind_speed_120m`, so hub-height wind is a real
feature rather than a power-law extrapolation. Free tier is CC BY 4.0 and
non-commercial at 10k calls/day (our load is ~20/day); the commercial move is a
paid key plus a hostname swap, and the server is AGPL so self-hosting is a fallback.

Aggregation: capacity-weighted over ~12–20 cluster-centroid points, weights from
the ANEEL SIGA registry (which does carry coordinates and commissioning dates, so
weights can be made time-varying to avoid fleet-composition leakage). Storage for
hourly weather at 20 points, 2023→now, is negligible: ~95 MB in Postgres in a
wide `real`-column layout (~0.9 GB if stored EAV).

Two load-bearing risks carried forward: the Historical Forecast archive is a stitch
of *initial* hours of successive runs, so it may be optimistic relative to a true
D−1 lead time (Open-Meteo's Previous Model Runs / Single Runs APIs were not
evaluated and may be the fix); and `best_match` is not a stable model contract,
while pinning a model can silently null out variables (`ecmwf_ifs025` returns null
`wind_speed_120m`).

Full comparison, variable tables, proposed subsystem points, storage arithmetic and
the open questions: [`docs/research/weather-sources.md`](../../docs/research/weather-sources.md)

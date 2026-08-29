# Open-Meteo Single Runs fixtures

Real captured payloads, not hand-written approximations. Every one was fetched
from the live endpoint on the capture date below and is committed byte-for-byte.

Every URL below carries `&models=ecmwf_ifs` and `&run=…`. That is not
incidental: without the pin, Open-Meteo silently substitutes DWD ICON for ECMWF
IFS between lead offsets, and this endpoint's own default is `ncep_gfs025`,
which has no 2024 archive at all. A fixture captured without the pin would be a
fixture of a different model.

| File | Captured | Source | Notes |
|---|---|---|---|
| `single-runs-ecmwf-2024-04-09T12Z.json` | 2026-08-28 | `https://single-runs-api.open-meteo.com/v1/forecast?latitude=-11.216,-5.40,-15.62&longitude=-41.341,-36.05,-43.60&hourly=<the twelve>&run=2024-04-09T12:00&forecast_days=3&timezone=GMT&models=ecmwf_ifs` | The D−1 12Z run for target day 2024-04-10. Three centroids (W1, W7, S5) as a JSON **array**, one object per point, each snapped to its own grid cell. 72 hours × 12 variables × 3 points. |
| `single-runs-ecmwf-2024-04-09T00Z.json` | 2026-08-28 | as above with `run=2024-04-09T00:00` | The earlier cycle over the same target day. Its values differ from the 12Z run's on the same valid hours — which is what makes supersession testable at all. |
| `single-runs-unavailable.json` | 2026-08-28 | `…&hourly=wind_speed_120m&run=2024-03-10T00:00&models=ecmwf_ifs` | HTTP **400** and `{"error":true,"reason":"The requested model run is not available…"}`. Four days before `ecmwf_ifs` coverage begins; the same shape as the 4.5% of mid-window run slots the research found missing. |
| `single-runs-undefined-variable.json` | 2026-08-28 | `…&hourly=wind_speed_120m,temperature_120m&run=2024-04-09T12:00&forecast_days=1&models=ecmwf_ifs` | HTTP **200**. `temperature_120m` comes back with `"units": "undefined"` and 24/24 nulls, beside a `wind_speed_120m` that is fine. The silent failure the loud check exists for. |

## What the multi-point fixtures prove without any code

- **Hour zero of the accumulated variables is null.** In
  `single-runs-ecmwf-2024-04-09T12Z.json`, `precipitation`,
  `shortwave_radiation`, `direct_normal_irradiance`, `diffuse_radiation` and
  `wind_gusts_10m` are all `null` at `2024-04-09T12:00` and non-null from 13:00,
  while `wind_speed_120m` carries a value at 12:00. There is no preceding
  accumulation window at initialisation.
- **The API echoes the snapped grid cell.** W1 was asked for at
  (−11.216, −41.341) and came back at (−11.212653, −41.360016). That echo is
  the only way to detect two centroids collapsing into one cell.
- **A single-point request returns a bare object, a multi-point request an
  array.** Both shapes are in this directory.

## Recapture

```bash
V="wind_speed_100m,wind_speed_120m,wind_direction_120m,wind_gusts_10m,\
temperature_2m,surface_pressure,relative_humidity_2m,precipitation,\
shortwave_radiation,direct_normal_irradiance,diffuse_radiation,cloud_cover"
curl -s "https://single-runs-api.open-meteo.com/v1/forecast\
?latitude=-11.216,-5.40,-15.62&longitude=-41.341,-36.05,-43.60\
&hourly=$V&run=2024-04-09T12:00&forecast_days=3&timezone=GMT&models=ecmwf_ifs"
```

**Attribution:** Open-Meteo data is CC BY 4.0 and the free tier is
non-commercial only ([terms](https://open-meteo.com/en/terms)).

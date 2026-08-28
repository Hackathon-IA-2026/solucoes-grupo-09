# Weather sources for WattSteer

**Question.** Which weather source gives WattSteer *both* a historical archive (for training and backtests) *and* a day-ahead forecast (for serving), on the **same variables** and ideally the **same grid**, so that the feature vector the model is trained on is the same object the model is scored on?

**The disqualifying constraint.** WattSteer is day-ahead only. Every feature must exist in both products. A source that offers only reanalysis (great history, no forecast) or only a forecast (no history to train on) is not "half a solution" — it is a train/serve skew generator, and it is disqualifying. Two *different* sources stitched together (e.g. ERA5 for training, some NWP for serving) is the same failure with extra steps: ERA5's `ssrd` and a forecast model's `ssrd` are different numbers from different physics, and the model will learn the reanalysis bias and then be served the forecast bias.

A useful sharpening: the strongest form of "no skew" is not *same variable names* but **same model, same grid, same post-processing** — i.e. the history you train on is literally an archive of the forecasts you will be served. Only one candidate below offers that.

Research date: 2026-08-28. Every live API probe below was run on that date against the production endpoints.

---

## Open-Meteo

### Brazil coverage

Open-Meteo is a global point-query API; there is no regional restriction. Probing the Bahia wind heartland (-12.5, -41.5) returns data from every endpoint tested (live probes below). The API snaps to the nearest grid cell and returns the actual cell centre and its elevation — for (-12.5, -41.5) it returned `latitude: -12.54833, longitude: -41.500885, elevation: 1020.0`.

Open-Meteo's own model listing gives resolution "from 1 km (regional mesoscale) to 9–11 km (global)", with `best_match` automatically selecting the highest-resolution model for a coordinate ([pricing page](https://open-meteo.com/en/pricing)). Open-Meteo's high-resolution regional models (ICON-D2, AROME, UKV, MeteoSwiss CH1, HRRR) cover Europe and North America; **for Brazil `best_match` necessarily resolves to a global model** (ECMWF IFS 9 km, ICON ~11 km, GFS ~13 km). I confirmed indirectly that `best_match` over Bahia is *not* GFS and *not* plain ICON — at the same hour and point the three disagreed:

| model | `wind_speed_120m` | `shortwave_radiation` |
|---|---|---|
| `best_match` | 19.0 km/h | 712 W/m² |
| `ecmwf_ifs025` | *null* | 685 W/m² |
| `gfs_seamless` | 16.2 km/h | 943 W/m² |
| `icon_seamless` | 20.9 km/h | 775 W/m² |

(live probe, `api.open-meteo.com/v1/forecast`, 2026-08-28). I could **not** confirm from a documentation page which exact model `best_match` picks over Brazil — see open questions. Note the important gotcha already visible here: `ecmwf_ifs025` returns **null for `wind_speed_120m`**, so pinning to the ECMWF open-data model costs you hub-height wind.

Open-Meteo runs three separate archives, and the distinction between them is the whole answer to this research question:

### Historical product A — Historical Weather API (ERA5 reanalysis)

[Docs](https://open-meteo.com/en/docs/historical-weather-api). Models and coverage as documented:

| Model | Resolution | Start | Update delay |
|---|---|---|---|
| ERA5 | 0.25° (~25 km) | 1940 | 5 days |
| ERA5-Land | 0.1° (~11 km) | 1950 | 5 days |
| ECMWF IFS | 9 km | 2017 | no delay |

Live probe of `archive-api.open-meteo.com/v1/archive` at (-12.5, -41.5), asking for a single mid-day value with `models=` pinned, on 2026-08-28:

| date | `models=era5` | `models=ecmwf_ifs` |
|---|---|---|
| 2026-08-20 | 18.6 °C | 17.4 °C |
| 2026-08-24 | **null** | 18.5 °C |
| 2026-08-27 | **null** | 17.7 °C |

So the documented ~5-day ERA5 latency is real (8 days back available, 4 days back not), and the default archive endpoint silently backfills the recent tail from ECMWF IFS rather than ERA5. **That silent model switch is itself a skew source** if you build a training set that runs up to "yesterday".

### Historical product B — Historical Forecast API (archived operational forecasts)

[Docs](https://open-meteo.com/en/docs/historical-forecast-api). This archives the initial hours of successive operational model runs, stitched into a continuous hourly series. The docs state coverage begins "around 2022" for most models (GFS from March 2021, ECMWF IFS HRES from January 2017), and explicitly that the data is "ideal for training machine learning models" and comes "directly from the operational model runs".

Live probes of `historical-forecast-api.open-meteo.com/v1/forecast` at (-12.5, -41.5) on 2026-08-28 returned non-null `wind_speed_120m` and `shortwave_radiation` for 2021-06-01, 2022-01-01, 2022-06-01, 2023-01-01 — i.e. **comfortably covers the required 2023 → now**. Latency is ~1 day: 2026-08-27 returned data.

### Forecast product

[Docs](https://open-meteo.com/en/docs). Horizon up to 16 days (default 7), model update "every hour", "every 3 hours" or "every 6 hours" depending on model. Day-ahead is well inside this.

### The parity test (the decisive evidence)

I pulled the same point, same hour, same variable list from the **Historical Forecast API** and from the **Forecast API's `past_days` window**, for 2026-08-24T12:00 at (-12.5, -41.5):

| variable | Historical Forecast API | Forecast API (`past_days`) |
|---|---|---|
| `temperature_2m` | 18.5 | 18.5 |
| `shortwave_radiation` | 489.0 | 489.0 |
| `direct_normal_irradiance` | 615.8 | 615.8 |
| `cloud_cover` | 81 | 81 |
| `surface_pressure` | 909.5 | 909.5 |
| `wind_speed_10m` | 17.9 | 17.9 |
| `wind_speed_100m` | 24.5 | 24.5 |
| `wind_speed_120m` | 25.0 | 25.0 |

Bit-identical on every field. This is the same model, same grid, same post-processing, same parameter names — the *strong* form of no-skew.

### Solar variables

Both the [Forecast API](https://open-meteo.com/en/docs) and the [Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) document `shortwave_radiation` (GHI), `direct_radiation`, `direct_normal_irradiance` (DNI), `diffuse_radiation` (DHI), `global_tilted_irradiance`, `cloud_cover`, `cloud_cover_low/mid/high`, `temperature_2m`, `surface_pressure`. The [Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api) documents the same set. Verified live on the ERA5 archive at the Bahia point (units returned: `shortwave_radiation` W/m², `direct_radiation` W/m², `diffuse_radiation` W/m², `direct_normal_irradiance` W/m², `cloud_cover*` %, `temperature_2m` °C, `surface_pressure` hPa). **Solar has full parity across all three products.**

### Wind variables and hub height

This is where the archives diverge:

| variable | Forecast API | Historical **Forecast** API | Historical **Weather** API (ERA5) |
|---|---|---|---|
| `wind_speed_10m` / `wind_direction_10m` | yes | yes | yes |
| `wind_speed_80m` | yes | yes | **no** |
| `wind_speed_100m` / `wind_direction_100m` | yes | yes | yes |
| `wind_speed_120m` / `wind_direction_120m` | yes | yes | **no** |
| `wind_speed_180m` | yes | yes | **no** |

Confirmed live: the ERA5 archive endpoint does not reject `wind_speed_120m` — it returns it with `"units": "undefined"` and an all-`null` array. That is a nasty silent failure: a naive ingest writes a column of NULLs rather than erroring.

So **hub-height wind (80–120 m, the relevant band for Brazilian NE turbines) is directly available without extrapolation — but only from the Forecast API and the Historical Forecast API, not from the ERA5 archive.** If you insisted on ERA5 you would be limited to 10 m and 100 m and would have to power-law/log-law extrapolate to reach 120 m, and that extrapolation would then have to be replicated identically at serve time — an avoidable second skew source.

### Licence

- API data: **CC BY 4.0**, attribution required ([terms](https://open-meteo.com/en/terms)).
- The free/open-access tier is **non-commercial only**. The terms name qualifying non-commercial uses ("private or non-profit websites or apps that do not have subscriptions or advertising", "public research conducted at public institutions", "educational content") and explicitly exclude "websites or apps that have subscriptions or display advertisements", "integrating our service into commercial products", and "undisclosed research at commercial entities" ([terms](https://open-meteo.com/en/terms)).
- A paid subscription "grants a commercial use licence and an API key for the dedicated customer endpoint at `customer-api.open-meteo.com`", with the note that "the API syntax is identical to the free tier — only the domain and `key` parameter differ" ([pricing](https://open-meteo.com/en/pricing)). **This is the important operational fact: the non-commercial → commercial transition is a hostname and a query parameter, not a rewrite.**
- The server is open source under **AGPL-3.0** ([github.com/open-meteo/open-meteo](https://github.com/open-meteo/open-meteo)), so self-hosting is a real escape hatch if pricing or terms ever move.

### Rate limits

Free tier ([pricing](https://open-meteo.com/en/pricing)): **600 calls/min, 5,000/hour, 10,000/day, 300,000/month.** Calls are weighted: "requests for data covering more than 10 weather variables or extending over a period of more than 2 weeks for a single location are considered multiple API calls" — a 2-week / 15-variable request counts as 1.5 calls, 4 weeks as 3.0.

Paid tiers are unlimited per minute/hour/day, capped monthly: Standard 1M calls/month, Professional 5M/month, Enterprise >50M/month. The Historical Forecast API is listed as available on Standard and above; note from the feature matrix that **the Climate API is *not* on Standard** but Historical Weather / Historical Forecast are. Prices in currency were not present in the fetched HTML (rendered client-side) — see open questions.

### Verdict on the train/serve-skew test

**PASSES, in the strong form** — but only via the Forecast API + **Historical Forecast API** pairing. The Forecast API + Historical *Weather* (ERA5) API pairing **fails on wind**: it loses 80/120/180 m silently, and it swaps model underneath you in the last 5 days.

---

## INMET (Instituto Nacional de Meteorologia)

### Brazil coverage

INMET is a station network, not a gridded product. `GET https://apitempo.inmet.gov.br/estacoes/T` returned **674 automatic stations** on 2026-08-28, of which **103 are in BA/RN/CE/PI/PE** (the wind/solar heartland). Each record carries `VL_LATITUDE`, `VL_LONGITUDE`, `VL_ALTITUDE`, `CD_ESTACAO`, `SG_ESTADO`, `DT_INICIO_OPERACAO`, `CD_SITUACAO` — e.g.:

```json
{"DC_NOME":"ACAJUTIBA","CD_ESTACAO":"A472","SG_ESTADO":"BA",
 "VL_LATITUDE":"-11.65444444","VL_LONGITUDE":"-38.01583333","VL_ALTITUDE":"182",
 "TP_ESTACAO":"Automatica","CD_SITUACAO":"Operante"}
```

Note the endpoints require a browser `User-Agent`; with a default curl UA they return empty bodies.

### Historical product

`https://apitempo.inmet.gov.br/estacao/{start}/{end}/{station}` is the commonly used hourly-observation endpoint. **I could not retrieve any data from it.** It returned **HTTP 204 No Content** for every combination I tried — stations A401, A402, A404, A408, dates 2023-06-01 and 2026-08-20/21, single-day and two-day ranges. Path variants (`/estacao/diaria/...`, `/token/estacao/...`, `/estacao/dados/...`) returned 404 `E_ROUTE_NOT_FOUND`. So on 2026-08-28 this endpoint either requires a credential I do not have, or is broken. I am recording this as *unconfirmed*, not as *absent*.

[BDMEP](https://portal.inmet.gov.br/servicos/bdmep-dados-hist%C3%B3ricos) is the documented historical archive; INMET describes it as holding "daily meteorological data in digital form, from historical series of various conventional meteorological stations", updated every 90 days. The page I fetched did not enumerate variables, download mechanism, anemometer height, or licence. `https://bdmep.inmet.gov.br/` responds (HTTP 200) but is a small SPA shell. A newer `https://bndmet.inmet.gov.br/api` appears in INMET search results but **failed DNS resolution** from here.

### Forecast product

`https://apiprevmet3.inmet.gov.br/previsao/{ibge_code}` works and is documented-by-example. Its payload for Salvador (2927408) on 2026-08-28 is a **qualitative municipal text forecast**, keyed by city → date → period (`manha`/`tarde`/`noite`):

```json
{"uf":"BA","entidade":"Salvador","resumo":"Muitas nuvens com névoa úmida",
 "temp_max":31,"temp_min":22,
 "dir_vento":"E-NE","int_vento":"Fraco/Moderado",
 "cod_icone":"5","icone":"data:image/png;base64,..."}
```

There is **no irradiance, no numeric wind speed, no cloud fraction, no hourly resolution, and no hub height**. `int_vento` is the string "Fraco/Moderado". Each day's payload also carries a base64 PNG icon, which bloats the response to ~250 KB per city.

### Solar / wind variables

Not assessable in the forecast product — they do not exist there. Station anemometer height: INMET automatic stations follow WMO practice (10 m), but **I could not confirm the anemometer height from an INMET page** — the manual/BDMEP pages I fetched do not state it. In any case a station anemometer is a point measurement at 10 m, not a hub-height model field.

### Licence

INMET's own guidance states the data are provided but "o uso e aplicação desses dados é de responsabilidade do usuário" ([INMET portal news item](https://portal.inmet.gov.br/noticias/saiba-como-acessar-os-dados-meteorol%C3%B3gicos-dispon%C3%ADveis-no-site-do-inmet)), and warns that automatic-station data are **raw and not quality-controlled** — gaps appear as `9999`, `Null`, or blank. I found **no explicit licence or commercial-use terms** for the APIs. Rate limits: none published that I could find.

### Verdict on the train/serve-skew test

**DISQUALIFIED.** The forecast side is qualitative text at municipal granularity with no radiation and no numeric wind. Even if the historical endpoint worked perfectly it would be observations at 10 m at scattered stations, which cannot be paired with anything on the serving side. INMET's real role in this project is **validation/ground-truth**, not features: a set of independent station observations to sanity-check that the gridded product is not systematically wrong over Brazil.

---

## Copernicus / ERA5 (and ECMWF Open Data)

### Brazil coverage

Global. ERA5 is regridded to a **regular 0.25° lat-lon grid** (~28 km at Brazilian latitudes) for atmospheric variables ([CDS dataset page](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=overview)); the underlying HRES model resolution is 31 km / 0.28125° ([ERA5 data documentation](https://confluence.ecmwf.int/display/CKB/ERA5%3A+data+documentation)). Hourly, "January 1940 to the present". Format GRIB.

### Historical product

ERA5 itself. Latency: **~5 days** for preliminary ERA5T, with the final release "2 to 3 months later" ([CDS dataset page](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=overview), [ERA5 documentation](https://confluence.ecmwf.int/display/CKB/ERA5%3A+data+documentation)). Two consequences worth naming: (a) 5 days is fine for training, useless for serving; (b) **the ERA5T→ERA5 revision means values you ingested can change under you 2–3 months later**, so a naive incremental ingest produces a training set that silently disagrees with a re-pull.

### Forecast product

**ERA5 has none — it is a reanalysis.** The nearest primary-source forecast from the same institution is [ECMWF Open Data](https://www.ecmwf.int/en/forecasts/datasets/open-data): IFS and AIFS at **0.25°**, GRIB2, four cycles a day (00/06/12/18 UTC), out to 360 h, under **CC BY 4.0** ("the data may be redistributed and used commercially, subject to appropriate attribution"). Access is capped at 500 simultaneous connections and it is a **rolling archive retained only ~2–3 days**, also mirrored on AWS/Azure/GCP.

Two problems with using ECMWF Open Data as the serving half:
1. **It is 0.25°, ERA5 is 0.25°, but they are different systems** — a 2026 operational IFS forecast and a 1940–present reanalysis are not the same physics. Same grid, still skew.
2. **The ~2–3 day rolling archive means you cannot build a training set from it.** You would have to start capturing today and wait years. (Open-Meteo's Historical Forecast API exists precisely because this archive is ephemeral.)

The ECMWF Confluence page for open data ([real-time forecasts from IFS and AIFS](https://confluence.ecmwf.int/display/DAC/ECMWF+open+data%3A+real-time+forecasts+from+IFS+and+AIFS)) states files contain "all of the parameters available" **without enumerating them**; I could not confirm from that page whether `ssrd`, `100u/100v`, or `lcc/mcc/hcc` are in the free set. The ECMWF Open Data overview page asserts `ssrd`, `100u`/`100v`, `2t`, `tcc`, `sp` are included. These two claims are in tension and I could not resolve them — see open questions. The corroborating evidence from Open-Meteo's side is discouraging: `models=ecmwf_ifs025` returned **null for `wind_speed_120m`** in my live probe, consistent with the open-data set being narrower than the full IFS.

### Solar variables

ERA5 single levels, confirmed against the [ERA5 data documentation](https://confluence.ecmwf.int/display/CKB/ERA5%3A+data+documentation) parameter table:

| quantity | short name | paramId |
|---|---|---|
| Surface solar radiation downwards (GHI) | `ssrd` | 169 |
| Total sky direct solar radiation at surface | `fdir` | 228021 |
| Surface net solar radiation | `ssr` | 176 |
| Total cloud cover | `tcc` | 164 |
| Low / medium / high cloud cover | `lcc` / `mcc` / `hcc` | 186 / 187 / 188 |
| 2 metre temperature | `2t` | 167 |
| Surface pressure | `sp` | 134 |

Note there is **no native DHI and no native DNI**: you get GHI (`ssrd`) and direct-on-horizontal (`fdir`), and must derive DHI = `ssrd` − `fdir` and DNI = `fdir` / cos(solar zenith), with the usual low-sun-angle blowups. That derivation is extra code that must be byte-identical on both sides of the train/serve boundary.

Also note the **accumulation convention**: ERA5 radiation is accumulated in **J m⁻²** "over the hour ending at the validity date/time", not instantaneous W m⁻². Converting to W m⁻² is a divide-by-3600, and getting the hour-labelling convention wrong is a classic one-hour shift bug in solar models.

### Wind variables and hub height

`10u`/`10v` (165/166) and **`100u`/`100v` (228246/228247)** are both confirmed present in ERA5 single levels ([ERA5 data documentation](https://confluence.ecmwf.int/display/CKB/ERA5%3A+data+documentation)). So ERA5 gives you 100 m natively — you must compute speed and direction from the u/v components yourself, and **anything above 100 m must be extrapolated** (no 120 m field exists).

### Licence

CDS datasets are covered by the "Licence to use Copernicus Products"; the CDS dataset page describes ERA5 as under a "CC-BY licence" ([CDS dataset page](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=overview)), and the CDS documentation notes datasets carry one or more licences that "users have to accept... in order to download" ([CDS documentation](https://confluence.ecmwf.int/display/CKB/Climate+Data+Store+%28CDS%29+documentation)). I did **not** find a page that states in so many words that commercial use is permitted — see open questions. Practically, Copernicus products are widely used commercially with attribution, but that is not a primary-source claim.

### Rate limits

CDS documentation states "limits are set on usage of CDS resources... changed from time to time according to the current workload", split into per-user, global and system categories, and that the CDS "will queue requests which would otherwise cause any of these limits to be exceeded" ([CDS documentation](https://confluence.ecmwf.int/display/CKB/Climate+Data+Store+%28CDS%29+documentation)). Documented **per-request field caps** exist and are dataset-specific: ERA5 hourly pressure levels 120,000 fields, ERA5-Land hourly 12,000 fields, seasonal forecast 10,000 fields. Practical guidance in the ECMWF forum is to keep to ~10 parallel requests. The live limits page is advertised at `https://cds.climate.copernicus.eu/live` — I fetched it and got only the Next.js SPA shell, so I **could not read the current numeric limits**.

Operationally, the bigger cost is not the rate limit but the shape: CDS is a **queued batch job returning GRIB/NetCDF files**, not a synchronous point query. Extracting 10–20 points means downloading area subsets and doing your own nearest-neighbour extraction. Queue waits of minutes to hours are normal.

### Verdict on the train/serve-skew test

**FAILS on its own** (reanalysis only, no forecast). ERA5 + ECMWF Open Data is a *possible* pairing but fails in practice: the open-data archive is ~2–3 days rolling so there is no forecast history to train on, the free parameter set is not confirmed to include what we need, DNI/DHI must be derived, and hub height above 100 m must be extrapolated on both sides.

ERA5's real value here is as an **independent cross-check** — a long, stable, well-understood record to validate that the chosen operational archive is not biased over Brazil, and as the fallback if Open-Meteo becomes unavailable.

---

## NASA POWER

### Brazil coverage

Global. Live probe of `https://power.larc.nasa.gov/api/temporal/hourly/point` at (-12.5, -41.5) with `community=RE` returned all requested parameters for 2023-06-01. Hourly coverage runs "from 2001/01/01 to Near Real Time (NRT)" ([hourly API docs](https://power.larc.nasa.gov/docs/services/api/temporal/hourly/)); the API itself rejects earlier dates with "The data starts at 2001/01/01". The hourly docs say data "are available in their original source spatial resolution" **without stating a number** — see open questions. (POWER's meteorology is MERRA-2-derived, nominally 0.5° × 0.625°, and its solar is CERES/GEOS-derived at 1° — but I could not confirm either from the pages I fetched.)

### Historical product

The hourly point API is the historical product. Live latency probe on 2026-08-28 at the Bahia point:

| requested date | `T2M` | `WS50M` | `ALLSKY_SFC_SW_DWN` |
|---|---|---|---|
| 2026-08-26 | −999 (fill) | — | −999 |
| 2026-08-20 | 28.13 | 2.72 | **−999** |
| 2026-08-01 | 26.95 | — | **−999** |
| 2026-06-01 | — | 2.72 | **−999** |
| 2026-05-01 | — | 4.18 | 333.62 |

**This is the headline finding for POWER: meteorology lags about a week, but solar radiation lags roughly three months.** May 2026 solar is present; June 2026 onwards is `-999`. For a solar-curtailment model that alone is fatal even for retraining cadence, let alone serving.

### Forecast product

**None.** The [hourly API documentation](https://power.larc.nasa.gov/docs/services/api/temporal/hourly/) describes only historical and near-real-time data via the "POWER Near Real Time (NRT) processing system"; the [API overview](https://power.larc.nasa.gov/docs/services/api/) lists three API families (Temporal, Application, System) returning "Analysis Ready Data (ARD) products", with no forecast among them.

### Solar variables

Confirmed live at the Bahia point, with units as returned by the API:

| parameter | units | value at 2023-06-01 12 UTC |
|---|---|---|
| `ALLSKY_SFC_SW_DWN` (GHI) | Wh/m² | 815.72 |
| `ALLSKY_SFC_SW_DNI` (DNI) | Wh/m² | 837.04 |
| `ALLSKY_SFC_SW_DIFF` (DHI) | Wh/m² | 125.68 |
| `CLOUD_AMT` | % | 4.58 |
| `T2M` | °C | 28.5 |
| `PS` | kPa | 94.28 |

Credit where due: **POWER is the only candidate that serves native DNI *and* native DHI as first-class hourly parameters** — better than ERA5, which makes you derive both. Note units are Wh/m² (hourly accumulation) and pressure is **kPa**, not hPa.

### Wind variables and hub height

Confirmed live: `WS10M` (m/s), `WD10M` (deg), `WS50M` (m/s), `WD50M` (deg). Requesting `WS100M` returns an explicit API error: `"One of your parameters is incorrect: WS100M."`

So **POWER tops out at 50 m.** Reaching a 100–120 m hub height requires extrapolating from 50 m, which is better than extrapolating from 10 m but is still an added modelling assumption with no forecast counterpart to match it against.

The hourly API also caps requests at **15 parameters per submission** ([hourly API docs](https://power.larc.nasa.gov/docs/services/api/temporal/hourly/)).

### Licence

NASA POWER's [referencing guide](https://power.larc.nasa.gov/docs/referencing/) asks that users cite the service name, version and access date, and include both POWER's Reference and Data Reference in publications. Broader NASA policy is that mission data are open and, where unmarked, effectively unrestricted. I did **not** find a POWER page stating an explicit licence identifier or an explicit commercial-use permission — see open questions.

### Rate limits

The [API overview](https://power.larc.nasa.gov/docs/services/api/) notes only that "response times vary between the different services and load at a given time". A dedicated rate-limiting docs page at `/docs/services/api/rate-limiting/` **returns HTTP 404**. So I could not confirm any published numeric rate limit.

### Verdict on the train/serve-skew test

**DISQUALIFIED.** No forecast product at all — this is a reanalysis-only source. Compounded by: solar latency of ~3 months, wind ceiling of 50 m, and 15-parameter request cap. POWER is a decent *auxiliary* source for long-run solar climatology and for sanity-checking irradiance magnitudes, and nothing more for this system.

---

## Comparison

| | Open-Meteo (Forecast + **Historical Forecast**) | Open-Meteo (Forecast + ERA5 archive) | INMET | ERA5 / CDS | NASA POWER |
|---|---|---|---|---|---|
| Brazil coverage | global, point query | global, point query | 674 stations, 103 in NE | global grid | global grid |
| Resolution | 9–13 km (global model over BR) | 0.25° / 9 km | point | 0.25° | not stated in docs |
| History back to | ~2021–2022 (2017 for IFS HRES) | 1940 | unconfirmed (204s) | 1940 | 2001 |
| History latency | **~1 day** | ~5 days (ERA5); IFS backfill | n/a | ~5 days, revised at 2–3 mo | ~7 d met / **~3 mo solar** |
| Day-ahead forecast | **yes, 16 d** | yes, 16 d | qualitative text only | **none** | **none** |
| GHI | `shortwave_radiation` both sides | both sides | no | `ssrd` (J/m², accum.) | `ALLSKY_SFC_SW_DWN` |
| DNI | `direct_normal_irradiance` both sides | both sides | no | derive from `fdir` | `ALLSKY_SFC_SW_DNI` |
| DHI | `diffuse_radiation` both sides | both sides | no | derive `ssrd`−`fdir` | `ALLSKY_SFC_SW_DIFF` |
| Cloud low/mid/high | yes both sides | yes both sides | no | `lcc`/`mcc`/`hcc` | `CLOUD_AMT` only |
| Wind 10 m | yes both sides | yes both sides | station obs | `10u`/`10v` | `WS10M`/`WD10M` |
| Wind 100 m | yes both sides | yes both sides | no | `100u`/`100v` | **no** (50 m max) |
| **Wind 120 m (hub)** | **yes both sides** | **no — silent NULLs** | no | no (extrapolate) | no (extrapolate) |
| Parameter names identical train/serve | **yes, verified bit-identical** | mostly, but wind gaps | n/a | n/a | n/a |
| Licence | CC BY 4.0; free tier non-commercial | same | unstated | Copernicus / CC-BY | NASA open, cite |
| Commercial path | paid key, same API syntax | same | unknown | yes (attribution) | presumed yes |
| **Skew verdict** | **PASS (strong)** | partial fail (wind) | **FAIL** | **FAIL** (no forecast) | **FAIL** (no forecast) |

---

## Subsystem aggregation: from point queries to one feature vector per subsystem

### Where the capacity actually is

The point set has to be grounded in where Brazilian VRE capacity physically sits, not in state capitals.

**Wind** — ABEEólica *InfoVento* #39 (10 Mar 2026, [PDF](https://abeeolica.org.br/wp-content/uploads/2026/03/424_ABEEOLICA_INFOVENTO_N39_DIGITAL_V2-1.pdf), index at [abeeolica.org.br/energia-eolica/dados-abeeolica](https://abeeolica.org.br/energia-eolica/dados-abeeolica/)) reports 34,883 MW in 1,123 parks: **BA 11,786 · RN 10,794 · PI 4,415 · CE 2,645 · RS 2,138 · PE 1,263 · PB 1,108 · MA 426 · SC 243**. Independently aggregating the [ANEEL SIGA CSV](https://dadosabertos.aneel.gov.br/dataset/siga-sistema-de-informacoes-de-geracao-da-aneel) (generation date 2026-08-25, `SigTipoGeracao = EOL`, `DscFaseUsina = Operação`) reproduces this within ~1%: 34,874 MW / 1,137 plants, BA 11,832 · RN 10,726 · PI 4,396 · CE 2,690 · RS 2,051 · PE 1,265 · PB 1,171. **Note that Bahia now outranks Rio Grande do Norte** — the older "RN is the wind capital" framing is out of date.

ONS's own [capacidade-geracao](https://dados.ons.org.br/dataset/capacidade-geracao) (dispatched units only) puts eólica at 33,719 MW split **NE 30,765 · S 2,266 · N 426 · SE 261 MW**. So **~91% of Brazilian wind is in the NE subsystem.**

**Utility-scale solar** — ABSOLAR ([12 Jan 2026 release](https://www.absolar.org.br/noticia/grandes-usinas-solares-ultrapassam-20-gw-de-potencia-instalada-diz-absolar/)) puts centralised solar past 20 GW, regionally **Nordeste 52% · Sudeste 46.8% · Sul 0.5% · Centro-Oeste 0.28% · Norte 0.26%**. ANEEL SIGA (UFV, Operação) totals 22,946 MW: **MG 8,767 · BA 3,045 · PI 2,404 · CE 2,298 · RN 2,113 · PE 1,505 · SP 1,223 · PB 715 · GO 365**. ONS `capacidade-geracao` shows fotovoltaica in only two subsystems: **NE 11,446 MW, SE 10,757 MW**.

The practical consequence: **N and S are nearly irrelevant to VRE curtailment** (S has 2.3 GW wind and essentially no utility solar; N has 426 MW wind and no solar), while **NE carries the wind and half the solar, and SE/CO carries the other half of the solar, concentrated in northern Minas Gerais**.

### Subsystem membership

ONS's [O que é o SIN](https://www.ons.org.br/paginas/sobre-o-sin/o-que-e-o-sin) says only that the SIN has "quatro subsistemas: Sul, Sudeste/Centro-Oeste, Nordeste e a maior parte da região Norte" — **it gives no state list**. The mapping has to be derived from ONS's own registries. From [SUBESTACAO.csv](https://dados.ons.org.br/dataset/subestacao) (1,687 rows, `id_subsistema` × `id_estado`):

- **N**: PA, MA, AM, TO, AP, RR (+1 MT)
- **NE**: BA, CE, PE, RN, PI, PB, AL, SE
- **SE** (Sudeste/Centro-Oeste): SP, MG, GO, MT, RJ, MS, RO, ES, DF, AC (+ some PR, TO, PA)
- **S**: RS, PR, SC

Two warnings that matter for feature engineering: **assignment is electrical, not administrative** — Tocantins straddles N and SE, Itaipu 60 Hz is SE despite sitting in PR, and six Bahian wind plants ("Serra das Almas I–VI") are classified SE. So **do not derive subsystem from state**; carry ONS's plant-level `id_subsistema` (it is present in the curtailment datasets directly).

### Is a plant-location registry with coordinates publicly available?

**Yes — ANEEL SIGA, and it is the right tool.** Direct CSV:

```
https://dadosabertos.aneel.gov.br/dataset/6d90b77c-c5f5-4d81-bdec-7bc619494bb9/resource/
  11ec447d-698d-4ab8-977f-b424d5deee6a/download/siga-empreendimentos-geracao.csv
```

8.4 MB, `;`-delimited, UTF-8, decimal comma, 25,133 rows, `DatGeracaoConjuntoDados = 2026-08-25`. Coordinate columns are `NumCoordNEmpreendimento` (latitude) and `NumCoordEEmpreendimento` (longitude), and **coordinate coverage is 100%** for operating EOL (1,137/1,137) and UFV (17,260/17,260). Also carries `CodCEG`, `SigUFPrincipal`, `MdaPotenciaFiscalizadaKw`, `DatEntradaOperacao`, `DscMuninicpios`. Licence: **ODbL** per the dataset page. (The ANEEL metadata does not advertise the coordinate columns; their presence was confirmed by downloading.)

**ONS does not publish a plant registry with coordinates.** Enumerating the full ONS CKAN catalogue (`https://dados.ons.org.br/api/3/action/package_list`, 84 datasets) turns up no *cadastro de usinas* with lat/lon; `capacidade-geracao` has state and subsystem but no coordinates, and the only ONS dataset with coordinates is `subestacao`. **The join that makes capacity weighting possible is SIGA's `CodCEG` ↔ ONS's `ceg`**, which appears in the constrained-off datasets ([wind detail](https://dados.ons.org.br/dataset/restricao_coff_eolica_detail), [solar](https://dados.ons.org.br/dataset/restricao_coff_fotovoltaica)). ONS data is Creative Commons Atribuição.

**So capacity-weighted aggregation does *not* require anything private.** SIGA gives (lat, lon, MW, CEG, technology, commissioning date) for every plant; ONS gives (CEG → subsystem) and the curtailment target itself at 30-minute granularity through 2026-08. That is everything needed.

### Recommended approach: cluster-centroid points, capacity-weighted

Do **not** query one point per subsystem — a single point cannot represent 30 GW spread over 1,500 km of Bahia and Rio Grande do Norte, and the NE's coastal-RN and interior-BA wind regimes are meteorologically distinct (sea-breeze/trade-wind vs. elevated plateau). Do **not** query one point per plant either — 1,137 wind plants × 24 h/day blows the Open-Meteo call budget and buys almost nothing, because plants cluster inside single grid cells.

The middle path: **k cluster centroids, each weighted by the installed MW it represents**, then `feature_subsystem_t = Σ_i w_i · x_i,t` with `w_i = MW_i / Σ MW`. Separate weight vectors for wind and solar, since the fleets sit in different places.

The following points are **centroids of ANEEL SIGA plant coordinates** aggregated by municipality (computed from the CSV cited above), not gazetteer points:

**NE — wind (~30.8 GW, ~91% of national wind):**

| # | cluster | lat | lon | MW represented |
|---|---|---|---|---|
| W1 | Morro do Chapéu / Chapada Diamantina, BA | −11.216 | −41.341 | 1,992 |
| W2 | Sento Sé + Campo Formoso, BA (north São Francisco) | −10.34 | −41.02 | 2,399 |
| W3 | Gentio do Ouro / Serra do Assuruá + Xique-Xique, BA | −11.15 | −42.60 | 1,955 |
| W4 | Caetité, BA (south) | −14.180 | −42.574 | 921 |
| W5 | Dom Inocêncio + Lagoa do Barro do Piauí, PI | −8.80 | −41.60 | 2,016 |
| W6 | Simões, PI (PE border) | −7.644 | −40.688 | 694 |
| W7 | Coastal-east RN: João Câmara / Lajes / Parazinho / São Bento do Norte / São Miguel do Gostoso / Pedro Avelino | −5.40 | −36.05 | 4,172 |
| W8 | Serra do Mel, RN (coastal-west) | −5.292 | −37.195 | 1,200 |
| W9 | Trairi, CE (coast) | −3.273 | −39.318 | 768 |

**NE — solar (~11.4 GW):**

| # | cluster | lat | lon | MW |
|---|---|---|---|---|
| S1 | Açu, RN | −5.586 | −37.042 | 1,239 |
| S2 | Juazeiro, BA / Petrolina axis | −9.640 | −40.615 | 972 |
| S3 | São Gonçalo do Gurguéia + Ribeiro Gonçalves, PI (SW Cerrado) | −8.90 | −45.24 | 1,314 |
| S4 | São José do Belmonte, PE | −7.897 | −38.743 | 863 |

**SE/CO — solar (~10.8 GW, overwhelmingly northern Minas Gerais):**

| # | cluster | lat | lon | MW |
|---|---|---|---|---|
| S5 | Janaúba + Jaíba, MG | −15.62 | −43.60 | 3,534 |
| S6 | Paracatu + Arinos, MG (northwest) | −16.48 | −46.41 | 3,051 |
| S7 | Pirapora + Várzea da Palma, MG | −17.47 | −44.84 | 1,494 |

**S (~2.3 GW wind, negligible solar):**

| # | cluster | lat | lon | MW |
|---|---|---|---|---|
| W10 | Santa Vitória do Palmar, RS (far south — the modern RS centre of gravity, not Osório) | −33.418 | −53.156 | 628 |
| W11 | RS/SC north-coast belt (Osório and successors) | −29.80 | −50.30 | ~600 |

**N (~426 MW wind, no utility solar):**

| # | cluster | lat | lon | MW |
|---|---|---|---|---|
| W12 | Maranhão coastal wind | −2.70 | −42.70 | 426 |

That is **20 points**. A 12-point starter set that still covers >80% of capacity: W1, W2, W3, W5, W7, W8, W9 (wind NE); S1, S3 (solar NE); S5, S6 (solar SE/CO); W10 (S). Add W12 only if N-subsystem curtailment turns out to matter.

**Caveats worth stating up front.** (a) The W11 and W12 coordinates are approximate — I did *not* verify them against SIGA municipality centroids the way the others were, because those municipalities fell outside the top-18 list I obtained. Recompute them from the SIGA CSV before use. (b) Weights are static snapshots; SIGA carries `DatEntradaOperacao`, so weights should be recomputed **as of each timestamp** for a 2023→now backtest, otherwise you leak 2026 fleet composition into 2023 features. (c) At 9–13 km global-model resolution, W1/W3 and W7/W8 pairs may land in adjacent or even the same grid cell — check the `latitude`/`longitude` Open-Meteo echoes back and deduplicate.

---

## Storage cost: hourly weather in Postgres

**Time span.** 2023-01-01 → 2026-08-28 is 1,335 days = **32,040 hours**.

**Variable set (16), the one that has full train/serve parity on Open-Meteo:**
`temperature_2m`, `surface_pressure`, `shortwave_radiation`, `direct_radiation`, `diffuse_radiation`, `direct_normal_irradiance`, `cloud_cover`, `cloud_cover_low`, `cloud_cover_mid`, `cloud_cover_high`, `wind_speed_10m`, `wind_direction_10m`, `wind_speed_100m`, `wind_direction_100m`, `wind_speed_120m`, `wind_direction_120m`.

**Layout A — wide table, one row per (point, hour), 16 `real` columns.**

Per-row bytes:
- tuple header `HeapTupleHeaderData` = 23 B, plus null bitmap for 18 columns = 3 B → 26 B, MAXALIGN(8) → **32 B**
- `ts timestamptz` = 8 B
- `point_id smallint` = 2 B (aligned into 4 with padding before the `real` run)
- 16 × `real` (float4) = **64 B**
- item pointer in the page = **4 B**

`32 + 8 + 4 + 64 + 4 =` **112 B/row**, call it **116 B** with page-level slack.

| points | rows | heap | PK btree on (point_id, ts) ≈ 32 B/entry | total |
|---|---|---|---|---|
| 10 | 320,400 | 37 MB | ~10 MB | **~47 MB** |
| 20 | 640,800 | 74 MB | ~21 MB | **~95 MB** |

**Layout B — long/EAV, one row per (point, hour, variable).** 20 × 32,040 × 16 = **10,252,800 rows**. Per row ≈ 32 B header + 8 ts + 2 point + 2 var_id + 4 value → padded ~56 B + 4 B item pointer = 60 B → **615 MB heap**, plus a composite index at ~30 B/entry ≈ 300 MB → **~0.9 GB**.

**Conclusion: use the wide layout.** It is ~10× smaller and roughly an order of magnitude faster to read as a feature matrix. Under 100 MB for the full 20-point 2023→now history, this fits comfortably in any Railway Postgres plan and needs no partitioning, no TimescaleDB, and no compression. If it ever mattered, `float4` → `smallint` with a fixed scale factor would halve the payload again, but at this size that is not worth the complexity.

**Ongoing cost.** Serving adds one day-ahead forecast vector per point per day: 20 points × 24 h × 116 B ≈ **56 KB/day**, ~20 MB/year, even if you keep every issued forecast (which you should, to measure forecast error). The archive backfill grows at the same 56 KB/day. **Total steady state well under 200 MB for several years.**

**API call cost.** Backfilling 20 points × 3.7 years from the Historical Forecast API, with the documented weighting ("more than 10 weather variables or... more than 2 weeks for a single location" count as multiple calls — a 2-week/15-variable request = 1.5 calls, 4 weeks = 3.0), is roughly 20 points × 96 fortnights × 1.6 ≈ **~3,100 weighted calls** — a third of one day's free-tier allowance. Daily serving is 20 calls/day. **Volume is a non-issue on either tier; the licence is the only gating factor.**

---

## Recommendation

**Use Open-Meteo, pairing the Forecast API for serving with the *Historical Forecast API* for training — not the ERA5 Historical Weather API.**

### Reasoning

1. **It is the only candidate that passes the disqualifying constraint at all.** ERA5 and NASA POWER have no forecast product; INMET's forecast is qualitative municipal text with no irradiance and no numeric wind speed. Three of four candidates are out on the stated constraint alone.

2. **It passes in the strong form, and this was verified rather than assumed.** For 2026-08-24T12:00 at (−12.5, −41.5), the Historical Forecast API and the Forecast API returned bit-identical values on all eight variables tested, including `wind_speed_120m` (25.0 km/h from both). That is the same model, same grid, same post-processing, same parameter names — not merely "the same variable exists in both".

3. **Hub-height wind is native, not extrapolated.** `wind_speed_80m/100m/120m/180m` and matching directions exist in both products. Every alternative caps out at 100 m (ERA5) or 50 m (POWER) and forces a power-law extrapolation that would then have to be reproduced identically at serve time — a second, entirely avoidable skew source. For a Brazilian NE fleet with 80–120 m hubs this is the difference between a feature and a guess.

4. **Native DNI and DHI.** ERA5 gives `ssrd` and `fdir` and makes you derive DHI and DNI, with a divide-by-cos(zenith) that misbehaves at low sun angles and an accumulation-vs-instantaneous convention that is a classic one-hour-shift bug. Open-Meteo serves `direct_normal_irradiance` and `diffuse_radiation` directly in W/m², identically on both sides.

5. **Latency fits the operational loop.** The Historical Forecast API had 2026-08-27 data on 2026-08-28 — ~1 day. ERA5 is 5 days behind *and revises itself 2–3 months later*; POWER's solar is ~3 months behind. Only Open-Meteo lets you retrain on data that includes last week.

6. **The commercial transition is cheap and pre-planned.** Free tier is CC BY 4.0, non-commercial, 10,000 calls/day — our whole daily serving load is ~20 calls. Going commercial is a paid key and a hostname swap: "the API syntax is identical to the free tier — only the domain and `key` parameter differ". Build against `customer-api.open-meteo.com`-shaped config from day one and the migration is an environment variable.

7. **There is an escape hatch.** The server is AGPL-3.0 open source, so if pricing or terms move against us we can self-host rather than rewrite the feature pipeline.

Concretely: **backfill 2023-01-01 → now from `historical-forecast-api.open-meteo.com/v1/forecast`, serve day-ahead from `api.open-meteo.com/v1/forecast`, pin the same 16-variable list and the same `models=` choice on both, and store into the wide Postgres layout.** Pull ERA5 for the same points as a *second, separately-named* feature family used only for validation and drift-checking — never mixed into the training columns.

### Risks, and what would falsify this

- **`best_match` is not a stable contract.** Open-Meteo can change which model `best_match` resolves to over Brazil, silently altering the feature distribution mid-life. **Mitigation: pin an explicit `models=` value on both endpoints** and treat a model change as a retrain trigger. *But note the trap I found:* `models=ecmwf_ifs025` returns **null `wind_speed_120m`**. Pinning must be validated per variable, not assumed. Falsifier: pin a model, discover it lacks a variable `best_match` was supplying.
- **The Historical Forecast archive is a *stitch*, not a true day-ahead archive.** The docs describe it as the *initial hours* of successive runs concatenated — i.e. closer to an analysis than to a genuine D+1 forecast. So training on it may still leave a mild optimism bias relative to serving a real 24–48 h lead time. **This is the most serious residual risk and I could not fully characterise it.** Falsifier: compare, for the same target hours, the Historical Forecast API values against Forecast API values *captured live at D−1* over several weeks; a systematic gap means the training set is easier than reality. Open-Meteo's "Previous Model Runs API" / "Single Runs API" may be the correct fix — I did not evaluate them.
- **Single-vendor dependency.** Open-Meteo is a small operation. Mitigations: AGPL self-hosting; ERA5 kept warm as a validation feed so a fallback is a known quantity rather than a panic.
- **Non-commercial terms.** Running the free tier once WattSteer monetises is a licence breach, not a grey area — the terms explicitly exclude "integrating our service into commercial products". Falsifier for the cost model: the paid tier prices, which I could not read (see below).
- **Point representativeness.** A 9–13 km global model at 20 centroids may simply not resolve the sea-breeze and complex-terrain effects that drive NE wind ramps. Falsifier: fit the model and find that capacity-weighted point features explain little of the ONS constrained-off signal; the fix would be more points, or a mesoscale/satellite product (Open-Meteo's Satellite Radiation API is on the paid tier and worth revisiting for solar).
- **Fleet-composition leakage.** If capacity weights are computed from today's SIGA snapshot and applied to 2023 features, the backtest is contaminated. Mitigation: time-varying weights from `DatEntradaOperacao`.

---

## Open questions / could not confirm

**Open-Meteo**
- Which model `best_match` actually selects over Brazil. Live probes show it matches none of `ecmwf_ifs025`, `gfs_seamless`, or `icon_seamless` at the tested point/hour, but no documentation page I fetched states the selection rule for South America.
- Paid-tier **prices** in currency. The pricing page renders them client-side; the fetched HTML contained the tier names and call budgets but no numbers.
- Whether the Historical Forecast API's "initial hours of successive runs" stitching leaves a measurable optimism bias versus a true D−1 forecast. **This is the load-bearing unknown in the recommendation.**
- The "Previous Model Runs API" and "Single Runs API" (listed on the pricing feature matrix) were not evaluated; one of them may provide genuine lead-time-matched history.
- Exact start date of Historical Forecast coverage for the model `best_match` uses over Brazil. Verified non-null back to 2021-06-01 at one point; the docs say "around 2022" generally.

**INMET**
- **Whether hourly historical station observations are retrievable at all.** `apitempo.inmet.gov.br/estacao/{start}/{end}/{station}` returned HTTP 204 for every station and date tried on 2026-08-28. Undocumented — could be a credential requirement, a decommissioning, or an outage.
- BDMEP's variable list, whether it includes global solar radiation, its download mechanism, and its licence — the portal page I fetched states none of these.
- **INMET anemometer height.** Not stated on any page I fetched. WMO convention is 10 m but that is an assumption, not a citation.
- Any explicit licence or commercial-use terms for INMET's APIs — none found.
- `bndmet.inmet.gov.br/api` (a newer INMET data-bank API surfaced in search) **failed DNS resolution**.

**Copernicus / ERA5 / ECMWF**
- **Whether the free ECMWF Open Data parameter set actually includes `ssrd`, `100u`/`100v`, and `lcc`/`mcc`/`hcc`.** The [open-data overview page](https://www.ecmwf.int/en/forecasts/datasets/open-data) asserts yes; the [Confluence real-time forecasts page](https://confluence.ecmwf.int/display/DAC/ECMWF+open+data%3A+real-time+forecasts+from+IFS+and+AIFS) says files contain "all of the parameters available" without enumerating them. Unresolved.
- **Current numeric CDS per-user limits** (concurrent requests, queued requests). The live limits page at `cds.climate.copernicus.eu/live` returned only a JavaScript SPA shell.
- **Whether the Copernicus licence explicitly permits commercial use.** The CDS pages describe a "CC-BY licence" and a "Licence to use Copernicus Products" that users must accept, but I found no page stating the commercial-use permission in terms.
- The exact retention window of the ECMWF Open Data rolling archive — the overview page says ~2–3 days / ~12 runs; the Confluence page does not state it.

**NASA POWER**
- **Spatial resolution.** The hourly docs say data are "available in their original source spatial resolution" without giving a number.
- **Rate limits.** No published numbers found; `/docs/services/api/rate-limiting/` returns HTTP 404.
- **Licence.** No POWER page states an explicit licence identifier or explicit commercial-use permission; only the [referencing guide](https://power.larc.nasa.gov/docs/referencing/)'s citation request was confirmed.
- Whether the ~3-month solar latency observed on 2026-08-28 is a documented steady state or a transient processing backlog.

**Brazil capacity / registries**
- **ABSOLAR state-level solar MW** — the [infographic](https://www.absolar.org.br/mercado/infografico/) is form-gated. State figures above come from ANEEL SIGA instead.
- ABEEólica InfoVento #39's reference date: the PDF's own footnote reads "ATUALIZADO CONFORME ANEEL / ABEEÓLICA EM OUTUBRO DE 2024", contradicting its March-2026 edition date.
- **No official ONS page listing states per subsystem in prose was found**; the mapping above is derived from ONS's `subestacao` registry.
- Whether ONS's `linha-transmissao` dataset carries geometry (not downloaded).
- Exact semantics of the ONS constrained-off columns (`val_geracaoestimada` vs `val_geracaoverificada`, `cod_razaorestricao` codes `ENE`/`REL`/`CNF`) — the data dictionaries were not read, so any curtailment ratios derived from them are indicative only.
- The W11 (RS/SC north coast) and W12 (Maranhão) coordinates are **approximate** and were not computed from SIGA municipality centroids; recompute before use.

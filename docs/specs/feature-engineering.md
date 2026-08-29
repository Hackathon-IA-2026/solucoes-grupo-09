# Spec — WattSteer Feature Engineering

> From canonical bitemporal facts to the feature vector the day-ahead model is
> trained on and served from — one definition, one gate, no train/serve skew.
>
> **Evidence base.** Every factual claim traces to the research files, which are
> the authority and are *not* restated here:
> [`ons-datasets.md`](../research/ons-datasets.md) ·
> [`weather-sources.md`](../research/weather-sources.md) ·
> [`weather-lead-time.md`](../research/weather-lead-time.md) ·
> [`plant-registry.md`](../research/plant-registry.md).
>
> **Naming authority.** [`../domain-model.md`](../domain-model.md) is the
> ubiquitous language; where it and this spec disagree, it wins.
>
> **Upstream spec.** [`data-platform.md`](data-platform.md) produces the
> canonical facts this document consumes, and defers two decisions here: the
> **weather variable list** and the **centroid set**. Both are settled below.
>
> Ticket: [`008-feature-spec.md`](../../.wayfinder/tickets/008-feature-spec.md).
> Map: [`.wayfinder/map.md`](../../.wayfinder/map.md).

## Problem Statement

IDEA.md §4–§12 proposes a feature set that reads well and is, as written, mostly
unbuildable. It asks for `solar_ramp_1h = solar[t] − solar[t−1]`, for
`residual_load = load − solar − wind`, for `load_t-24`, for
`exchange_utilization`, for `solar_capacity_factor`. Every one of those is a
function of **day D's actuals**, and WattSteer must produce its forecast at
**D−1**, when day D's actuals do not exist and will not exist for another one to
two days.

A model trained on those features and served in production is not merely
optimistic. It is *silently* optimistic, in the specific way the weather
lead-time research exists to prevent: the backtest reports a number the live
system can never reproduce, no walk-forward split catches it, because the leak
lives inside the feature rather than in the split, and the first honest signal
arrives weeks later as unexplained live degradation. This is the same failure
class as the data platform's silent-join problem, one layer up — a plausible
chart instead of a crash.

The failure has a second face that is easier to miss. A feature can be *dropped*
for the wrong reason too. `residual_load` is the single most physically
meaningful quantity in this domain — it is what curtailment *is* — and abandoning
it because the actuals are unavailable would throw away the product. The correct
move is neither to leak it nor to drop it, but to **rebuild it from sources that
genuinely exist at D−1**: ONS's own day-ahead programming, the DESSEM balance,
and a pinned weather run.

So there are really three problems stacked:

1. **Classification.** Every proposed feature must be sorted into: available from
   DESSEM, available from the weather forecast, available from ONS day-ahead
   programming, replaceable by a last-known value, deterministic, or dropped.
   Unclassified is not an option — an unclassified feature is a leak waiting to
   be written.
2. **Enforcement.** Classification by discipline decays. A future session adds a
   `lag_24h` because pandas made it easy, and nothing fails. The classification
   has to be enforced by construction and by a test that can detect a violation
   it was not told about in advance.
3. **Two feature sets, not one.** The map settled DESSEM as an A/B: a
   DESSEM-free model over 2024-04→now and a DESSEM-augmented model over
   2025-05→now. That is two feature vectors, two windows, and — a consequence
   nobody has written down yet — **two different decision gates**, because
   DESSEM for day D is not published until the evening of D−1.

## Solution

**One SQL function, called twice.**

The whole design collapses to a single idea: the point at which the future
becomes unknowable is a **function of the target date**, not a property of the
caller. Define

```
gate_at(target_date, gate_profile) -> timestamptz
```

and make *every* as-of join, every lag offset and every rolling window inside the
feature builder resolve against `gate_at(...)`. Training then passes a date
range and serving passes tomorrow's date, and they execute **the same expression
over the same tables**. Train/serve skew stops being something to avoid and
becomes something that cannot be expressed.

**The tables it reads through are the canonical views** of tickets 013/016, not the
ingest tables. The feature function is where ONS's conventions would get
reimplemented if anywhere, so it must not be able to see a padded code, an
average-power value or an end-of-interval timestamp in the first place. Ticket
016 settled that the contract is SQL for exactly this reason; see
`api-surface.md` § the publication job.

On top of that spine:

- **Facts are read at two different as-ofs, deliberately.** Features are read
  `AsOf(gate)`. Labels are read `AsOf(now)`. That asymmetry is the one place the
  point-in-time discipline is broken on purpose, and §*Implementation Decisions*
  says why.
- **Observations are cut on `valid_time`, forecasts on `published_at`.** These
  are not interchangeable, and conflating them is the subtlest available leak.
- **Local differences are never last-known-valued.** A level can be carried
  forward honestly; a ramp cannot. Ramps survive only where the *whole day-D
  profile* is known at D−1 — which is exactly the weather run, the DESSEM
  balance and the ONS programming, and never the actuals.
- **Residual load is rebuilt, not dropped.** Set B gets it from DESSEM directly.
  Set A gets it from ONS `carga-energia-programada` (a day-ahead load forecast
  covering the *entire* 2024-04 window) minus a deterministic power-curve /
  irradiance conversion of the pinned weather run scaled by
  `InstalledCapacityAsOf`.
- **The interchange limit is estimated, because no published one exists**, and
  the estimator is itself point-in-time so the proxy cannot leak.

## User Stories

**The gate**

1. As the platform, I want the D−1 cut-off expressed as a function of the target
   date, so that training and serving cannot use different cut-offs.
2. As the platform, I want two named gate profiles — an early gate on the D−1
   00Z weather run and a late gate on the D−1 12Z run plus DESSEM — so that the
   product's two publication times are a configuration rather than two code
   paths.
3. As the platform, I want a model artifact bound to exactly one
   (gate profile, feature set, threshold) triple, so that an artifact can never
   be served against inputs it was not trained on.
4. As an analyst, I want the gate stamped on every feature row, backtest and
   prediction, so that any number can be traced to what was knowable when.
5. As the platform, I want DESSEM features to be unavailable at the early gate
   by construction, so that a model cannot be served with a file that will not
   exist for another eleven hours.

**Observations, and what is actually known at the gate**

6. As the platform, I want observation-sourced features cut on `valid_time`
   against a per-dataset publication lag, so that the backfill window — where
   every row shares one `ingested_at` — is still honestly point-in-time.
7. As the platform, I want that publication lag to be a configured constant per
   dataset with a deliberately conservative default, so that an unmeasured
   latency cannot become an unmeasured leak.
8. As an operator, I want a scheduled check that measures the real publication
   lag and fails when it exceeds the configured constant, so that ONS getting
   slower is an alert rather than a silent column of NULLs.
9. As a modeller, I want the measured distance from the gate to the last
   available actual exposed as a feature, so that the model can condition on how
   stale its own inputs are.
10. As a modeller, I want lag offsets that do not clear the cut-off to be NULL
    rather than shifted to the nearest available hour, so that a lag never
    silently changes meaning between rows.
11. As a modeller, I want last-known-value substitution permitted only for level
    features, so that no difference or ramp is ever reconstructed from a
    constant.
12. As a modeller, I want rolling windows over actuals to end at the cut-off and
    rolling windows over forecasts to be free to centre on the target hour, so
    that the two kinds of window are visibly different things.

**Rebuilding the physics that D−1 removes**

13. As a modeller, I want residual load available in both feature sets, so that
    the most physically meaningful quantity in the domain is not lost to the
    day-ahead constraint.
14. As a modeller, I want ONS `carga-energia-programada` ingested as a Forecast
    with its own `published_at`, so that the DESSEM-free set has a genuine
    day-ahead load view across the whole window.
15. As a modeller, I want expected VRE generation derived from the pinned
    weather run and `InstalledCapacityAsOf` by a *deterministic* conversion, so
    that no model-inside-a-model is introduced and the conversion is identical
    in training and serving.
16. As a modeller, I want the wind conversion to be a published power curve with
    its parameters written down, so that it is arguable rather than magic.
17. As a modeller, I want the solar conversion to be STC-referenced with no
    temperature derate, and air temperature present in the vector, so that the
    model learns the temperature interaction rather than inheriting my guess at
    it.
18. As a modeller, I want DESSEM's implied net export derived from its own
    energy identity, so that the exchange signal exists day-ahead even though
    DESSEM publishes no exchange column.

**Weather**

19. As the platform, I want a pinned, explicit list of twelve weather variables,
    so that the call-weighting cliff, the null-under-`ecmwf_ifs` variables and
    the training backfill are all decided once.
20. As the platform, I want a variable that is documented-but-null under the
    pinned model excluded from the list rather than requested and discarded, so
    that no run writes a column of NULLs.
21. As the platform, I want centroids frozen for the life of a feature-set
    version while their weights vary with time, so that the query point does not
    drift underneath the series.
22. As the platform, I want two centroids that snap to the same Open-Meteo grid
    cell to be a build error, so that a duplicated column is never averaged in
    twice.
23. As the platform, I want the centroid set generated from the registry by a
    script rather than transcribed, so that it is reproducible and regenerable.
24. As an operator, I want a drift metric on capacity-weighted plant-to-centroid
    distance, so that a growing fleet triggers regeneration rather than quietly
    invalidating the points.
25. As the platform, I want a fallback to the previous available run when a run
    is missing, with the substitution exposed as a feature, so that a 4.5%
    missing-run rate degrades the forecast rather than corrupting it.
26. As the platform, I want the weather completeness contract asserted at serve
    time and a refusal on failure, so that an incomplete run never becomes an
    imputed one.

**Calendar and capacity**

27. As a modeller, I want calendar features computed in Brasília local civil
    time, so that the diurnal and holiday structure matches the grid rather than
    UTC.
28. As the platform, I want the ingestion contract to state the `din_instante`
    timezone assumption explicitly rather than inherit it, so that the one
    undocumented fact the whole time axis rests on is written down.
29. As an operator, I want a canary asserting exactly 24 distinct local hours per
    target date, so that a DST change in Brazilian law surfaces as a test
    failure rather than a duplicated hour.
30. As a modeller, I want the Brazilian holiday calendar materialised as data
    with a pinned generator version, so that upgrading a library cannot silently
    restate three years of training features.
31. As a modeller, I want national and regional holidays separated, so that a
    state observance is not modelled as if the whole subsystem stopped.
32. As a modeller, I want installed capacity joined as a function of the target
    date read through the gate's vintage, so that neither today's fleet nor a
    unit commissioned after the gate contaminates a historical row.
33. As an analyst, I want capacity features marked day-grain, so that a value
    constant across 24 hours is not mistaken for an hourly signal.

**Interchange**

34. As an analyst, I want the absence of any published interchange limit stated
    rather than worked around silently, so that the utilisation feature is
    understood as an estimate.
35. As the platform, I want the export-capability estimate computed only from
    flows observed before the gate, so that the denominator of a utilisation
    ratio cannot leak the future.
36. As the platform, I want the estimate to be a high quantile rather than a
    maximum, so that one outlier hour does not define a year of denominators.
37. As an analyst, I want the estimate published per directed corridor with its
    sample size, so that a corridor that never binds is visibly not a constraint.

**The two feature sets**

38. As a modeller, I want `dessem_free_v1` over 2024-04-01→now and
    `dessem_augmented_v1` over 2025-05-23→now built by the same function under
    different arguments, so that the A/B compares feature content and not two
    implementations.
39. As a modeller, I want the A/B run on the common window as well as each set's
    native window, so that DESSEM's contribution is separated from the effect of
    training on a longer history.
40. As a modeller, I want the features that exist *only* in the augmented set
    enumerated explicitly, so that "what does DESSEM buy" has a written answer
    before any model is trained.
41. As a modeller, I want both sets evaluated on the same held-out period at the
    same gate, so that the comparison is not confounded by the evaluation split.

**Labels**

42. As a modeller, I want the positive class defined by a threshold passed as an
    argument, so that the >1 / >5 / >10 MW sweep costs a parameter rather than a
    rebuild.
43. As a modeller, I want `has_curtailment` derived at feature-build time and
    never stored, so that two consumers cannot hold disagreeing thresholds.
44. As a modeller, I want labels read at the latest vintage while features are
    read at the gate, so that the model learns to predict reality rather than
    ONS's first draft.
45. As an analyst, I want the label's vintage fidelity carried through to every
    metric, so that a `revision_optimistic` window is never reported as
    point-in-time.

**One definition, verified**

46. As a developer, I want features defined in SQL owned by the API's migration
    tree, so that there is exactly one implementation and it lives with the
    schema authority.
47. As a developer, I want the Python service to call the feature function and
    perform no windowed or joined computation of its own, so that the ownership
    boundary is also the definition boundary.
48. As a developer, I want a test that builds a past date's feature row through
    the training path and the serving path and asserts they are identical, so
    that the central claim of this spec is checked rather than asserted.
49. As a developer, I want a gate-ablation test that deletes every post-gate row
    and asserts no feature value changes, so that a leak is detected even when
    nobody thought to look for it.
50. As a developer, I want the seven-day same-hour baseline computed from the
    same function as the model's features, so that the mandatory baseline and
    the model cannot disagree about what "yesterday" means.

## Implementation Decisions

### The gate, precisely

Two profiles. Times are Brasília local civil time (`America/Sao_Paulo`); the
window contains no DST transitions and the builder asserts that.

| Profile | Weather run | DESSEM | Gate instant | Feature sets |
|---|---|---|---|---|
| `gate_early` | D−1 **00Z** (disseminated ≈ 06:00 BRT) | ✗ not yet published | **D−1 09:00 BRT** | `dessem_free_v1` only |
| `gate_late` | D−1 **12Z** (disseminated ≈ 15:00 BRT) | ✓ file created ≈ 14:48–16:42 BRT | **D−1 19:00 BRT** | both |

> **Corrected while implementing ticket 08.** This table first read "file
> created ≈ 17:48 BRT", taking CKAN's naive `created` timestamp as local time.
> It is UTC — confirmed by matching an S3 `Last-Modified` of 19:42:43 GMT
> against a CKAN `created` of 19:43:09 for the same file — so DESSEM publishes
> mid-afternoon Brasília, not evening. The conclusion is unchanged and slightly
> safer: still comfortably inside `gate_late`, still hours after `gate_early`.

`gate_late` is v1's primary. It is measurably better weather (RMSE 4.38 vs 4.76
km/h on `wind_speed_120m`) and it is the only gate at which DESSEM exists at all.

**DESSEM's exclusion from the early gate is structural, not a rule.** The DESSEM
file for reference day D is created on the evening of D−1 — 2026-08-28's file was
created 2026-08-27T17:48 **UTC**. At 09:00 on D−1 the newest DESSEM file describes D−1
itself. So the A/B is not only a shorter window; it is also **eleven hours less
notice**. That cost belongs in the comparison and was not previously recorded.

### Where the cut actually falls: `valid_time` for observations, `published_at` for forecasts

This is the decision most likely to be got wrong by a later session, because
`AsOf(t)` looks like it already solves it.

`AsOf(gate)` filters on `ingested_at` — *when WattSteer learned a value*. For
the backfill window every row was ingested at go-live, so `AsOf(gate)` for a 2024
target date returns everything and filters nothing. For a **Forecast** table that
is still fine: a weather row carries the run initialisation as `published_at` and
a DESSEM row carries the file creation, so `published_at ≤ gate` is a genuine
point-in-time filter even in backfill. For an **Observation** table it is not
fine at all — the balanço row for 2024-06-10 14:00 has a `published_at` derived
from an S3 `Last-Modified` that may be *2026*, and no filter on either vintage
axis will stop it entering a feature for 2024-06-10.

So:

- **Forecast-sourced features** (weather, DESSEM, ONS programming) are cut on
  `published_at ≤ gate`, and their D−1 availability is *genuine* in backfill.
- **Observation-sourced features** are cut on
  `valid_time ≤ actuals_cutoff(gate, dataset)`, and their D−1 availability is
  *enforced*, not observed.

> **Corrected while implementing ticket 01.** The canonical weather view carried
> no publication cut at all — ticket 016 put the gate on the day-ahead balance
> and left it off the weather read, because within a target day the newer run
> winning is exactly right. It is exactly wrong *across* the gate: the D 00Z run
> is a newer version of day D's hours than the D−1 12Z run, so a `gate_late`
> feature silently read a run that would not exist for another three hours, and
> over backfill `AsOf(gate)` filters nothing and caught none of it. The gate is
> now applied inside both forecast views. The rule above was always right; one
> of the two views did not implement it.

```
actuals_cutoff(gate, dataset) = gate − publication_lag_hours[dataset]
```

`publication_lag_hours` is a small configured table with conservative defaults:

| Dataset | Default lag | Reasoning |
|---|---|---|
| `balanco-energia-subsistema` | **40 h** | Bulk file, published 12h/19h daily. Whether the 12h publication contains any hour of D−1 is **unmeasured**. 40 h from `gate_late` lands the cutoff at the end of D−2, assuming nothing. |
| `intercambio-nacional` | 40 h | Same publication regime. |
| constrained-off (1–4) | 40 h | Same publication regime; this is the label's own series, read as a lagged feature. |
| carga API (`cargaverificada`) | 6 h | Continuous REST API carrying a row-level `din_atualizacao`. |
| `capacidade-geracao` | 24 h | Daily snapshot. |

These defaults can only ever be **loosened** by measurement, and loosening them
changes the feature distribution — so it is a retrain trigger, not a config
tweak. A scheduled conformance job measures the real lag and fails if it exceeds
the configured value.

> **Implemented in ticket 05.** The table is `feature_publication_lag`
> (`apps/api/src/database/schema.ts`), seeded with the defaults above by
> `drizzle/0021_lagged_actuals_behind_the_cutoff.sql`, and read by
> `actuals_cutoff(target_date, gate_profile, dataset)`. Two consequences of that
> shape are deliberate. **Nothing writes the table at runtime and no repository
> exists through which it could**, so loosening a lag is a migration — a diff, a
> review and a retrain — rather than an `UPDATE` somebody ran once. And the
> function takes a *target date and a profile* rather than the `gate` the formula
> above names, because a `gate timestamptz` parameter would be the one door into
> the feature layer through which a hand-chosen instant could arrive; the gate is
> derived inside it by `gate_at`, exactly as `feature_apply_gate` derives it. An
> unconfigured dataset raises `22023` rather than defaulting to a zero-hour lag,
> which would be an unfiltered observation read that looks exactly like a correct
> answer.

The consequence is the sharpest single fact in this document: **at `gate_late`,
no hour of day D−1 is assumed available.** The nearest usable same-hour actual is
`t − 48 h`, and even that is conditional.

### The classification, and the two extra classes the ticket's frame needed

The ticket asks for four classes. Building the table produced six. The two
additions are load-bearing and are called out rather than smuggled in:

| Class | Meaning |
|---|---|
| **D** | From the DESSEM balance. Available only in `dessem_augmented_v1`, only at `gate_late`. |
| **W** | From the pinned weather run. The whole day-D profile is known, so ramps and centred windows are legitimate. |
| **P** | From ONS **day-ahead programming** (`carga-energia-programada`). *Not anticipated by the ticket's four classes, and it is what rescues the DESSEM-free set* — it is a genuine D−1 load forecast covering 2021-03-05→now, i.e. the entire window. |
| **K** | Last-known value / lagged actual, subject to `actuals_cutoff`. Legitimate for **levels only**. |
| **T** | Deterministic: calendar, solar astronomy, and registry capacity read at the gate's vintage. *Also not one of the ticket's four* — these are not "forecast" and not "last known"; they are simply computable. |
| **✗** | Unavailable and dropped, with a named replacement. |

**The rule that decides `K` versus `✗`.** Last-known-value substitution is honest
for a **state** and dishonest for a **local difference**. `load_mwh[t−168]` is a
real observation of a real hour. `solar_ramp_1h[t] ← last observed ramp` is not a
ramp at all: it is one number broadcast across 24 hours, and a tree model will
happily treat it as intraday shape. Every ramp, every centred rolling window and
every same-hour-yesterday lag on actuals therefore lands in `✗`, and the
replacement is the *forecast-side* equivalent, where the full day-D profile
genuinely exists.

### The feature table

Row grain is **(`subsystem`, `valid_time`)** — hourly, UTC, start-labelled.

The label atom is (`Subsystem`, `Technology`, `valid_time`) per the domain model,
but the *feature row* carries both technologies' labels as columns rather than
duplicating sixty-odd shared context columns per technology. Set A is
4 × 24 × ~880 days ≈ 84,500 rows; set B ≈ 44,200.

Prefixes name the source, not the class: `calendar_`, `solar_`, `capacity_`,
`weather_`, `programmed_`, `proxy_`, `dessem_`, `observed_`, `y_`.

#### Targets

| Feature | Definition | D−1 | Source |
|---|---|---|---|
| `y_constrained_off_wind_mwh` | Σ `constrained_off_mwh` over reporting entities of the subsystem, technology `WIND`, hour | — label | ONS 1 |
| `y_constrained_off_solar_mwh` | as above, `SOLAR` | — label | ONS 3 |
| `y_constrained_off_total_mwh` | wind + solar | — label | ONS 1, 3 |
| `y_has_curtailment` | `y_constrained_off_total_mwh > threshold_mw × 1 h` | — label, **derived, never stored** | argument |
| `y_magnitude_mwh` | `y_constrained_off_total_mwh` where `y_has_curtailment` | — label | ONS 1, 3 |

Threshold default **5 MW at subsystem grain** (domain model §5); it is an
argument to the feature function, stamped on every artifact. At hourly grain MWh
and MW are numerically equal, which is why the comparison is written with the
explicit `× 1 h`.

#### Calendar and astronomy — class `T`

All computed in `America/Sao_Paulo` from the UTC `valid_time`.

| Feature | Definition | D−1 | Source |
|---|---|---|---|
| `calendar_local_hour` | local hour 0–23, categorical | **T** | derived |
| `calendar_hour_sin` / `_cos` | sin/cos(2π·hour/24) | **T** | derived |
| `calendar_doy_sin` / `_cos` | sin/cos(2π·day_of_year/365.25) | **T** | derived |
| `calendar_day_of_week` | 0–6, categorical | **T** | derived |
| `calendar_is_weekend` | Sat or Sun | **T** | derived |
| `calendar_is_holiday_national` | national statutory holiday, incl. moveable feasts | **T** | `calendar_day` table |
| `calendar_holiday_state_share` | share of the subsystem's states observing a state holiday | **T** | `calendar_day` × subsystem→state map |
| `calendar_is_day_before_holiday` | national holiday falls on D+1 | **T** | `calendar_day` |
| `calendar_is_bridge_day` | weekday wedged between a national holiday and a weekend | **T** | `calendar_day` |
| `solar_zenith_cos` | cos(solar zenith) at the solar-capacity-weighted centroid | **T** | astronomy in SQL |
| `solar_extraterrestrial_ghi` | top-of-atmosphere horizontal irradiance, W/m² | **T** | astronomy in SQL |

`month` and `week_of_year` are **dropped as redundant** with the day-of-year
encoding — they are a coarser quantisation of the same axis and add split points
without information.

> **Settled while implementing ticket 03.** Four details this table left open,
> each of which has exactly one defensible answer once written down:
>
> - **The day-of-year period is 365.25, not 365.** A 365-day period puts 29
>   February a day out of phase and never recovers it; 365.25 makes the new-year
>   step 1.25 days out of a common year and 0.25 out of a leap year, which
>   averages to one over the cycle. Asserted directly in
>   `database-calendar.test.ts` rather than left as an intention.
> - **The solar geometry is computed at the frozen set's solar centroid**, the
>   `represented_mw`-weighted mean of `centroid_set_v1`'s SOLAR points. It has to
>   be frozen: a point that moved with the fleet would restate `solar_zenith_cos`
>   for hours already trained on, and a class-`T` feature that changes when a
>   plant is commissioned is not deterministic in any useful sense. With no set
>   frozen, both solar columns are NULL rather than zero — `greatest(x, 0)`
>   ignores NULLs, and a confident 0 W/m² at noon is the one wrong answer that
>   looks like a right one.
> - **Irradiance is sampled at the hour's midpoint**, because
>   `weather_shortwave_radiation` is an hour *mean* and the clearness index
>   divides one by the other. An edge-sampled denominator peaks the ratio above 1
>   every morning.
> - **A bridge day is a Monday before a Tuesday national holiday or a Friday
>   after a Thursday one**, and a holiday is never a bridge to itself.

#### Installed capacity — class `T`, day grain broadcast across hours

| Feature | Definition | D−1 | Source |
|---|---|---|---|
| `capacity_wind_mw` | `InstalledCapacityAsOf(subsystem, wind, D)` | **T** | ONS 12 |
| `capacity_solar_mw` | `InstalledCapacityAsOf(subsystem, solar, D)` | **T** | ONS 12 |
| `capacity_wind_added_28d_mw` | `capacity_wind_mw(D) − capacity_wind_mw(D−28)` | **T** | ONS 12 |
| `capacity_solar_added_28d_mw` | as above, solar | **T** | ONS 12 |

#### Weather — class `W`, capacity-weighted over frozen centroids

Twelve pinned variables (list and reasoning below). Wind variables are weighted
by the **wind** capacity vector, solar variables by the **solar** vector, shared
variables by combined VRE capacity.

| Feature | Definition | D−1 | Source |
|---|---|---|---|
| `weather_wind_speed_120m` | Σᵢ wᵢ(t)·xᵢ(t), wind weights | **W** | Single Runs |
| `weather_wind_speed_100m` | as above | **W** | Single Runs |
| `weather_wind_direction_120m_sin` / `_cos` | circular encoding of the weighted vector mean | **W** | Single Runs |
| `weather_wind_gusts_10m` | wind-weighted | **W** | Single Runs |
| `weather_temperature_2m` | VRE-weighted | **W** | Single Runs |
| `weather_surface_pressure` | VRE-weighted | **W** | Single Runs |
| `weather_relative_humidity_2m` | VRE-weighted | **W** | Single Runs |
| `weather_precipitation` | VRE-weighted | **W** | Single Runs |
| `weather_shortwave_radiation` | solar-weighted GHI | **W** | Single Runs |
| `weather_direct_normal_irradiance` | solar-weighted DNI | **W** | Single Runs |
| `weather_diffuse_radiation` | solar-weighted DHI | **W** | Single Runs |
| `weather_cloud_cover` | solar-weighted | **W** | Single Runs |
| `weather_clearness_index` | `weather_shortwave_radiation / max(solar_extraterrestrial_ghi, ε)` | **W**+**T** | derived |
| `weather_wind_power_curve_cf` | generic IEC power curve at 120 m applied per centroid, then capacity-weighted | **W** | derived |
| `weather_expected_wind_mwh` | `weather_wind_power_curve_cf × capacity_wind_mw × 1 h` | **W**+**T** | derived |
| `weather_expected_solar_mwh` | `capacity_solar_mw × weather_shortwave_radiation / 1000 × 1 h` | **W**+**T** | derived |
| `weather_wind_speed_120m_ramp_1h` | `x[t] − x[t−1]` **within the forecast profile** | **W** | derived |
| `weather_shortwave_radiation_ramp_1h` | as above | **W** | derived |
| `weather_expected_vre_ramp_1h` | Δ(`expected_wind` + `expected_solar`) | **W** | derived |
| `weather_wind_speed_120m_mean_3h` | centred on t, forecast profile | **W** | derived |
| `weather_wind_speed_120m_std_6h` | centred on t, forecast profile | **W** | derived |
| `weather_shortwave_radiation_mean_3h` | centred on t | **W** | derived |
| `weather_run_age_hours` | `run_init(used) − run_init(scheduled)`; 0 normally, 12 or 24 on fallback | **W** | ingest metadata |
| `weather_centroid_coverage` | share of the subsystem's **capacity weight mass** that a centroid reported for | **W** | ingest metadata |

**`weather_centroid_coverage` is weighted, not counted.** An earlier draft of
this spec said "fraction of centroids returning non-null". A count is the wrong
denominator once the points carry capacity weights: losing W12 (426 MW) and
losing W7 (4,172 MW) are the same fraction of centroids and are not remotely the
same event. The weighted reading still gives 1 when everything arrived, so the
`stale_inputs` rule in the diagnosis spec is unaffected.

**`observed_constrained_off_same_hour_exceedance_7d` was missing and is added.**
`forecaster.md`'s baseline ladder gives rung 1 two columns, one per head of the
hurdle: the magnitude side reads
`observed_constrained_off_same_hour_mean_7d`, which existed, and the
**occurrence** side needs the exceedance frequency at the same local hour, which
did not. That spec also says rung 1 is "computed *from the feature function* …
so it and the model cannot disagree about the last seven days" — a promise that
could not be kept for the occurrence head with no column to read. Note it is not
`observed_constrained_off_hours_above_threshold_7d`, which counts *all* hours
across seven days rather than the seven observations of one local hour.

**Ramps and centred windows are legal here and nowhere else on the actuals side.**
A D−1 run publishes all 24 hours of day D at once, so `x[t] − x[t−1]` inside that
profile is computed from data that exists at the gate. This is the single largest
recovery of IDEA.md's proposed features.

**`weather_lead_hours` is deliberately absent.** Within a fixed run cycle it is
perfectly collinear with `calendar_local_hour`: target hours 00–23 BRT on D are
03Z–02Z(+1), and from a D−1 12Z run the lead is exactly `15 + local_hour`. It
carries no information the vector does not already hold. What *is* informative is
the fallback case, and `weather_run_age_hours` captures precisely that — zero in
roughly 95% of rows, 12 or 24 when a run was missing.

**The wind power curve** is the one used in the lead-time research: cut-in 3 m/s,
rated 12 m/s, cut-out 25 m/s, hub 120 m, no air-density correction. It is
deterministic and identical on both sides of the gate, so it introduces no skew.
It is a *generic IEC-class* curve, not the Brazilian fleet's, and the resulting
capacity factor is a **proxy**, named as one.

**The solar conversion carries no temperature derate.** `capacity × GHI/1000` is
STC-referenced and nothing more. Adding a −0.4%/K cell-temperature derate would
bake my coefficient into a feature; `weather_temperature_2m` is in the vector, so
a gradient-boosted model can learn the interaction from data instead.

#### ONS day-ahead programming — class `P`, `dessem_free_v1`'s spine

`carga-energia-programada` is a REST-only dataset covering **2021-03-05 → now**,
at 30-min × área de carga, end-labelled, addressed with `SECO` rather than `SE`.
Downsampled to hourly and re-labelled to interval start by the adapter. It is a
`Forecast` and carries a `ForecastOrigin` of `ons_programacao`.

| Feature | Definition | D−1 | Source |
|---|---|---|---|
| `programmed_load_mwh` | ONS programmed load for the subsystem-hour | **P** | ONS 7 |
| `programmed_load_ramp_1h` | Δ within the programmed profile | **P** | ONS 7 |
| `programmed_load_mean_3h` | centred on t | **P** | ONS 7 |
| `programmed_load_daily_min_mwh` | min over the 24 hours of D | **P** | ONS 7 |
| `programmed_load_rank_in_day` | rank of t among D's 24 programmed loads | **P** | ONS 7 |
| `proxy_residual_load_mwh` | `programmed_load − weather_expected_wind − weather_expected_solar` | **P**+**W**+**T** | derived |
| `proxy_residual_load_ratio` | `proxy_residual_load / programmed_load` | **P**+**W**+**T** | derived |
| `proxy_renewable_load_ratio` | `(expected_wind + expected_solar) / programmed_load` | **P**+**W**+**T** | derived |
| `proxy_vre_surplus_mwh` | `expected_wind + expected_solar − programmed_load` | **P**+**W**+**T** | derived |
| `proxy_residual_load_ramp_1h` | Δ within the day-D proxy profile | **P**+**W**+**T** | derived |
| `proxy_residual_load_min_of_day` | min over D | **P**+**W**+**T** | derived |
| `proxy_residual_load_rank_in_day` | rank of t | **P**+**W**+**T** | derived |

`proxy_residual_load_mwh` is IDEA.md §5 rebuilt from day-ahead-available inputs.
It is the most important feature in the DESSEM-free set, and its existence is the
reason set A is worth training at all.

**Publication-time caveat.** The row-level publication time of
`cargaprogramada` is not established by the research. The adapter must capture
the API's own update stamp; if a row's `published_at` falls after the gate, the
as-of join drops it and the feature is NULL. The failure mode is therefore a
visible hole, not a leak — but the ingestion conformance suite must measure the
real lag before either set is trusted.

> **Settled while implementing ticket 06.** There is no update stamp to capture:
> `/cargaprogramada` returns none, and the adapter's fallback — the response's
> fetch instant — is not merely coarse. It makes `published_at > valid_time` on
> every backfilled row, which is the shape §4 of the domain model reserves for an
> **`Observation`**, and it puts the whole series behind every historical gate.
> So the instant is **decided**, at the adapter, in
> `PROGRAMME_PUBLICATION_HOUR_BRT` / `programmePublishedAt`
> (`apps/api/src/ingest/ons/load.ts`), and four things travel with it:
>
> - **The programme for day D is stamped D−1 15:00 BRT**, derived from the row's
>   own reference day rather than from the request. The instant is the tightest
>   *evidenced* upper bound rounded conservatively: ONS's DESSEM file for D was
>   measured created at D−1 17:48Z, and DESSEM's `val_demanda` agrees with this
>   series to 0.03%, so a run consumed the programme before then. Assuming an
>   earlier hour would claim availability nothing has measured — and a model
>   trained on a value it will not have at serve time is the exact leak this
>   spec exists to prevent, not a convenience.
> - **The consequence at `gate_early` is a column of NULLs, and it is real.**
>   D−1 09:00 BRT is four hours before the assumed publication, so every
>   `programmed_*` (and, downstream, every `proxy_*`) column is NULL at the early
>   gate. `dessem_free_v1` has its spine at `gate_late` across the full
>   2021-03-05 → now coverage and does **not** have one at `gate_early`. That is
>   a visible hole rather than a leak, which is the machinery working; closing it
>   needs the measurement issue 12 owns, and until then the A/B's early-gate arm
>   is weaker than this document assumed.
> - **`published_at` cannot distinguish a revision from the original**, because
>   it is derived from the reference day and a restatement shares it. The as-of
>   axis carries that instead — a revision ingested after the gate is excluded by
>   `ingested_at <= gate` — which works live and, over the backfill window where
>   every row shares one `ingested_at`, does not. A backfilled programme is
>   therefore `revision_optimistic`, and `programmed-load` now joins the
>   weakest-link fidelity stamp so the row says so.
> - **The forecast shape is enforced, not asserted.** `programmed_load_half_hour`
>   carries a `published_at < valid_time` check, so the stamp that started this
>   is now unrepresentable.
>
> Two shape features have edges worth stating. A **D−1 programme publishes the
> whole of day D at once**, which is what makes a ramp and a centred window legal
> here — but only *inside* that day: the first hour has no ramp (its predecessor
> belongs to a different publication) and the first and last have no centred mean
> (D+1's programme is published after both gates). Both are NULL rather than
> computed over a partial window, and both check that the adjacent row is the
> adjacent hour so a gap in the profile cannot turn `_ramp_1h` into a two-hour
> difference. `programmed_load_daily_min_mwh` and `programmed_load_rank_in_day`
> are NULL unless the profile has all 24 hours, and the rank is **ascending** —
> 1 is the day's trough — so it points the same way as the minimum beside it.

#### DESSEM — class `D`, `dessem_augmented_v1` only

From `balanco_dessem_detalhe`, 30-min × subsystem, end-labelled via
`num_patamar`, resampled to hourly, `published_at` = file creation (D−1 evening).
Coverage begins **2025-05-23**.

| Feature | Definition | D−1 | Source |
|---|---|---|---|
| `dessem_demand_mwh` | `val_demanda` | **D** | ONS 11 |
| `dessem_wind_mwh` | `val_ger_eolica` | **D** | ONS 11 |
| `dessem_solar_mwh` | `val_ger_fotovoltaica` | **D** | ONS 11 |
| `dessem_mmgd_mwh` | `val_ger_mmgd` | **D** | ONS 11 |
| `dessem_hydro_mwh` | `val_ger_hidraulica` + `val_ger_pch` | **D** | ONS 11 |
| `dessem_thermal_mwh` | `val_ger_termica` + `val_ger_pct` | **D** | ONS 11 |
| `dessem_pumping_mwh` | `val_cons_elevatoria` | **D** | ONS 11 |
| `dessem_residual_load_mwh` | `demand − wind − solar − mmgd` | **D** | derived |
| `dessem_renewable_load_ratio` | `(wind + solar + mmgd) / demand` | **D** | derived |
| `dessem_vre_surplus_mwh` | `wind + solar + mmgd − demand` | **D** | derived |
| `dessem_inflexible_share` | `(hydro + thermal) / demand` | **D** | derived |
| `dessem_implied_net_export_mwh` | `(hydro + thermal + wind + solar + mmgd) − demand − pumping` | **D** | derived |
| `dessem_export_utilisation` | `implied_net_export / export_capability_estimate` | **D**+**K** | derived |
| `dessem_demand_ramp_1h` | Δ within D's profile | **D** | derived |
| `dessem_residual_load_ramp_1h` | Δ within D's profile | **D** | derived |
| `dessem_vre_ramp_1h` | Δ(wind + solar + mmgd) | **D** | derived |
| `dessem_residual_load_min_of_day` / `_rank_in_day` | over D | **D** | derived |
| `dessem_wind_capacity_factor` | `dessem_wind_mwh / (capacity_wind_mw × 1 h)` | **D**+**T** | derived |
| `dessem_solar_capacity_factor` | `dessem_solar_mwh / (capacity_solar_mw × 1 h)` | **D**+**T** | derived |
| `dessem_sin_residual_load_mwh` | Σ over the four subsystems | **D** | derived |
| `dessem_absorber_residual_load_mwh` | SE's `dessem_residual_load_mwh` on N/NE rows; NULL on SE | **D** | derived |

**DESSEM publishes no exchange column, and this is worked around by identity, not
by omission.** For a subsystem, generation minus demand minus pumping is net
export, up to losses. `dessem_implied_net_export_mwh` is named "implied" because
losses are not modelled; it is a strong day-ahead signal for exactly the
mechanism ONS's own prospective-curtailment tool cites — NE/N export limits.

`dessem_absorber_residual_load_mwh` encodes the physical asymmetry that N and NE
curtail when SE has no headroom to absorb them.

#### Lagged actuals — class `K`, all resolved at `actuals_cutoff(gate)`

Every feature here is a **level**, and every lag offset is checked against the
cutoff — an offset that does not clear it yields NULL rather than sliding.

| Feature | Definition | D−1 | Source |
|---|---|---|---|
| `observed_actual_lag_hours` | `valid_time − actuals_cutoff(gate)` — how stale the actuals are | **K** | derived |
| `observed_constrained_off_lag_168h` | total, same local hour, D−7 | **K** | ONS 1, 3 |
| `observed_constrained_off_wind_lag_168h` / `_solar_lag_168h` | per technology | **K** | ONS 1, 3 |
| `observed_constrained_off_lag_48h` | same local hour, D−2; NULL if cutoff excludes it | **K** | ONS 1, 3 |
| `observed_constrained_off_same_hour_mean_7d` | mean at the same local hour over the 7 available days ending at the cutoff day | **K** | ONS 1, 3 |
| `observed_constrained_off_hours_above_threshold_7d` | count over the trailing 7 available days | **K** | ONS 1, 3 |
| `observed_constrained_off_same_hour_exceedance_7d` | share of the 7 same-local-hour observations at or above `threshold_mw`, in 1/7 steps | **K** | ONS 1, 3 |
| `observed_constrained_off_total_7d_mwh` | sum over the trailing 7 available days | **K** | ONS 1, 3 |
| `observed_load_lag_168h` | `load_mwh`, D−7 same hour | **K** | ONS 5 |
| `observed_wind_generation_lag_168h` / `observed_solar_generation_lag_168h` | D−7 same hour | **K** | ONS 5 |
| `observed_wind_capacity_factor_mean_7d` | realised fleet CF over the trailing 7 available days | **K**+**T** | ONS 5, 12 |
| `observed_solar_capacity_factor_mean_7d` | as above | **K**+**T** | ONS 5, 12 |
| `observed_net_exchange_lag_168h` | subsystem net exchange, D−7 same hour | **K** | ONS 5 |
| `observed_net_exchange_mean_24h_to_cutoff` | mean over the last 24 available hours | **K** | ONS 5 |
| `observed_corridor_flow_ne_se_lag_168h` | directed NE→SE flow, D−7 same hour | **K** | ONS 9 |
| `observed_corridor_flow_n_ne_lag_168h` | directed N→NE flow, D−7 same hour | **K** | ONS 9 |
| `observed_export_utilisation_mean_24h_to_cutoff` | mean of `flow / capability` over the last 24 available hours | **K** | ONS 9 |
| `observed_corridor_utilisation_ne_se_max_7d` | max over the trailing 7 available days | **K** | ONS 9 |
| `observed_reason_share_ene_7d` | share of restricted entity-hours in the subsystem with reason `ENE`, trailing 7 available days | **K** | ONS 1, 3 |
| `observed_reason_share_cnf_7d` / `_rel_7d` | as above | **K** | ONS 1, 3 |

**The reason-share features are legal and it is worth saying why.** A reason is a
property of a `ReportingEntity`, and aggregating observed reasons *upward* across
the entities of a subsystem is an aggregation of observations. It is the
downward direction — attributing a conjunto's reason to a member plant — that the
domain model forbids as an allocation presented as an observation. These features
never travel downward. `PAR` is excluded from the share set because it has been
observed zero times; its first appearance is a monitoring signal, not a class.

#### Dropped — class `✗`, with the replacement named

| IDEA.md feature | Why it cannot be served at D−1 | Replacement |
|---|---|---|
| `load_mw`, `solar_mw`, `wind_mw`, `hydro_mw`, `thermal_mw` at t | day-D actuals | `programmed_load_mwh` (P), `weather_expected_*` (W), `dessem_*` (D) |
| `residual_load` at t (§5) | actuals | `proxy_residual_load_mwh` (A), `dessem_residual_load_mwh` (B) |
| `renewable_load_ratio` at t (§4) | actuals | `proxy_renewable_load_ratio` / `dessem_renewable_load_ratio` |
| `solar_ramp_1h`, `wind_ramp_1h`, `load_ramp_1h` on actuals (§6) | a **local difference**; LKV would broadcast one number over 24 hours | forecast-side ramps (W, P, D) |
| `solar_t-1 … t-3`, `wind_t-1 … t-6`, `load_t-1`, `load_t-24` (§7) | do not clear `actuals_cutoff` | `*_lag_168h`, `*_lag_48h`, and the day-grain 7-day aggregates |
| `solar_mean_3h`, `wind_mean_3h`, `load_mean_3h`, `renewable_max_6h`, `load_std_6h`, `wind_std_6h` centred on t (§8) | windows straddle the cutoff | forecast-side centred windows; actuals-side windows ending at the cutoff |
| `exchange_NE_SE`, `exchange_N_NE` at t (§9) | actuals | `dessem_implied_net_export_mwh` (B); `observed_corridor_*` lags (A) |
| `val_intercambioprogmwmed` (programmed exchange) | present only from 2026-01 and **not backfilled** — would create the mirror-image skew: a feature richer at serve time than in training | excluded from both sets; recorded as a candidate third set |
| `solar_capacity_factor` at t (§12) | actuals | `weather_wind_power_curve_cf`, `weather_clearness_index`, `dessem_*_capacity_factor` |
| `val_ventoverificado`, `val_irradianciaverificado` (`_detail`) | plant-grain **measurements**, and actuals | the weather run at centroids |
| `month`, `week_of_year` (§10) | available, but redundant | `calendar_doy_sin/cos` |

Of the twelve feature families IDEA.md proposes, **five are unavailable exactly
as written, and all five are recoverable in a different form.** That, in one
line, is what this ticket was for.

### The weather variable list — settled

Twelve variables, pinned to `models=ecmwf_ifs` on the Single Runs API:

```
wind_speed_100m, wind_speed_120m, wind_direction_120m, wind_gusts_10m,
temperature_2m, surface_pressure, relative_humidity_2m, precipitation,
shortwave_radiation, direct_normal_irradiance, diffuse_radiation, cloud_cover
```

Twelve is chosen against the call-weighting rule (requests over ten variables are
billed as multiple calls) and matches the 20-location × 12-variable request the
lead-time research measured at 84 KB / 10.5 s.

**Excluded, each for a stated reason:**

- `boundary_layer_height`, `temperature_120m` — **null under `ecmwf_ifs`**. Not
  requested at all, so no run can write a NULL column.
- `wind_speed_180m`, `cape` — available on Single Runs (and *not* on the
  Historical Forecast archive, so this is a genuine Single-Runs bonus) but
  excluded to hold twelve. `cape` is the first candidate to add if convective
  wind ramps prove to matter.
- `wind_speed_10m`, `wind_speed_80m` — collinear with 100/120 m. `wind_speed_10m`
  is retained in the **validation** feed only, because it is the only
  hub-adjacent height ERA5 carries and therefore the only cross-check axis.
- `cloud_cover_low/mid/high` — three variables for marginal gain over total cloud
  plus three radiation variables that already encode the optical effect.
- `direct_radiation` — recoverable from DNI and the zenith angle already in the
  vector.
- `global_tilted_irradiance` — requires a tilt and tracking assumption for a
  fleet whose tilt/tracking mix is unknown. Requesting it would fabricate a
  parameter.
- `wind_direction_100m` — one direction suffices; it enters as sin/cos.

### The centroid set — settled

- **Points are frozen per feature-set version; weights vary with time.** A moving
  query point changes the Open-Meteo grid cell underneath the series, which is a
  silent covariate shift; a moving weight is exactly what the plant-registry
  research measured as mandatory (fixed 2026-08 weights misallocate 50.4% of the
  SE-solar weight mass at window start and move that centroid 94 km — seven grid
  cells).
- **v1 uses the twenty points in `weather-sources.md`, regenerated from SIGA
  rather than transcribed.** W11 (RS/SC north-coast) and W12 (MA coastal) were
  never computed from SIGA municipality centroids and must be recomputed before
  first use; generating the whole set by script makes that automatic and makes
  the set reproducible.
- **Grid-cell collision is a build error.** Open-Meteo echoes the snapped
  latitude and longitude. Two centroids resolving to the same cell would be
  averaged in twice under different weights; the generator asserts uniqueness and
  merges colliding points (summing their weights) before freezing.
- **Weights** are `CapacityWeight(centroid, technology, t)` — each operating
  plant assigned to its nearest centroid, weight = its `InstalledCapacityAsOf`
  share, recomputed per target date.
- **Drift trigger.** The generator records the capacity-weighted mean
  plant-to-centroid distance at freeze time. A scheduled job recomputes it; a
  25% increase means the fleet has grown away from the frozen points and
  triggers regeneration — which is a new `centroid_set_v2`, a new feature-set
  version and a retrain, never an in-place edit.

### The interchange utilisation proxy — no published limit exists

**Answer to the ticket's question: no.** The ONS Dados Abertos catalogue was
enumerated in full (84 packages) and contains **no transfer-limit dataset** at
any grain. `intercambio-nacional` publishes realised flow and, from 2026 only,
programmed flow. There is no denominator to divide by. Whether limits exist
behind ONS Sintegre (authenticated) was not investigated and is recorded as an
open question; even if they do, they would be study-horizon values rather than
hourly operational limits.

So the proxy is estimated, and the estimator is itself point-in-time:

```
export_capability_estimate(corridor, gate)
  = P99.5 of directed flow over the 365 days ending at actuals_cutoff(gate)
```

- **P99.5, not the maximum.** A maximum is a single outlier and would define a
  year of denominators from one hour. At hourly grain P99.5 is ≈ 44 hours per
  year — plausibly the binding regime, and robust.
- **Trailing and gate-bounded**, so the denominator cannot see the future. This
  matters more than it looks: a naive whole-history maximum leaks a 2026 record
  flow into a 2024 feature.
- **Minimum sample.** Fewer than 300 non-null hours in the trailing year yields
  NULL rather than a denominator computed from noise.
- **The proxy works *because* of the tautology, not despite it.** When a corridor
  binds, observed flow *is* the limit — which is precisely why historical maxima
  approximate it, and equally why it is only meaningful for corridors that
  actually bind (NE→SE, N→NE). For corridors that never bind, the ratio is a
  scaled flow and the model should be allowed to discover it is uninformative.
- **Named limitation.** The estimate is a *capability* proxy. It cannot see a
  temporary derate from a line outage — which is exactly the condition `REL`
  (external grid unavailability) names. The estimate is published per corridor
  with its sample size so a screen can show it as an estimate.

### SQL or Python — SQL, and why the single definition is the point

**Features are computed in SQL**, as a versioned set-returning function in the
API's Drizzle migration tree. The Python service calls it and performs **no
windowed or joined computation of its own**.

```sql
feature_rows(
  target_from   date,
  target_to     date,
  gate_profile  text,        -- 'gate_early' | 'gate_late'
  feature_set   text,        -- 'dessem_free_v1' | 'dessem_augmented_v1'
  threshold_mw  double precision
) returns setof feature_row
```

Training passes a range; serving passes `target_from = target_to = tomorrow`. The
gate is derived per row from `target_date`, so the two calls execute the same
expression.

The ticket is right that a single definition matters more than which side. The
reasons SQL wins are nonetheless specific:

1. **The correctness-critical part is already SQL.** `AsOf(t)` is a `DISTINCT ON`
   with an ordering, specified and tested in the data-platform spec. Rebuilding
   the as-of in pandas would fork the one query whose correctness was expensively
   established.
2. **The leak lives in the window frame.** `ROWS BETWEEN 168 PRECEDING AND 1
   PRECEDING` versus `... AND CURRENT ROW` is a one-token difference that decides
   whether a feature is honest. Having exactly one place where that token exists
   is worth more than ergonomics.
3. **The ownership boundary is already settled.** The API owns the schema and all
   migrations; Python reads only. Defining features in Python would either breach
   that boundary or create a second definition.
4. **The counter-argument, and why it loses.** pandas is more pleasant for this
   work, and the modeller lives in Python. But the alternative on offer is not
   "SQL or pandas" — it is "one definition or two", because a Python
   implementation that reads canonical views would still need its own lag and
   window logic. Ergonomics is a real cost and it is paid once; skew is a cost
   paid silently forever.

**What Python may still do:** anything row-local and model-internal — scaling,
categorical encoding, the imputation policy inside the estimator pipeline, sample
weighting, the train/test split. The line is precise: **no window, no join, no
time offset.** If a computation needs another row, it belongs in the function.

### The holiday calendar — data, not a library call

Source: the **`holidays`** Python package (MIT), `Brazil`, with all 27 UF
subdivisions and `categories=(PUBLIC, OPTIONAL)` so that Carnival and Corpus
Christi — which move the Brazilian load curve as much as any statutory holiday —
are included.

**It is materialised into a `calendar_day` table, not called at feature time.**
The generator runs once per version, writes `(date, uf, name, category)` rows plus
the pinned library version, and the feature function reads only the table. This
is deliberate: a library upgrade that changes one moveable feast would otherwise
silently restate three years of training features with no migration, no diff and
no test failure. Regeneration is an explicit job whose output diff must be
reviewed, and a non-empty diff over past dates is a retrain trigger.

**National and regional are separated.** `calendar_is_holiday_national` is a
binary. Regional holidays enter as `calendar_holiday_state_share` — the share of
the subsystem's constituent states observing a state holiday, using ONS's
electrical state assignment. That share is **unweighted by load, and that is a
known crudeness**: load is not published per state (the map rules state grain out
of scope), so no honest per-state load weight exists in WattSteer's sources.
Inventing one from population or GDP would add a source to fabricate a weight for
a feature likely to be marginal. The feature ships as a count share, labelled as
a proxy, and is an early candidate for the forecaster's feature-selection pass.

Municipal holidays are out of scope; `holidays` does not carry them and they do
not move a subsystem.

> **Settled while implementing ticket 03.** The materialisation is
> `feature_calendar_generation` (one immutable row per version, carrying the pin
> `holidays==0.103` and a digest of its days) and `feature_calendar_day`
> (`(day, uf, name, category)`). Three decisions inside that:
>
> - **`uf = 'BR'` is national and national days are stored once.** A calendar
>   that repeated Tiradentes under all 27 UFs would make
>   `calendar_holiday_state_share` read 1.0 on every national holiday — a second
>   copy of the binary in the column beside it, dressed as a regional signal. The
>   subtraction of national days from a state's list is by **name and across
>   categories**: `holidays` joins same-day names into one string
>   (`'Fundação de Brasília; Tiradentes'`), and Rio observes Carnival as
>   *public* where the country observes it as *optional*.
> - **The retrain trigger is enforced, not documented.** The loader refuses to
>   write a different calendar under an existing version and says why; a changed
>   calendar has to be `br_calendar_v2`, which is a new feature-set version. The
>   Python side asserts the artifact is byte-for-byte what the pinned library
>   produces, so bumping `holidays` without regenerating fails the build rather
>   than silently restating three years of features.
> - **Outside the loaded horizon every holiday-derived column is NULL**, never
>   `false`. The horizon is checked against D−1 and D+1 because the bridge and
>   day-before features read the neighbours, so the calendar's edge is visible in
>   the row rather than being a quiet "not a holiday".

### Installed capacity, joined across a changing fleet

`InstalledCapacityAsOf(scope, technology, t)` sums `rated_power_mw` over
generating units where `commissioned_on ≤ t < coalesce(decommissioned_on, ∞)`. It
is a function, never a column.

**It is a double as-of, and this is the part that is easy to get wrong.** The
valid-time argument is the *target date D*; the vintage is the *gate*. Both are
needed:

- Without the valid-time as-of, today's fleet leaks into 2024 features —
  measured at 25.8% of curtailed-fleet MW not existing when the window opens.
- Without the vintage as-of, a unit whose commissioning ONS records *after* the
  gate enters a feature that could not have known about it.

The vintage as-of makes capacity features slightly conservative: a unit entering
service on day D is not counted at D−1. That is correct behaviour, not an error
to patch.

**Over the backfill window, capacity is `revision_optimistic`.** Registry
snapshots only begin at ingestion go-live, so a pre-go-live row reflects today's
record of the past. This is the same fidelity label the backtest already carries;
it is not a new caveat, but it does mean the capacity features cannot be claimed
as point-in-time for historical dates.

**Decommissioning is asserted, not modelled.** ONS records zero VRE
deactivations on or after 2024-04-01 across 3,380 units. An alert fires if
`dat_desativacao` becomes non-null for any VRE unit; nothing is estimated for an
error that is currently exactly zero.

Capacity features are **day grain**, broadcast identically across the 24 hours of
D. The feature dictionary marks them so, because a column that is constant within
a day must not be read as an hourly signal.

### The two feature sets

| | `dessem_free_v1` | `dessem_augmented_v1` |
|---|---|---|
| Window | **2024-04-01 → now** (~880 days) | **2025-05-23 → now** (~460 days) |
| Rows | ≈ 84,500 | ≈ 44,200 |
| Gates | `gate_early` and `gate_late` | **`gate_late` only** |
| Day-ahead load | `programmed_load_mwh` (ONS programming) | DESSEM demand, with ONS programming retained |
| Day-ahead VRE | weather-derived expected generation | DESSEM wind/solar/MMGD **plus** the weather-derived proxies |
| Residual load | `proxy_residual_load_mwh` | `dessem_residual_load_mwh` |
| Exchange day-ahead | ✗ — lagged actuals only | `dessem_implied_net_export_mwh` |
| Window start driver | solar constrained-off begins 2024-04 | DESSEM begins 2025-05-23 |

**Features present only in the augmented set** are exactly the `dessem_*` block
above — **22 feature names across 21 table rows**, since the
`dessem_residual_load_min_of_day` / `_rank_in_day` row carries two. (An earlier
draft said "21 columns", counting rows.) Four are the ones that would justify
the trade:
`dessem_residual_load_mwh`, `dessem_implied_net_export_mwh`,
`dessem_export_utilisation` and `dessem_absorber_residual_load_mwh`. Everything
else DESSEM contributes has a weather- or programming-derived analogue in set A.

**The A/B needs three trainings, not two**, or the comparison confounds feature
content with window length:

| Run | Set | Window | Isolates |
|---|---|---|---|
| A-full | `dessem_free_v1` | 2024-04 → now | the product's actual set-A model |
| A-common | `dessem_free_v1` | 2025-05-23 → now | — |
| B-common | `dessem_augmented_v1` | 2025-05-23 → now | **DESSEM's contribution**, against A-common |

`A-full` vs `A-common` measures what the longer history is worth; `B-common` vs
`A-common` measures what DESSEM is worth. All three are evaluated on the same
held-out period at `gate_late` with the same threshold. **DESSEM ships only if
`B-common` beats `A-common` by more than the eleven hours of lost notice are
worth** — and that trade is a product decision, not a metric.

### Labels: features at the gate, labels at the latest vintage

Features are read `AsOf(gate)`. Labels are read `AsOf(now)`.

This asymmetry is intentional and is the one place the point-in-time discipline
is deliberately broken. A model should learn to predict what actually happened,
not ONS's first draft of what happened; using the settled restatement of the
label is measurement-error reduction, not leakage, because the label for hour *t*
is a statement about hour *t*. The same settled values are used at evaluation, so
training and scoring agree.

Two caveats travel with it, and both are recorded rather than smoothed:

- ONS's restatements are not guaranteed to be neutral. If a re-publication
  campaign changes the *definition* of `val_geracaolimitada` rather than
  correcting it, the model learns a methodology break as a change in the grid —
  the same hazard the daily-load series carries at its 2021-03 and 2023-04-29
  level shifts. The conformance suite watches for large-scale label restatements.
- For any window predating ingestion go-live the label is `revision_optimistic`
  and every metric computed over it says so.

`y_has_curtailment` is derived inside the function from `threshold_mw`. It is
never stored, so two consumers cannot hold disagreeing thresholds.

### Timezone, stated rather than inherited

`din_instante` is **Brasília local civil time**, and ONS documents this nowhere —
it is established empirically, to high confidence, by three independent methods.
The ingestion contract states the assumption explicitly:

- `din_instante` is parsed as `America/Sao_Paulo` using the full IANA zone, never
  a fixed −3 offset, and converted to a UTC instant at the adapter boundary.
- `din_referenciautc` is parsed as UTC.
- The 2024-04→now window contains no DST transitions, so no DST handling is
  built — but the **canary is**: the feature builder asserts that every target
  date yields exactly 24 distinct local hours. Should Brazil reinstate summer
  time, that assertion fails on the first affected date instead of silently
  duplicating or dropping an hour.
- Calendar features are computed from the local rendering; everything else is
  computed in UTC.

## Testing Decisions

**What makes a good test here.** These tests assert properties of the feature
values, not the presence of functions. Two of them are the acceptance gate for
this entire spec, and both are *generic* — they can catch a leak nobody
anticipated, which is the only kind that matters.

**Seam 1 — train/serve identity.** Build the feature row for a past date twice:
once through the training call (`target_from = target_to = D`, a range query) and
once through the serving call path as it will run in production. Assert the rows
are identical, column by column, including NULLs. This is the central claim of
the spec, and it is cheap because the claim is that they are literally the same
query.

**Seam 2 — gate ablation, the general leak detector.** For a sample of target
dates: compute the feature row; then delete (in a transaction, rolled back) every
row from every source table whose `published_at > gate` or whose
`valid_time > actuals_cutoff(gate)`; recompute; assert **no value changed**. Any
feature that moves depends on data that will not exist at serve time. This test
does not need to know which features are suspect — it tests the property
directly, and it will catch a lag added by a future session that nobody thought
to review.

**Seam 3 — feature definitions, fixture-driven.** A small hand-built series with
known answers, covering the cases where an off-by-one is invisible:
window frames (`168 PRECEDING AND 1 PRECEDING` vs `CURRENT ROW`); a lag offset
that does not clear the cutoff yielding NULL rather than sliding; cyclical
encodings at hour 23→0, day-of-year 365→1 and across a leap year; circular
averaging of wind direction across 350°→10°; the power curve at cut-in, rated and
cut-out; the clearness index at night with a zero denominator.

**Seam 4 — time and calendar.** The 24-local-hours canary per target date. A
fixture pinning known Brazilian holidays including moveable feasts (Carnival,
Good Friday, Corpus Christi) across several years. A test that regenerating
`calendar_day` at the pinned library version reproduces the stored table exactly
— the guard against a silent library upgrade.

**Seam 5 — weather contract.** The centroid generator asserts no two points snap
to the same Open-Meteo grid cell. The serve path asserts the completeness
contract (12 variables × 24 hours × all centroids non-null) and **refuses to
serve** on failure rather than imputing. The run-fallback path is exercised
against a recorded missing-run response and asserted to set
`weather_run_age_hours` rather than to fail open.

**Seam 6 — live conformance, gated and scheduled.** Following the data platform's
`test:live` precedent. Measures the real publication lag of each observation
dataset against the configured constant. Asserts `cargaprogramada` still returns
rows for `SECO` and still publishes before `gate_late`. Cross-checks DESSEM
`val_demanda` against `carga-energia-programada` for the same subsystem-day — the
research measured 0.03% agreement, so a divergence is evidence one of the two
changed meaning. Watches for the first appearance of reason code `PAR`, and for
`dat_desativacao` becoming non-null on any VRE unit.

**Seam 7 — the two experiments this spec inherits.** Both belong here because
both are feature-level questions, and both were left open by the research:

1. **Train twice.** Train the same model on the Historical Forecast archive and
   on the lead-matched Single Runs feature, evaluate both on the lead-matched
   feature. The lead-time research names this the definitive experiment and the
   acceptance test for the weather decision.
2. **Recompute the train/serve gap on the real aggregate.** The measured
   per-point `r = 0.88` is an upper bound on the harm; the feature is a
   capacity-weighted average over frozen centroids and aggregation will raise it.
   Recompute on the real centroids and publish the number. If `r > 0.95`, the
   size of the claim in the map's Notes should be revised downward.

**Acceptance gate.** Default `bun test` passes with no network. Seams 1–5 pass
against real Postgres under the existing env-var gating. Seam 6 passes on its
schedule. Both sets build over their full windows, and the row counts match the
arithmetic above.

## Out of Scope

- **Model choice, hyperparameters, calibration and the quantile method.** This
  spec produces a vector; **Forecaster spec** consumes it.
- **The >1 / >5 / >10 MW threshold sweep.** The function takes the threshold as
  an argument so the sweep is free; running it and choosing is the forecaster's.
- **Feature selection and importance.** Everything here is *available*; which
  features survive is an empirical question with no answer before a model exists.
- **SHAP, driver ranking and domain rules.** **Diagnosis spec**.
- **CMO price features.** `cmo-semi-horario` is the DESSEM shadow price with
  history to **2020**, and curtailment is the zero/negative-price regime, so it
  is the most promising family this spec does not use. It is excluded because the
  data platform recorded rather than ingested it — and because of one unresolved
  question worth stating: it is not established whether the published CMO series
  is the D−1 DESSEM run's own output or a settled restatement. **If it is the
  former, it is a DESSEM-like day-ahead signal reaching back to 2020**, which
  would change the shape of the A/B entirely. See *Further Notes*.
- **Programmed exchange (`val_intercambioprogmwmed`).** Serve-time-only from
  2026-01, not backfilled. Excluded from both sets; a candidate third set once it
  has history.
- **`programacao_diaria`** (per-plant programmed generation) and all plant-grain
  features. The forecast grain is the subsystem.
- **Per-plant reason attribution.** Ruled out upstream as an allocation presented
  as an observation; nothing here reverses the direction.
- **MMGD as a separate modelled quantity.** It enters only inside
  `dessem_mmgd_mwh` and inside the daily-load series' 2023-04-29 level shift.
- **State grain, intraday horizons, multi-horizon features.** Ruled out by the
  map.
- **Feature stores, online/offline sync, embeddings.** The function is the store.

## Further Notes

**The honest headline of this ticket is that IDEA.md's feature list does not
survive contact with D−1 — and that this is fine.** Five of its twelve families
are unavailable as written. All five are recoverable in a different form, and the
recovery is more interesting than the original: a residual load built from ONS's
own day-ahead programming and a pinned weather run is a *forecast* of the
oversupply condition, which is what a day-ahead product should be conditioning
on, where `load[t] − solar[t] − wind[t]` is a *description* of it after the fact.

**`carga-energia-programada` is the quiet find.** The ticket framed the A/B as
"DESSEM or nothing", and the DESSEM-free set looked like it would have to survive
on weather and lags alone. It does not: ONS has published a day-ahead load
programme since 2021-03-05, covering the whole window, and it agrees with DESSEM
demand to 0.03% where both exist. That single series is what makes
`proxy_residual_load_mwh` possible over 880 days instead of 460, and it makes
`dessem_free_v1` a real contender rather than a control arm. It is also the one
input in this spec whose publication timing is **not** established by the
research, so it carries the most risk of any decision here — the AsOf machinery
makes the failure a visible hole rather than a leak, but the lag must be measured
before either set is trusted.

**Two costs of DESSEM, not one.** The map recorded DESSEM's cost as a shorter
window. Writing the gate down surfaced a second: DESSEM is not published until
the evening of D−1, so the augmented model can only ever run at the late gate.
Whatever the metric says, the augmented model buys accuracy with eleven hours of
operator notice, and that trade should be stated wherever the A/B result is.

**The gate-ablation test is the load-bearing artifact, more than the table.** The
feature table will be edited — features will be added, dropped, redefined — and a
table is a snapshot of one session's care. The ablation test is a *property*: it
asserts that no feature, named or unnamed, present or future, depends on data
that will not exist at serve time. If exactly one thing from this spec survives
into the built system, it should be that test.

**Where this spec is weakest.** Three places, ranked:

1. The `publication_lag_hours` defaults are conservative *guesses*, not
   measurements. 40 hours may be throwing away a full day of usable actuals — if
   the 12h publication on D−1 does contain D−1's morning, then `lag_24h` becomes
   partially available and several dropped features return. Measuring this is
   cheap and should happen early.
2. `calendar_holiday_state_share` is unweighted, and I could not find an honest
   weight inside WattSteer's sources.
3. The CMO question above. If the published CMO is the DESSEM run's own output,
   this spec's central trade-off is wrong and the A/B should be restructured.

**Nothing here is throwaway, for the same reason the data platform is not.** The
gate function, the ablation test and the frozen-centroid discipline are all more
work than a demo needs, and all three are irreversible if skipped: a model
trained through a leaky feature cannot be un-trained, and a backtest number
published from one cannot be un-published.

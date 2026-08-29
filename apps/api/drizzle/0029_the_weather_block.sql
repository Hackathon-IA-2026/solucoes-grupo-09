-- The weather block, complete — class `W`, capacity-weighted over the frozen
-- centroids.
--
-- Hand-written, like `0012_canonical_read_axes.sql`, `0016_the_feature_gate.sql`,
-- `0017_capacity_at_the_gate.sql`, `0019_calendar_and_astronomy.sql`,
-- `0021_lagged_actuals_behind_the_cutoff.sql`, `0024_day_ahead_programming.sql`
-- and `0025_dessem_and_the_feature_set.sql`, and for the same reason:
-- drizzle-kit generates tables and views, not function DDL. The one view this
-- reads that did not exist before — `canonical_capacity_weight` — is generated,
-- in `0028`.
--
-- ## The debt `0016` named, paid
--
-- Ticket 01 carried **one** weather feature through the gate to prove the cut,
-- and said so at the function: "the geometry is provisional and the gate is
-- not". `weather_temperature_2m` was the *unweighted* mean over every centroid
-- that reported the hour, which is the same number for all four subsystems — a
-- placeholder that proved a publication cut and nothing about geography.
--
-- This migration replaces the aggregation and changes **nothing** about the
-- gate. The publication cut ticket 01 found and fixed — `canonical_weather_forecast`
-- had none, so a `gate_late` feature read a run three hours in its own future —
-- is inherited untouched: the block still writes all four read axes through
-- `feature_apply_gate` and still takes a target date and a profile and no
-- instant of any kind.
--
-- ## The weighting, and why it arrives through a view
--
-- Every class-`W` feature is a capacity-weighted mean over the frozen points,
-- with **wind variables on the wind vector, solar variables on the solar vector
-- and the shared variables on combined VRE capacity**. The two fleets sit in
-- different places — NE wind is the Bahia/Piauí interior and the RN/CE coast,
-- while more than half of SE solar is three municipality clusters in northern
-- Minas Gerais — so one shared vector would put solar weight on wind's coast.
--
-- The weights are **recomputed per target date**, because
-- `docs/research/plant-registry.md` §5 measured fixed 2026-08 weights as
-- misallocating 50.4% of the SE-solar weight mass at window start and moving
-- the SE solar capacity centroid 94 km — more than seven Open-Meteo grid cells.
-- A static vector would leak today's fleet composition into 2024's features.
--
-- They arrive through `canonical_capacity_weight`, which is read under the
-- double as-of `feature_apply_gate` already writes: `canonical_fleet_date()`
-- decides which units existed on D, `canonical_as_of()` decides what WattSteer
-- had learned by the gate. That is why no argument is added here — the weights
-- are a function of the axes the gate sets, not of anything a caller passes.
--
-- **`apps/api/src/features/capacity-weights.ts` remains the authority on the
-- geometry**, and the view is bound to it rather than trusted beside it:
-- `database-features.test.ts` recomputes the same fleet through
-- `computeCapacityWeights` and asserts the two agree, exactly as
-- `feature_vintage_fidelity` is bound to the golden vintage vectors it restates.
-- A feature function cannot call TypeScript, so the choice was a second
-- implementation bound by a test, or a feature layer that cannot weight at all.
--
-- ## Nineteen points, not twenty
--
-- `docs/research/weather-sources.md` says "That is 20 points" and lists
-- nineteen. `ingest/weather/centroids.ts` holds the nineteen, and nothing here
-- counts them: the set is read from the frozen geometry, so a set that is not
-- nineteen is a set-version event rather than a discrepancy this file hides.
--
-- ## Coverage is weight mass, and a hole is not calm weather
--
-- Two rules, and they are the same rule twice:
--
--   * **`weather_centroid_coverage` is the share of capacity weight mass that
--     reported**, not the fraction of centroids. Losing a 426 MW point and
--     losing a 4,172 MW point are the same fraction of points and are not
--     remotely the same event. The weighted reading still gives 1 when
--     everything arrived.
--   * **A missing centroid renormalises the mean over the reporters** rather
--     than dividing by the full mass. Dividing by the full mass would pull every
--     mean toward zero in proportion to the hole and produce a number that looks
--     like weather. The size of the hole is reported separately, so the serve
--     path can refuse the row instead of imputing it.
--
-- ## Ramps and centred windows are legal here, and nowhere on the actuals side
--
-- A D−1 run publishes the whole profile at once, so a difference inside it is
-- computed from data that genuinely exists at the gate. This is the single
-- largest recovery of the originally proposed feature set.
--
-- **And the profile is the run's, not the calendar day's** — which is where this
-- block legitimately differs from the class-`P` and class-`D` blocks beside it.
-- There, the hour before the first hour of D belongs to *D−1's own file*, a
-- different publication, so the ramp is NULL at the day's near edge. A weather
-- run carries D−1 23:00 BRT and D 00:00 BRT in one publication, so the same
-- difference is a shape inside one forecast and is legal. The read window is
-- therefore widened by three hours on each side, and the emitted rows are still
-- exactly the 24 hours of D.
--
-- ## The two conversions, argued rather than magic
--
-- Both are deterministic and identical on both sides of the gate, so neither
-- introduces skew.
--
--   * **Wind** — a generic IEC-class power curve at 120 m, cut-in 3 m/s, rated
--     12 m/s, cut-out 25 m/s, no air-density correction, applied **per centroid**
--     and then capacity-weighted. The resulting capacity factor is a **proxy**
--     and is named as one: it is not the Brazilian fleet's curve, and the
--     research it comes from (`docs/research/weather-lead-time.md` §4) calls it
--     illustrative.
--   * **Solar** — STC-referenced irradiance over installed capacity, with **no
--     temperature derate**. Adding a −0.4%/K cell-temperature coefficient would
--     bake one person's constant into a feature; `weather_temperature_2m` is in
--     the vector, so a gradient-boosted model learns the interaction from data.
--
-- ## Lead time is deliberately absent
--
-- Within a fixed run cycle `weather_lead_hours` is perfectly collinear with
-- `calendar_local_hour`: target hours 00–23 BRT on D are 03Z–02Z(+1), and from a
-- D−1 12Z run the lead is exactly `15 + local_hour`. It carries nothing the
-- vector does not already hold. What *is* informative is the fallback, and
-- `weather_run_age_hours` captures precisely that — zero in roughly 95% of rows,
-- twelve or twenty-four when a scheduled run was missing from the archive and an
-- older cycle stood in. That is how a 4.5% missing-run rate degrades the
-- forecast rather than corrupting it.
--
-- ## The twelve variables, and the exclusions
--
-- The request is pinned at twelve on `ecmwf_ifs`: wind speed at 100 m and
-- 120 m, wind direction at 120 m, gusts at 10 m, air temperature, surface
-- pressure, relative humidity, precipitation, shortwave radiation, direct normal
-- irradiance, diffuse radiation and cloud cover. Twelve is chosen against the
-- call-weighting cliff and matches the request shape the lead-time research
-- measured. Variables documented by Open-Meteo but **null under the pinned model
-- are not requested at all**, so no run can write a column of NULLs; the pinning
-- and the exclusions live at the adapter, which is the one place a variable list
-- can be a request. Nothing here can add a thirteenth: this block reads
-- `canonical_weather_forecast`, whose columns are the twelve.

-- The wind power curve, with its parameters written down at the feature.
--
-- Cut-in 3 m/s, rated 12 m/s, cut-out 25 m/s, hub 120 m, no air-density
-- correction — the curve `docs/research/weather-lead-time.md` §4 passes both
-- sides of the train/serve comparison through, restated here as a function so
-- that the three numbers exist once and a fixture test can pin them.
--
-- Below cut-in and at or above cut-out the machine produces nothing; between
-- rated and cut-out it is at nameplate; between cut-in and rated the power
-- available in the wind goes as the cube of the speed, so the interpolation does
-- too. A linear ramp there would overstate every hour in the middle of the band,
-- which over Brazil is most of them.
--
-- IMMUTABLE, and it speaks m/s while `canonical_weather_forecast` speaks km/h.
-- The conversion is at the call site rather than inside, because the curve is a
-- statement about turbines and the unit is a statement about Open-Meteo.
CREATE OR REPLACE FUNCTION feature_wind_power_curve_cf(speed_ms double precision)
  RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN speed_ms IS NULL THEN NULL
    WHEN speed_ms < 3.0 THEN 0.0
    WHEN speed_ms >= 25.0 THEN 0.0
    WHEN speed_ms >= 12.0 THEN 1.0
    ELSE (speed_ms ^ 3 - 3.0 ^ 3) / (12.0 ^ 3 - 3.0 ^ 3)
  END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_wind_power_curve_cf(double precision) IS
  'Generic IEC-class power curve at 120 m: cut-in 3 m/s, rated 12 m/s, cut-out 25 m/s, cubic between cut-in and rated, no air-density correction. Takes m/s. A proxy for the Brazilian fleet and named as one - it is the illustrative curve of docs/research/weather-lead-time.md, not a fleet curve.';
--> statement-breakpoint

-- The provisional shape of `0016`, replaced rather than extended.
--
-- The type gains a `subsystem` attribute and twenty-four features, and the one
-- it already had changes meaning — the same column name, now the VRE-weighted
-- mean rather than the unweighted one. `ALTER TYPE ... ADD ATTRIBUTE` appends,
-- which would put `subsystem` last in a type whose first attribute it has to be,
-- so the type is dropped and restated. That is safe here and nowhere else in
-- this tree: `feature_weather_hour` is local to this block, while `feature_row`
-- is hashed into a lane's identity and is only ever appended to.
DROP FUNCTION IF EXISTS feature_weather_block(date, text);--> statement-breakpoint
DROP TYPE IF EXISTS feature_weather_hour;--> statement-breakpoint

CREATE TYPE feature_weather_hour AS (
  subsystem subsystem_code,
  valid_time timestamptz,
  weather_wind_speed_100m double precision,
  weather_wind_speed_120m double precision,
  weather_wind_direction_120m_sin double precision,
  weather_wind_direction_120m_cos double precision,
  weather_wind_gusts_10m double precision,
  weather_temperature_2m double precision,
  weather_surface_pressure double precision,
  weather_relative_humidity_2m double precision,
  weather_precipitation double precision,
  weather_shortwave_radiation double precision,
  weather_direct_normal_irradiance double precision,
  weather_diffuse_radiation double precision,
  weather_cloud_cover double precision,
  weather_clearness_index double precision,
  weather_wind_power_curve_cf double precision,
  weather_expected_wind_mwh double precision,
  weather_expected_solar_mwh double precision,
  weather_wind_speed_120m_ramp_1h double precision,
  weather_shortwave_radiation_ramp_1h double precision,
  weather_expected_vre_ramp_1h double precision,
  weather_wind_speed_120m_mean_3h double precision,
  weather_wind_speed_120m_std_6h double precision,
  weather_shortwave_radiation_mean_3h double precision,
  weather_run_age_hours double precision,
  weather_centroid_coverage double precision
);
--> statement-breakpoint

-- The class-`W` block.
--
-- **The fleet is read before the weather, and that order is load-bearing** — the
-- same order, for the same reason, as `0025`'s. `feature_capacity_block` leaves
-- the read axes at the D−28 fleet date, because the last thing it does is the
-- second of its two as-of reads. So the expected-generation denominator is
-- materialised into an array first and `feature_apply_gate` is called
-- afterwards, which rewrites all four axes at the target date before a single
-- weather row or weight is read. Reading either first would work today and would
-- silently read them under whatever axes the previous block left behind the day
-- someone reorders the CTEs in `feature_rows`.
--
-- Calling `feature_capacity_block` rather than re-reading
-- `canonical_installed_capacity` costs a second evaluation and buys the thing
-- worth having: one definition of "the fleet at the gate", so
-- `weather_expected_wind_mwh` and `capacity_wind_mw` in the same row cannot
-- disagree about the denominator.
--
-- `feature_calendar_block` is read as a CTE rather than materialised first,
-- because it writes no axis at all — it is class `T` and reads nothing carrying
-- a vintage — so it can neither inherit nor disturb the gate this block set.
CREATE OR REPLACE FUNCTION feature_weather_block(target_date date, gate_profile text)
  RETURNS SETOF feature_weather_hour LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  day_from timestamptz := target_date::timestamp AT TIME ZONE 'America/Sao_Paulo';
  day_to timestamptz := (target_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';
  fleet feature_capacity_day[];
BEGIN
  SELECT coalesce(
           array_agg(ROW(c.subsystem, c.capacity_wind_mw, c.capacity_solar_mw,
                         c.capacity_wind_added_28d_mw,
                         c.capacity_solar_added_28d_mw)::feature_capacity_day),
           '{}'::feature_capacity_day[])
    INTO fleet
  FROM feature_capacity_block(target_date, gate_profile) c;

  PERFORM feature_apply_gate(target_date, gate_profile);

  RETURN QUERY
  -- The three bases, per subsystem and point. Two rows of the weight view
  -- become one row of three weights: the wind vector, the solar vector, and the
  -- combined VRE vector, which is the two blended by their own placed capacity
  -- rather than a third opinion about geography. A point appearing in both
  -- vectors contributes to both — that is not a double count, because the wind
  -- megawatts and the solar megawatts behind it are different megawatts.
  WITH basis AS (
    SELECT
      w.subsystem,
      w.centroid_id,
      coalesce(sum(w.weight) FILTER (WHERE w.technology = 'WIND'), 0) AS wind_weight,
      coalesce(sum(w.weight) FILTER (WHERE w.technology = 'SOLAR'), 0) AS solar_weight,
      sum(w.capacity_mw)
        / nullif(sum(sum(w.capacity_mw)) OVER (PARTITION BY w.subsystem), 0)
        AS vre_weight
    FROM canonical_capacity_weight w
    GROUP BY w.subsystem, w.centroid_id
  ),
  -- The forecast profile, widened by three hours on each side of the local day.
  -- Those hours belong to the same publication as day D's — a weather run is not
  -- a day file — so a difference or a centred window that reaches into them is
  -- still a shape inside one forecast, computed from data that exists at the
  -- gate. The cut is still `published_at <= gate`, which is what makes that true
  -- rather than merely convenient.
  profile_hours AS (
    SELECT h AS valid_time
    FROM generate_series(day_from - interval '3 hours',
                         day_to + interval '2 hours',
                         interval '1 hour') AS h
  ),
  points AS (
    SELECT
      f.centroid_id,
      f.valid_time,
      f.run_age_hours,
      f.wind_speed100m_kmh,
      f.wind_speed120m_kmh,
      f.wind_direction120m_deg,
      f.wind_gusts10m_kmh,
      f.temperature2m_c,
      f.surface_pressure_hpa,
      f.relative_humidity2m_pct,
      f.precipitation_mm,
      f.shortwave_radiation_wm2,
      f.direct_normal_irradiance_wm2,
      f.diffuse_radiation_wm2,
      f.cloud_cover_pct
    FROM canonical_weather_forecast f
    WHERE f.valid_time >= day_from - interval '3 hours'
      AND f.valid_time <= day_to + interval '2 hours'
  ),
  -- The spine of the aggregate: every subsystem the fleet places weight for,
  -- crossed with every hour of the widened profile, **before** the weather is
  -- joined. A subsystem-hour no centroid reported is therefore a row with
  -- coverage 0 rather than an absent row, and 0 is what the serve-time contract
  -- refuses on. An absent row would arrive downstream as NULL, which reads as
  -- "there is no weather feature here" rather than as "the fleet's weather did
  -- not arrive".
  hour_spine AS (
    SELECT DISTINCT basis.subsystem, profile_hours.valid_time
    FROM basis CROSS JOIN profile_hours
  ),
  -- One weighted mean per variable, renormalised over the centroids that
  -- reported it. The denominator is the mass of the reporters, never the full
  -- mass: a hole in the sample is not calm weather.
  aggregated AS (
    SELECT
      hour_spine.subsystem,
      hour_spine.valid_time,
      sum(p.wind_speed100m_kmh * basis.wind_weight)
        / nullif(sum(basis.wind_weight)
                   FILTER (WHERE p.wind_speed100m_kmh IS NOT NULL), 0) AS wind_speed_100m,
      sum(p.wind_speed120m_kmh * basis.wind_weight)
        / nullif(sum(basis.wind_weight)
                   FILTER (WHERE p.wind_speed120m_kmh IS NOT NULL), 0) AS wind_speed_120m,
      -- The direction is a **vector** mean and never a numeric one: 350° and 10°
      -- do not average to 180°. Each point contributes a unit vector at its own
      -- bearing, weighted by capacity; the resultant is renormalised to unit
      -- length below, so the pair is a direction rather than a
      -- directional-consistency score.
      sum(sin(radians(p.wind_direction120m_deg)) * basis.wind_weight)
        AS direction_sin_sum,
      sum(cos(radians(p.wind_direction120m_deg)) * basis.wind_weight)
        AS direction_cos_sum,
      sum(p.wind_gusts10m_kmh * basis.wind_weight)
        / nullif(sum(basis.wind_weight)
                   FILTER (WHERE p.wind_gusts10m_kmh IS NOT NULL), 0) AS wind_gusts_10m,
      sum(p.temperature2m_c * basis.vre_weight)
        / nullif(sum(basis.vre_weight)
                   FILTER (WHERE p.temperature2m_c IS NOT NULL), 0) AS temperature_2m,
      sum(p.surface_pressure_hpa * basis.vre_weight)
        / nullif(sum(basis.vre_weight)
                   FILTER (WHERE p.surface_pressure_hpa IS NOT NULL), 0)
        AS surface_pressure,
      sum(p.relative_humidity2m_pct * basis.vre_weight)
        / nullif(sum(basis.vre_weight)
                   FILTER (WHERE p.relative_humidity2m_pct IS NOT NULL), 0)
        AS relative_humidity_2m,
      sum(p.precipitation_mm * basis.vre_weight)
        / nullif(sum(basis.vre_weight)
                   FILTER (WHERE p.precipitation_mm IS NOT NULL), 0) AS precipitation,
      sum(p.shortwave_radiation_wm2 * basis.solar_weight)
        / nullif(sum(basis.solar_weight)
                   FILTER (WHERE p.shortwave_radiation_wm2 IS NOT NULL), 0)
        AS shortwave_radiation,
      sum(p.direct_normal_irradiance_wm2 * basis.solar_weight)
        / nullif(sum(basis.solar_weight)
                   FILTER (WHERE p.direct_normal_irradiance_wm2 IS NOT NULL), 0)
        AS direct_normal_irradiance,
      sum(p.diffuse_radiation_wm2 * basis.solar_weight)
        / nullif(sum(basis.solar_weight)
                   FILTER (WHERE p.diffuse_radiation_wm2 IS NOT NULL), 0)
        AS diffuse_radiation,
      sum(p.cloud_cover_pct * basis.solar_weight)
        / nullif(sum(basis.solar_weight)
                   FILTER (WHERE p.cloud_cover_pct IS NOT NULL), 0) AS cloud_cover,
      -- The power curve is applied **per centroid and then weighted**, never to
      -- the weighted mean speed. It is nonlinear, so the two differ, and the
      -- second understates every hour in which the fleet's weather is not
      -- uniform — which is every hour worth forecasting.
      sum(feature_wind_power_curve_cf(p.wind_speed120m_kmh / 3.6) * basis.wind_weight)
        / nullif(sum(basis.wind_weight)
                   FILTER (WHERE p.wind_speed120m_kmh IS NOT NULL), 0)
        AS wind_power_curve_cf,
      -- Staleness is a property of the rows that actually entered this
      -- subsystem's aggregate, so a point carrying no weight here cannot make
      -- the row look stale. The **max** rather than a mean: the feature exists to
      -- say that this row is older than the rows around it, and a mean would
      -- dilute one stale point into invisibility.
      max(p.run_age_hours::double precision)
        FILTER (WHERE basis.vre_weight > 0) AS run_age_hours,
      -- Coverage is weight **mass**, not a count of points, and 1 still means
      -- everything arrived.
      coalesce(sum(basis.vre_weight) FILTER (WHERE p.centroid_id IS NOT NULL), 0)
        / nullif(sum(basis.vre_weight), 0) AS centroid_coverage
    FROM hour_spine
    JOIN basis ON basis.subsystem = hour_spine.subsystem
    LEFT JOIN points p
      ON p.centroid_id = basis.centroid_id
     AND p.valid_time = hour_spine.valid_time
    GROUP BY hour_spine.subsystem, hour_spine.valid_time
  ),
  -- The two conversions, and the point at which the fleet enters. Both are
  -- deterministic and identical on both sides of the gate, so neither introduces
  -- skew. `capacity_*_mw` is the fleet read at the gate's vintage and the target
  -- date's valid time — the same double as-of, and the same reading, as
  -- `capacity_wind_mw` in the row this feeds. At hourly grain a capacity factor
  -- times MW is MWh, which is why neither conversion carries a time term.
  converted AS (
    SELECT
      aggregated.*,
      CASE WHEN coalesce(fleet_mw.capacity_wind_mw, 0) > 0
           THEN aggregated.wind_power_curve_cf * fleet_mw.capacity_wind_mw END
        AS expected_wind_mwh,
      -- STC-referenced, and carrying **no temperature derate**: adding one would
      -- bake a coefficient into a feature, and `weather_temperature_2m` is in the
      -- vector so the model learns the interaction from data instead.
      CASE WHEN coalesce(fleet_mw.capacity_solar_mw, 0) > 0
           THEN fleet_mw.capacity_solar_mw * aggregated.shortwave_radiation / 1000.0 END
        AS expected_solar_mwh
    FROM aggregated
    LEFT JOIN unnest(fleet) AS fleet_mw
      ON fleet_mw.subsystem = aggregated.subsystem
  ),
  -- Everything the profile can say about itself, in one pass. Legal because a
  -- run publishes the whole profile at once; the adjacency checks below are what
  -- keep a neighbouring *row* from standing in for a neighbouring *hour* once
  -- the profile has a gap.
  --
  -- `_std_6h` is the six hours t−3 … t+2. An even window has no exactly centred
  -- form, and the convention is written here rather than left to whoever reads
  -- the frame: three hours of history, the hour itself, two hours ahead.
  shaped AS (
    SELECT
      converted.*,
      lag(converted.valid_time) OVER hourly AS previous_hour,
      lead(converted.valid_time) OVER hourly AS next_hour,
      lag(converted.wind_speed_120m) OVER hourly AS previous_wind_speed_120m,
      lead(converted.wind_speed_120m) OVER hourly AS next_wind_speed_120m,
      lag(converted.shortwave_radiation) OVER hourly AS previous_shortwave,
      lead(converted.shortwave_radiation) OVER hourly AS next_shortwave,
      lag(converted.expected_wind_mwh) OVER hourly AS previous_expected_wind,
      lag(converted.expected_solar_mwh) OVER hourly AS previous_expected_solar,
      stddev_samp(converted.wind_speed_120m) OVER centred_6h AS wind_speed_120m_std_6h,
      count(converted.wind_speed_120m) OVER centred_6h AS wind_speed_120m_hours_6h,
      count(*) OVER centred_6h AS hours_in_6h
    FROM converted
    WINDOW hourly AS (PARTITION BY converted.subsystem ORDER BY converted.valid_time),
           centred_6h AS (PARTITION BY converted.subsystem
                          ORDER BY converted.valid_time
                          ROWS BETWEEN 3 PRECEDING AND 2 FOLLOWING)
  ),
  -- The clearness index's denominator, from the block that owns it. Read through
  -- `feature_calendar_block` rather than recomputed, so the numerator's
  -- hour-mean irradiance and the denominator's hour-midpoint top-of-atmosphere
  -- irradiance cannot drift apart: an edge-sampled denominator peaks the ratio
  -- above 1 every morning, which is exactly what the midpoint offset in `0019`
  -- exists to prevent.
  extraterrestrial AS (
    SELECT k.valid_time, k.solar_extraterrestrial_ghi
    FROM feature_calendar_block(target_date) k
  )
  SELECT
    shaped.subsystem,
    shaped.valid_time,
    shaped.wind_speed_100m,
    shaped.wind_speed_120m,
    -- Renormalised to unit length. A resultant that collapses to zero — opposed
    -- bearings cancelling exactly — has no direction to report and is NULL
    -- rather than an arbitrary pick.
    CASE WHEN sqrt(shaped.direction_sin_sum ^ 2 + shaped.direction_cos_sum ^ 2) > 0
         THEN shaped.direction_sin_sum
              / sqrt(shaped.direction_sin_sum ^ 2 + shaped.direction_cos_sum ^ 2) END,
    CASE WHEN sqrt(shaped.direction_sin_sum ^ 2 + shaped.direction_cos_sum ^ 2) > 0
         THEN shaped.direction_cos_sum
              / sqrt(shaped.direction_sin_sum ^ 2 + shaped.direction_cos_sum ^ 2) END,
    shaped.wind_gusts_10m,
    shaped.temperature_2m,
    shaped.surface_pressure,
    shaped.relative_humidity_2m,
    shaped.precipitation,
    shaped.shortwave_radiation,
    shaped.direct_normal_irradiance,
    shaped.diffuse_radiation,
    shaped.cloud_cover,
    -- The clearness index, guarded at night. The denominator is clamped at
    -- 1 W/m² rather than divided by as it stands: top-of-atmosphere irradiance is
    -- exactly zero below the horizon, and a ratio of two small numbers at dawn is
    -- not a measurement. NULL where no centroid set is frozen, because there is
    -- then no place the geometry was computed at.
    CASE WHEN extraterrestrial.solar_extraterrestrial_ghi IS NOT NULL
         THEN shaped.shortwave_radiation
              / greatest(extraterrestrial.solar_extraterrestrial_ghi, 1.0) END,
    shaped.wind_power_curve_cf,
    shaped.expected_wind_mwh,
    shaped.expected_solar_mwh,
    -- The adjacency check is the point, as it is in `0024` and `0025`. A
    -- neighbouring row is not a neighbouring hour once the profile has a gap,
    -- and a `_ramp_1h` that quietly spanned two hours would be wrong in precisely
    -- the rows where the run was already thin.
    CASE WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
         THEN shaped.wind_speed_120m - shaped.previous_wind_speed_120m END,
    CASE WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
         THEN shaped.shortwave_radiation - shaped.previous_shortwave END,
    -- The VRE ramp is the difference of the *sum*, and it is NULL unless both
    -- halves exist at both hours. Coalescing a missing expectation to zero would
    -- make a fleet that has no solar registered look like one whose solar output
    -- collapsed.
    CASE WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
         THEN (coalesce(shaped.expected_wind_mwh, 0)
               + coalesce(shaped.expected_solar_mwh, 0))
              - (coalesce(shaped.previous_expected_wind, 0)
                 + coalesce(shaped.previous_expected_solar, 0)) END,
    CASE WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
          AND shaped.next_hour = shaped.valid_time + interval '1 hour'
         THEN (shaped.previous_wind_speed_120m + shaped.wind_speed_120m
               + shaped.next_wind_speed_120m) / 3.0 END,
    -- A partial window is a different window, so the six hours have to be six.
    CASE WHEN shaped.hours_in_6h = 6 AND shaped.wind_speed_120m_hours_6h = 6
         THEN shaped.wind_speed_120m_std_6h END,
    CASE WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
          AND shaped.next_hour = shaped.valid_time + interval '1 hour'
         THEN (shaped.previous_shortwave + shaped.shortwave_radiation
               + shaped.next_shortwave) / 3.0 END,
    shaped.run_age_hours,
    shaped.centroid_coverage
  FROM shaped
  LEFT JOIN extraterrestrial ON extraterrestrial.valid_time = shaped.valid_time
  -- The widened profile was read so the shapes above could be computed; only the
  -- 24 hours of the target date are a feature row.
  WHERE shaped.valid_time >= day_from AND shaped.valid_time < day_to
  ORDER BY shaped.valid_time, shaped.subsystem;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_weather_block(date, text) IS
  'Class W: the twelve pinned Open-Meteo variables aggregated to the subsystem-hour, capacity-weighted over the frozen centroids and cut on published_at <= gate. Wind variables carry the wind vector, solar variables the solar vector, shared variables combined VRE capacity, and the weights are recomputed per target date. A missing centroid renormalises the mean over the reporters rather than dividing by the full mass, and weather_centroid_coverage reports the share of weight mass that reported. Ramps and centred windows are computed within the run profile, which carries the hours either side of the local day in the same publication.';
--> statement-breakpoint

-- Twenty-four columns onto the one declaration, appended.
--
-- `ALTER TYPE ... ADD ATTRIBUTE` appends, so migration order *is* attribute
-- order and this block lands after the class-`D` block of `0025`.
-- `docs/specs/forecaster.md` hashes the type's ordered names into a lane's
-- `feature_hash`, which is exactly the visible event that hash exists to make —
-- and it is needed twice here, because `weather_temperature_2m` keeps its name
-- and its position while its **meaning** changes from the unweighted mean over
-- all centroids to the VRE-weighted mean over this subsystem's. A model trained
-- on ticket 01's placeholder is not valid against this row, and the hash moving
-- is what says so.
--
-- Twenty-four, not twenty-five: `weather_lead_hours` is deliberately absent, and
-- the collinearity argument is recorded at the block above and in the column
-- comment on `weather_run_age_hours` below.
ALTER TYPE feature_row ADD ATTRIBUTE weather_wind_speed_100m double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_wind_speed_120m double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_wind_direction_120m_sin double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_wind_direction_120m_cos double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_wind_gusts_10m double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_surface_pressure double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_relative_humidity_2m double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_precipitation double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_shortwave_radiation double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_direct_normal_irradiance double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_diffuse_radiation double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_cloud_cover double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_clearness_index double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_wind_power_curve_cf double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_expected_wind_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_expected_solar_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_wind_speed_120m_ramp_1h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_shortwave_radiation_ramp_1h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_expected_vre_ramp_1h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_wind_speed_120m_mean_3h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_wind_speed_120m_std_6h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_shortwave_radiation_mean_3h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_run_age_hours double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE weather_centroid_coverage double precision;--> statement-breakpoint

-- The catalogue copy of the caveats, at the column itself. A caveat a modeller
-- cannot find from the column is a caveat nobody applies.
COMMENT ON COLUMN feature_row.weather_temperature_2m IS
  'Air temperature at 2 m, degrees C, capacity-weighted over the frozen centroids on the combined VRE vector. Restated by ticket 08: through ticket 01 this was the unweighted mean over every centroid that reported the hour and was the same number for all four subsystems. The gate it is cut on is unchanged - published_at <= gate, which is what makes a weather feature D-1 available in backfill.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_wind_speed_100m IS
  'Wind speed at 100 m, km/h, capacity-weighted on the wind vector. Kept beside the 120 m field rather than dropped: 100 m is the only hub-adjacent height the reanalysis carries, so it is the one height at which a forecast and an independent analysis can be compared.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_wind_speed_120m IS
  'Wind speed at 120 m, km/h, capacity-weighted on the wind vector. The hub height the power curve is stated at.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_wind_direction_120m_sin IS
  'sin of the capacity-weighted **vector** mean wind direction at 120 m. Never a numeric mean: 350 deg and 10 deg do not average to 180 deg. Each centroid contributes a unit vector at its own bearing weighted by capacity, and the resultant is renormalised to unit length so the pair is a direction rather than a directional-consistency score. NULL where opposed bearings cancel exactly.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_wind_direction_120m_cos IS
  'cos of the same weighted vector mean, on the same terms as weather_wind_direction_120m_sin.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_wind_gusts_10m IS
  'Wind gusts at 10 m, km/h, capacity-weighted on the wind vector. 10 m because it is the only height the pinned model publishes gusts at, not because 10 m is the height of interest.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_surface_pressure IS
  'Surface pressure, hPa, capacity-weighted on the combined VRE vector.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_relative_humidity_2m IS
  'Relative humidity at 2 m, per cent, capacity-weighted on the combined VRE vector.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_precipitation IS
  'Precipitation, mm over the hour, capacity-weighted on the combined VRE vector.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_shortwave_radiation IS
  'Global horizontal irradiance, W/m2, an hour mean, capacity-weighted on the solar vector. The numerator of weather_clearness_index and of weather_expected_solar_mwh.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_direct_normal_irradiance IS
  'Direct normal irradiance, W/m2, capacity-weighted on the solar vector.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_diffuse_radiation IS
  'Diffuse horizontal irradiance, W/m2, capacity-weighted on the solar vector.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_cloud_cover IS
  'Total cloud cover, per cent, capacity-weighted on the solar vector.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_clearness_index IS
  'weather_shortwave_radiation / max(solar_extraterrestrial_ghi, 1 W/m2). The denominator is the astronomy block own top-of-atmosphere irradiance, sampled at the hour midpoint so that an hour-mean numerator is not divided by an edge-sampled denominator. Clamped rather than divided by zero: below the horizon the denominator is exactly zero, and a ratio of two small numbers at dawn is not a measurement. NULL where no centroid set is frozen.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_wind_power_curve_cf IS
  'Generic IEC-class power curve at 120 m - cut-in 3 m/s, rated 12 m/s, cut-out 25 m/s, no air-density correction - applied per centroid and then capacity-weighted. A **proxy** and named as one: it is not the Brazilian fleet curve. Applied per centroid rather than to the weighted mean speed because the curve is nonlinear, so the two differ and the second understates every non-uniform hour.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_expected_wind_mwh IS
  'weather_wind_power_curve_cf x capacity_wind_mw x 1 h. The fleet is read at the gate vintage and the target date valid time - the same double as-of, and the same reading, as capacity_wind_mw in this row. NULL where the fleet is unknown or zero at that gate, never zero.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_expected_solar_mwh IS
  'capacity_solar_mw x weather_shortwave_radiation / 1000 x 1 h. STC-referenced and carrying **no temperature derate**: adding a cell-temperature coefficient would bake a constant into a feature, and weather_temperature_2m is in the vector so the model can learn the interaction from data. NULL where the fleet is unknown or zero at the gate.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_wind_speed_120m_ramp_1h IS
  'Difference within the forecast profile. Legal because a D-1 run publishes the whole profile at once - and unlike the class-P and class-D ramps beside it, it is defined at the first hour of the local day, because the hour before it belongs to the same weather run rather than to a different file. NULL wherever the previous row is not the previous hour.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_shortwave_radiation_ramp_1h IS
  'Difference of weather_shortwave_radiation within the forecast profile, on the same terms as weather_wind_speed_120m_ramp_1h.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_expected_vre_ramp_1h IS
  'Difference of (weather_expected_wind_mwh + weather_expected_solar_mwh) within the forecast profile. A missing half counts as zero within the sum, so a subsystem with no registered solar is not read as one whose solar collapsed.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_wind_speed_120m_mean_3h IS
  'Mean of weather_wind_speed_120m over the three hours centred on t, within the forecast profile. NULL unless both neighbours are the adjacent hours and both carry a value.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_wind_speed_120m_std_6h IS
  'Sample standard deviation of weather_wind_speed_120m over the six hours t-3 .. t+2. An even window has no exactly centred form and this is the convention: three hours of history, the hour itself, two ahead. NULL unless all six hours carry a value, because a partial window is a different window.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_shortwave_radiation_mean_3h IS
  'Mean of weather_shortwave_radiation over the three hours centred on t, on the same terms as weather_wind_speed_120m_mean_3h.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_run_age_hours IS
  'run_init(scheduled) - run_init(used), hours, taken as the **max** over the centroids that carry weight in this subsystem. 0 on the normal path; 12 or 24 when a scheduled run was missing from the archive and an older cycle stood in, which is how a 4.5% missing-run rate degrades the forecast rather than corrupting it. The max rather than a mean, because the feature exists to say this row is staler than its neighbours and a mean would dilute one stale point into invisibility. weather_lead_hours is deliberately absent: within a fixed run cycle it is perfectly collinear with calendar_local_hour, and run age is the only informative part of it.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.weather_centroid_coverage IS
  'Share of the subsystem combined-VRE capacity weight **mass** that a centroid reported for this hour - not the fraction of centroids. Losing a 426 MW point and losing a 4,172 MW point are the same fraction of points and are not the same event. 1 means everything arrived; 0 means nothing did, and is a row rather than an absence so the serve path can refuse it. The weighted means beside it are renormalised over the reporters, so a hole moves this column and not them.';
--> statement-breakpoint

-- `feature_rows(...)` again — the same function, one wider join.
--
-- Restated in full because a function body cannot be patched, and restated from
-- `0025`'s definition rather than from an older copy: `ALTER TYPE ... ADD
-- ATTRIBUTE` appends, so migration order *is* attribute order, and a restatement
-- that rebuilt the select list from `0024` would emit the columns in an order
-- Postgres reports as "returned type X does not match expected type Y in column
-- N" — if it is lucky, and as two silently swapped columns if it is not. Every
-- prior block's columns are in their existing positions and the twenty-four new
-- ones are last.
--
-- The spine is untouched: the signature still holds no instant of any kind, and
-- the gate is still resolved per target date inside the loop. **The one change
-- to the shape of the query is that the weather join gained a subsystem**, which
-- is the whole of ticket 08 in one line — through ticket 01 the weather CTE had
-- no subsystem to join on, because the unweighted mean did not have one.
CREATE OR REPLACE FUNCTION feature_rows(
  target_from date,
  target_to date,
  gate_profile text,
  feature_set text,
  threshold_mw double precision
) RETURNS SETOF feature_row LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  d date;
  gate timestamptz;
  weather_go_live timestamptz;
  label_go_live timestamptz;
  capacity_go_live timestamptz;
  context_go_live timestamptz;
  exchange_go_live timestamptz;
  programmed_go_live timestamptz;
  dessem_go_live timestamptz;
BEGIN
  IF target_from IS NULL OR target_to IS NULL THEN
    RAISE EXCEPTION 'feature_rows requires both ends of the target range'
      USING ERRCODE = '22023';
  END IF;
  IF target_to < target_from THEN
    RAISE EXCEPTION 'target range % .. % is backwards', target_from, target_to
      USING ERRCODE = '22023';
  END IF;
  IF feature_set IS NULL
     OR feature_set NOT IN ('dessem_free_v1', 'dessem_augmented_v1') THEN
    RAISE EXCEPTION 'unknown feature set %: expected dessem_free_v1 or dessem_augmented_v1',
      coalesce(feature_set, '<null>') USING ERRCODE = '22023';
  END IF;
  IF threshold_mw IS NULL OR threshold_mw < 0 THEN
    RAISE EXCEPTION 'threshold_mw must be a non-negative number of MW'
      USING ERRCODE = '22023';
  END IF;
  -- Structural, not a rule: the DESSEM file for day D is created on the
  -- afternoon of D-1, so at 09:00 on D-1 the newest one describes D-1 itself.
  -- The block behind this raises the same refusal for a caller that reaches it
  -- another way; this one is here so the refusal costs nothing to discover.
  IF feature_set = 'dessem_augmented_v1' AND gate_profile IS DISTINCT FROM 'gate_late' THEN
    RAISE EXCEPTION 'dessem_augmented_v1 exists only at gate_late: DESSEM for day D is not published until the evening of D-1'
      USING ERRCODE = '22023';
  END IF;
  -- Reject an unknown profile once, up front, rather than on the first row.
  PERFORM gate_at(target_from, gate_profile);

  -- WattSteer's own go-live per source, for the fidelity stamp. Not filtered by
  -- any axis: go-live is a fact about WattSteer's history rather than about the
  -- cut being asked for.
  SELECT g.go_live_at INTO weather_go_live
  FROM canonical_read_go_live g WHERE g.read = 'weather-forecast';
  SELECT g.go_live_at INTO label_go_live
  FROM canonical_read_go_live g WHERE g.read = 'curtailment-by-reporting-entity';
  SELECT g.go_live_at INTO capacity_go_live
  FROM canonical_read_go_live g WHERE g.read = 'installed-capacity';
  SELECT g.go_live_at INTO context_go_live
  FROM canonical_read_go_live g WHERE g.read = 'system-context';
  SELECT g.go_live_at INTO exchange_go_live
  FROM canonical_read_go_live g WHERE g.read = 'system-exchange';
  SELECT g.go_live_at INTO programmed_go_live
  FROM canonical_read_go_live g WHERE g.read = 'programmed-load';
  SELECT g.go_live_at INTO dessem_go_live
  FROM canonical_read_go_live g WHERE g.read = 'day-ahead-balance';

  FOR d IN SELECT generate_series(target_from, target_to, interval '1 day')::date LOOP
    gate := gate_at(d, gate_profile);

    RETURN QUERY
    WITH spine AS (
      -- Four subsystems by twenty-four local hours, from the enum and the
      -- calendar. `SIN` is not a Subsystem and there is no fifth member to
      -- leak in.
      SELECT s.subsystem, h.valid_time
      FROM unnest(enum_range(NULL::subsystem_code)) AS s(subsystem)
      CROSS JOIN feature_local_day_hours(d) AS h(valid_time)
    ),
    -- MATERIALIZED so each block is evaluated whole. Each writes every axis at
    -- its own start, so the vintages cannot interleave whichever order the
    -- planner picks them in.
    --
    -- Class `W`, and now at (subsystem, hour) rather than at the hour: the
    -- weather a subsystem sees is the weather over *its own* fleet.
    weather AS MATERIALIZED (
      SELECT * FROM feature_weather_block(d, gate_profile)
    ),
    capacity AS MATERIALIZED (
      SELECT * FROM feature_capacity_block(d, gate_profile)
    ),
    labels AS MATERIALIZED (
      SELECT * FROM feature_label_block(d)
    ),
    -- Class `T`, and no vintage: the calendar is the same calendar whichever
    -- gate is being asked about, which is precisely why these two take a target
    -- date and no profile.
    calendar AS MATERIALIZED (
      SELECT * FROM feature_calendar_block(d)
    ),
    shares AS MATERIALIZED (
      SELECT * FROM feature_holiday_share_block(d)
    ),
    -- Class `K`. The one block cut on `valid_time` rather than on a vintage,
    -- and the only one that reads the fleet under a second fleet date, which is
    -- why it is materialised as firmly as the rest.
    lagged AS MATERIALIZED (
      SELECT * FROM feature_lagged_actuals_block(d, gate_profile, feature_rows.threshold_mw)
    ),
    -- Class `P`. A forecast, so it is cut on publication like the weather and
    -- unlike the block above it — the two cuts sit side by side here on purpose.
    programmed AS MATERIALIZED (
      SELECT * FROM feature_programmed_load_block(d, gate_profile)
    ),
    -- Class `D`. The only block that is handed the feature set, because it is
    -- the only one the set decides the existence of: at `dessem_free_v1` it
    -- returns nothing and the twenty-one columns below are NULL because the
    -- join found no row, not because a filter emptied them.
    dessem AS MATERIALIZED (
      SELECT * FROM feature_dessem_block(d, gate_profile, feature_rows.feature_set)
    )
    SELECT
      spine.subsystem,
      spine.valid_time,
      d,
      feature_rows.gate_profile,
      gate,
      feature_rows.feature_set,
      feature_rows.threshold_mw,
      -- The weakest link. An answer composed from a point-in-time series and a
      -- revision-optimistic one is revision-optimistic as a whole, because a
      -- consumer cannot use half of it. Capacity joins that rule here: over the
      -- backfill window the registry answers from today's snapshot. So do the
      -- two observation series the class-`K` block reads, the day-ahead
      -- programme the class-`P` block reads, and the DESSEM balance. The
      -- registry's own go-live now also stands behind every weather feature,
      -- because the weights are read from it.
      CASE
        WHEN feature_vintage_fidelity(spine.valid_time, weather_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, label_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, capacity_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, context_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, exchange_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, programmed_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, dessem_go_live) = 'point_in_time'
        THEN 'point_in_time' ELSE 'revision_optimistic'
      END,
      weather.weather_temperature_2m,
      labels.wind_mwh,
      labels.solar_mwh,
      total.mwh,
      -- Derived from the argument and never stored, so two consumers cannot
      -- hold disagreeing thresholds. At hourly grain MWh and MW are numerically
      -- equal, which is why the comparison needs no conversion.
      total.mwh > feature_rows.threshold_mw,
      CASE WHEN total.mwh > feature_rows.threshold_mw THEN total.mwh END,
      -- Day grain, broadcast identically across the 24 hours of D. The join is
      -- on the subsystem alone because there is nothing hourly to join on.
      capacity.capacity_wind_mw,
      capacity.capacity_solar_mw,
      capacity.capacity_wind_added_28d_mw,
      capacity.capacity_solar_added_28d_mw,
      calendar.calendar_local_hour,
      calendar.calendar_hour_sin,
      calendar.calendar_hour_cos,
      calendar.calendar_doy_sin,
      calendar.calendar_doy_cos,
      calendar.calendar_day_of_week,
      calendar.calendar_is_weekend,
      calendar.calendar_is_holiday_national,
      shares.calendar_holiday_state_share,
      calendar.calendar_is_day_before_holiday,
      calendar.calendar_is_bridge_day,
      calendar.solar_zenith_cos,
      calendar.solar_extraterrestrial_ghi,
      lagged.observed_actual_lag_hours,
      lagged.observed_constrained_off_lag_168h,
      lagged.observed_constrained_off_wind_lag_168h,
      lagged.observed_constrained_off_solar_lag_168h,
      lagged.observed_constrained_off_lag_48h,
      lagged.observed_constrained_off_same_hour_mean_7d,
      lagged.observed_constrained_off_hours_above_threshold_7d,
      lagged.observed_constrained_off_total_7d_mwh,
      lagged.observed_load_lag_168h,
      lagged.observed_wind_generation_lag_168h,
      lagged.observed_solar_generation_lag_168h,
      lagged.observed_wind_capacity_factor_mean_7d,
      lagged.observed_solar_capacity_factor_mean_7d,
      lagged.observed_net_exchange_lag_168h,
      lagged.observed_net_exchange_mean_24h_to_cutoff,
      lagged.observed_corridor_flow_ne_se_lag_168h,
      lagged.observed_corridor_flow_n_ne_lag_168h,
      lagged.observed_reason_share_ene_7d,
      lagged.observed_reason_share_cnf_7d,
      lagged.observed_reason_share_rel_7d,
      programmed.programmed_load_mwh,
      programmed.programmed_load_ramp_1h,
      programmed.programmed_load_mean_3h,
      programmed.programmed_load_daily_min_mwh,
      programmed.programmed_load_rank_in_day,
      dessem.dessem_demand_mwh,
      dessem.dessem_wind_mwh,
      dessem.dessem_solar_mwh,
      dessem.dessem_mmgd_mwh,
      dessem.dessem_hydro_mwh,
      dessem.dessem_thermal_mwh,
      dessem.dessem_pumping_mwh,
      dessem.dessem_residual_load_mwh,
      dessem.dessem_renewable_load_ratio,
      dessem.dessem_vre_surplus_mwh,
      dessem.dessem_inflexible_share,
      dessem.dessem_implied_net_export_mwh,
      dessem.dessem_demand_ramp_1h,
      dessem.dessem_residual_load_ramp_1h,
      dessem.dessem_vre_ramp_1h,
      dessem.dessem_residual_load_min_of_day,
      dessem.dessem_residual_load_rank_in_day,
      dessem.dessem_wind_capacity_factor,
      dessem.dessem_solar_capacity_factor,
      dessem.dessem_sin_residual_load_mwh,
      dessem.dessem_absorber_residual_load_mwh,
      weather.weather_wind_speed_100m,
      weather.weather_wind_speed_120m,
      weather.weather_wind_direction_120m_sin,
      weather.weather_wind_direction_120m_cos,
      weather.weather_wind_gusts_10m,
      weather.weather_surface_pressure,
      weather.weather_relative_humidity_2m,
      weather.weather_precipitation,
      weather.weather_shortwave_radiation,
      weather.weather_direct_normal_irradiance,
      weather.weather_diffuse_radiation,
      weather.weather_cloud_cover,
      weather.weather_clearness_index,
      weather.weather_wind_power_curve_cf,
      weather.weather_expected_wind_mwh,
      weather.weather_expected_solar_mwh,
      weather.weather_wind_speed_120m_ramp_1h,
      weather.weather_shortwave_radiation_ramp_1h,
      weather.weather_expected_vre_ramp_1h,
      weather.weather_wind_speed_120m_mean_3h,
      weather.weather_wind_speed_120m_std_6h,
      weather.weather_shortwave_radiation_mean_3h,
      weather.weather_run_age_hours,
      weather.weather_centroid_coverage
    FROM spine
    LEFT JOIN weather
      ON weather.subsystem = spine.subsystem
     AND weather.valid_time = spine.valid_time
    LEFT JOIN capacity ON capacity.subsystem = spine.subsystem
    LEFT JOIN calendar ON calendar.valid_time = spine.valid_time
    LEFT JOIN shares ON shares.subsystem = spine.subsystem
    LEFT JOIN lagged
      ON lagged.subsystem = spine.subsystem
     AND lagged.valid_time = spine.valid_time
    LEFT JOIN programmed
      ON programmed.subsystem = spine.subsystem
     AND programmed.valid_time = spine.valid_time
    LEFT JOIN dessem
      ON dessem.subsystem = spine.subsystem
     AND dessem.valid_time = spine.valid_time
    LEFT JOIN labels
      ON labels.subsystem = spine.subsystem
     AND labels.valid_time = spine.valid_time
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN labels.wind_mwh IS NULL AND labels.solar_mwh IS NULL THEN NULL
        ELSE coalesce(labels.wind_mwh, 0) + coalesce(labels.solar_mwh, 0)
      END AS mwh
    ) total
    ORDER BY spine.valid_time, spine.subsystem;
  END LOOP;

  PERFORM feature_release_axes();
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_rows(date, date, text, text, double precision) IS
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. Capacity is a double as-of: valid time D, vintage the gate. The class W block is the twelve pinned weather variables capacity-weighted over the frozen centroids, per subsystem, with the weights recomputed per target date. The calendar and astronomy block is class T and reads no vintage at all. The class K block is cut on valid_time <= actuals_cutoff(gate, dataset), which is the only cut an observation-sourced feature may rely on. The class P block is ONS day-ahead programming, cut on publication like every other forecast. The class D block is the DESSEM balance: it exists only for dessem_augmented_v1 and only at gate_late, and for dessem_free_v1 it returns no rows at all, so a set-A row carries no DESSEM-sourced value at either gate.';

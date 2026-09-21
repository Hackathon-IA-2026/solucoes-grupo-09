-- Drops `observed_constrained_off_lag_48h`, the one column whose NULL rate was a
-- property of its own definition rather than of any upstream dataset.
--
-- The value at "the target hour minus 48 h" is read only up to the cutoff, which
-- at `gate_late` is D-2 03:00 BRT, so it clears the cutoff for the first four
-- local hours of the day and is NULL for the other twenty: 83.3% NULL in
-- training, by construction. `serving_smoke` compares that to serving, where it
-- read 100% once ONS's file also went stale, and refused `gate_late` on the 5%
-- ceiling. No amount of fresher data could have passed it. At `gate_early` it
-- never cleared at all. The spec called it "conditional" and the model carried
-- it anyway; it goes, and `observed_constrained_off_lag_168h` and the three
-- day-grain seven-day aggregates are what remains of the same series.
--
-- Hand-written, because drizzle-kit cannot express composite-type DDL or
-- function bodies. The two function bodies below are the previous definitions
-- (0036 for the block, 0040 for `feature_rows`) with exactly the 48 h column,
-- its join and its select-list entries removed, and nothing else changed.
-- `DROP ATTRIBUTE` comes first because both functions return these types by
-- position.
--
-- NOT a rollback-safe change: an artifact trained before this holds a feature
-- contract that names the column, so its serving-time hash no longer matches and
-- the hot-swap gate will mark it unusable until the next retrain.
ALTER TYPE feature_lagged_actuals_hour DROP ATTRIBUTE observed_constrained_off_lag_48h;--> statement-breakpoint
ALTER TYPE feature_row DROP ATTRIBUTE observed_constrained_off_lag_48h;--> statement-breakpoint
CREATE OR REPLACE FUNCTION feature_lagged_actuals_block(
  target_date date, gate_profile text, threshold_mw double precision
) RETURNS SETOF feature_lagged_actuals_hour LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  cut_curtailment timestamptz := actuals_cutoff(target_date, gate_profile, 'restricao-coff');
  cut_context timestamptz := actuals_cutoff(target_date, gate_profile, 'balanco-energia-subsistema');
  cut_exchange timestamptz := actuals_cutoff(target_date, gate_profile, 'intercambio-nacional');
  -- The staleness the row reports is the *widest* of the three, not an average
  -- and not a favourite. A backward view composed of three series is as stale as
  -- its stalest part, on the weakest-link rule the fidelity stamp already uses:
  -- a consumer cannot use half of it.
  cut_earliest timestamptz := least(cut_curtailment, cut_context, cut_exchange);
  fleet_days_back int;
  fleet feature_capacity_scope[];
BEGIN
  IF threshold_mw IS NULL OR threshold_mw < 0 THEN
    RAISE EXCEPTION 'threshold_mw must be a non-negative number of MW'
      USING ERRCODE = '22023';
  END IF;

  -- The last available civil day of the balance series, as a whole number of
  -- days back from the target date. Whole days because that is the only shape
  -- `feature_apply_gate_for_fleet_offset` accepts, and it accepts only that
  -- shape so the valid-time axis stays a function of the target date.
  fleet_days_back := target_date
    - (cut_context AT TIME ZONE 'America/Sao_Paulo')::date;

  PERFORM feature_apply_gate_for_fleet_offset(target_date, gate_profile, fleet_days_back);
  SELECT coalesce(
           array_agg(ROW(c.subsystem, c.technology, c.capacity_mw)::feature_capacity_scope),
           '{}'::feature_capacity_scope[])
    INTO fleet
  FROM canonical_installed_capacity c;

  -- Back to the level's axes before anything hourly is read. Every block writes
  -- all four axes before it reads (`0016`), and this block writes them twice
  -- because it reads under two fleet dates.
  PERFORM feature_apply_gate(target_date, gate_profile);

  RETURN QUERY
  WITH spine AS (
    SELECT s.subsystem, h.valid_time
    FROM unnest(enum_range(NULL::subsystem_code)) AS s(subsystem)
    CROSS JOIN feature_local_day_hours(target_date) AS h(valid_time)
  ),
  -- The seven days of subsystem-hours ending at the cutoff, aggregated upward
  -- from reporting entities. Upward is the legal direction: it is an
  -- aggregation of observations. Nothing here travels downward from a conjunto
  -- to a member plant, which the domain model forbids as an allocation
  -- presented as an observation.
  --
  -- Half-open at the bottom and closed at the top — `(cutoff − 168 h, cutoff]`
  -- — so every local hour appears exactly seven times, and the trailing
  -- aggregates below have a constant sample size no matter which hour is asked
  -- about. This is the `168 PRECEDING AND 1 PRECEDING` frame, spelled against
  -- the cutoff rather than against the target hour: an actuals window may never
  -- reach `CURRENT ROW`.
  curtailment_hours AS (
    SELECT c.subsystem,
           c.valid_time,
           sum(c.constrained_off_mwh) FILTER (WHERE c.technology = 'WIND') AS wind_mwh,
           sum(c.constrained_off_mwh) FILTER (WHERE c.technology = 'SOLAR') AS solar_mwh,
           sum(c.constrained_off_mwh) AS total_mwh
    FROM canonical_curtailment_by_reporting_entity c
    WHERE c.valid_time > cut_curtailment - interval '168 hours'
      AND c.valid_time <= cut_curtailment
    GROUP BY c.subsystem, c.valid_time
  ),
  -- Same **local** hour, seven samples. Local because the diurnal structure the
  -- mean is about belongs to the grid and not to UTC; everything else stays UTC.
  curtailment_same_hour AS (
    SELECT subsystem,
           extract(hour FROM valid_time AT TIME ZONE 'America/Sao_Paulo')::int AS local_hour,
           avg(total_mwh) AS same_hour_mean,
           -- The occurrence twin of the mean beside it, over the *same seven
           -- observations*: the share of them above the threshold, which lands
           -- in 1/7 steps because the frame above is half-open and every local
           -- hour therefore appears exactly seven times.
           --
           -- **`> threshold_mw`, not `>=`.** The spec's table wrote "at or
           -- above"; the comparison here is the strict one because
           -- `y_has_curtailment` is `total > threshold_mw` and this column is
           -- the occurrence head's baseline for exactly that label. A baseline
           -- that counted a boundary hour the label does not count would be a
           -- baseline and a target disagreeing about what curtailment is, which
           -- is the one thing computing rung 1 from the feature function exists
           -- to prevent. `observed_constrained_off_hours_above_threshold_7d`
           -- beside it uses the same strict comparison, for the same reason.
           (count(*) FILTER (WHERE total_mwh > threshold_mw))::double precision
             / nullif(count(*), 0) AS same_hour_exceedance
    FROM curtailment_hours
    GROUP BY subsystem, local_hour
  ),
  -- Day grain: one number per subsystem for the whole target date, because the
  -- window is anchored to the cutoff and not to the target hour.
  curtailment_window AS (
    SELECT subsystem,
           sum(total_mwh) AS total_7d_mwh,
           count(*) FILTER (WHERE total_mwh > threshold_mw)::int AS hours_above
    FROM curtailment_hours
    GROUP BY subsystem
  ),
  -- Reason shares, aggregated upward over the entity-hours that carry a reason.
  --
  -- `PAR` is **not** in the set. It is a live enum member with zero observations
  -- (`docs/domain-model.md`), and a share column for a class that has never
  -- occurred is a column of zeroes a model would spend split points on. It stays
  -- in the denominator, though, deliberately: on the day `PAR` first appears the
  -- three shares stop summing to one, and that is the monitoring signal rather
  -- than a silent redistribution across the other three.
  reason_shares AS (
    SELECT c.subsystem,
           count(*) FILTER (WHERE c.restriction_reason = 'ENE')::double precision
             / nullif(count(*), 0) AS share_ene,
           count(*) FILTER (WHERE c.restriction_reason = 'CNF')::double precision
             / nullif(count(*), 0) AS share_cnf,
           count(*) FILTER (WHERE c.restriction_reason = 'REL')::double precision
             / nullif(count(*), 0) AS share_rel
    FROM canonical_curtailment_by_reporting_entity c
    WHERE c.valid_time > cut_curtailment - interval '168 hours'
      AND c.valid_time <= cut_curtailment
      AND c.restriction_reason IS NOT NULL
    GROUP BY c.subsystem
  ),
  context_hours AS (
    SELECT s.subsystem, s.valid_time, s.load_mwh, s.wind_generation_mwh,
           s.solar_generation_mwh, s.net_exchange_mwh
    FROM canonical_system_context s
    WHERE s.valid_time > cut_context - interval '168 hours'
      AND s.valid_time <= cut_context
  ),
  context_window AS (
    SELECT subsystem,
           avg(wind_generation_mwh) AS wind_mean_7d,
           avg(solar_generation_mwh) AS solar_mean_7d,
           avg(net_exchange_mwh) FILTER (
             WHERE valid_time > cut_context - interval '24 hours'
           ) AS net_exchange_mean_24h
    FROM context_hours
    GROUP BY subsystem
  ),
  -- Directed flow, in the canonical orientation the ingest table enforces:
  -- `from_subsystem < to_subsystem` in enum order, positive from → to. So
  -- `NE → SE` and `N → NE` are both stored the way they are named, and neither
  -- needs a sign flip — which is worth stating, because a corridor read with the
  -- sign inverted is a feature that is exactly as smooth and exactly as wrong.
  exchange_hours AS (
    SELECT x.from_subsystem, x.to_subsystem, x.valid_time, x.verified_exchange_mwh
    FROM canonical_system_exchange x
    WHERE x.valid_time > cut_exchange - interval '168 hours'
      AND x.valid_time <= cut_exchange
  ),
  -- The fleet of the last available day, read above under its own axes. Empty
  -- array means the registry had nothing to say at this gate, and the capacity
  -- factors are NULL rather than divided by zero.
  fleet_capacity AS (
    SELECT f.subsystem,
           sum(f.capacity_mw) FILTER (WHERE f.technology = 'WIND') AS wind_mw,
           sum(f.capacity_mw) FILTER (WHERE f.technology = 'SOLAR') AS solar_mw
    FROM unnest(fleet) AS f
    GROUP BY f.subsystem
  )
  SELECT
    spine.subsystem,
    spine.valid_time,
    -- How stale the backward view is at this hour. The model is told the
    -- distance from the hour it is predicting to the last actual it was allowed
    -- to see, so it can condition on its own blindness instead of assuming the
    -- lag is constant — which it is not: it moves by a day between the two gate
    -- profiles and would move again the day a lag is measured and loosened.
    -- Cast explicitly: `extract` returns numeric, and a composite type will
    -- reject the row rather than coerce it — loudly, which is the behaviour
    -- this file wants from a type it is appended to twenty attributes at a time.
    (extract(epoch FROM (spine.valid_time - cut_earliest)) / 3600.0)::double precision,
    lag_168h.total_mwh,
    lag_168h.wind_mwh,
    lag_168h.solar_mwh,
    curtailment_same_hour.same_hour_mean,
    curtailment_window.hours_above,
    curtailment_window.total_7d_mwh,
    context_168h.load_mwh,
    context_168h.wind_generation_mwh,
    context_168h.solar_generation_mwh,
    context_window.wind_mean_7d / nullif(fleet_capacity.wind_mw, 0),
    context_window.solar_mean_7d / nullif(fleet_capacity.solar_mw, 0),
    context_168h.net_exchange_mwh,
    context_window.net_exchange_mean_24h,
    corridor_ne_se.verified_exchange_mwh,
    corridor_n_ne.verified_exchange_mwh,
    reason_shares.share_ene,
    reason_shares.share_cnf,
    reason_shares.share_rel,
    -- Last, and last for a mechanical reason rather than a thematic one:
    -- `ALTER TYPE feature_lagged_actuals_hour ADD ATTRIBUTE` above appended it,
    -- so the select list has to end where the type does. Sitting three lines
    -- away from the mean it is the twin of is what appending costs.
    curtailment_same_hour.same_hour_exceedance
  FROM spine
  LEFT JOIN curtailment_hours lag_168h
    ON lag_168h.subsystem = spine.subsystem
   AND lag_168h.valid_time = spine.valid_time - interval '168 hours'
  LEFT JOIN curtailment_same_hour
    ON curtailment_same_hour.subsystem = spine.subsystem
   AND curtailment_same_hour.local_hour
       = extract(hour FROM spine.valid_time AT TIME ZONE 'America/Sao_Paulo')::int
  LEFT JOIN curtailment_window ON curtailment_window.subsystem = spine.subsystem
  LEFT JOIN reason_shares ON reason_shares.subsystem = spine.subsystem
  LEFT JOIN context_hours context_168h
    ON context_168h.subsystem = spine.subsystem
   AND context_168h.valid_time = spine.valid_time - interval '168 hours'
  LEFT JOIN context_window ON context_window.subsystem = spine.subsystem
  LEFT JOIN fleet_capacity ON fleet_capacity.subsystem = spine.subsystem
  -- The two corridors that bind. System-level facts, so the same pair of numbers
  -- is broadcast to all four subsystems: a corridor is not a property of one end
  -- of it, and pretending otherwise would need a sign convention per subsystem
  -- that nothing in the domain model licenses.
  LEFT JOIN exchange_hours corridor_ne_se
    ON corridor_ne_se.from_subsystem = 'NE'
   AND corridor_ne_se.to_subsystem = 'SE'
   AND corridor_ne_se.valid_time = spine.valid_time - interval '168 hours'
  LEFT JOIN exchange_hours corridor_n_ne
    ON corridor_n_ne.from_subsystem = 'N'
   AND corridor_n_ne.to_subsystem = 'NE'
   AND corridor_n_ne.valid_time = spine.valid_time - interval '168 hours'
  ORDER BY spine.valid_time, spine.subsystem;
END $$;
--> statement-breakpoint
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
  row_go_live timestamptz;
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

  -- WattSteer's own go-live behind this row, for the fidelity stamp: the
  -- weakest link over the sources a feature row reads, **derived** rather than
  -- named. Not filtered by any axis, for the reason the seven named lookups it
  -- replaces were not: go-live is a fact about WattSteer's history rather than
  -- about the cut being asked for.
  row_go_live := feature_read_go_live();

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
    ),
    -- Class `P`+`W`+`T`. The one block that reads no source: it composes the
    -- class-`P` and class-`W` blocks above rather than re-reading what they
    -- read, so the reconstruction and the terms it is built from are the same
    -- numbers in the same row. It is not handed the feature set, because both
    -- sets carry it — set B holds this family beside the DESSEM one so the two
    -- views of residual load are comparable.
    proxy AS MATERIALIZED (
      SELECT * FROM feature_proxy_residual_load_block(d, gate_profile)
    ),
    -- Class `K` and class `D`+`K`. The three utilisation ratios, and the only
    -- place in the row where a class-`D` numerator meets a class-`K`
    -- denominator. It is handed the feature set because of that one column: the
    -- class-`D` block it composes returns nothing at `dessem_free_v1`, so
    -- `dessem_export_utilisation` is NULL for set A by the same mechanism as
    -- the other twenty-one `dessem_*` columns — the join found no row — while
    -- the two observed ratios are present in both sets and at both gates.
    utilisation AS MATERIALIZED (
      SELECT * FROM feature_interchange_utilisation_block(
        d, gate_profile, feature_rows.feature_set
      )
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
      -- consumer cannot use half of it. Capacity is in that rule: over the
      -- backfill window the registry answers from today's snapshot. So are the
      -- two observation series the class-`K` block reads, the day-ahead
      -- programme the class-`P` block reads, the DESSEM balance, and the
      -- registry's location cut, which stands behind every weather feature
      -- because the weights are read from it.
      --
      -- It was seven `feature_vintage_fidelity` conjuncts over seven go-lives
      -- named one at a time, and `plant_geo` was in none of them — the eighth
      -- source, behind the weather weights, with no go-live row to name. So the
      -- weakest link is now taken over the sources this function's blocks
      -- **actually read**, discovered from the catalogue by
      -- `feature_read_go_live()`. Same rule, one conjunct, and a ninth source
      -- onboarded tomorrow joins it without an edit here.
      CASE
        WHEN feature_vintage_fidelity(spine.valid_time, row_go_live) = 'point_in_time'
         -- And the gate itself, against WattSteer's own ingestion history over
         -- those same sources. `feature_as_of` suspends the ingestion cut for a
         -- gate that precedes it, because over the backfill window
         -- `ingested_at` is the loader's clock rather than a record of what had
         -- been learned. A row built under that relaxation cannot claim to be
         -- point-in-time, so the stamp is exact: `point_in_time` means this row
         -- was built under `as_of = gate`, unrelaxed. It is the second conjunct
         -- because it is about the gate rather than about a source, and it is a
         -- conjunct rather than a replacement for the one above because a
         -- source that has ingested nothing has a NULL go-live and moves no
         -- horizon.
         AND gate >= feature_ingestion_history_from()
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
      weather.weather_centroid_coverage,
      proxy.proxy_residual_load_mwh,
      proxy.proxy_residual_load_ratio,
      proxy.proxy_renewable_load_ratio,
      proxy.proxy_vre_surplus_mwh,
      proxy.proxy_residual_load_ramp_1h,
      proxy.proxy_residual_load_min_of_day,
      proxy.proxy_residual_load_rank_in_day,
      utilisation.observed_export_utilisation_mean_24h_to_cutoff,
      utilisation.observed_corridor_utilisation_ne_se_max_7d,
      utilisation.dessem_export_utilisation,
      -- The 112th attribute, and last because appending is the only thing
      -- `ALTER TYPE ... ADD ATTRIBUTE` does. It comes from the class-`K` CTE
      -- twenty lines above the `utilisation` one, so this is the first place in
      -- the tree where the select list's order and the blocks' order visibly
      -- part company. That is what the restatement rule is protecting: rebuilt
      -- from `0031`'s copy with every prior column in its existing position.
      lagged.observed_constrained_off_same_hour_exceedance_7d
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
    LEFT JOIN proxy
      ON proxy.subsystem = spine.subsystem
     AND proxy.valid_time = spine.valid_time
    LEFT JOIN utilisation
      ON utilisation.subsystem = spine.subsystem
     AND utilisation.valid_time = spine.valid_time
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
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. Capacity is a double as-of: valid time D, vintage the gate. The class W block is the twelve pinned weather variables capacity-weighted over the frozen centroids, per subsystem, with the weights recomputed per target date. The calendar and astronomy block is class T and reads no vintage at all. The class K block is cut on valid_time <= actuals_cutoff(gate, dataset), which is the only cut an observation-sourced feature may rely on. The class P block is ONS day-ahead programming, cut on publication like every other forecast. The class D block is the DESSEM balance: it exists only for dessem_augmented_v1 and only at gate_late, and for dessem_free_v1 it returns no rows at all, so a set-A row carries no DESSEM-sourced value at either gate. The proxy block is class P+W+T: it composes the class P and class W blocks rather than reading a source of its own, it is in both feature sets so the two views of residual load are comparable, and it is NULL at gate_early because the programme it subtracts from is. The utilisation block is class K and class D+K: three ratios that all divide by feature_export_capability_estimate, an ESTIMATE of directed export capability computed as P99.5 of directed flow over the trailing 365 days ending at the same actuals_cutoff, because no ONS dataset publishes a transfer limit at any grain. There is exactly one such estimate and every ratio reaches it. The one class-K column ticket 05 owed and did not ship is now here too: observed_constrained_off_same_hour_exceedance_7d, the occurrence twin of observed_constrained_off_same_hour_mean_7d over the same seven same-local-hour observations, which is what lets forecaster.md rung 1 compute BOTH heads of the mandatory baseline from this function instead of only the magnitude one. The vintage stamp is the weakest link over the sources the blocks read, taken from feature_read_go_live() rather than from seven go-lives named one at a time, so a source onboarded tomorrow binds the stamp without an edit here - which is how plant_geo, the registry location cut behind every weather feature, reached it.';
--> statement-breakpoint
DELETE FROM feature_dictionary_entry WHERE column_name = 'observed_constrained_off_lag_48h';--> statement-breakpoint
INSERT INTO feature_dropped_feature (idea_feature, reason, replacement, replacement_columns) VALUES
  ('observed_constrained_off_lag_48h',
   'Structurally NULL for 20 of 24 hours at gate_late and for all of them at gate_early: the value at the target hour minus 48 h lies after the cutoff (D-2 03:00 BRT) for every hour but the first four. It failed serving_smoke''s 5% NULL ceiling by construction, so no artifact carrying it could be served.',
   'the 168-hour same-hour lag and the day-grain seven-day aggregates of the same series',
   array['observed_constrained_off_lag_168h', 'observed_constrained_off_same_hour_mean_7d',
         'observed_constrained_off_hours_above_threshold_7d', 'observed_constrained_off_total_7d_mwh']::text[]);
--> statement-breakpoint
-- The earlier ✗ entry for the raw t-1 … t-24 actuals named this column as part
-- of its replacement ("the conditional 48-hour lag"). `feature_dropped_features()`
-- checks every named replacement against the type and refuses the whole read
-- when one is gone, so the entry is edited in the same statement stream rather
-- than left naming a column that no longer exists.
UPDATE feature_dropped_feature
SET replacement = 'the 168-hour lags and the day-grain 7-day aggregates',
    replacement_columns = array_remove(replacement_columns, 'observed_constrained_off_lag_48h'),
    reason = replace(reason, 'and even that is conditional.',
      'and that column, being NULL for twenty of twenty-four hours, was dropped in turn.')
WHERE 'observed_constrained_off_lag_48h' = ANY (replacement_columns)
  AND idea_feature <> 'observed_constrained_off_lag_48h';
--> statement-breakpoint
-- `ordinal` was the catalogue's `attnum`, which keeps counting over a dropped
-- attribute: after the drop above the dictionary read 35, 37, ... and its own
-- test, which asserts the ordinals are 1..n, caught the hole. It is the column's
-- position in the type as it stands now, so it is numbered rather than copied.
-- The body is the previous definition with that one expression changed.
CREATE OR REPLACE FUNCTION feature_dictionary() RETURNS TABLE (
  ordinal integer,
  column_name text,
  sql_type text,
  role text,
  classes text[],
  class_label text,
  source text,
  grain text,
  in_dessem_free_v1 boolean,
  in_dessem_augmented_v1 boolean,
  augmented_only boolean,
  available_at_gate_early boolean,
  is_proxy boolean,
  justifies_dessem_trade boolean,
  model_input boolean,
  description text
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  attrs oid := (SELECT t.typrelid FROM pg_type t WHERE t.oid = 'feature_row'::regtype);
  offenders text;
BEGIN
  SELECT string_agg(a.attname, ', ' ORDER BY a.attnum) INTO offenders
  FROM pg_attribute a
  LEFT JOIN feature_dictionary_entry e ON e.column_name = a.attname
  WHERE a.attrelid = attrs AND a.attnum > 0 AND NOT a.attisdropped
    AND e.column_name IS NULL;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'feature_row attributes carry no dictionary entry: %', offenders
      USING ERRCODE = '22023',
            HINT = 'Unclassified is not an option - an unclassified feature is a leak waiting to be written. The migration that appends an attribute is the migration that classifies it.';
  END IF;

  SELECT string_agg(e.column_name, ', ' ORDER BY e.column_name) INTO offenders
  FROM feature_dictionary_entry e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = attrs AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname = e.column_name
  );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'dictionary entries name no feature_row attribute: %', offenders
      USING ERRCODE = '22023',
            HINT = 'A dictionary that describes a column the type does not have is the second list this design exists to make impossible. Drop the entry in the same migration that drops the attribute.';
  END IF;

  SELECT string_agg(a.attname, ', ' ORDER BY a.attnum) INTO offenders
  FROM pg_attribute a
  WHERE a.attrelid = attrs AND a.attnum > 0 AND NOT a.attisdropped
    AND coalesce(col_description(attrs, a.attnum::integer), '') = '';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'feature_row attributes carry no catalogue comment: %', offenders
      USING ERRCODE = '22023',
            HINT = 'The dictionary reads its prose from col_description so the prose lives once. A column an analyst cannot read the meaning of from the catalogue is a column nobody applies the caveats of.';
  END IF;

  RETURN QUERY
  SELECT
    (row_number() OVER (ORDER BY a.attnum))::integer,
    a.attname::text,
    format_type(a.atttypid, a.atttypmod),
    e.role,
    e.classes,
    CASE WHEN cardinality(e.classes) = 0 THEN e.role
         ELSE array_to_string(e.classes, '+') END,
    e.source,
    e.grain,
    e.in_dessem_free_v1,
    e.in_dessem_augmented_v1,
    e.in_dessem_augmented_v1 AND NOT e.in_dessem_free_v1,
    e.available_at_gate_early,
    e.is_proxy,
    e.justifies_dessem_trade,
    e.model_input,
    col_description(attrs, a.attnum::integer)
  FROM pg_attribute a
  JOIN feature_dictionary_entry e ON e.column_name = a.attname
  WHERE a.attrelid = attrs AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum;
END $$;

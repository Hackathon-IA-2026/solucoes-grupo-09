-- ONS day-ahead programming — class `P`, and the DESSEM-free set's spine.
--
-- Hand-written, like `0012_canonical_read_axes.sql`, `0016_the_feature_gate.sql`,
-- `0019_calendar_and_astronomy.sql` and `0021_lagged_actuals_behind_the_cutoff.sql`,
-- and for the same reason: drizzle-kit generates tables and views, not function
-- DDL. The one view this reads (`canonical_programmed_load`) is generated, in
-- `0023`; everything here is a composite type, a block, five attributes and the
-- entry point restated.
--
-- ## What class `P` is, and why the spec grew a class for it
--
-- `docs/specs/feature-engineering.md` frames the A/B as DESSEM against nothing,
-- and the DESSEM-free set looked as though it would have to survive on weather
-- and lagged actuals. It does not. ONS publishes `carga-energia-programada` — a
-- genuine day-ahead load programme — from 2021-03-05, covering the whole of set
-- A's window, and it agrees with DESSEM's `val_demanda` to 0.03% where the two
-- overlap. That single series is what makes a rebuilt residual load possible
-- over 880 days instead of 460, and it is why `dessem_free_v1` is a contender
-- rather than a control arm.
--
-- ## The publication decision, which is this ticket's real subject
--
-- The risk in class `P` was never the arithmetic; it was the timing. The
-- endpoint returns **no row-level update stamp at all** — no `din_atualizacao`,
-- nothing in the OpenAPI schema, nothing in either dictionary — so the adapter
-- fell back to the response's fetch instant. Over a backfill that is not merely
-- coarse:
--
--   * `published_at <= gate` is false for every historical target date, so the
--     spine would be a column of NULLs across its own window; and
--   * `published_at > valid_time` on every row, which is the shape
--     `docs/domain-model.md` §4 reserves for an **`Observation`**. The one
--     structural guarantee that stops a forecast being read as an actual was
--     inverted for the whole series.
--
-- The instant is therefore decided, and decided **at the adapter** — see
-- `programmePublishedAt` in `src/ingest/ons/load.ts`, which holds the argument
-- and the evidence. In one line: the programme for day D is stamped D−1 15:00
-- BRT, the DESSEM-anchored upper bound rounded in the conservative direction,
-- because the DESSEM file for D was measured created at D−1 17:48Z and could
-- not have consumed a programme that did not yet exist. Nothing in this file
-- re-decides it, and nothing in this file could: the feature layer reads
-- `published_at` through the canonical view and has no second opinion about
-- what "published" means.
--
-- **The consequence, stated rather than discovered.** At `gate_late`
-- (D−1 19:00 BRT) the programme clears by four hours across the full window. At
-- `gate_early` (D−1 09:00 BRT) it does not clear, and every column below is
-- NULL — a visible hole, which is the failure mode the as-of machinery is for,
-- and not a leak. Closing it needs the measurement issue 12 owns; assuming an
-- earlier hour to make the column non-null would be a leak dressed as a fix,
-- because a model trained on a value it will not have at 09:00 cannot be served.
--
-- ## Why centred windows and ramps are legal here, and are not on the actuals
--
-- `0021` put every ramp and every centred window over actuals in the dropped
-- class: last-known-value substitution is honest for a level and dishonest for
-- a local difference, and a ramp rebuilt from one carried-forward number is one
-- value broadcast across 24 hours. That argument does not apply here, and the
-- reason is worth recording rather than assuming: **a D−1 programme publishes
-- the whole of day D at once**. Every hour of the profile is known at the gate,
-- so a difference inside it is computed from data that genuinely exists, and a
-- window centred on the target hour reaches only into hours the same
-- publication already carried.
--
-- Two edges follow from taking "the whole of day D" literally, and both are
-- NULL rather than filled:
--
--   * The **first hour of D has no ramp.** Its predecessor belongs to day D−1's
--     programme, which is a different publication with a different
--     `published_at`; a difference across that boundary is a difference of two
--     forecasts rather than a shape inside one.
--   * The **first and last hours of D have no centred mean**, for the same
--     reason at the far end — and the far end is worse, because D+1's programme
--     is published at D 15:00 BRT, which is *after* both gates. A partial
--     two-of-three mean is not a centred mean; it is a different statistic
--     wearing the same column name.
--
-- And one guard that is easy to leave out: the ramp and the centred mean check
-- that the neighbouring row really is the neighbouring **hour**. Without it a
-- gap in the profile would make `lag()` reach across it, and a column named
-- `_ramp_1h` would silently be a two-hour difference in exactly the rows where
-- the data was already thin. `0021` gets that property from a window frame that
-- stops at the cutoff; here it has to be written.

-- The programmed profile for one target date, at (subsystem, hour).
--
-- Five columns: the level, the two shape features derived inside the profile,
-- and the two day-grain summaries of it.
CREATE TYPE feature_programmed_load_hour AS (
  subsystem subsystem_code,
  valid_time timestamptz,
  programmed_load_mwh double precision,
  programmed_load_ramp_1h double precision,
  programmed_load_mean_3h double precision,
  programmed_load_daily_min_mwh double precision,
  programmed_load_rank_in_day integer
);
--> statement-breakpoint

-- The class-`P` block.
--
-- One view, one gate, no cutoff: the programme is a **Forecast**, so it is cut
-- on `published_at <= gate` and its D−1 availability is *genuine* rather than
-- enforced. There is no `actuals_cutoff` here and there must not be — that
-- function answers a question about observations, and asking it about a
-- forecast would move the cut onto an axis the source never asserted.
--
-- The block takes a target date and a profile and no instant, exactly as every
-- block since `0016` has: the gate is derived inside `feature_apply_gate`, and
-- there is no argument through which a hand-chosen one could arrive.
--
-- **The day-grain pair is NULL unless the profile has all 24 hours.** A minimum
-- over nineteen hours is a minimum of a different day, and a rank among
-- nineteen is not the rank the column's name promises; a model reading either
-- as though the denominator were constant would learn the gaps. The hourly
-- columns survive a partial day, because each of them is a statement about its
-- own hour and its immediate neighbours.
CREATE OR REPLACE FUNCTION feature_programmed_load_block(
  target_date date, gate_profile text
) RETURNS SETOF feature_programmed_load_hour LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  day_from timestamptz := target_date::timestamp AT TIME ZONE 'America/Sao_Paulo';
  day_to timestamptz := (target_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';
BEGIN
  PERFORM feature_apply_gate(target_date, gate_profile);

  RETURN QUERY
  WITH profile AS (
    SELECT p.subsystem, p.valid_time, p.programmed_load_mwh
    FROM canonical_programmed_load p
    WHERE p.valid_time >= day_from AND p.valid_time < day_to
  ),
  -- Everything the profile can say about itself, in one pass. `rank()` orders
  -- ascending, so rank 1 is the day's trough and rank 24 its peak — the same
  -- direction as `programmed_load_daily_min_mwh` beside it, which is the only
  -- reason to prefer one direction over the other.
  shaped AS (
    SELECT
      profile.subsystem,
      profile.valid_time,
      profile.programmed_load_mwh,
      lag(profile.programmed_load_mwh) OVER hourly AS previous_mwh,
      lag(profile.valid_time) OVER hourly AS previous_hour,
      lead(profile.programmed_load_mwh) OVER hourly AS next_mwh,
      lead(profile.valid_time) OVER hourly AS next_hour,
      min(profile.programmed_load_mwh) OVER whole_day AS day_min_mwh,
      rank() OVER (PARTITION BY profile.subsystem
                   ORDER BY profile.programmed_load_mwh)::int AS rank_in_day,
      count(*) OVER whole_day AS hours_in_day
    FROM profile
    WINDOW hourly AS (PARTITION BY profile.subsystem ORDER BY profile.valid_time),
           whole_day AS (PARTITION BY profile.subsystem)
  )
  SELECT
    shaped.subsystem,
    shaped.valid_time,
    shaped.programmed_load_mwh,
    -- The adjacency check is the point. A neighbouring *row* is not a
    -- neighbouring *hour* once the profile has a gap, and a `_ramp_1h` that
    -- quietly spanned two hours would be wrong in precisely the rows where
    -- nobody would look.
    CASE
      WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
      THEN shaped.programmed_load_mwh - shaped.previous_mwh
    END,
    CASE
      WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
       AND shaped.next_hour = shaped.valid_time + interval '1 hour'
      THEN (shaped.previous_mwh + shaped.programmed_load_mwh + shaped.next_mwh) / 3.0
    END,
    CASE WHEN shaped.hours_in_day = 24 THEN shaped.day_min_mwh END,
    CASE WHEN shaped.hours_in_day = 24 THEN shaped.rank_in_day END
  FROM shaped
  ORDER BY shaped.valid_time, shaped.subsystem;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_programmed_load_block(date, text) IS
  'Class P: ONS day-ahead programming for the subsystem-hour, cut on published_at <= gate. Ramps and centred windows are legal here because a D-1 programme publishes the whole of day D at once; both are NULL at the edges of that day rather than reaching into a neighbouring publication, and both check that the adjacent row is the adjacent hour.';
--> statement-breakpoint

-- Five columns onto the one declaration, appended.
--
-- `ALTER TYPE ... ADD ATTRIBUTE` appends, so migration order *is* attribute
-- order and this block lands after the class-`K` block of `0021`.
-- `docs/specs/forecaster.md` hashes the type's ordered names into a lane's
-- `feature_hash`, which is exactly the visible event that hash exists to make.
ALTER TYPE feature_row ADD ATTRIBUTE programmed_load_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE programmed_load_ramp_1h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE programmed_load_mean_3h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE programmed_load_daily_min_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE programmed_load_rank_in_day integer;--> statement-breakpoint

-- The catalogue copy of the caveats, at the column itself. A caveat a modeller
-- cannot find from the column is a caveat nobody applies.
COMMENT ON COLUMN feature_row.programmed_load_mwh IS
  'ONS day-ahead programmed load for the subsystem-hour, from carga-energia-programada, cut on published_at <= gate. The publication instant is decided at the adapter (programmePublishedAt in ingest/ons/load.ts): D-1 15:00 BRT, the DESSEM-anchored upper bound. It clears gate_late by four hours and does not clear gate_early, where every programmed column is NULL.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.programmed_load_ramp_1h IS
  'Difference within the day-D programmed profile. Legal because a D-1 programme publishes the whole of day D at once. NULL at the first hour of the local day, whose predecessor belongs to a different publication, and NULL wherever the previous row is not the previous hour.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.programmed_load_mean_3h IS
  'Mean of the programmed profile over the target hour and its two neighbours, centred. NULL at both edges of the local day rather than averaged over two of three: the D+1 programme is published after both gates, and a partial centred window is a different statistic under the same name.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.programmed_load_daily_min_mwh IS
  'Minimum of the 24 programmed hours of the target date. Day grain: constant across the 24 hours of the day, and not an hourly signal. NULL unless the profile has all 24 hours, because a minimum over a partial day is the minimum of a different day.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.programmed_load_rank_in_day IS
  'Rank of the target hour among the 24 programmed loads of its day, ascending: 1 is the days trough and 24 its peak, matching the direction of programmed_load_daily_min_mwh. NULL unless the profile has all 24 hours.';
--> statement-breakpoint

-- `feature_rows(...)` again — the same function, one more join.
--
-- Restated in full because a function body cannot be patched, and restated from
-- `0021`'s definition rather than from `0016`'s: `ALTER TYPE ... ADD ATTRIBUTE`
-- appends, so migration order *is* attribute order, and a restatement that
-- rebuilt the select list from an older copy would emit the columns in an order
-- Postgres reports as "returned type X does not match expected type Y in column
-- N" — if it is lucky, and as two silently swapped columns if it is not. Every
-- prior block's columns are in their existing positions and the five new ones
-- are last.
--
-- The spine is untouched: the signature still holds no instant of any kind, the
-- gate is still resolved per target date inside the loop, and the new block is
-- joined exactly as weather, capacity, calendar and the class-`K` block already
-- were. It is not a second place a cutoff could enter, because it has no
-- argument that could carry one.
--
-- The fidelity stamp gains one source. The programme now feeds features, so its
-- go-live joins the weakest-link rule: a row whose spine had to be answered
-- from a series WattSteer was not yet watching is `revision_optimistic` as a
-- whole, because a consumer cannot use half of it.
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
  -- Structural, not a rule: the DESSEM file for day D is created on the evening
  -- of D-1, so at 09:00 on D-1 the newest one describes D-1 itself.
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
      -- two observation series the class-`K` block reads, and the day-ahead
      -- programme the class-`P` block reads.
      CASE
        WHEN feature_vintage_fidelity(spine.valid_time, weather_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, label_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, capacity_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, context_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, exchange_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, programmed_go_live) = 'point_in_time'
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
      programmed.programmed_load_rank_in_day
    FROM spine
    LEFT JOIN weather ON weather.valid_time = spine.valid_time
    LEFT JOIN capacity ON capacity.subsystem = spine.subsystem
    LEFT JOIN calendar ON calendar.valid_time = spine.valid_time
    LEFT JOIN shares ON shares.subsystem = spine.subsystem
    LEFT JOIN lagged
      ON lagged.subsystem = spine.subsystem
     AND lagged.valid_time = spine.valid_time
    LEFT JOIN programmed
      ON programmed.subsystem = spine.subsystem
     AND programmed.valid_time = spine.valid_time
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
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. Capacity is a double as-of: valid time D, vintage the gate. The calendar and astronomy block is class T and reads no vintage at all. The class K block is cut on valid_time <= actuals_cutoff(gate, dataset), which is the only cut an observation-sourced feature may rely on. The class P block is ONS day-ahead programming, cut on publication like every other forecast.';

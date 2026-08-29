-- Installed capacity, joined across a changing fleet — the double as-of.
--
-- Hand-written for the reason `0012_canonical_read_axes.sql` and
-- `0016_the_feature_gate.sql` are: drizzle-kit generates tables and views, not
-- function DDL, and this migration is functions and one composite type.
--
-- ## The one idea
--
-- `InstalledCapacityAsOf(scope, technology, t)` is a function and never a
-- column (`docs/domain-model.md` §"Installed capacity"), and here it is a
-- **double as-of**:
--
--   * the **valid-time** argument is the target date **D** — which units
--     existed on the day being described;
--   * the **vintage** is the **gate** — what ONS had recorded by D−1 19:00.
--
-- Both are load-bearing and they fail differently:
--
--   * Without the valid-time as-of, today's fleet leaks into 2024 features.
--     `docs/research/plant-registry.md` §5 measured 25.8% of curtailed-fleet MW
--     as not existing when the window opens, and the SE-solar capacity centroid
--     as moving 94 km across it. A feature built from today's fleet is a
--     present-tense number wearing a historical row's timestamp, and no
--     downstream test would see it: it is smooth, plausible and wrong.
--   * Without the vintage as-of, a unit whose commissioning ONS *records* after
--     the gate enters a feature that could not have known about it. That one is
--     a genuine leak of the future into the past.
--
-- The vintage as-of makes these features slightly conservative — a unit
-- entering service on day D is not counted at D−1, because at the gate ONS had
-- not yet said so. That is correct behaviour and not an error to patch: the
-- model is being told what was knowable, not what turned out to be true.
--
-- ## The gate is still derived, never passed
--
-- Ticket 01's wall stands. Nothing here accepts an instant. The one new axis
-- writer, `feature_apply_gate_for_fleet_offset`, takes a target date, a profile
-- and a **number of days back**; it derives the gate from the target date with
-- `gate_at(...)` exactly as `feature_apply_gate` does, and the only thing the
-- offset can move is the *valid-time* axis. There is no argument through which
-- a caller could hand it a different vintage, which is why the 28-day window
-- cannot silently become a second cut-off.
--
-- ## Day grain, and why it is marked
--
-- Capacity is a fact about a **day**, broadcast identically across the 24 hours
-- of D. The four columns are commented as day grain in the catalogue itself so
-- that the marking travels with the column rather than living only in a
-- document: a column constant within a day must not be read as an hourly
-- signal, and a modeller who cannot see that from the row will eventually build
-- a ramp out of it.
--
-- ## Two caveats that travel with the number
--
-- **Over the backfill window capacity is `revision_optimistic`.** Registry
-- snapshots begin at ingestion go-live; a target date before it can only be
-- answered from ONS's current cut of the past, so the row cannot claim to be
-- point-in-time. `feature_rows` therefore folds `installed-capacity`'s go-live
-- into the fidelity stamp on the weakest-link rule already established there.
-- The fidelity axis for capacity is the **fleet date** and not the vintage,
-- which is `readInstalledCapacityAsOf`'s reasoning unchanged.
--
-- **Decommissioning is asserted, not modelled.** ONS records zero VRE
-- deactivations on or after the window opens across 3,380 units, so the
-- weighting treats deactivation as impossible in the modelled period and
-- nothing is estimated for an error that is currently exactly 0 MW. The alert
-- for the day that stops being true already exists one layer down and fires at
-- ingest rather than here: `findRenewableDeactivations` in
-- `src/ingest/ons/plant-registry.ts` refuses a snapshot that records a
-- within-window VRE deactivation unless an operator explicitly allows it. A
-- second check inside the feature layer would be a second definition of the
-- same assumption — and the useful moment to notice is when the byte arrives,
-- not when a model is trained months later.

-- The capacity read's axes: the gate as vintage, D−`days_back` as fleet date.
--
-- The second axis writer in the feature layer, and the shape is deliberate.
-- `feature_apply_gate` writes fleet date = target date, which is right for the
-- level; the 28-day addition needs the fleet **as it was four weeks earlier, at
-- the same vintage**, and there is no way to express that by calling
-- `feature_apply_gate` twice — `feature_apply_gate(D − 28, ...)` would move the
-- gate too, and the difference of two vintages is not an addition, it is two
-- questions subtracted.
--
-- Only a whole number of days can be handed in, and it is subtracted from the
-- target date here. So the valid-time axis remains a function of the target
-- date, the vintage axis remains `gate_at(target_date, gate_profile)`, and
-- neither can be chosen by a caller.
--
-- Every axis is written on every call, absent ones as the empty string, for
-- `contract/scope.ts`'s reason: the settings live on a pooled connection, and a
-- block that wrote only the axes it cared about would inherit the previous
-- block's.
CREATE OR REPLACE FUNCTION feature_apply_gate_for_fleet_offset(
  target_date date, gate_profile text, days_back int
) RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  gate timestamptz := gate_at(target_date, gate_profile);
  fleet_date date;
BEGIN
  IF days_back IS NULL OR days_back < 0 THEN
    RAISE EXCEPTION 'days_back must be a non-negative number of days: the fleet axis only ever looks backwards from the target date'
      USING ERRCODE = '22023';
  END IF;
  fleet_date := target_date - days_back;

  PERFORM set_config('wattsteer.as_of', gate::text, true),
          set_config('wattsteer.fleet_date', fleet_date::text, true),
          set_config('wattsteer.published_at_or_before', gate::text, true),
          set_config('wattsteer.weather_run_cycle', '', true);
  RETURN gate;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_apply_gate_for_fleet_offset(date, text, int) IS
  'The feature-side axes with the fleet date moved back a whole number of days from the target date. The vintage stays gate_at(target_date, gate_profile): the trailing window is a second valid time, never a second cut-off.';
--> statement-breakpoint

-- One (subsystem, technology) scope of the fleet, at one pair of axes.
--
-- A composite rather than a temp table because the block reads the same view
-- twice under two different fleet dates, and the two reads must not be able to
-- interleave. Materialising the first into an array before the second axis is
-- written is what makes that structural rather than a hope about the planner.
CREATE TYPE feature_capacity_scope AS (
  subsystem subsystem_code,
  technology technology,
  capacity_mw double precision
);
--> statement-breakpoint

-- Capacity for the day, per subsystem: the level and the four-week addition.
CREATE TYPE feature_capacity_day AS (
  subsystem subsystem_code,
  capacity_wind_mw double precision,
  capacity_solar_mw double precision,
  capacity_wind_added_28d_mw double precision,
  capacity_solar_added_28d_mw double precision
);
--> statement-breakpoint

-- The capacity block — class `T`, day grain.
--
-- Two reads of `canonical_installed_capacity`, at one vintage and two valid
-- times, subtracted. Both reads go through the view: no ingest table name
-- appears here, so the commissioning interval, the latest-version pick and the
-- `ceg_core` join are ONS conventions this file cannot reimplement differently
-- from the contract.
--
-- **Absent is zero, but only once the fleet is known at all.** A subsystem with
-- no live units of a technology on D produces no row in the view, and 0 MW is
-- the honest reading — the registry covers the whole VRE fleet, so "no group"
-- means "nothing was commissioned yet". If the *whole* read comes back empty,
-- though, nothing is known rather than nothing exists: at a gate before the
-- registry's first ingest there is no snapshot to answer from, and the column
-- is NULL. That is the same distinction the label block draws between "no
-- curtailment was reported" and "this hour has not been settled".
CREATE OR REPLACE FUNCTION feature_capacity_block(target_date date, gate_profile text)
  RETURNS SETOF feature_capacity_day LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  at_target feature_capacity_scope[];
  at_minus_28 feature_capacity_scope[];
BEGIN
  -- The level: the fleet on D, as recorded at the gate.
  PERFORM feature_apply_gate(target_date, gate_profile);
  SELECT coalesce(
           array_agg(ROW(c.subsystem, c.technology, c.capacity_mw)::feature_capacity_scope),
           '{}'::feature_capacity_scope[])
    INTO at_target
  FROM canonical_installed_capacity c;

  -- The baseline: the fleet on D−28, at the **same** vintage. Same gate, other
  -- valid time — which is what makes the difference an addition rather than a
  -- comparison of two vintages.
  PERFORM feature_apply_gate_for_fleet_offset(target_date, gate_profile, 28);
  SELECT coalesce(
           array_agg(ROW(c.subsystem, c.technology, c.capacity_mw)::feature_capacity_scope),
           '{}'::feature_capacity_scope[])
    INTO at_minus_28
  FROM canonical_installed_capacity c;

  IF coalesce(array_length(at_target, 1), 0) = 0 THEN
    -- Nothing was knowable about the fleet at this gate. Four nulls, and not
    -- four zeroes: a zero here would tell a model the fleet did not exist.
    RETURN QUERY
      SELECT s.subsystem, NULL::double precision, NULL::double precision,
             NULL::double precision, NULL::double precision
      FROM unnest(enum_range(NULL::subsystem_code)) AS s(subsystem);
    RETURN;
  END IF;

  RETURN QUERY
  SELECT s.subsystem,
         now_mw.wind,
         now_mw.solar,
         now_mw.wind - then_mw.wind,
         now_mw.solar - then_mw.solar
  FROM unnest(enum_range(NULL::subsystem_code)) AS s(subsystem)
  CROSS JOIN LATERAL (
    SELECT
      coalesce(sum(a.capacity_mw) FILTER (WHERE a.technology = 'WIND'), 0) AS wind,
      coalesce(sum(a.capacity_mw) FILTER (WHERE a.technology = 'SOLAR'), 0) AS solar
    FROM unnest(at_target) AS a
    WHERE a.subsystem = s.subsystem
  ) now_mw
  CROSS JOIN LATERAL (
    SELECT
      coalesce(sum(b.capacity_mw) FILTER (WHERE b.technology = 'WIND'), 0) AS wind,
      coalesce(sum(b.capacity_mw) FILTER (WHERE b.technology = 'SOLAR'), 0) AS solar
    FROM unnest(at_minus_28) AS b
    WHERE b.subsystem = s.subsystem
  ) then_mw;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_capacity_block(date, text) IS
  'Installed wind and solar capacity per subsystem for the target date, read at the gates vintage, with the 28-day addition derived from the same double as-of. Day grain: one value per subsystem per day, broadcast across the 24 hours by feature_rows.';
--> statement-breakpoint

-- Four columns onto the one declaration, as `0016` said they would be added.
--
-- `ALTER TYPE ... ADD ATTRIBUTE` appends, so the capacity block lands after the
-- labels in ordinal position. That is cosmetic and the alternative is not:
-- rewriting the type would break every function returning it, and the ordered
-- names are what `docs/specs/forecaster.md` hashes into a lane's
-- `feature_hash`, so appending is also the change that is *visible* in the hash
-- rather than silently reshuffling it.
ALTER TYPE feature_row ADD ATTRIBUTE capacity_wind_mw double precision;
--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE capacity_solar_mw double precision;
--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE capacity_wind_added_28d_mw double precision;
--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE capacity_solar_added_28d_mw double precision;
--> statement-breakpoint

-- The feature dictionary's day-grain marking, in the catalogue.
--
-- `docs/specs/feature-engineering.md` marks these day grain and so does
-- `FEATURE_COLUMN_GRAIN` in `src/features/feature-rows.ts`; this is the copy
-- that travels with the column itself, so `\d+ feature_row` says it too. The
-- `revision_optimistic` reason is stated here rather than only in the spec for
-- the same reason: a caveat nobody can find from the number is a caveat nobody
-- applies.
COMMENT ON COLUMN feature_row.capacity_wind_mw IS
  'InstalledCapacityAsOf(subsystem, WIND, target_date) read at the gate. Day grain: constant across the 24 hours of the day, and not an hourly signal. revision_optimistic before the registry go-live, because a registry snapshot is todays record of the past.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.capacity_solar_mw IS
  'InstalledCapacityAsOf(subsystem, SOLAR, target_date) read at the gate. Day grain: constant across the 24 hours of the day, and not an hourly signal. revision_optimistic before the registry go-live, because a registry snapshot is todays record of the past.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.capacity_wind_added_28d_mw IS
  'capacity_wind_mw(D) - capacity_wind_mw(D-28), both at the gates vintage. Day grain. Zero deactivations are asserted rather than modelled, so this is an addition and not a net change.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.capacity_solar_added_28d_mw IS
  'capacity_solar_mw(D) - capacity_solar_mw(D-28), both at the gates vintage. Day grain. Zero deactivations are asserted rather than modelled, so this is an addition and not a net change.';
--> statement-breakpoint

-- `feature_rows(...)` — re-created, not re-decided.
--
-- Everything about the entry point is `0016`'s and is restated here only
-- because a composite type that gained attributes needs the function that
-- returns it rebuilt. The signature is unchanged and still holds no instant of
-- any kind; the gate is still resolved per target date inside the loop; the
-- capacity block is a third `MATERIALIZED` CTE alongside weather and labels,
-- for the same reason those two are — each block writes every axis at its own
-- start, so the vintages cannot interleave whichever order the planner picks.
--
-- The one substantive change beyond the join is the fidelity stamp, which now
-- also weakest-links `installed-capacity`. A row whose capacity had to be
-- answered from a registry snapshot taken after the fact is
-- `revision_optimistic` as a whole, because a consumer cannot use half of it.
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
      -- backfill window the registry answers from today's snapshot.
      CASE
        WHEN feature_vintage_fidelity(spine.valid_time, weather_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, label_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, capacity_go_live) = 'point_in_time'
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
      capacity.capacity_solar_added_28d_mw
    FROM spine
    LEFT JOIN weather ON weather.valid_time = spine.valid_time
    LEFT JOIN capacity ON capacity.subsystem = spine.subsystem
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
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. Capacity is a double as-of: valid time D, vintage the gate.';

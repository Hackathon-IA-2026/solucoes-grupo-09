-- Residual load, rebuilt for the DESSEM-free set — class `P`+`W`+`T`.
--
-- Hand-written, like `0012_canonical_read_axes.sql`, `0016_the_feature_gate.sql`,
-- `0017_capacity_at_the_gate.sql`, `0019_calendar_and_astronomy.sql`,
-- `0021_lagged_actuals_behind_the_cutoff.sql`, `0024_day_ahead_programming.sql`,
-- `0025_dessem_and_the_feature_set.sql` and `0029_the_weather_block.sql`, and
-- for the same reason: drizzle-kit generates tables and views, not function
-- DDL. This file reads **no view at all**, which is the one thing about it
-- worth noticing first.
--
-- ## What this feature is, and what it is not
--
-- `docs/IDEA.md` §5 asked for `residual_load = load − solar − wind` at the
-- target hour. Every term of that is a day-D **actual**, and the product
-- forecasts at D−1: the original is a *description* of the oversupply
-- condition after the fact, and it cannot be a day-ahead feature at any gate.
--
-- Neither leaking it nor dropping it is the right move. It is rebuilt from
-- terms that genuinely exist at D−1:
--
--   * `programmed_load_mwh` — ONS's own day-ahead load programme, class `P`;
--   * `weather_expected_wind_mwh` and `weather_expected_solar_mwh` — the two
--     deterministic conversions of the pinned D−1 weather run against the fleet
--     read at the gate's vintage, class `W`+`T`.
--
-- **No term is an actual and no term is a model.** Both conversions were fixed
-- by ticket 08 — a generic IEC power curve and an STC-referenced irradiance
-- ratio, neither of them fitted to anything — so the reconstruction is
-- identical in training and in serving by construction rather than by care, and
-- nothing here puts a model inside a model.
--
-- The consequence is that this column means something different from the one it
-- replaces, and the difference is the point: a residual load built from a
-- day-ahead programme and a pinned run is a **forecast** of the oversupply
-- condition. A day-ahead product should be conditioning on the forecast rather
-- than on the description.
--
-- ## It composes two blocks rather than re-reading their sources
--
-- The block calls `feature_programmed_load_block` and `feature_weather_block`.
-- It could have re-read `canonical_programmed_load` and re-derived the two
-- conversions from `canonical_weather_forecast` and `canonical_capacity_weight`
-- in a third place; it must not, and the reason is the same one `0025` and
-- `0029` give for calling `feature_capacity_block` rather than re-reading the
-- registry. There is one definition of "the programme at the gate" and one
-- definition of "the expected generation at the gate", so
-- `proxy_residual_load_mwh` and the three columns it is built from cannot
-- disagree **inside a single row**. The arithmetic identity
-- `proxy_residual_load_mwh = programmed_load_mwh − weather_expected_wind_mwh −
-- weather_expected_solar_mwh` holds across the row by construction, and
-- `database-features.test.ts` asserts it row by row rather than trusting it.
--
-- The cost is a second evaluation of each block per target date. That is the
-- same trade `0025` and `0029` already took, and it buys the same thing.
--
-- **The two calls are materialised into arrays before anything is composed**,
-- for the reason the fleet is in the two blocks above: each of them writes all
-- four read axes at its own start, and evaluating two axis-writing functions as
-- CTEs of one query would leave which axes were in force during which read to
-- the planner. Read whole, one after the other, each answers under its own
-- gate — which is the same gate, derived twice from the same target date.
--
-- This block writes no axis of its own and reads no view, which is precisely
-- why it can be composed at all: there is no vintage here to inherit or
-- disturb. It is the same property `feature_calendar_block` has, arrived at
-- from the other end.
--
-- ## Every term, or nothing
--
-- All three terms are required. A missing one is a NULL row and never a zero,
-- and that is the rule `0025` states at the capacity factors: "the fleet is
-- unknown at this gate" and "the fleet generated nothing" are different
-- statements and only one of them is a number. A subsystem the registry places
-- no VRE in at the gate therefore carries no proxy residual load — not
-- `programmed_load` with two zeroes subtracted from it, which would be a load
-- forecast wearing a residual load's name in exactly the rows where the fleet
-- read had failed.
--
-- ## The profile is the calendar day, because the narrower parent decides
--
-- `0029` widened the weather read by three hours on each side: a run is not a
-- day file, so a difference across midnight is a shape inside one publication
-- and is legal. The programme *is* a day file, and `0024`'s ramp is NULL at the
-- first hour of D for that reason. The proxy profile is the intersection of the
-- two, so it is the calendar day and the ramp is NULL at the first hour of D —
-- the class-`P` edge, inherited, because a proxy residual load at 23:00 on D−1
-- would need a programmed load from D−1's own publication.
--
-- The adjacency check is here for the same reason it is in the three blocks
-- above: a neighbouring *row* is not a neighbouring *hour* once the profile has
-- a gap, and a `_ramp_1h` that quietly spanned two hours would be wrong in
-- precisely the rows where a term was already missing.
--
-- ## What these columns do at `gate_early`, stated rather than discovered
--
-- **They are NULL, all seven of them, at every hour of every target date.**
-- `gate_early` is D−1 09:00 BRT and the programme for day D is stamped
-- D−1 15:00 BRT — the DESSEM-anchored upper bound decided at the adapter in
-- `programmePublishedAt` (`src/ingest/ons/load.ts`) and measured by ticket 06 —
-- so `programmed_load_mwh` is NULL there, and a subtraction from NULL is NULL.
--
-- That is inherited, not introduced, and it is not repaired here. Reaching for
-- an earlier publication hour, or falling back to a load forecast of our own,
-- would make the column non-null at 09:00 by asserting an availability nothing
-- has measured — which is the exact leak this spec exists to prevent, because a
-- model trained on a value it will not have at 09:00 cannot be served. The hole
-- is visible, `database-features.test.ts` asserts it, and closing it needs the
-- measurement issue 12 owns rather than a fallback.
--
-- So: `dessem_free_v1` has its spine, and this — its most important feature —
-- at `gate_late` across the full coverage of the programme, and has neither at
-- `gate_early`.
--
-- ## Both views of residual load are kept in the augmented set
--
-- Nothing here is conditioned on the feature set. `dessem_augmented_v1` carries
-- the `proxy_*` family **and** the `dessem_*` family, so the forecast of the
-- oversupply condition and DESSEM's own statement of it sit in the same row and
-- can be compared — which is what makes the A/B a comparison of two views
-- rather than of two disjoint sets. `docs/specs/feature-engineering.md`'s set
-- table names `proxy_residual_load_mwh` and `dessem_residual_load_mwh` as each
-- set's residual load *of record*; it does not remove the proxy from set B, and
-- it defines set B as set A plus the `dessem_*` block.

-- The proxy profile for one target date, at (subsystem, hour).
--
-- Seven columns: the reconstruction, the three quantities derived from the same
-- three terms by identity, the ramp inside the day-D profile and the two
-- day-grain summaries of it.
CREATE TYPE feature_proxy_residual_hour AS (
  subsystem subsystem_code,
  valid_time timestamptz,
  proxy_residual_load_mwh double precision,
  proxy_residual_load_ratio double precision,
  proxy_renewable_load_ratio double precision,
  proxy_vre_surplus_mwh double precision,
  proxy_residual_load_ramp_1h double precision,
  proxy_residual_load_min_of_day double precision,
  proxy_residual_load_rank_in_day integer
);
--> statement-breakpoint

-- The class-`P`+`W`+`T` block.
--
-- A target date and a gate profile and **no instant**, exactly as every block
-- since `0016` has. It resolves nothing itself: the two blocks it composes each
-- derive the gate from the target date, so there is not even an argument here
-- through which a hand-chosen one could arrive.
CREATE OR REPLACE FUNCTION feature_proxy_residual_load_block(
  target_date date, gate_profile text
) RETURNS SETOF feature_proxy_residual_hour LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  programme feature_programmed_load_hour[];
  expected feature_weather_hour[];
BEGIN
  -- Whole, one after the other, before anything is composed. Each writes all
  -- four axes at its own start; neither may be evaluated inside the other's.
  SELECT coalesce(array_agg(p), '{}'::feature_programmed_load_hour[])
    INTO programme
  FROM feature_programmed_load_block(target_date, gate_profile) p;

  SELECT coalesce(array_agg(w), '{}'::feature_weather_hour[])
    INTO expected
  FROM feature_weather_block(target_date, gate_profile) w;

  RETURN QUERY
  -- The three terms, joined at (subsystem, hour), and the two identities named
  -- once so that everything below reads them rather than respelling them.
  --
  -- An inner join and three NOT NULLs: every column of this block is a function
  -- of all three terms, so an hour missing one of them has nothing to say and
  -- says nothing. Emitting the hour with a NULL residual load would also put a
  -- hole in the middle of the profile that the window functions below would
  -- have to be taught to ignore; dropping it lets the adjacency check see the
  -- gap for what it is.
  WITH terms AS (
    SELECT
      p.subsystem,
      p.valid_time,
      p.programmed_load_mwh,
      w.weather_expected_wind_mwh + w.weather_expected_solar_mwh AS expected_vre_mwh,
      p.programmed_load_mwh - w.weather_expected_wind_mwh
        - w.weather_expected_solar_mwh AS residual_load_mwh
    FROM unnest(programme) AS p
    JOIN unnest(expected) AS w
      ON w.subsystem = p.subsystem
     AND w.valid_time = p.valid_time
    WHERE p.programmed_load_mwh IS NOT NULL
      AND w.weather_expected_wind_mwh IS NOT NULL
      AND w.weather_expected_solar_mwh IS NOT NULL
  ),
  -- Everything the profile can say about itself, in one pass — the same shape
  -- as `0024`'s and `0025`'s. `rank()` orders ascending, so rank 1 is the day's
  -- proxy-residual trough and rank 24 its peak: the same direction as
  -- `proxy_residual_load_min_of_day` beside it, which is the only reason to
  -- prefer one direction over the other.
  shaped AS (
    SELECT
      terms.*,
      lag(terms.valid_time) OVER hourly AS previous_hour,
      lag(terms.residual_load_mwh) OVER hourly AS previous_residual,
      min(terms.residual_load_mwh) OVER whole_day AS day_min_residual,
      rank() OVER (PARTITION BY terms.subsystem
                   ORDER BY terms.residual_load_mwh)::int AS rank_in_day,
      count(*) OVER whole_day AS hours_in_day
    FROM terms
    WINDOW hourly AS (PARTITION BY terms.subsystem ORDER BY terms.valid_time),
           whole_day AS (PARTITION BY terms.subsystem)
  )
  SELECT
    shaped.subsystem,
    shaped.valid_time,
    shaped.residual_load_mwh,
    -- Two ratios over the programmed load, and one difference. A zero
    -- programmed load is NULL rather than a division error or an infinity: ONS
    -- has never programmed one, and if it ever does the honest answer is that
    -- the ratio is undefined for that hour. The surplus needs no such guard,
    -- which is why it is the term to reach for when the load is small.
    CASE WHEN shaped.programmed_load_mwh <> 0
         THEN shaped.residual_load_mwh / shaped.programmed_load_mwh END,
    CASE WHEN shaped.programmed_load_mwh <> 0
         THEN shaped.expected_vre_mwh / shaped.programmed_load_mwh END,
    shaped.expected_vre_mwh - shaped.programmed_load_mwh,
    -- The ramp, inside the day-D proxy profile. NULL at the first hour of the
    -- local day: the hour before it needs a programmed load from D−1's own
    -- publication, and a difference across that boundary is a difference of two
    -- programmes rather than a shape inside one.
    CASE
      WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
      THEN shaped.residual_load_mwh - shaped.previous_residual
    END,
    -- The day-grain pair, NULL unless the profile has all 24 hours: a minimum
    -- over nineteen is the minimum of a different day, and a rank among
    -- nineteen is not the rank the column's name promises.
    CASE WHEN shaped.hours_in_day = 24 THEN shaped.day_min_residual END,
    CASE WHEN shaped.hours_in_day = 24 THEN shaped.rank_in_day END
  FROM shaped
  ORDER BY shaped.valid_time, shaped.subsystem;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_proxy_residual_load_block(date, text) IS
  'Class P+W+T: residual load rebuilt from the ONS day-ahead programme minus the two deterministic conversions of the pinned weather run against the fleet at the gate. No term is a day-D actual and no term is a model output. It composes feature_programmed_load_block and feature_weather_block rather than re-reading their sources, so the reconstruction cannot disagree with the columns beside it in the same row. Every column is NULL at gate_early, because the programme it subtracts from is.';
--> statement-breakpoint

-- Seven columns onto the one declaration, appended.
--
-- `ALTER TYPE ... ADD ATTRIBUTE` appends, so migration order *is* attribute
-- order and this block lands after the class-`W` block of `0029`.
-- `docs/specs/forecaster.md` hashes the type's ordered names into a lane's
-- `feature_hash`, which is exactly the visible event that hash exists to make.
ALTER TYPE feature_row ADD ATTRIBUTE proxy_residual_load_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE proxy_residual_load_ratio double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE proxy_renewable_load_ratio double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE proxy_vre_surplus_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE proxy_residual_load_ramp_1h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE proxy_residual_load_min_of_day double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE proxy_residual_load_rank_in_day integer;--> statement-breakpoint

-- The catalogue copy of the caveats, at the column itself — and here it carries
-- the **classification of every input**, which is the one thing a modeller
-- cannot recover from the number. A caveat a modeller cannot find from the
-- column is a caveat nobody applies.
COMMENT ON COLUMN feature_row.proxy_residual_load_mwh IS
  'Class P+W+T. programmed_load_mwh (class P, ONS day-ahead programming) minus weather_expected_wind_mwh minus weather_expected_solar_mwh (class W+T, the pinned D-1 run converted against the fleet read at the gate''s vintage). No input is a day-D actual and no input is a model output; both conversions are deterministic and fixed by drizzle/0029, so the reconstruction is identical in training and in serving. It is a forecast of the oversupply condition rather than a description of it, which is what a day-ahead product should condition on. NULL unless all three terms are present, and NULL at every hour of gate_early because the programme is.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.proxy_residual_load_ratio IS
  'Class P+W+T. proxy_residual_load_mwh / programmed_load_mwh, from the same three terms. NULL where the programmed load is zero: undefined is not a number, and an infinity in a feature column is a value a tree will happily split on.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.proxy_renewable_load_ratio IS
  'Class P+W+T. (weather_expected_wind_mwh + weather_expected_solar_mwh) / programmed_load_mwh, from the same three terms. The renewable penetration the day-ahead inputs imply, and one minus proxy_residual_load_ratio by construction.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.proxy_vre_surplus_mwh IS
  'Class P+W+T. (weather_expected_wind_mwh + weather_expected_solar_mwh) - programmed_load_mwh, the negative of proxy_residual_load_mwh and the term to read when the programmed load is small enough to make the two ratios unstable.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.proxy_residual_load_ramp_1h IS
  'Class P+W+T. Difference within the day-D proxy profile. Legal because both parents publish the whole of day D before the gate. NULL at the first hour of the local day, whose predecessor needs a programmed load from D-1''s own publication, and NULL wherever the previous row is not the previous hour.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.proxy_residual_load_min_of_day IS
  'Class P+W+T. Minimum of the 24 reconstructed hours of the target date - the deepest the oversupply condition is forecast to go. Day grain: constant across the 24 hours of the day, and not an hourly signal. NULL unless all 24 hours reconstructed, because a minimum over a partial day is the minimum of a different day.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.proxy_residual_load_rank_in_day IS
  'Class P+W+T. Rank of the target hour among the 24 reconstructed residual loads of its day, ascending: 1 is the day''s trough and 24 its peak, matching the direction of proxy_residual_load_min_of_day. NULL unless all 24 hours reconstructed.';
--> statement-breakpoint

-- `feature_rows(...)` again — the same function, one wider join.
--
-- Restated in full because a function body cannot be patched, and restated from
-- `0029`'s definition rather than from an older copy: `ALTER TYPE ... ADD
-- ATTRIBUTE` appends, so migration order *is* attribute order, and a
-- restatement that rebuilt the select list from `0025` would emit the columns
-- in an order Postgres reports as "returned type X does not match expected type
-- Y in column N" — if it is lucky, and as two silently swapped columns if it is
-- not. Every prior block's columns are in their existing positions and the
-- seven new ones are last.
--
-- The spine is untouched: the signature still holds no instant of any kind, and
-- the gate is still resolved per target date inside the loop. The new CTE is
-- not handed the feature set, because both sets carry these columns — the
-- augmented set holds the proxy family and the DESSEM family side by side, so
-- the two views of residual load are comparable.
--
-- The fidelity stamp gains no source, and that is a property rather than an
-- omission: this block reads no source of its own, so every go-live behind it —
-- the programme's, the weather's and the registry's — is already in the
-- weakest-link rule below.
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
    ),
    -- Class `P`+`W`+`T`. The one block that reads no source: it composes the
    -- class-`P` and class-`W` blocks above rather than re-reading what they
    -- read, so the reconstruction and the terms it is built from are the same
    -- numbers in the same row. It is not handed the feature set, because both
    -- sets carry it — set B holds this family beside the DESSEM one so the two
    -- views of residual load are comparable.
    proxy AS MATERIALIZED (
      SELECT * FROM feature_proxy_residual_load_block(d, gate_profile)
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
      weather.weather_centroid_coverage,
      proxy.proxy_residual_load_mwh,
      proxy.proxy_residual_load_ratio,
      proxy.proxy_renewable_load_ratio,
      proxy.proxy_vre_surplus_mwh,
      proxy.proxy_residual_load_ramp_1h,
      proxy.proxy_residual_load_min_of_day,
      proxy.proxy_residual_load_rank_in_day
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
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. Capacity is a double as-of: valid time D, vintage the gate. The class W block is the twelve pinned weather variables capacity-weighted over the frozen centroids, per subsystem, with the weights recomputed per target date. The calendar and astronomy block is class T and reads no vintage at all. The class K block is cut on valid_time <= actuals_cutoff(gate, dataset), which is the only cut an observation-sourced feature may rely on. The class P block is ONS day-ahead programming, cut on publication like every other forecast. The class D block is the DESSEM balance: it exists only for dessem_augmented_v1 and only at gate_late, and for dessem_free_v1 it returns no rows at all, so a set-A row carries no DESSEM-sourced value at either gate. The proxy block is class P+W+T: it composes the class P and class W blocks rather than reading a source of its own, it is in both feature sets so the two views of residual load are comparable, and it is NULL at gate_early because the programme it subtracts from is.';

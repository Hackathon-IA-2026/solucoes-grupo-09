-- The feature-side `as_of`, over a backfill — the sentence `0016` got backwards.
--
-- Hand-written, like `0012_canonical_read_axes.sql`, `0016_the_feature_gate.sql`
-- and every feature migration since, and for the same reason: drizzle-kit
-- generates tables and views, not function DDL.
--
-- ## The false sentence
--
-- `0016_the_feature_gate.sql` said, of the two instants `feature_apply_gate`
-- writes:
--
--   > `as_of` cuts on `ingested_at` — what WattSteer had learned — and over the
--   > backfill window every row was ingested at go-live, so it filters nothing.
--
-- It filters **everything**. `ingested_at` is the instant the backfill ran —
-- `src/ingest/versioned-write.ts` stamps `new Date()` — and the gate is a D−1
-- instant one to two years earlier, so `ingested_at <= canonical_as_of()` is
-- false for every backfilled row. Measured on a migrated database with weather
-- ingested in 2026:
--
--     select * from feature_weather_block('2024-04-10','gate_late')  ->  0 rows
--
-- Not even the coverage-0 spine rows `0029` promises, because
-- `canonical_capacity_weight` is read under the same axis and came back empty
-- too, so the block had no fleet to build a spine from. **Every historical
-- feature row was weatherless**, and so was every model trained on one.
--
-- ## What the two instants are actually for
--
-- They are not two spellings of one cut.
--
-- - `published_at_or_before` cuts on when the **source asserted** the value. For
--   a forecast that is the whole of the point-in-time claim: a weather row
--   carries its run initialisation, a DESSEM row its file creation, an ONS
--   programme row its D−1 publication hour, and `published_at <= gate` is
--   therefore *genuine* in backfill. It is also the cut ticket 01 had to add,
--   because `canonical_weather_forecast` had none and a `gate_late` feature was
--   reading a run three hours in its own future. **Nothing below touches it.**
-- - `as_of` cuts on when **WattSteer learned** the value. It guards against one
--   thing and one thing only: a row this repository re-ingested *after* the
--   gate — a restatement — being read back as though it had been on hand.
--
-- ## The decision: the ingestion cut binds only where there is an ingestion history
--
-- The question this migration had to answer is whether the ingestion cut should
-- apply at all over the backfill window. It should not, and the reason is that
-- over that window `ingested_at` carries no information to cut on. Before
-- WattSteer ran, it had learned nothing; the `ingested_at` on a backfilled row
-- is the loader's clock, and its ordering *within* a backfill is the order of a
-- loop rather than a record of knowledge. Cutting on it does not make the read
-- more point-in-time — it makes it empty, which is a strictly worse answer than
-- the honest one, because an empty column and a leaking column are both wrong
-- and only one of them says so.
--
-- The spec had already reached this conclusion for the observation half and
-- did not carry it back to the axis: §"Where the cut actually falls" says an
-- observation's D−1 availability has to be *enforced* on `valid_time` against a
-- publication lag, because no filter on either vintage axis will do it. What
-- follows is the same sentence, applied to the axis it was a sentence about.
--
-- Three other places in this tree repeat the claim — `0021`'s "the one idea,
-- and why `AsOf(gate)` is not it", `0031`'s estimator note, and the spec's
-- ticket-01 correction — and none of them is edited, because after this
-- migration each is **true**. Their conclusion never depended on the premise:
-- each says the ingestion axis is not what protects an observation or a
-- trailing estimator, and cuts on `valid_time` instead. `0016` was the only
-- file where the sentence had to be right, because `0016` is where the axis is
-- written.
--
-- So the cut is piecewise, and the seam is WattSteer's own ingestion history:
--
--     feature_as_of(D, profile) = gate                 when gate >= history_from
--                               = 'infinity'           otherwise
--
-- `'infinity'` is spelled out rather than dressed up as `now()`: over the
-- backfill window there is **no ingestion cut**, and a sentinel that says so is
-- better than one that looks like a vintage somebody chose.
--
-- Two things are unchanged by design, and each has a test:
--
-- 1. **No function here takes an instant.** `feature_as_of` takes a target date
--    and a profile and derives the gate itself, exactly as `feature_apply_gate`
--    and `actuals_cutoff` do. `feature_rows` still accepts no instant of any
--    kind, so train/serve skew is still unwritable. That is the property this
--    whole spine exists for, and it would have been cheaper — and wrong — to
--    buy the weather back with an `as_of` parameter.
-- 2. **The publication cut is untouched.** A `gate_late` feature still cannot
--    read a run published after its own gate, over a backfill or otherwise. The
--    relaxation below is on the ingestion axis alone.
--
-- ## Where `history_from` comes from, and what it costs
--
-- `feature_ingestion_history_from()` is the **latest** go-live across
-- `canonical_read_go_live` — the instant by which every canonical read had
-- begun ingesting something. The latest rather than the earliest, because a
-- source that had not started yet has an `ingested_at` that is still a backfill
-- artefact, and one session axis cannot carry a different floor per source.
--
-- That choice is loose in exactly one band: a gate between the first source's
-- go-live and the last one's relaxes the cut for sources that *were* already
-- live. The band is not left silent. `feature_rows` now stamps
-- **`revision_optimistic`** on any row whose gate precedes `history_from`, so
-- the invariant is exact and readable off the row:
--
--     vintage_fidelity = 'point_in_time'  =>  this row was built under
--                                             as_of = gate, unrelaxed.
--
-- A NULL horizon — no canonical read has ingested anything — falls to the
-- strict side. There is nothing to relax on an empty database, and failing
-- closed is `0012`'s posture.
--
-- **The memo.** `canonical_read_go_live` is nine `min(ingested_at)` aggregates
-- over nine ingest tables, none of which has an index leading on `ingested_at`.
-- `feature_apply_gate` is called once per block per target date, so a range
-- build would pay that scan thousands of times. The horizon is therefore
-- computed once and memoised in `wattsteer.feature_ingestion_history_from`,
-- transaction-locally, so it cannot outlive the build that computed it.
--
-- That setting is a **memo and not a read axis**, and the distinction is worth
-- stating because `features-gate.test.ts` guards the axes by asking which
-- functions write them: the four axes are still written in exactly four places,
-- all of which derive their instant, and the test now says that in those terms
-- rather than by counting `set_config` calls. `-infinity` is the memo's
-- spelling of "computed, and there is no horizon", so a NULL is cached once
-- rather than rescanned nine tables at a time.
--
-- ## What moves
--
-- `feature_hash` moves, and that is deliberate rather than incidental.
-- `docs/specs/forecaster.md` hashes the ordered feature names together with
-- `pg_get_functiondef(feature_rows)`, and the hot-swap gate refuses a bundle
-- whose hash disagrees with the live function. Every historical feature row
-- this fix repairs is a row every existing artifact was trained *without*, so
-- an artifact that kept serving across this migration would be a model fitted
-- on a weatherless vector, scored against rows that now carry weather. The
-- fidelity conjunct below is inside `feature_rows` for that reason as much as
-- for its own: it puts the change where the hash can see it. **Both lanes owe a
-- retrain.**

-- WattSteer's own ingestion history: the instant by which every canonical read
-- had begun. Memoised for the transaction, because the view behind it is nine
-- unindexed `min()` scans and this is asked once per block per target date.
CREATE OR REPLACE FUNCTION feature_ingestion_history_from()
  RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  memo text := nullif(current_setting('wattsteer.feature_ingestion_history_from', true), '');
  horizon timestamptz;
BEGIN
  IF memo IS NOT NULL THEN
    RETURN memo::timestamptz;
  END IF;

  SELECT max(g.go_live_at) INTO horizon FROM canonical_read_go_live g;
  -- A read that has ingested nothing contributes no rows to filter, so it does
  -- not move the horizon; a database where *nothing* has been ingested has no
  -- horizon at all, and `-infinity` puts that case on the strict side.
  horizon := coalesce(horizon, '-infinity'::timestamptz);

  PERFORM set_config('wattsteer.feature_ingestion_history_from', horizon::text, true);
  RETURN horizon;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_ingestion_history_from() IS
  'The instant by which every canonical read had begun ingesting - the latest go-live across canonical_read_go_live. Before it, ingested_at is a backfill artefact rather than a record of what WattSteer had learned, so the feature-side ingestion cut does not bind. Memoised transaction-locally in wattsteer.feature_ingestion_history_from, which is a memo and not a read axis. -infinity when no canonical read has ingested anything, which puts an empty database on the strict side.';
--> statement-breakpoint

-- The feature-side ingestion vintage, as a function of the target date.
--
-- It takes a target date and a profile and derives the gate itself, for the
-- reason `feature_apply_gate` and `actuals_cutoff` do: an instant parameter
-- would be the one door into the feature layer through which a hand-chosen
-- cut-off could arrive.
CREATE OR REPLACE FUNCTION feature_as_of(target_date date, gate_profile text)
  RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  gate timestamptz := gate_at(target_date, gate_profile);
BEGIN
  IF gate >= feature_ingestion_history_from() THEN
    RETURN gate;
  END IF;
  -- No ingestion cut. Over the backfill window `ingested_at` is the loader's
  -- clock and cutting on it empties the read; what makes the row honest here is
  -- `published_at <= gate` for the forecasts, `valid_time <= actuals_cutoff`
  -- for the observations, and the `revision_optimistic` stamp saying so.
  RETURN 'infinity'::timestamptz;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_as_of(date, text) IS
  'The instant written into wattsteer.as_of by the feature side. The gate where WattSteer had an ingestion history at it, and infinity - no ingestion cut - where it did not. Takes no instant: the gate is derived from the target date by gate_at, so there is no entry point through which a hand-chosen cut-off could arrive. The publication cut is a separate axis and is always the gate.';
--> statement-breakpoint

-- `feature_apply_gate`, with the ingestion axis fixed and nothing else moved.
--
-- `published_at_or_before` is still `gate`, unconditionally. The fleet date is
-- still the target date. The run cycle is still never pinned. Every axis is
-- still written on every call, absent ones as the empty string, for the reason
-- `contract/scope.ts` states: the settings live on a pooled connection, and a
-- block that wrote only the axes it cared about would inherit the previous
-- block's.
CREATE OR REPLACE FUNCTION feature_apply_gate(target_date date, gate_profile text)
  RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$
DECLARE gate timestamptz := gate_at(target_date, gate_profile);
BEGIN
  PERFORM set_config('wattsteer.as_of', feature_as_of(target_date, gate_profile)::text, true),
          set_config('wattsteer.fleet_date', target_date::text, true),
          set_config('wattsteer.published_at_or_before', gate::text, true),
          -- Never pinned: with no run cycle set the later run simply wins as a
          -- newer version of the same hours, which is what the gate already
          -- decides. Pinning one is a diagnostic, and a diagnostic in a feature
          -- would be a second definition of "the run".
          set_config('wattsteer.weather_run_cycle', '', true);
  RETURN gate;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_apply_gate(date, text) IS
  'The only way to obtain a feature-side axis, and it takes a target date and a profile rather than an instant. published_at_or_before is the gate, always: that is the cut that makes a forecast D-1 availability genuine even in backfill, and it is why a gate_late feature cannot read a run published after its own gate. as_of is feature_as_of(target_date, gate_profile) - the gate where WattSteer had an ingestion history at it, and no cut at all where it did not, because over the backfill window ingested_at is the loader clock rather than a record of what had been learned. Returns the gate.';
--> statement-breakpoint

-- The same fix on the second axis writer. It moves the *valid-time* axis and
-- only that; the vintage it writes is the target date's, so it inherits the
-- same piecewise ingestion cut and derives it the same way.
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

  PERFORM set_config('wattsteer.as_of', feature_as_of(target_date, gate_profile)::text, true),
          set_config('wattsteer.fleet_date', fleet_date::text, true),
          set_config('wattsteer.published_at_or_before', gate::text, true),
          set_config('wattsteer.weather_run_cycle', '', true);
  RETURN gate;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_apply_gate_for_fleet_offset(date, text, int) IS
  'The feature-side axes with the fleet date moved back a whole number of days from the target date. The vintage stays the target date own - gate_at(target_date, gate_profile) for publication and feature_as_of(target_date, gate_profile) for ingestion: the trailing window is a second valid time, never a second cut-off.';
--> statement-breakpoint

-- Hand the axes back empty, and the memo with them.
--
-- The memo is a fact about the database rather than a cut, so it could safely
-- have been left behind; it is cleared anyway, so that "a feature build leaves
-- nothing behind" stays one sentence rather than one sentence with an
-- exception.
CREATE OR REPLACE FUNCTION feature_release_axes()
  RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM set_config('wattsteer.as_of', '', true),
          set_config('wattsteer.fleet_date', '', true),
          set_config('wattsteer.published_at_or_before', '', true),
          set_config('wattsteer.weather_run_cycle', '', true),
          set_config('wattsteer.feature_ingestion_history_from', '', true);
END $$;
--> statement-breakpoint

-- `feature_rows(...)` again — the same function, one more conjunct on the
-- fidelity stamp.
--
-- Restated in full from `0036`'s definition, which is the newest one, for the
-- reason every restatement in this tree says: `ALTER TYPE ... ADD ATTRIBUTE`
-- appends, so migration order *is* attribute order, and a select list rebuilt
-- from an older copy emits the columns in an order Postgres reports as
-- "returned type X does not match expected type Y in column N" if it is lucky,
-- and as two silently swapped columns if it is not. **No attribute is added
-- here and none moves**: the row is the same 112 columns in the same order, and
-- this is the first restatement in the tree that is not carrying a new one.
--
-- The one change is inside the weakest-link `CASE`. It is in `feature_rows`
-- rather than only in `feature_apply_gate` on purpose: the lane's
-- `feature_hash` covers this function's definition and not the axis writer's,
-- so a fix that repaired every historical row while leaving the hash still
-- would let a weatherless artifact keep serving against rows that now carry
-- weather. Moving the hash is how the hot-swap gate is told.
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
         -- And the gate itself, against WattSteer's own ingestion history.
         -- `feature_as_of` suspends the ingestion cut for a gate that precedes
         -- it, because over the backfill window `ingested_at` is the loader's
         -- clock rather than a record of what had been learned. A row built
         -- under that relaxation cannot claim to be point-in-time, so the
         -- stamp is exact: `point_in_time` means this row was built under
         -- `as_of = gate`, unrelaxed. It is the last conjunct because it is
         -- about the gate rather than about a source, and it is a conjunct
         -- rather than a replacement for the seven above because a source that
         -- has ingested nothing has a NULL go-live and moves no horizon.
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
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. Capacity is a double as-of: valid time D, vintage the gate. The class W block is the twelve pinned weather variables capacity-weighted over the frozen centroids, per subsystem, with the weights recomputed per target date. The calendar and astronomy block is class T and reads no vintage at all. The class K block is cut on valid_time <= actuals_cutoff(gate, dataset), which is the only cut an observation-sourced feature may rely on. The class P block is ONS day-ahead programming, cut on publication like every other forecast. The class D block is the DESSEM balance: it exists only for dessem_augmented_v1 and only at gate_late, and for dessem_free_v1 it returns no rows at all, so a set-A row carries no DESSEM-sourced value at either gate. The proxy block is class P+W+T: it composes the class P and class W blocks rather than reading a source of its own, it is in both feature sets so the two views of residual load are comparable, and it is NULL at gate_early because the programme it subtracts from is. The utilisation block is class K and class D+K: three ratios that all divide by feature_export_capability_estimate, an ESTIMATE of directed export capability computed as P99.5 of directed flow over the trailing 365 days ending at the same actuals_cutoff, because no ONS dataset publishes a transfer limit at any grain. There is exactly one such estimate and every ratio reaches it. The one class-K column ticket 05 owed and did not ship is now here too: observed_constrained_off_same_hour_exceedance_7d, the occurrence twin of observed_constrained_off_same_hour_mean_7d over the same seven same-local-hour observations, which is what lets forecaster.md rung 1 compute BOTH heads of the mandatory baseline from this function instead of only the magnitude one.';

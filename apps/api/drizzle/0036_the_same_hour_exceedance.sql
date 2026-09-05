-- The 112th attribute: `observed_constrained_off_same_hour_exceedance_7d`.
--
-- feature-engineering ticket 14, and the column ticket 05 owed. The spec's
-- class-`K` table has carried this name since 05's merge; twenty of the
-- twenty-one class-`K` names shipped and this one did not, and
-- `docs/specs/feature-engineering.md` recorded the gap rather than closing it
-- because ticket 11 found it while writing a dictionary derived from a type
-- that had 111 attributes.
--
-- **Why it lands here, in the ticket that retires the second feature list.**
-- The hand-transcribed `apps/ml/.../ordered_features.yaml` omitted this name
-- too, so it agreed with `feature_set_model_inputs()` exactly — 77 names and 99
-- names — and both of them disagreed with the authority the YAML claimed to
-- transcribe. Replacing the transcription with something derived from the type
-- is worth nothing while the type is the thing that is wrong: the derived list
-- would inherit the omission and be *more* convincing about it. So the column
-- lands first, in the same commit, and the derived list is derived from a type
-- that matches its spec.
--
-- **What it is, and what it is not.** The share of the seven same-local-hour
-- observations ending at `actuals_cutoff` that are above `threshold_mw`. It is
-- *not* `observed_constrained_off_hours_above_threshold_7d`, which counts all
-- 168 hours of the window rather than the seven observations of one local hour
-- — that column is day grain and this one is hour grain, for the same reason
-- `observed_constrained_off_same_hour_mean_7d` is: the window is anchored to
-- the cutoff but *selected* by the target's local hour, so it genuinely varies
-- across the 24.
--
-- **`forecaster.md` rung 1 is the caller.** The mandatory baseline is a hurdle
-- with two heads: the magnitude head reads the same-hour mean, which has
-- existed since `0021`, and the occurrence head reads this. `apps/ml`'s
-- `evaluation/ladder.py` already names it as `EXCEEDANCE_FEATURE` and already
-- refuses to fit rung 1 without it, so until now the spec's promise that rung 1
-- is "computed *from the feature function*" could not be kept for half of it.
--
-- **The comparison is `>` and not `>=`, deliberately, and the spec's table is
-- corrected rather than matched.** That table wrote "at or above
-- `threshold_mw`". `y_has_curtailment` is `total > threshold_mw`, and so is
-- `observed_constrained_off_hours_above_threshold_7d` — which `0021` argued for
-- explicitly, so that the >1 / >5 / >10 sweep cannot make the feature and the
-- label disagree about what curtailment is. This column is the *baseline for
-- that label*. A boundary hour counted by the baseline and not by the target
-- would be exactly the disagreement rung 1 is computed from this function to
-- avoid, and at `threshold_mw = 0` the two readings are not a rounding apart:
-- `>= 0` is every hour. The prose in `feature-engineering.md` is amended to say
-- "above"; the code is not amended to say "at or above".
--
-- **`feature_hash` moves, and that is the visible event it exists for.**
-- `docs/specs/forecaster.md` hashes the type's ordered attribute names into a
-- lane's `feature_hash`, so every existing artifact is now bound to a vector
-- that is one name short. That is a retrain trigger and it is supposed to be
-- loud.
-- ---------------------------------------------------------------------------

-- One column onto the class-`K` block's return type, appended.
ALTER TYPE feature_lagged_actuals_hour ADD ATTRIBUTE observed_constrained_off_same_hour_exceedance_7d double precision;--> statement-breakpoint

-- The class-`K` block again — the same function, one more aggregate over a CTE
-- it already builds. Restated in full because a function body cannot be
-- patched, and its select list now ends where the type does.
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
    -- D−2, and NULL rather than slid. At `gate_late` this clears the cutoff only
    -- for the first four local hours of the day and is NULL for the other
    -- twenty; at `gate_early` it never clears at all. That is the spec's "the
    -- nearest usable same-hour actual is t−48 h, and even that is conditional",
    -- and it is enforced by the window rather than by a check: `curtailment_hours`
    -- stops at the cutoff, so there is no row to find.
    lag_48h.total_mwh,
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
  LEFT JOIN curtailment_hours lag_48h
    ON lag_48h.subsystem = spine.subsystem
   AND lag_48h.valid_time = spine.valid_time - interval '48 hours'
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

-- One column onto the row declaration, appended. The 112th.
ALTER TYPE feature_row ADD ATTRIBUTE observed_constrained_off_same_hour_exceedance_7d double precision;--> statement-breakpoint

COMMENT ON COLUMN feature_row.observed_constrained_off_same_hour_exceedance_7d IS
  'Class K. Share of the seven same-local-hour observations ending at actuals_cutoff(gate, restricao-coff) whose subsystem constrained-off total is ABOVE threshold_mw, in 1/7 steps. The occurrence twin of observed_constrained_off_same_hour_mean_7d, and the occurrence head of forecaster.md rung 1 - the mandatory same-hour 7-day baseline - which is computed from this function rather than reimplemented so the baseline and the model cannot disagree about what the last seven days were. NOT observed_constrained_off_hours_above_threshold_7d, which counts all 168 hours of the window rather than the seven observations of one local hour: that column is day grain, this one is hour grain, because the window is anchored to the cutoff but SELECTED by the target local hour. The comparison is strict, matching y_has_curtailment and observed_constrained_off_hours_above_threshold_7d, so the >1 / >5 / >10 threshold sweep cannot make the baseline and the label disagree about what curtailment is. NULL where the seven-day frame found no observation for this local hour at all.';
--> statement-breakpoint

-- Its dictionary row. `feature_dictionary()` raises 22023 for an attribute with
-- no entry, so this INSERT is not bookkeeping - without it the whole dictionary
-- stops answering, which is the severity ticket 11 chose on purpose.
--
-- `grain` is 'hour', beside the same-hour mean and not beside the day-grain
-- window aggregates. `is_proxy` is false: it is a count of observations, not an
-- estimate of a quantity nobody publishes.
INSERT INTO feature_dictionary_entry (
  column_name, role, classes, source, grain,
  in_dessem_free_v1, in_dessem_augmented_v1, available_at_gate_early,
  is_proxy, justifies_dessem_trade, model_input
) VALUES
  ('observed_constrained_off_same_hour_exceedance_7d', 'feature', array['K']::text[], 'ONS 1, 3', 'hour', true, true, true, false, false, true);
--> statement-breakpoint

-- `feature_rows(...)` again - the same function, one more column.
--
-- Restated in full from `0031`'s definition, which is the newest one, for the
-- reason every restatement in this tree says: `ALTER TYPE ... ADD ATTRIBUTE`
-- appends, so migration order *is* attribute order, and a select list rebuilt
-- from an older copy emits the columns in an order Postgres reports as
-- "returned type X does not match expected type Y in column N" if it is lucky,
-- and as two silently swapped columns if it is not. Every prior column is in
-- its existing position and the new one is last - which here means it is *not*
-- beside the class-`K` block's other columns, because the block it comes from
-- ran twenty attributes ago.
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

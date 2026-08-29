-- Lagged actuals, behind an enforced cutoff — class `K`.
--
-- Hand-written, like `0012_canonical_read_axes.sql`, `0016_the_feature_gate.sql`
-- and `0019_calendar_and_astronomy.sql`, and for the same reason: drizzle-kit
-- generates tables and views, not function DDL. The one table this reads
-- (`feature_publication_lag`) is generated, in `0020`; everything here is a
-- seed, two functions, a composite type and twenty attributes.
--
-- ## The one idea, and why `AsOf(gate)` is not it
--
-- `AsOf(gate)` looks like it already solves this and does not. `AsOf` filters on
-- `ingested_at` — when WattSteer *learned* a value. Over the backfill window
-- every row was ingested at go-live, so for a 2024 target date `AsOf(gate)`
-- returns everything and filters nothing. For a **Forecast** that is fine:
-- `published_at` is a genuine publication instant, which is why `0016` can cut
-- the weather on it and mean it. For an **Observation** it is not fine at all —
-- the balanço row for a 2024 hour carries a `published_at` derived from an S3
-- `Last-Modified` that may be 2026, and no filter on *either* vintage axis stops
-- it entering that hour's feature.
--
-- So every feature below is cut on a second, enforced axis:
--
--     actuals_cutoff(gate, dataset) = gate − publication_lag_hours[dataset]
--
-- and the filter is on **`valid_time`**, never on a vintage. `docs/specs/
-- feature-engineering.md` §"Where the cut actually falls" is the authority:
-- forecasts are cut on publication and their D−1 availability is *genuine*;
-- observations are cut on valid time and their D−1 availability is *enforced*.
--
-- ## The wall still stands: nothing here accepts an instant
--
-- `actuals_cutoff` is spelled `actuals_cutoff(target_date, gate_profile,
-- dataset)` and not `actuals_cutoff(gate, dataset)`, and the difference is the
-- whole of `0016`'s first property. A `gate timestamptz` parameter is a door
-- into the feature layer through which a hand-chosen instant could arrive, and
-- there must not be one — so the gate is derived here by `gate_at(target_date,
-- gate_profile)`, exactly as `feature_apply_gate` derives it, and the caller
-- chooses a date and a profile or nothing at all. The spec's `gate` in the
-- formula above is the derived gate, and this signature is what makes that the
-- only gate available.
--
-- ## The consequence, which is the sharpest fact in the spec
--
-- At `gate_late` (D−1 19:00 BRT) with a 40 h lag the cutoff lands at
-- **D−2 03:00 BRT**, so **no hour of day D−1 is assumed available at all**. The
-- nearest usable same-hour actual is t−48 h, and even that is conditional: for a
-- target hour of 04:00 local or later, t−48 h is *after* the cutoff and the
-- feature is NULL. That conditionality is deliberate and is the second rule:
--
--   * **A lag offset that does not clear the cutoff yields NULL rather than
--     sliding to the nearest available hour.** Sliding would let `_lag_48h` mean
--     "48 hours" in one row and "51 hours" in the next, and nothing in the row
--     would say which. Here it is structural rather than a check: the windowed
--     CTEs stop at the cutoff, so an offset past it simply finds no row.
--   * **Last-known-value substitution is permitted for levels only.** A state
--     can be carried forward honestly; a local difference cannot. A ramp
--     reconstructed from one last-observed value is not a ramp — it is one
--     number broadcast across 24 hours, and a tree model will read it as
--     intraday shape. So every ramp, every centred window over actuals and every
--     same-hour-*yesterday* lag on actuals is in the dropped class, with its
--     forecast-side replacement named in the spec's §"Dropped" table. Nothing
--     below is a difference of two actuals.
--
-- Rolling windows over actuals therefore **end at the cutoff** — the
-- `168 PRECEDING AND 1 PRECEDING` versus `... AND CURRENT ROW` distinction the
-- whole single-definition argument was made for. Every window here is spelled
-- `valid_time > cutoff − interval` and `valid_time <= cutoff`, and
-- `database-features.test.ts` pins the arithmetic against a hand-built series.
--
-- ## Why the seven-day same-hour aggregate is here and not in the forecaster
--
-- `observed_constrained_off_same_hour_mean_7d` is also the **mandatory
-- baseline's** definition (`docs/specs/forecaster.md` §"The baseline ladder",
-- rung 1). The baseline is computed from this function rather than
-- reimplemented, so the baseline and the model cannot disagree about what "the
-- last seven days" means — which is the only reason a baseline is worth
-- comparing against at all.
--
-- ## What is deliberately absent
--
-- The two **utilisation ratios** (`observed_export_utilisation_mean_24h_to_cutoff`
-- and `observed_corridor_utilisation_ne_se_max_7d`) need a denominator that does
-- not exist in any ONS dataset and has to be *estimated* — P99.5 of directed
-- flow over the trailing year, itself gate-bounded, with a minimum sample. That
-- estimator is its own ticket. The directed corridor *flows* they would divide
-- are here; the ratios are not.

-- The configured lags, seeded with the spec's conservative defaults.
--
-- Seeded by a migration on purpose. These may only ever be **loosened by
-- measurement** (seam 6's scheduled conformance job measures the real lag and
-- fails if it exceeds the configured one), and loosening one moves the cutoff,
-- which moves every lag and every trailing window behind it, which changes the
-- feature distribution the model was fitted on. **It is a retrain trigger, not a
-- config tweak** — so it lands as a migration, in a diff, next to a new
-- feature-set version, and never as an UPDATE somebody ran once.
--
-- `ON CONFLICT DO NOTHING` rather than an upsert, for the same reason
-- `feature_calendar_generation` refuses to restate a version: re-running the
-- tree must not silently reset a value a later migration deliberately changed.
INSERT INTO feature_publication_lag (dataset, canonical_read, publication_lag_hours, rationale)
VALUES
  ('balanco-energia-subsistema', 'system-context', 40,
   'Bulk file published twice daily. Whether the earlier publication carries any hour of D-1 is unmeasured; 40 h from gate_late lands the cutoff at D-2 03:00 BRT, assuming nothing.'),
  ('intercambio-nacional', 'system-exchange', 40,
   'Same publication regime as the balance file.'),
  ('restricao-coff', 'curtailment-by-reporting-entity', 40,
   'Same publication regime. The labels own series, read as a lagged feature, and the series the mandatory baseline is computed from.'),
  ('restricao-coff-detalhe', 'curtailment-by-plant', 40,
   'Same publication regime; the plant-grain detail files of the same release.'),
  ('carga-verificada', 'verified-load', 6,
   'Continuous REST API carrying a row-level din_atualizacao, so the latency is observed rather than assumed. No canonical read exists for this series yet and no feature is built on it; the row is configuration ahead of a reader, not a reader ahead of configuration.'),
  ('capacidade-geracao', 'installed-capacity', 24,
   'Daily snapshot. Capacity enters the row as class T at the gates vintage; this lag is the valid-time cut for the realised capacity factors, whose denominator is the fleet of the last available day.')
ON CONFLICT (dataset) DO NOTHING;
--> statement-breakpoint
COMMENT ON TABLE feature_publication_lag IS
  'Configured publication latency per ONS dataset, and the only input to actuals_cutoff beyond the gate. Conservative by default; loosening a value is a retrain trigger and lands as a migration, never as a runtime write.';
--> statement-breakpoint

-- `actuals_cutoff(gate, dataset)`, with the gate derived rather than passed.
--
-- The second axis of the two the spec names, and the one that has to be
-- *enforced*. `gate_at` resolves the instant from the target date, exactly as
-- `feature_apply_gate` does, so there is no parameter here through which a
-- different cutoff could arrive.
--
-- An unknown dataset raises `22023` rather than returning the gate itself. That
-- is `0012`'s posture inherited twice over: a default of zero hours would turn a
-- forgotten configuration row into an *unfiltered* observation read that looks
-- exactly like a correct answer, which is the precise failure this whole file
-- exists to prevent.
CREATE OR REPLACE FUNCTION actuals_cutoff(
  target_date date, gate_profile text, dataset text
) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  gate timestamptz := gate_at(target_date, gate_profile);
  lag_hours int;
BEGIN
  SELECT l.publication_lag_hours INTO lag_hours
  FROM feature_publication_lag l
  WHERE l.dataset = actuals_cutoff.dataset;

  IF lag_hours IS NULL THEN
    RAISE EXCEPTION
      'no configured publication lag for dataset %: an observation cut on an unmeasured latency is an unmeasured leak',
      coalesce(actuals_cutoff.dataset, '<null>') USING ERRCODE = '22023';
  END IF;

  RETURN gate - make_interval(hours => lag_hours);
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION actuals_cutoff(date, text, text) IS
  'gate_at(target_date, gate_profile) - publication_lag_hours[dataset]. The valid-time cut every observation-sourced feature is filtered on. Takes a target date and a profile rather than an instant: the gate is derived here, so there is no parameter through which a hand-chosen cutoff could arrive.';
--> statement-breakpoint

-- Twenty backward-looking levels for one target date, at (subsystem, hour).
--
-- Every column is a **level** — an observation of a real hour, or a mean, sum or
-- share of observations of real hours. There is no difference, no ramp and no
-- window centred on the target hour anywhere in this type, because those are the
-- three shapes last-known-value substitution cannot carry honestly.
CREATE TYPE feature_lagged_actuals_hour AS (
  subsystem subsystem_code,
  valid_time timestamptz,
  observed_actual_lag_hours double precision,
  observed_constrained_off_lag_168h double precision,
  observed_constrained_off_wind_lag_168h double precision,
  observed_constrained_off_solar_lag_168h double precision,
  observed_constrained_off_lag_48h double precision,
  observed_constrained_off_same_hour_mean_7d double precision,
  observed_constrained_off_hours_above_threshold_7d integer,
  observed_constrained_off_total_7d_mwh double precision,
  observed_load_lag_168h double precision,
  observed_wind_generation_lag_168h double precision,
  observed_solar_generation_lag_168h double precision,
  observed_wind_capacity_factor_mean_7d double precision,
  observed_solar_capacity_factor_mean_7d double precision,
  observed_net_exchange_lag_168h double precision,
  observed_net_exchange_mean_24h_to_cutoff double precision,
  observed_corridor_flow_ne_se_lag_168h double precision,
  observed_corridor_flow_n_ne_lag_168h double precision,
  observed_reason_share_ene_7d double precision,
  observed_reason_share_cnf_7d double precision,
  observed_reason_share_rel_7d double precision
);
--> statement-breakpoint

-- The class-`K` block.
--
-- Three observation datasets, three cutoffs, one fleet read. The cutoffs are
-- derived per dataset rather than shared, because the lag is a property of the
-- publication regime and two of these could diverge the day one is measured.
--
-- **The threshold is an argument for the reason it is one in `feature_rows`:**
-- `observed_constrained_off_hours_above_threshold_7d` counts hours above the
-- same boundary `y_has_curtailment` is derived from, so the >1 / >5 / >10 sweep
-- cannot make the feature and the label disagree about what "curtailment" is.
--
-- **The capacity-factor denominator is a double as-of, and it is not the target
-- date's.** The numerator is realised generation over the seven days ending at
-- the cutoff, so the denominator is the fleet of the **last available day**, at
-- the gate's vintage — which is exactly what `feature_apply_gate_for_fleet_offset`
-- from `0017` expresses and the only reason that function takes a whole number
-- of days rather than a date. A ratio of last week's generation to tomorrow's
-- fleet would drift downward every time a plant is commissioned, and a modeller
-- would read the drift as weather.
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
           avg(total_mwh) AS same_hour_mean
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
    reason_shares.share_rel
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
COMMENT ON FUNCTION feature_lagged_actuals_block(date, text, double precision) IS
  'Class K: backward-looking levels, every one cut on valid_time <= actuals_cutoff(gate, dataset) rather than on a vintage axis. Lags that do not clear the cutoff are NULL and never slide; every trailing window ends at the cutoff. No difference, ramp or centred window over actuals appears here.';
--> statement-breakpoint

-- Twenty columns onto the one declaration, appended.
--
-- `ALTER TYPE ... ADD ATTRIBUTE` appends, so migration order *is* attribute
-- order and this block lands after the calendar. `docs/specs/forecaster.md`
-- hashes the type's ordered names into a lane's `feature_hash`, which is exactly
-- the visible event that hash exists to make visible.
ALTER TYPE feature_row ADD ATTRIBUTE observed_actual_lag_hours double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_constrained_off_lag_168h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_constrained_off_wind_lag_168h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_constrained_off_solar_lag_168h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_constrained_off_lag_48h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_constrained_off_same_hour_mean_7d double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_constrained_off_hours_above_threshold_7d integer;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_constrained_off_total_7d_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_load_lag_168h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_wind_generation_lag_168h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_solar_generation_lag_168h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_wind_capacity_factor_mean_7d double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_solar_capacity_factor_mean_7d double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_net_exchange_lag_168h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_net_exchange_mean_24h_to_cutoff double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_corridor_flow_ne_se_lag_168h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_corridor_flow_n_ne_lag_168h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_reason_share_ene_7d double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_reason_share_cnf_7d double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_reason_share_rel_7d double precision;--> statement-breakpoint

-- The grain marking, in the catalogue, at the column itself.
--
-- Eight of the twenty are anchored to the cutoff rather than to the target hour,
-- so they carry one value for the whole target date. That is invisible in the
-- data — twenty-four equal numbers look exactly like a flat hourly series — and
-- the marking is the only thing that distinguishes them. `FEATURE_COLUMN_GRAIN`
-- in `src/features/feature-rows.ts` and the spec's own feature table say the
-- same thing; this is the copy that travels with the number.
COMMENT ON COLUMN feature_row.observed_actual_lag_hours IS
  'valid_time - actuals_cutoff(gate, dataset), in hours, at the widest of the three observation lags. How stale the rows backward view is, so the model can condition on its own blindness.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_constrained_off_lag_48h IS
  'Subsystem constrained-off total at t-48 h. NULL where t-48 h does not clear actuals_cutoff, which at gate_late is every local hour from 04:00 on. A lag that does not clear the cutoff is NULL and never slides to the nearest available hour.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_constrained_off_same_hour_mean_7d IS
  'Mean subsystem constrained-off at the same local hour over the seven days ending at actuals_cutoff. The mandatory baselines definition: docs/specs/forecaster.md rung 1 is computed from this column rather than reimplemented.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_constrained_off_hours_above_threshold_7d IS
  'Hours above threshold_mw over the seven days ending at actuals_cutoff. Day grain: constant across the 24 hours of the day, and not an hourly signal.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_constrained_off_total_7d_mwh IS
  'Sum of subsystem constrained-off over the seven days ending at actuals_cutoff. Day grain: constant across the 24 hours of the day, and not an hourly signal.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_wind_capacity_factor_mean_7d IS
  'Realised fleet wind capacity factor over the seven days ending at actuals_cutoff. Day grain. The denominator is the fleet of the last available day at the gates vintage, never the target dates fleet.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_solar_capacity_factor_mean_7d IS
  'Realised fleet solar capacity factor over the seven days ending at actuals_cutoff. Day grain. The denominator is the fleet of the last available day at the gates vintage, never the target dates fleet.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_net_exchange_mean_24h_to_cutoff IS
  'Mean subsystem net exchange over the last 24 available hours, ending at actuals_cutoff. Day grain: constant across the 24 hours of the day.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_reason_share_ene_7d IS
  'Share of reason-carrying entity-hours in the subsystem with reason ENE over the seven days ending at actuals_cutoff. Day grain. Aggregated upward from reporting entities only; nothing attributes a conjuntos reason downward to a member plant. PAR has no share column and stays in the denominator, so the day it first appears the three shares stop summing to one.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_reason_share_cnf_7d IS
  'Share of reason-carrying entity-hours in the subsystem with reason CNF over the seven days ending at actuals_cutoff. Day grain.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_reason_share_rel_7d IS
  'Share of reason-carrying entity-hours in the subsystem with reason REL over the seven days ending at actuals_cutoff. Day grain. REL is external grid unavailability, not relaxamento.';
--> statement-breakpoint

-- `feature_rows(...)` again — the same function, one more join.
--
-- Restated in full because a function body cannot be patched, and restated
-- **without touching the spine**: the signature is unchanged and still holds no
-- instant of any kind, the gate is still resolved per target date inside the
-- loop, and the new block is joined exactly as weather, capacity, calendar and
-- labels already were. It is not a second place a cutoff could enter, because it
-- has no argument that could carry one.
--
-- The fidelity stamp gains two sources. `system-context` and `system-exchange`
-- now feed features, so their go-lives join the weakest-link rule: a row whose
-- backward view had to be answered from a series WattSteer was not yet watching
-- is `revision_optimistic` as a whole, because a consumer cannot use half of it.
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
      -- two observation series the class-`K` block reads.
      CASE
        WHEN feature_vintage_fidelity(spine.valid_time, weather_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, label_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, capacity_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, context_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, exchange_go_live) = 'point_in_time'
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
      lagged.observed_reason_share_rel_7d
    FROM spine
    LEFT JOIN weather ON weather.valid_time = spine.valid_time
    LEFT JOIN capacity ON capacity.subsystem = spine.subsystem
    LEFT JOIN calendar ON calendar.valid_time = spine.valid_time
    LEFT JOIN shares ON shares.subsystem = spine.subsystem
    LEFT JOIN lagged
      ON lagged.subsystem = spine.subsystem
     AND lagged.valid_time = spine.valid_time
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
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. Capacity is a double as-of: valid time D, vintage the gate. The calendar and astronomy block is class T and reads no vintage at all. The class K block is cut on valid_time <= actuals_cutoff(gate, dataset), which is the only cut an observation-sourced feature may rely on.';

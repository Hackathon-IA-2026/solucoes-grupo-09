-- Both feature sets, and the dictionary that says what each column is.
--
-- Feature-engineering ticket 11 — the one that closes the spec. Ten tickets
-- built the blocks; this one adds no feature and changes no value. It adds the
-- artifact that makes the other 111 columns *readable*: a dictionary that gives
-- every attribute of `feature_row` a class, a source, a grain and a set
-- membership, and refuses to answer at all while one of them has none.
--
-- WHY THE DICTIONARY IS DERIVED AND NOT WRITTEN DOWN
-- --------------------------------------------------
-- The obvious shape for a feature dictionary is a table of rows, one per
-- column, hand-listed. That shape is wrong here, and this repository has the
-- scar tissue to prove it twice over: `apps/ml/.../ordered_features.yaml`
-- transcribed the spec's feature table by hand because no dictionary existed
-- (and already disagrees with it), and `DAY_GRAIN_COLUMNS` in
-- `src/features/feature-rows.ts` restates a marking the catalogue also carries.
-- A hand-listed dictionary is a second place the feature set is written down,
-- and two lists that can disagree eventually do.
--
-- So `feature_dictionary()` takes the **columns** from `pg_attribute` on the
-- `feature_row` composite type — their names, their order and their SQL types —
-- and takes the **prose** from `col_description`, where every block from `0017`
-- onward already wrote its argument. `feature_dictionary_entry` supplies only
-- the structured facts that no catalogue field can hold: the class, the source,
-- the grain, the set membership, the gate-early availability, the proxy flag.
-- Adding an attribute without a row there does not produce a dictionary with a
-- gap in it; it produces a raise.
--
-- That is also what makes the dictionary meaningful next to `feature_hash`.
-- `docs/specs/forecaster.md` hashes the type's ordered attribute names into a
-- lane's hash, so the hash and the dictionary read the same list from the same
-- catalogue. A hand-listed dictionary could describe a vector the hash was not
-- taken over, which is precisely the class of silent disagreement the hash
-- exists to prevent.
--
-- WHAT THE DICTIONARY RECORDS THAT IS UNCOMFORTABLE
-- -------------------------------------------------
-- Three facts the ten tickets established, recorded faithfully rather than
-- tidied away:
--
--   * `programmed_*` and the whole `proxy_*` family are **NULL at
--     `gate_early`** — `available_at_gate_early = false` — because the
--     programme for day D is stamped D-1 15:00 BRT and the early gate is D-1
--     09:00 BRT. Nobody repaired it, deliberately: reaching for an earlier hour
--     would claim an availability nothing has measured. Set A's most important
--     feature exists at `gate_late` only, and the early-gate arm of the A/B is
--     weaker for it.
--   * The `dessem_*` family is the augmented set and nothing else: 22 names,
--     `in_dessem_free_v1 = false`, and a CHECK constraint that makes the
--     opposite unrepresentable.
--   * The three utilisation ratios divide by a denominator that is an **upper
--     bound** — a sum over corridors that do not peak together — so they are
--     conservative in a known direction. They carry `is_proxy`, and their
--     column comments say the word "estimate".
--
-- THE PART THAT IS NOT A COLUMN
-- -----------------------------
-- The spec's sixth class is `✗`: a feature that cannot be served at D-1 at all.
-- A dropped feature has no attribute, so it cannot have a dictionary row
-- without breaking the derivation — it lives in `feature_dropped_feature`
-- instead, each with the replacement named, and `feature_dropped_features()`
-- checks every replacement name against the type's attributes so a replacement
-- cannot point at a column that does not exist.

-- ---------------------------------------------------------------------------
-- First, the catalogue is completed.
--
-- Seventy-six of the 111 attributes already carry a `COMMENT ON COLUMN`; the
-- other thirty-five were declared by `0016`, `0019` and `0021` before that
-- habit set in. The dictionary raises on a missing comment, so they are written
-- now — at the column, where a modeller reading `\d+ feature_row` finds them,
-- rather than in a table beside it.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN feature_row.subsystem IS
  'Identity. One of the four ONS subsystems - the row grain, with valid_time. Never SIN: the national aggregate is not a Subsystem and there is no fifth enum member for it to arrive as. It is also a model input, because the model is trained across all four and the diagnosis spec matches its attribution background on it.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.valid_time IS
  'Identity. Start of the hour, UTC, start-labelled. The other half of the row grain. Observations are cut on this axis and forecasts on published_at; conflating the two is the subtlest available leak, which is why the two cuts are never both spelled the same way.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.target_date IS
  'Identity. The Brasilia civil date whose gate produced this row. The gate is a function of this date and of nothing the caller holds, which is the sense in which the cut-off is a property of the target and not of the call.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.gate_profile IS
  'Stamp. gate_early or gate_late, as asked for. Carried on the row so that any number downstream can be traced to what was knowable when, rather than to a parameter someone remembers passing.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.gate_at IS
  'Stamp. The resolved instant - gate_at(target_date, gate_profile) - and not a second copy of the rule. D-1 09:00 BRT at gate_early, D-1 19:00 BRT at gate_late. Every as-of join, lag offset and rolling window in the row resolves against this one value.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.feature_set IS
  'Stamp. dessem_free_v1 or dessem_augmented_v1. The set is an argument rather than a second function: the whole A/B is one expression under different parameters, which is what stops the comparison being between two implementations.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.threshold_mw IS
  'Stamp. The positive-class boundary in MW at subsystem grain, default 5. An argument so the >1 / >5 / >10 sweep costs a parameter rather than a rebuild, and stamped so an artifact can never be served against a threshold it was not trained on.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.vintage_fidelity IS
  'Stamp. point_in_time or revision_optimistic, by the weakest link across every source the row read. A row composed from a point-in-time series and a revision-optimistic one is revision-optimistic as a whole, because a consumer cannot use half of it. Over the backfill window - before WattSteer''s own go-live per source - it is revision_optimistic, and every metric computed over that window says so.';
--> statement-breakpoint

COMMENT ON COLUMN feature_row.y_constrained_off_wind_mwh IS
  'Label, not a feature. Sum of constrained_off_mwh over the reporting entities of the subsystem, technology WIND, for the hour. Read AsOf(now()) rather than at the gate, deliberately: a model should learn to predict what actually happened rather than ONS''s first draft of it, and the label for hour t is a statement about hour t. That asymmetry is the one place the point-in-time discipline is broken on purpose.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.y_constrained_off_solar_mwh IS
  'Label. As y_constrained_off_wind_mwh, technology SOLAR. Solar constrained-off begins 2024-04, which is what opens dessem_free_v1''s window.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.y_constrained_off_total_mwh IS
  'Label. wind + solar, and NULL - not zero - when neither technology reported: the feature row carries both technologies'' labels as columns rather than duplicating sixty-odd shared context columns per technology, so an absence has to stay an absence.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.y_has_curtailment IS
  'Label, derived from threshold_mw inside the function and NEVER STORED. y_constrained_off_total_mwh > threshold_mw x 1 h; at hourly grain MWh and MW are numerically equal, which is why the comparison needs no conversion. Not stored because a stored label freezes a threshold into the database and lets two consumers disagree about which one they hold.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.y_magnitude_mwh IS
  'Label. y_constrained_off_total_mwh where y_has_curtailment, NULL otherwise - the magnitude head of the hurdle, defined only where the occurrence head fired.';
--> statement-breakpoint

COMMENT ON COLUMN feature_row.calendar_local_hour IS
  'Class T. Local hour 0-23 in America/Sao_Paulo, categorical. Computed in Brasilia civil time and not UTC, because the diurnal structure belongs to the grid rather than to the prime meridian. The builder asserts exactly 24 distinct local hours per target date, so a reinstated Brazilian summer time fails a test rather than duplicating an hour.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.calendar_hour_sin IS
  'Class T. sin(2 pi x local_hour / 24). The cyclical half of the hour, so that 23 and 00 are adjacent to a model rather than twenty-three apart.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.calendar_hour_cos IS
  'Class T. cos(2 pi x local_hour / 24). Paired with calendar_hour_sin; one alone does not identify the hour.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.calendar_doy_sin IS
  'Class T. sin(2 pi x day_of_year / 365.25). The period is 365.25 and not 365: a 365-day period puts 29 February a day out of phase and never recovers it, where 365.25 makes the new-year step 1.25 days in a common year and 0.25 in a leap year, averaging to one over the cycle.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.calendar_doy_cos IS
  'Class T. cos(2 pi x day_of_year / 365.25). month and week_of_year are deliberately absent from this row: they are a coarser quantisation of this same axis and add split points without information.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.calendar_day_of_week IS
  'Class T. 0 = Sunday, matching Postgres'' dow. Categorical.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.calendar_is_weekend IS
  'Class T. Saturday or Sunday in Brasilia civil time.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.calendar_is_holiday_national IS
  'Class T. A national statutory holiday, including the moveable feasts (Carnival, Good Friday, Corpus Christi), read from feature_calendar_day at the pinned calendar version. NULL - never false - outside the loaded horizon, and the horizon is checked against D-1 and D+1 because the bridge and day-before features read the neighbours. A quiet "not a holiday" at the calendar''s edge would be a fabricated fact.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.calendar_holiday_state_share IS
  'Class T, and A PROXY. The share of the subsystem''s ONS-assigned states observing a *state* holiday the country does not. Unweighted by load, and that is a known crudeness rather than an oversight: load is not published per state in any WattSteer source, so no honest weight exists, and inventing one from population or GDP would add a source to fabricate a weight for a feature likely to be marginal. National days are stored once under uf = BR and are not repeated per state, which is what keeps this column from reading 1.0 on every national holiday and becoming a second copy of the binary beside it.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.calendar_is_day_before_holiday IS
  'Class T. A national holiday falls on D+1. Reads the calendar''s next day, so it is NULL at the loaded horizon''s far edge.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.calendar_is_bridge_day IS
  'Class T. A Monday before a Tuesday national holiday, or a Friday after a Thursday one - a weekday wedged between a holiday and a weekend. A holiday is never a bridge to itself.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.solar_zenith_cos IS
  'Class T. cos of the solar zenith angle at the FROZEN solar centroid - the represented_mw-weighted mean of centroid_set_v1''s SOLAR points - sampled at the hour''s midpoint. Frozen because a point that moved with the fleet would restate this column for hours already trained on, and a class-T feature that changes when a plant is commissioned is not deterministic in any useful sense. NULL, not zero, when no centroid set is frozen.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.solar_extraterrestrial_ghi IS
  'Class T. Top-of-atmosphere horizontal irradiance in W/m2 at the same frozen point, sampled at the hour''s midpoint because weather_shortwave_radiation is an hour mean and weather_clearness_index divides one by the other - an edge-sampled denominator peaks that ratio above 1 every morning. NULL rather than 0 with no frozen set: a confident 0 W/m2 at noon is the one wrong answer that looks like a right one.';
--> statement-breakpoint

COMMENT ON COLUMN feature_row.observed_constrained_off_lag_168h IS
  'Class K. Total constrained-off at the same local hour, seven days back - a LEVEL, which is what makes a lagged actual legal at all. Resolved against actuals_cutoff(gate, restricao-coff): if t-168h does not clear the cutoff the value is NULL rather than sliding to the nearest available hour, so a lag never silently changes meaning between rows.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_constrained_off_wind_lag_168h IS
  'Class K. As observed_constrained_off_lag_168h, technology WIND. Per technology because the two fleets curtail for different reasons and at different hours.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_constrained_off_solar_lag_168h IS
  'Class K. As observed_constrained_off_lag_168h, technology SOLAR.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_load_lag_168h IS
  'Class K. load_mwh at the same local hour, D-7, from the subsystem energy balance. A level, cut on valid_time <= actuals_cutoff(gate, balanco-energia-subsistema). load_t-24 and load_t-1 are dropped rather than lagged: at gate_late no hour of D-1 is assumed available at all, so neither offset clears the cutoff.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_wind_generation_lag_168h IS
  'Class K. Realised wind generation at the same local hour, D-7. A level. The day-D equivalent is not lagged but rebuilt: weather_expected_wind_mwh.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_solar_generation_lag_168h IS
  'Class K. Realised solar generation at the same local hour, D-7. A level, with weather_expected_solar_mwh as the day-D reconstruction beside it.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_net_exchange_lag_168h IS
  'Class K. The subsystem''s net exchange at the same local hour, D-7. Set A has no day-ahead exchange signal at all - the programmed-exchange series exists only from 2026-01 and is not backfilled - so this lag and the corridor lags beside it are the whole of what it knows about the interconnection.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_corridor_flow_ne_se_lag_168h IS
  'Class K. Directed NE->SE flow at the same local hour, D-7. A system-level fact broadcast identically to all four subsystems: a corridor is not a property of one end of it. NE->SE is one of the two corridors that actually bind, which is what makes the capability estimate that divides it meaningful.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_corridor_flow_n_ne_lag_168h IS
  'Class K. Directed N->NE flow at the same local hour, D-7, broadcast to all four subsystems on the same terms. The second of the two corridors that bind, and the upstream half of the N/NE export mechanism that dessem_absorber_residual_load_mwh encodes from the other side.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The structured half, one row per attribute, in attribute order.
--
-- Seeded by a migration and expected to be *edited* by a migration, exactly as
-- `feature_publication_lag` is: nothing writes this table at runtime and there
-- is deliberately no repository through which it could. Reclassifying a column
-- changes what the vector is understood to be, and that belongs in a diff.
--
-- The order below is `pg_attribute`'s order, which is the migration tree's
-- history rather than a grouping: `ALTER TYPE ... ADD ATTRIBUTE` appends, so
-- the two `observed_` utilisation ratios sit after the `proxy_` family and not
-- beside their class-K siblings. `feature_dictionary()` re-derives that order
-- from the catalogue anyway, so nothing depends on the order of these rows -
-- they are written this way to be readable against `\d+ feature_row`.
--
-- Five classifications in here are worth reading twice:
--
--   * `weather_expected_vre_ramp_1h` is class **W+T**, where the spec's table
--     wrote W. It is the difference of two columns that are themselves W+T -
--     both multiply a forecast by InstalledCapacityAsOf - so a capacity read
--     stands behind it and the class has to say so. The spec is corrected to
--     match rather than the row being classified to match the spec.
--   * The seven `proxy_*` rows are **P+W+T**, the only three-class family here,
--     because the reconstruction subtracts a weather-and-capacity quantity from
--     a programmed one. That is also why they are NULL at `gate_early`: the P
--     term is, and every term is required.
--   * `dessem_export_utilisation` is **D+K** - the one column in the row where
--     a class-D numerator meets a class-K denominator.
--   * `is_proxy` is twelve columns, and the three `weather_expected_*` are
--     deliberately **not** among them. The spec names the proxies it means: the
--     generic IEC power curve's capacity factor, the unweighted holiday share
--     and the three utilisation ratios, plus the `proxy_*` family by its own
--     name. The expected-generation columns are a *deterministic conversion* -
--     "no model inside a model", and the STC reference carries no derate on
--     purpose so the model learns the temperature interaction rather than
--     inheriting a guess at it. The proxy stands one step behind them, in
--     `weather_wind_power_curve_cf`, and is flagged there. Flagging everything
--     downstream of a proxy would dilute the flag until nobody read it.
--   * `observed_constrained_off_same_hour_mean_7d` is **hour** grain, not day.
--     Its window is anchored to the cutoff but *selected* by the target's local
--     hour, so it genuinely varies across the 24. The same distinction keeps
--     the three `_rank_in_day` columns hourly while the `_min_of_day` columns
--     beside them are day grain.
-- ---------------------------------------------------------------------------

INSERT INTO feature_dictionary_entry (
  column_name, role, classes, source, grain,
  in_dessem_free_v1, in_dessem_augmented_v1, available_at_gate_early,
  is_proxy, justifies_dessem_trade, model_input
) VALUES
  ('subsystem', 'identity', '{}'::text[], 'the spine: subsystem_code x feature_local_day_hours', null, true, true, true, false, false, true),
  ('valid_time', 'identity', '{}'::text[], 'the spine: subsystem_code x feature_local_day_hours', null, true, true, true, false, false, false),
  ('target_date', 'identity', '{}'::text[], 'argument', null, true, true, true, false, false, false),
  ('gate_profile', 'stamp', '{}'::text[], 'argument', null, true, true, true, false, false, false),
  ('gate_at', 'stamp', '{}'::text[], 'gate_at(target_date, gate_profile)', null, true, true, true, false, false, false),
  ('feature_set', 'stamp', '{}'::text[], 'argument', null, true, true, true, false, false, false),
  ('threshold_mw', 'stamp', '{}'::text[], 'argument', null, true, true, true, false, false, false),
  ('vintage_fidelity', 'stamp', '{}'::text[], 'canonical_read_go_live', null, true, true, true, false, false, false),
  ('weather_temperature_2m', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('y_constrained_off_wind_mwh', 'label', '{}'::text[], 'ONS 1', 'hour', true, true, true, false, false, false),
  ('y_constrained_off_solar_mwh', 'label', '{}'::text[], 'ONS 3', 'hour', true, true, true, false, false, false),
  ('y_constrained_off_total_mwh', 'label', '{}'::text[], 'ONS 1, 3', 'hour', true, true, true, false, false, false),
  ('y_has_curtailment', 'label', '{}'::text[], 'argument', 'hour', true, true, true, false, false, false),
  ('y_magnitude_mwh', 'label', '{}'::text[], 'ONS 1, 3', 'hour', true, true, true, false, false, false),
  ('capacity_wind_mw', 'feature', array['T']::text[], 'ONS 12', 'day', true, true, true, false, false, true),
  ('capacity_solar_mw', 'feature', array['T']::text[], 'ONS 12', 'day', true, true, true, false, false, true),
  ('capacity_wind_added_28d_mw', 'feature', array['T']::text[], 'ONS 12', 'day', true, true, true, false, false, true),
  ('capacity_solar_added_28d_mw', 'feature', array['T']::text[], 'ONS 12', 'day', true, true, true, false, false, true),
  ('calendar_local_hour', 'feature', array['T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('calendar_hour_sin', 'feature', array['T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('calendar_hour_cos', 'feature', array['T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('calendar_doy_sin', 'feature', array['T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('calendar_doy_cos', 'feature', array['T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('calendar_day_of_week', 'feature', array['T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('calendar_is_weekend', 'feature', array['T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('calendar_is_holiday_national', 'feature', array['T']::text[], 'feature_calendar_day', 'hour', true, true, true, false, false, true),
  ('calendar_holiday_state_share', 'feature', array['T']::text[], 'feature_calendar_day x subsystem-state map', 'hour', true, true, true, true, false, true),
  ('calendar_is_day_before_holiday', 'feature', array['T']::text[], 'feature_calendar_day', 'hour', true, true, true, false, false, true),
  ('calendar_is_bridge_day', 'feature', array['T']::text[], 'feature_calendar_day', 'hour', true, true, true, false, false, true),
  ('solar_zenith_cos', 'feature', array['T']::text[], 'astronomy in SQL', 'hour', true, true, true, false, false, true),
  ('solar_extraterrestrial_ghi', 'feature', array['T']::text[], 'astronomy in SQL', 'hour', true, true, true, false, false, true),
  ('observed_actual_lag_hours', 'feature', array['K']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('observed_constrained_off_lag_168h', 'feature', array['K']::text[], 'ONS 1, 3', 'hour', true, true, true, false, false, true),
  ('observed_constrained_off_wind_lag_168h', 'feature', array['K']::text[], 'ONS 1, 3', 'hour', true, true, true, false, false, true),
  ('observed_constrained_off_solar_lag_168h', 'feature', array['K']::text[], 'ONS 1, 3', 'hour', true, true, true, false, false, true),
  ('observed_constrained_off_lag_48h', 'feature', array['K']::text[], 'ONS 1, 3', 'hour', true, true, true, false, false, true),
  ('observed_constrained_off_same_hour_mean_7d', 'feature', array['K']::text[], 'ONS 1, 3', 'hour', true, true, true, false, false, true),
  ('observed_constrained_off_hours_above_threshold_7d', 'feature', array['K']::text[], 'ONS 1, 3', 'day', true, true, true, false, false, true),
  ('observed_constrained_off_total_7d_mwh', 'feature', array['K']::text[], 'ONS 1, 3', 'day', true, true, true, false, false, true),
  ('observed_load_lag_168h', 'feature', array['K']::text[], 'ONS 5', 'hour', true, true, true, false, false, true),
  ('observed_wind_generation_lag_168h', 'feature', array['K']::text[], 'ONS 5', 'hour', true, true, true, false, false, true),
  ('observed_solar_generation_lag_168h', 'feature', array['K']::text[], 'ONS 5', 'hour', true, true, true, false, false, true),
  ('observed_wind_capacity_factor_mean_7d', 'feature', array['K', 'T']::text[], 'ONS 5, 12', 'day', true, true, true, false, false, true),
  ('observed_solar_capacity_factor_mean_7d', 'feature', array['K', 'T']::text[], 'ONS 5, 12', 'day', true, true, true, false, false, true),
  ('observed_net_exchange_lag_168h', 'feature', array['K']::text[], 'ONS 5', 'hour', true, true, true, false, false, true),
  ('observed_net_exchange_mean_24h_to_cutoff', 'feature', array['K']::text[], 'ONS 5', 'day', true, true, true, false, false, true),
  ('observed_corridor_flow_ne_se_lag_168h', 'feature', array['K']::text[], 'ONS 9', 'hour', true, true, true, false, false, true),
  ('observed_corridor_flow_n_ne_lag_168h', 'feature', array['K']::text[], 'ONS 9', 'hour', true, true, true, false, false, true),
  ('observed_reason_share_ene_7d', 'feature', array['K']::text[], 'ONS 1, 3', 'day', true, true, true, false, false, true),
  ('observed_reason_share_cnf_7d', 'feature', array['K']::text[], 'ONS 1, 3', 'day', true, true, true, false, false, true),
  ('observed_reason_share_rel_7d', 'feature', array['K']::text[], 'ONS 1, 3', 'day', true, true, true, false, false, true),
  ('programmed_load_mwh', 'feature', array['P']::text[], 'ONS 7', 'hour', true, true, false, false, false, true),
  ('programmed_load_ramp_1h', 'feature', array['P']::text[], 'ONS 7', 'hour', true, true, false, false, false, true),
  ('programmed_load_mean_3h', 'feature', array['P']::text[], 'ONS 7', 'hour', true, true, false, false, false, true),
  ('programmed_load_daily_min_mwh', 'feature', array['P']::text[], 'ONS 7', 'day', true, true, false, false, false, true),
  ('programmed_load_rank_in_day', 'feature', array['P']::text[], 'ONS 7', 'hour', true, true, false, false, false, true),
  ('dessem_demand_mwh', 'feature', array['D']::text[], 'ONS 11', 'hour', false, true, false, false, false, true),
  ('dessem_wind_mwh', 'feature', array['D']::text[], 'ONS 11', 'hour', false, true, false, false, false, true),
  ('dessem_solar_mwh', 'feature', array['D']::text[], 'ONS 11', 'hour', false, true, false, false, false, true),
  ('dessem_mmgd_mwh', 'feature', array['D']::text[], 'ONS 11', 'hour', false, true, false, false, false, true),
  ('dessem_hydro_mwh', 'feature', array['D']::text[], 'ONS 11', 'hour', false, true, false, false, false, true),
  ('dessem_thermal_mwh', 'feature', array['D']::text[], 'ONS 11', 'hour', false, true, false, false, false, true),
  ('dessem_pumping_mwh', 'feature', array['D']::text[], 'ONS 11', 'hour', false, true, false, false, false, true),
  ('dessem_residual_load_mwh', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, true, true),
  ('dessem_renewable_load_ratio', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, false, true),
  ('dessem_vre_surplus_mwh', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, false, true),
  ('dessem_inflexible_share', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, false, true),
  ('dessem_implied_net_export_mwh', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, true, true),
  ('dessem_demand_ramp_1h', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, false, true),
  ('dessem_residual_load_ramp_1h', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, false, true),
  ('dessem_vre_ramp_1h', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, false, true),
  ('dessem_residual_load_min_of_day', 'feature', array['D']::text[], 'derived', 'day', false, true, false, false, false, true),
  ('dessem_residual_load_rank_in_day', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, false, true),
  ('dessem_wind_capacity_factor', 'feature', array['D', 'T']::text[], 'derived', 'hour', false, true, false, false, false, true),
  ('dessem_solar_capacity_factor', 'feature', array['D', 'T']::text[], 'derived', 'hour', false, true, false, false, false, true),
  ('dessem_sin_residual_load_mwh', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, false, true),
  ('dessem_absorber_residual_load_mwh', 'feature', array['D']::text[], 'derived', 'hour', false, true, false, false, true, true),
  ('weather_wind_speed_100m', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_wind_speed_120m', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_wind_direction_120m_sin', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_wind_direction_120m_cos', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_wind_gusts_10m', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_surface_pressure', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_relative_humidity_2m', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_precipitation', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_shortwave_radiation', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_direct_normal_irradiance', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_diffuse_radiation', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_cloud_cover', 'feature', array['W']::text[], 'Single Runs', 'hour', true, true, true, false, false, true),
  ('weather_clearness_index', 'feature', array['W', 'T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('weather_wind_power_curve_cf', 'feature', array['W']::text[], 'derived', 'hour', true, true, true, true, false, true),
  ('weather_expected_wind_mwh', 'feature', array['W', 'T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('weather_expected_solar_mwh', 'feature', array['W', 'T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('weather_wind_speed_120m_ramp_1h', 'feature', array['W']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('weather_shortwave_radiation_ramp_1h', 'feature', array['W']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('weather_expected_vre_ramp_1h', 'feature', array['W', 'T']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('weather_wind_speed_120m_mean_3h', 'feature', array['W']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('weather_wind_speed_120m_std_6h', 'feature', array['W']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('weather_shortwave_radiation_mean_3h', 'feature', array['W']::text[], 'derived', 'hour', true, true, true, false, false, true),
  ('weather_run_age_hours', 'feature', array['W']::text[], 'ingest metadata', 'hour', true, true, true, false, false, true),
  ('weather_centroid_coverage', 'feature', array['W']::text[], 'ingest metadata', 'hour', true, true, true, false, false, true),
  ('proxy_residual_load_mwh', 'feature', array['P', 'W', 'T']::text[], 'derived', 'hour', true, true, false, true, false, true),
  ('proxy_residual_load_ratio', 'feature', array['P', 'W', 'T']::text[], 'derived', 'hour', true, true, false, true, false, true),
  ('proxy_renewable_load_ratio', 'feature', array['P', 'W', 'T']::text[], 'derived', 'hour', true, true, false, true, false, true),
  ('proxy_vre_surplus_mwh', 'feature', array['P', 'W', 'T']::text[], 'derived', 'hour', true, true, false, true, false, true),
  ('proxy_residual_load_ramp_1h', 'feature', array['P', 'W', 'T']::text[], 'derived', 'hour', true, true, false, true, false, true),
  ('proxy_residual_load_min_of_day', 'feature', array['P', 'W', 'T']::text[], 'derived', 'day', true, true, false, true, false, true),
  ('proxy_residual_load_rank_in_day', 'feature', array['P', 'W', 'T']::text[], 'derived', 'hour', true, true, false, true, false, true),
  ('observed_export_utilisation_mean_24h_to_cutoff', 'feature', array['K']::text[], 'ONS 9', 'day', true, true, true, true, false, true),
  ('observed_corridor_utilisation_ne_se_max_7d', 'feature', array['K']::text[], 'ONS 9', 'day', true, true, true, true, false, true),
  ('dessem_export_utilisation', 'feature', array['D', 'K']::text[], 'derived', 'hour', false, true, false, true, true, true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The sixth class: `✗`, the features that cannot be served at D-1 at all.
--
-- Eleven rows, from the spec's dropped table. Each names its replacement, and
-- `feature_dropped_features()` checks every name in `replacement_columns`
-- against `feature_row`'s attributes - so a drop cannot point at a column that
-- does not exist, and a column renamed by a later ticket breaks the pointer
-- loudly instead of leaving a stale sentence in a document.
--
-- The one row with no replacement column is `val_intercambioprogmwmed`, and its
-- emptiness is the honest shape: it is excluded from both sets rather than
-- replaced, because it exists only from 2026-01 and is not backfilled. A
-- feature richer at serve time than in training is the mirror image of the leak
-- this spec is about, and it would be just as invisible.
-- ---------------------------------------------------------------------------

INSERT INTO feature_dropped_feature (idea_feature, reason, replacement, replacement_columns) VALUES
  ('load_mw, solar_mw, wind_mw, hydro_mw, thermal_mw at t',
   'Day-D actuals. None of them exists at D-1, and none is published for another one to two days after the target hour.',
   'programmed_load_mwh (P), weather_expected_* (W), dessem_* (D)',
   array['programmed_load_mwh', 'weather_expected_wind_mwh', 'weather_expected_solar_mwh',
         'dessem_demand_mwh', 'dessem_wind_mwh', 'dessem_solar_mwh',
         'dessem_hydro_mwh', 'dessem_thermal_mwh']::text[]),
  ('residual_load at t (IDEA.md section 5)',
   'Day-D actuals. The single most physically meaningful quantity in the domain - it is what curtailment IS - so dropping it outright would have thrown away the product. It is rebuilt rather than abandoned.',
   'proxy_residual_load_mwh in set A, dessem_residual_load_mwh in set B',
   array['proxy_residual_load_mwh', 'dessem_residual_load_mwh']::text[]),
  ('renewable_load_ratio at t (IDEA.md section 4)',
   'Day-D actuals: both terms are measurements of the target hour.',
   'proxy_renewable_load_ratio / dessem_renewable_load_ratio',
   array['proxy_renewable_load_ratio', 'dessem_renewable_load_ratio']::text[]),
  ('solar_ramp_1h, wind_ramp_1h, load_ramp_1h on actuals (IDEA.md section 6)',
   'A LOCAL DIFFERENCE, and last-known-value substitution is honest for a state and dishonest for a difference: one observed ramp broadcast across 24 hours is not a ramp at all, and a tree model will treat it as intraday shape.',
   'the forecast-side ramps, where a single publication carries the whole day-D profile (W, P, D)',
   array['weather_wind_speed_120m_ramp_1h', 'weather_shortwave_radiation_ramp_1h',
         'weather_expected_vre_ramp_1h', 'programmed_load_ramp_1h',
         'proxy_residual_load_ramp_1h', 'dessem_demand_ramp_1h',
         'dessem_residual_load_ramp_1h', 'dessem_vre_ramp_1h']::text[]),
  ('solar_t-1 .. t-3, wind_t-1 .. t-6, load_t-1, load_t-24 (IDEA.md section 7)',
   'None of these offsets clears actuals_cutoff. At gate_late no hour of D-1 is assumed available at all, so the nearest usable same-hour actual is t-48h and even that is conditional.',
   'the 168-hour lags, the conditional 48-hour lag, and the day-grain 7-day aggregates',
   array['observed_load_lag_168h', 'observed_wind_generation_lag_168h',
         'observed_solar_generation_lag_168h', 'observed_constrained_off_lag_168h',
         'observed_constrained_off_lag_48h', 'observed_constrained_off_total_7d_mwh',
         'observed_wind_capacity_factor_mean_7d', 'observed_solar_capacity_factor_mean_7d']::text[]),
  ('solar_mean_3h, wind_mean_3h, load_mean_3h, renewable_max_6h, load_std_6h, wind_std_6h centred on t (IDEA.md section 8)',
   'A window centred on the target hour straddles the cutoff: half of it is day-D actuals.',
   'forecast-side centred windows, and actuals-side windows that END at the cutoff',
   array['weather_wind_speed_120m_mean_3h', 'weather_wind_speed_120m_std_6h',
         'weather_shortwave_radiation_mean_3h', 'programmed_load_mean_3h',
         'observed_net_exchange_mean_24h_to_cutoff',
         'observed_constrained_off_same_hour_mean_7d']::text[]),
  ('exchange_NE_SE, exchange_N_NE at t (IDEA.md section 9)',
   'Day-D actuals.',
   'dessem_implied_net_export_mwh in set B; the directed corridor lags in set A',
   array['dessem_implied_net_export_mwh', 'observed_corridor_flow_ne_se_lag_168h',
         'observed_corridor_flow_n_ne_lag_168h']::text[]),
  ('val_intercambioprogmwmed (programmed exchange)',
   'Present only from 2026-01 and NOT BACKFILLED. Including it would create the mirror-image skew: a feature richer at serve time than in training, which no walk-forward split catches either.',
   'Excluded from both sets. Recorded as a candidate third set once it has history - there is no column to replace it with, and inventing one would be worse than the absence.',
   '{}'::text[]),
  ('solar_capacity_factor at t (IDEA.md section 12)',
   'Day-D actuals in the numerator.',
   'the forecast-side capacity-factor proxies, DESSEM''s own factors, and the realised trailing means',
   array['weather_wind_power_curve_cf', 'weather_clearness_index',
         'dessem_wind_capacity_factor', 'dessem_solar_capacity_factor',
         'observed_wind_capacity_factor_mean_7d', 'observed_solar_capacity_factor_mean_7d']::text[]),
  ('val_ventoverificado, val_irradianciaverificado (constrained-off detail)',
   'Plant-grain MEASUREMENTS, and actuals. Both halves disqualify them: the forecast grain is the subsystem, and the values describe the target hour after the fact.',
   'the pinned weather run, capacity-weighted over the frozen centroids',
   array['weather_wind_speed_120m', 'weather_shortwave_radiation']::text[]),
  ('month, week_of_year (IDEA.md section 10)',
   'Available at D-1, and dropped anyway: redundant. A coarser quantisation of the same axis as the day-of-year encoding, adding split points without information.',
   'calendar_doy_sin / calendar_doy_cos',
   array['calendar_doy_sin', 'calendar_doy_cos']::text[]);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The two sets and the three trainings.
--
-- The sets are arguments to `feature_rows`, not implementations - that is the
-- whole design. What these two tables add is the part the function cannot hold:
-- the WINDOW. A caller passing 2024-04-01 for `dessem_augmented_v1` would get
-- eleven months of NULL DESSEM columns rather than a refusal, because an empty
-- join is not an error; `feature_set_definition.window_from` is where that stops
-- being folklore.
--
-- And the A/B needs THREE trainings, not two, or it confounds feature content
-- with window length. Written as rows so that the forecaster reads the three
-- configurations instead of transcribing them a fourth time.
-- ---------------------------------------------------------------------------

INSERT INTO feature_set_definition (feature_set, window_from, window_from_driver, gates, residual_load_column) VALUES
  ('dessem_free_v1', '2024-04-01',
   'Solar constrained-off reporting begins 2024-04; before it the solar half of the label does not exist.',
   array['gate_early', 'gate_late']::text[], 'proxy_residual_load_mwh'),
  ('dessem_augmented_v1', '2025-05-23',
   'DESSEM balance coverage begins 2025-05-23.',
   array['gate_late']::text[], 'dessem_residual_load_mwh');
--> statement-breakpoint

INSERT INTO feature_ab_configuration (run, feature_set, window_from, gate_profile, isolates) VALUES
  ('A-full', 'dessem_free_v1', '2024-04-01', 'gate_late',
   'The product''s actual set-A model. Read against A-common it measures what the longer history is worth.'),
  ('A-common', 'dessem_free_v1', '2025-05-23', 'gate_late',
   'The control arm: set A''s feature content over set B''s window, so that the comparison below is about content alone.'),
  ('B-common', 'dessem_augmented_v1', '2025-05-23', 'gate_late',
   'DESSEM''s contribution, against A-common. DESSEM ships only if this beats A-common by more than eleven hours of lost operator notice are worth - and that trade is a product decision, not a metric.');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- `feature_dictionary()` — the artifact, and the only place it exists.
--
-- Every column of the answer that describes a *column* comes from the
-- catalogue: `attname`, `attnum`, `format_type` and `col_description`. Only the
-- structured classification comes from `feature_dictionary_entry`. The three
-- raises below are the enforcement, and they are deliberately total in both
-- directions - an attribute with no entry, an entry with no attribute, and an
-- attribute with no prose all refuse the whole dictionary rather than returning
-- a row with a gap in it.
--
-- Refusing the whole answer is the right severity. A dictionary with one
-- unclassified column in it still reads like a dictionary, and the one column
-- nobody classified is exactly the one a reader will assume somebody did.
-- ---------------------------------------------------------------------------

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
    a.attnum::integer,
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
--> statement-breakpoint
COMMENT ON FUNCTION feature_dictionary() IS
  'The feature dictionary: every attribute of feature_row with its class, source, grain, set membership, gate-early availability and prose. DERIVED FROM THE COMPOSITE TYPE, never hand-listed - the names, the order, the SQL types and the descriptions all come from the catalogue, and feature_dictionary_entry supplies only the structured classification. Raises 22023 rather than answering when an attribute has no entry, an entry has no attribute, or an attribute has no comment. docs/specs/forecaster.md hashes the same ordered attribute names into a lane''s feature_hash, so the dictionary and the hash cannot describe two different vectors.';
--> statement-breakpoint

-- The ordered model inputs of one set — what an artifact is bound to.
--
-- This is the function that replaces a transcribed feature list. It returns the
-- names in the type's own order, filtered to the set, and it is total by
-- construction: `model_input` is true for every feature and for `subsystem`,
-- and there is no way to add a feature without adding the row that says so.
CREATE OR REPLACE FUNCTION feature_set_model_inputs(feature_set text) RETURNS TABLE (
  input_index integer,
  column_name text,
  class_label text,
  grain text,
  available_at_gate_early boolean
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF feature_set IS NULL
     OR NOT EXISTS (SELECT 1 FROM feature_set_definition d WHERE d.feature_set = feature_set_model_inputs.feature_set) THEN
    RAISE EXCEPTION 'unknown feature set %: expected dessem_free_v1 or dessem_augmented_v1',
      coalesce(feature_set, '<null>') USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT (row_number() OVER (ORDER BY d.ordinal))::integer,
         d.column_name, d.class_label, d.grain, d.available_at_gate_early
  FROM feature_dictionary() d
  WHERE d.model_input
    AND CASE feature_set_model_inputs.feature_set
          WHEN 'dessem_free_v1' THEN d.in_dessem_free_v1
          ELSE d.in_dessem_augmented_v1
        END
  ORDER BY d.ordinal;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_set_model_inputs(text) IS
  'The ordered model inputs of one feature set, in the composite type''s own attribute order: every feature the set carries, plus subsystem, and nothing from the stamp or the labels. This is the list a model artifact is bound to, derived from the type rather than transcribed - apps/ml''s ordered_features.yaml exists only because this did not, and its own header says the transcription goes away when the builder lands.';
--> statement-breakpoint

-- The `✗` class, with every replacement checked against the type.
CREATE OR REPLACE FUNCTION feature_dropped_features() RETURNS TABLE (
  idea_feature text,
  reason text,
  replacement text,
  replacement_columns text[]
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  attrs oid := (SELECT t.typrelid FROM pg_type t WHERE t.oid = 'feature_row'::regtype);
  offenders text;
BEGIN
  SELECT string_agg(DISTINCT missing.name, ', ') INTO offenders
  FROM feature_dropped_feature f
  CROSS JOIN LATERAL unnest(f.replacement_columns) AS missing(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = attrs AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname = missing.name
  );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'dropped features name replacements that are not feature_row attributes: %', offenders
      USING ERRCODE = '22023',
            HINT = 'A named replacement that does not exist is a drop with no replacement, written so it looks like one that has one.';
  END IF;

  RETURN QUERY
  SELECT f.idea_feature, f.reason, f.replacement, f.replacement_columns
  FROM feature_dropped_feature f
  ORDER BY f.idea_feature;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_dropped_features() IS
  'The spec''s sixth class: IDEA.md features that cannot be served at D-1, each with its named replacement. Raises 22023 if any replacement names a column feature_row does not have, so a rename cannot leave a stale pointer behind. One row has no replacement column and that is deliberate: val_intercambioprogmwmed is excluded from both sets rather than replaced.';
--> statement-breakpoint

-- The three trainings, validated against the sets they name.
CREATE OR REPLACE FUNCTION feature_ab_configurations() RETURNS TABLE (
  run text,
  feature_set text,
  window_from date,
  gate_profile text,
  isolates text
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(c.run, ', ' ORDER BY c.run) INTO offenders
  FROM feature_ab_configuration c
  JOIN feature_set_definition d ON d.feature_set = c.feature_set
  WHERE NOT (c.gate_profile = ANY (d.gates))
     OR c.window_from < d.window_from;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'A/B configurations ask for a gate or a window the feature set does not have: %', offenders
      USING ERRCODE = '22023',
            HINT = 'The augmented set is a gate_late set whose window opens 2025-05-23. A configuration outside that would build rows of NULLs rather than fail, which is why it is refused here.';
  END IF;

  RETURN QUERY
  SELECT c.run, c.feature_set, c.window_from, c.gate_profile, c.isolates
  FROM feature_ab_configuration c
  ORDER BY c.run;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_ab_configurations() IS
  'The three trainings the A/B needs - A-full, A-common, B-common - as argument tuples for feature_rows, not as a second code path. Two, not three, would confound feature content with window length. Each row is checked against feature_set_definition, so a configuration naming a gate or a window its set does not have is refused rather than silently building NULLs.';
--> statement-breakpoint

-- The row arithmetic, counted rather than assumed.
--
-- Set A over 2024-04-01 -> now is roughly 84,500 rows and set B roughly 44,200,
-- and those numbers are subsystems x local hours x days. The hours are counted
-- through `feature_local_day_hours` rather than multiplied by a literal 24: the
-- 24-local-hours canary is an assertion the builder makes, and a function that
-- assumed the same number would agree with a broken calendar.
CREATE OR REPLACE FUNCTION feature_set_expected_rows(feature_set text, target_to date)
RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  opens date;
  total bigint;
BEGIN
  SELECT d.window_from INTO opens
  FROM feature_set_definition d WHERE d.feature_set = feature_set_expected_rows.feature_set;
  IF opens IS NULL THEN
    RAISE EXCEPTION 'unknown feature set %: expected dessem_free_v1 or dessem_augmented_v1',
      coalesce(feature_set, '<null>') USING ERRCODE = '22023';
  END IF;
  IF target_to IS NULL THEN
    RAISE EXCEPTION 'feature_set_expected_rows requires the far end of the window'
      USING ERRCODE = '22023';
  END IF;
  IF target_to < opens THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO total
  FROM generate_series(opens, target_to, interval '1 day') AS g(day)
  CROSS JOIN unnest(enum_range(NULL::subsystem_code)) AS s(subsystem)
  CROSS JOIN LATERAL feature_local_day_hours(g.day::date) AS h(valid_time);
  RETURN total;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_set_expected_rows(text, date) IS
  'How many rows a full-window build of one feature set produces: subsystems x local hours x days, from the set''s own window_from to the date given. Counted through feature_local_day_hours rather than multiplied by a literal 24, so it cannot agree with a calendar that lost an hour.';
--> statement-breakpoint

COMMENT ON TABLE feature_dictionary_entry IS
  'The structured half of the feature dictionary: one row per feature_row attribute, carrying the class, source, grain, set membership, gate-early availability and proxy flag that no catalogue field can hold. NOT the column list - feature_dictionary() takes the columns from pg_attribute and the prose from col_description, and raises when this table and the type disagree in either direction. Seeded and edited by migration only; nothing writes it at runtime.';
--> statement-breakpoint
COMMENT ON TABLE feature_dropped_feature IS
  'The spec''s class ✗: IDEA.md features that cannot be served at D-1, with the named replacement for each. Its own table because a dropped feature is not a column - it has no attribute, no type and no ordinal - and giving it a dictionary row would break the derivation the dictionary rests on.';
--> statement-breakpoint
COMMENT ON TABLE feature_set_definition IS
  'The two feature sets as data: the window each builds over, the gates each exists at, and the column each calls residual load. The set is already an argument to feature_rows; what this adds is the window, which the function cannot hold because an empty join over a set B date before 2025-05-23 is not an error.';
--> statement-breakpoint
COMMENT ON TABLE feature_ab_configuration IS
  'The A/B''s three trainings - A-full, A-common, B-common - as argument tuples for the one feature function. Three and not two, because two would confound DESSEM''s feature content with the length of the window it is available over.';

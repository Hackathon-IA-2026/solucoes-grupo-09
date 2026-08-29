-- DESSEM — class `D`, and the feature-set argument that gates it.
--
-- Hand-written, like `0012_canonical_read_axes.sql`, `0016_the_feature_gate.sql`,
-- `0017_capacity_at_the_gate.sql`, `0019_calendar_and_astronomy.sql`,
-- `0021_lagged_actuals_behind_the_cutoff.sql` and
-- `0024_day_ahead_programming.sql`, and for the same reason: drizzle-kit
-- generates tables and views, not function DDL. Everything here is a composite
-- type, a block, twenty-one attributes and the entry point restated.
--
-- ## What class `D` is
--
-- ONS's own day-ahead balance for the subsystem: demand, generation by
-- technology, pumping, and the quantities derived from them. It arrives through
-- `canonical_day_ahead_balance` at 30-minute × subsystem grain in **MW**, with
-- the DESSEM file's creation as its `published_at`, and coverage beginning
-- 2025-05-23.
--
-- Its `published_at` is genuine — a real file-creation instant, not a fetch —
-- so `published_at <= gate` is a point-in-time filter even over backfill, in
-- exactly the way `0024` had to argue for and could not simply assert. That is
-- what makes ramps, day minima and in-day ranks legal here: a D−1 publication
-- carries the *whole* of day D at once, so a difference inside it is computed
-- from data that genuinely exists at the gate. The same argument, and the same
-- two edges, as the class-`P` block beside it.
--
-- ## The feature-set argument, which is this ticket's real subject
--
-- **DESSEM's exclusion from the early gate is structural, not a rule.** The
-- file for reference day D is created mid-afternoon on D−1 (2026-08-28's was
-- created 2026-08-27T17:48 UTC). At 09:00 BRT on D−1 the newest DESSEM file
-- describes D−1 itself. So a caller asking for `dessem_augmented_v1` at
-- `gate_early` is not asking for a shorter window; it is asking for a file that
-- does not exist, and `feature_rows` has refused it with `22023` since `0016`.
--
-- That refusal now has a second wall behind it, in the block itself. The block
-- takes the **feature set** as well as the target date and the profile, and:
--
--   * `dessem_free_v1` returns **no rows at all**, at either gate, so every
--     `dessem_*` column in a set-A row is NULL by construction rather than by a
--     `WHERE` clause somebody could relax; and
--   * `dessem_augmented_v1` at anything but `gate_late` raises, so the rule
--     survives a future caller that reaches the block without going through
--     `feature_rows`.
--
-- Neither wall is a filter on data. The set argument is not an instant and
-- cannot become one: the gate is still derived inside `feature_apply_gate` from
-- the target date, and there is still no argument anywhere in this layer
-- through which a hand-chosen cutoff could arrive.
--
-- **The eleven hours are the augmented set's second cost.** `gate_late` is
-- D−1 19:00 BRT and `gate_early` is D−1 09:00 BRT, so a model that needs DESSEM
-- gives an operator ten fewer hours of notice than one that does not — eleven,
-- counting from the 08:00 BRT dispatch desk the spec's A/B is stated against.
-- `docs/specs/feature-engineering.md` §"The two feature sets" records it beside
-- the shorter window, because a comparison that reports only the metric is
-- reporting half the trade.
--
-- ## Half hours become hours, and MW becomes MWh
--
-- The source grain is 30 minutes and the feature row is hourly, so the two half
-- hours of an hour are combined — and the combination is a **mean, not a sum**,
-- which is the opposite of `canonical_programmed_load`'s and is right for the
-- opposite reason. The programme is already MWh per half hour, so its hours are
-- summed. DESSEM publishes instantaneous MW, so half an hour at *P* MW is
-- *P*/2 MWh and the hour is (*P₁* + *P₂*)/2 — the mean of the two powers. A sum
-- here would publish every DESSEM quantity at twice its true size, which is the
-- kind of wrong that looks like a busy day.
--
-- **A half-empty hour is a hole, not a half-sized one**, exactly as in `0024`:
-- the hour is emitted only where both half hours survive the gate.
--
-- ## The exchange column DESSEM does not publish
--
-- For a subsystem, generation minus demand minus pumping is net export, up to
-- losses. `dessem_implied_net_export_mwh` is derived from that identity and is
-- named *implied* because the losses are not modelled — the number is a
-- day-ahead signal for the mechanism ONS's own prospective-curtailment tool
-- cites, the northern export limits, and it is not a measured flow. The
-- **utilisation ratio** that would divide it is not here: it needs an export
-- capability estimate that no ONS dataset publishes, and that denominator is
-- ticket 10's. A ratio with an invented denominator would be a worse answer
-- than a missing column.
--
-- ## The one feature that is a physical asymmetry rather than a statistic
--
-- `dessem_absorber_residual_load_mwh` carries **SE's** residual load onto the
-- **N and NE** rows, because N and NE curtail when SE has no headroom to absorb
-- what they export. It is NULL on SE's own rows — a subsystem is not its own
-- absorber, and a column that quietly became a copy of `dessem_residual_load_mwh`
-- there would be a duplicate feature under a name promising something else —
-- and NULL on S, which the mechanism does not describe.
--
-- `dessem_sin_residual_load_mwh` is the system-wide total. `SIN` is **not** a
-- Subsystem (`docs/domain-model.md` §2) and nothing here makes it one: this is a
-- derived sum over the four, which is the only form the domain model allows a
-- national total to take. It is NULL unless all four subsystems reported the
-- hour, because a sum over three is the total of a different system.

-- The DESSEM balance for one target date, at (subsystem, hour).
--
-- Twenty-one columns: seven levels read from the balance, five quantities
-- derived from those levels by identity, three ramps and two day-grain
-- summaries derived within day D's profile, two capacity factors that need the
-- fleet at the gate's vintage, and the two cross-subsystem terms.
CREATE TYPE feature_dessem_hour AS (
  subsystem subsystem_code,
  valid_time timestamptz,
  dessem_demand_mwh double precision,
  dessem_wind_mwh double precision,
  dessem_solar_mwh double precision,
  dessem_mmgd_mwh double precision,
  dessem_hydro_mwh double precision,
  dessem_thermal_mwh double precision,
  dessem_pumping_mwh double precision,
  dessem_residual_load_mwh double precision,
  dessem_renewable_load_ratio double precision,
  dessem_vre_surplus_mwh double precision,
  dessem_inflexible_share double precision,
  dessem_implied_net_export_mwh double precision,
  dessem_demand_ramp_1h double precision,
  dessem_residual_load_ramp_1h double precision,
  dessem_vre_ramp_1h double precision,
  dessem_residual_load_min_of_day double precision,
  dessem_residual_load_rank_in_day integer,
  dessem_wind_capacity_factor double precision,
  dessem_solar_capacity_factor double precision,
  dessem_sin_residual_load_mwh double precision,
  dessem_absorber_residual_load_mwh double precision
);
--> statement-breakpoint

-- The class-`D` block.
--
-- One view, one gate, no cutoff: DESSEM is a **Forecast**, so it is cut on
-- `published_at <= gate` and its D−1 availability is *genuine* rather than
-- enforced. There is no `actuals_cutoff` here and there must not be — that
-- function answers a question about observations, and asking it about a
-- forecast would move the cut onto an axis the source never asserted.
--
-- The block takes a target date, a profile and a feature set, and **no
-- instant** — exactly as every block since `0016` has. The set is the third
-- argument rather than a filter in `feature_rows` so that "the DESSEM-free set
-- contains no DESSEM-sourced value" is a property of the function that produces
-- them: at `dessem_free_v1` this returns the empty set and the twenty-one
-- columns are NULL because there was nothing to join.
--
-- **The fleet is read before the balance, and that order is load-bearing.**
-- `feature_capacity_block` leaves the read axes at the D−28 fleet date, because
-- the last thing it does is the second of its two as-of reads. So the capacity
-- factors' denominator is materialised into an array first, and
-- `feature_apply_gate` is called afterwards — which rewrites all four axes at
-- the target date before a single DESSEM row is read. Reading the balance first
-- and the fleet second would work today and would silently read the balance
-- under whatever axes the previous block left behind the day someone reorders
-- the CTEs in `feature_rows`.
--
-- Calling `feature_capacity_block` rather than re-reading
-- `canonical_installed_capacity` costs a second evaluation and buys the thing
-- worth having: one definition of "the fleet at the gate", so a capacity factor
-- and `capacity_wind_mw` in the same row cannot disagree about the denominator.
CREATE OR REPLACE FUNCTION feature_dessem_block(
  target_date date, gate_profile text, feature_set text
) RETURNS SETOF feature_dessem_hour LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  day_from timestamptz := target_date::timestamp AT TIME ZONE 'America/Sao_Paulo';
  day_to timestamptz := (target_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';
  fleet feature_capacity_day[];
BEGIN
  IF feature_set IS NULL
     OR feature_set NOT IN ('dessem_free_v1', 'dessem_augmented_v1') THEN
    RAISE EXCEPTION 'unknown feature set %: expected dessem_free_v1 or dessem_augmented_v1',
      coalesce(feature_set, '<null>') USING ERRCODE = '22023';
  END IF;
  -- Set A carries no DESSEM-sourced value, at either gate. Not a filter: there
  -- is nothing to filter, because the block produces no row to be filtered.
  IF feature_set = 'dessem_free_v1' THEN
    RETURN;
  END IF;
  -- Structural, not a rule, and restated here rather than trusted to the
  -- caller: the DESSEM file for day D is created mid-afternoon on D−1, so at
  -- 09:00 on D−1 the newest one describes D−1 itself.
  IF gate_profile IS DISTINCT FROM 'gate_late' THEN
    RAISE EXCEPTION 'dessem_augmented_v1 exists only at gate_late: DESSEM for day D is not published until the afternoon of D-1'
      USING ERRCODE = '22023';
  END IF;

  -- The capacity-factor denominator, at the gate's vintage and the target
  -- date's valid time, materialised before the axes move.
  SELECT coalesce(
           array_agg(ROW(c.subsystem, c.capacity_wind_mw, c.capacity_solar_mw,
                         c.capacity_wind_added_28d_mw,
                         c.capacity_solar_added_28d_mw)::feature_capacity_day),
           '{}'::feature_capacity_day[])
    INTO fleet
  FROM feature_capacity_block(target_date, gate_profile) c;

  PERFORM feature_apply_gate(target_date, gate_profile);

  RETURN QUERY
  WITH profile AS (
    -- Half hours to hours, and MW to MWh in the same step: half an hour at P MW
    -- is P/2 MWh, so the hour is the *mean* of the two powers. `having count(*)
    -- = 2` is the hole-not-a-half-hour rule — with one half hour surviving the
    -- gate the mean would be a plausible number for a different hour.
    SELECT
      b.subsystem,
      date_trunc('hour', b.valid_time) AS valid_time,
      avg(b.demand_mw) AS demand_mwh,
      avg(b.wind_generation_mw) AS wind_mwh,
      avg(b.solar_generation_mw) AS solar_mwh,
      avg(b.mmgd_generation_mw) AS mmgd_mwh,
      -- The published headers, summed as the spec's feature table defines them:
      -- `val_ger_hidraulica` + `val_ger_pch`, `val_ger_termica` + `val_ger_pct`.
      avg(b.hydro_generation_mw + b.small_hydro_generation_mw) AS hydro_mwh,
      avg(b.thermal_generation_mw + b.small_thermal_generation_mw) AS thermal_mwh,
      avg(b.pumping_consumption_mw) AS pumping_mwh
    FROM canonical_day_ahead_balance b
    WHERE b.valid_time >= day_from AND b.valid_time < day_to
    GROUP BY b.subsystem, date_trunc('hour', b.valid_time)
    HAVING count(*) = 2
  ),
  -- The identities, once, so that everything below reads them rather than
  -- respelling them. `dessem_residual_load_mwh` in particular is spelled in one
  -- place and used in five.
  derived AS (
    SELECT
      profile.*,
      profile.wind_mwh + profile.solar_mwh + profile.mmgd_mwh AS vre_mwh,
      profile.demand_mwh - profile.wind_mwh - profile.solar_mwh
        - profile.mmgd_mwh AS residual_load_mwh
    FROM profile
  ),
  -- Everything the profile can say about itself, in one pass — the same shape
  -- as `0024`'s, and legal for the same reason: a D−1 publication carries the
  -- whole of day D, so a difference inside it reaches only into hours the same
  -- publication already carried. `rank()` orders ascending, so rank 1 is the
  -- day's residual-load trough and rank 24 its peak — the same direction as
  -- `dessem_residual_load_min_of_day` beside it.
  shaped AS (
    SELECT
      derived.*,
      lag(derived.valid_time) OVER hourly AS previous_hour,
      lag(derived.demand_mwh) OVER hourly AS previous_demand,
      lag(derived.residual_load_mwh) OVER hourly AS previous_residual,
      lag(derived.vre_mwh) OVER hourly AS previous_vre,
      min(derived.residual_load_mwh) OVER whole_day AS day_min_residual,
      rank() OVER (PARTITION BY derived.subsystem
                   ORDER BY derived.residual_load_mwh)::int AS rank_in_day,
      count(*) OVER whole_day AS hours_in_day
    FROM derived
    WINDOW hourly AS (PARTITION BY derived.subsystem ORDER BY derived.valid_time),
           whole_day AS (PARTITION BY derived.subsystem)
  ),
  -- The system-wide total: a derived sum over the four subsystems, which is the
  -- only form `docs/domain-model.md` §2 allows a national figure to take. NULL
  -- unless all four reported the hour — a sum over three is the residual load of
  -- a different system, and it would drift downward exactly when one subsystem's
  -- file was thin.
  system_hour AS (
    SELECT derived.valid_time, sum(derived.residual_load_mwh) AS sin_residual_load_mwh
    FROM derived
    GROUP BY derived.valid_time
    HAVING count(*) = 4
  ),
  -- The absorbing subsystem's own residual load, keyed by hour so it can be
  -- carried onto the northern rows.
  absorber AS (
    SELECT derived.valid_time, derived.residual_load_mwh
    FROM derived
    WHERE derived.subsystem = 'SE'
  )
  SELECT
    shaped.subsystem,
    shaped.valid_time,
    shaped.demand_mwh,
    shaped.wind_mwh,
    shaped.solar_mwh,
    shaped.mmgd_mwh,
    shaped.hydro_mwh,
    shaped.thermal_mwh,
    shaped.pumping_mwh,
    shaped.residual_load_mwh,
    -- Three ratios over demand. A zero demand is NULL rather than a division
    -- error or an infinity: DESSEM has never published one, and if it ever does
    -- the honest answer is that the ratio is undefined for that hour.
    CASE WHEN shaped.demand_mwh <> 0 THEN shaped.vre_mwh / shaped.demand_mwh END,
    shaped.vre_mwh - shaped.demand_mwh,
    CASE WHEN shaped.demand_mwh <> 0
         THEN (shaped.hydro_mwh + shaped.thermal_mwh) / shaped.demand_mwh END,
    -- The energy identity, and the reason the column is named *implied*:
    -- generation minus demand minus pumping is net export **up to losses**,
    -- which are not modelled here and are not published anywhere.
    (shaped.hydro_mwh + shaped.thermal_mwh + shaped.vre_mwh)
      - shaped.demand_mwh - shaped.pumping_mwh,
    -- The adjacency check is the point, as it was in `0024`. A neighbouring
    -- *row* is not a neighbouring *hour* once the profile has a gap, and a
    -- `_ramp_1h` that quietly spanned two hours would be wrong in precisely the
    -- rows where the file was already thin. The first hour of D has no ramp at
    -- all: its predecessor belongs to D−1's DESSEM file, which is a different
    -- publication, and a difference across that boundary is a difference of two
    -- forecasts rather than a shape inside one.
    CASE
      WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
      THEN shaped.demand_mwh - shaped.previous_demand
    END,
    CASE
      WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
      THEN shaped.residual_load_mwh - shaped.previous_residual
    END,
    CASE
      WHEN shaped.previous_hour = shaped.valid_time - interval '1 hour'
      THEN shaped.vre_mwh - shaped.previous_vre
    END,
    -- The day-grain pair, NULL unless the profile has all 24 hours: a minimum
    -- over nineteen is the minimum of a different day, and a rank among
    -- nineteen is not the rank the column's name promises.
    CASE WHEN shaped.hours_in_day = 24 THEN shaped.day_min_residual END,
    CASE WHEN shaped.hours_in_day = 24 THEN shaped.rank_in_day END,
    -- Capacity factors against the fleet read at the gate's vintage. A zero or
    -- absent capacity is NULL and never zero: "the fleet is unknown at this
    -- gate" and "the fleet generated nothing" are different statements, and only
    -- one of them is a number.
    CASE WHEN coalesce(fleet_mw.capacity_wind_mw, 0) > 0
         THEN shaped.wind_mwh / fleet_mw.capacity_wind_mw END,
    CASE WHEN coalesce(fleet_mw.capacity_solar_mw, 0) > 0
         THEN shaped.solar_mwh / fleet_mw.capacity_solar_mw END,
    system_hour.sin_residual_load_mwh,
    -- N and NE curtail when SE has no headroom to absorb them. NULL on SE — a
    -- subsystem is not its own absorber, and a copy of the column beside it
    -- would be a duplicate feature wearing a name that promises otherwise — and
    -- NULL on S, which this mechanism does not describe.
    CASE WHEN shaped.subsystem IN ('N', 'NE') THEN absorber.residual_load_mwh END
  FROM shaped
  LEFT JOIN system_hour ON system_hour.valid_time = shaped.valid_time
  LEFT JOIN absorber ON absorber.valid_time = shaped.valid_time
  LEFT JOIN unnest(fleet) AS fleet_mw ON fleet_mw.subsystem = shaped.subsystem
  ORDER BY shaped.valid_time, shaped.subsystem;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_dessem_block(date, text, text) IS
  'Class D: ONS DESSEM day-ahead balance for the subsystem-hour, cut on published_at <= gate. Half hours are averaged into hours because DESSEM publishes MW and the row is MWh. Returns no rows at all for dessem_free_v1, and raises 22023 for dessem_augmented_v1 at any gate but gate_late: the DESSEM file for day D is created mid-afternoon on D-1, so at 09:00 on D-1 the newest one describes D-1 itself.';
--> statement-breakpoint

-- Twenty-one columns onto the one declaration, appended.
--
-- `ALTER TYPE ... ADD ATTRIBUTE` appends, so migration order *is* attribute
-- order and this block lands after the class-`P` block of `0024`.
-- `docs/specs/forecaster.md` hashes the type's ordered names into a lane's
-- `feature_hash`, which is exactly the visible event that hash exists to make.
--
-- Twenty-one, not the spec's twenty-two: `dessem_export_utilisation` needs an
-- export capability estimate that does not exist yet and is ticket 10's.
ALTER TYPE feature_row ADD ATTRIBUTE dessem_demand_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_wind_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_solar_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_mmgd_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_hydro_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_thermal_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_pumping_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_residual_load_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_renewable_load_ratio double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_vre_surplus_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_inflexible_share double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_implied_net_export_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_demand_ramp_1h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_residual_load_ramp_1h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_vre_ramp_1h double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_residual_load_min_of_day double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_residual_load_rank_in_day integer;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_wind_capacity_factor double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_solar_capacity_factor double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_sin_residual_load_mwh double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_absorber_residual_load_mwh double precision;--> statement-breakpoint

-- The catalogue copy of the caveats, at the column itself. A caveat a modeller
-- cannot find from the column is a caveat nobody applies.
COMMENT ON COLUMN feature_row.dessem_demand_mwh IS
  'ONS DESSEM day-ahead demand for the subsystem-hour, val_demanda, cut on published_at <= gate. Present only in dessem_augmented_v1 and only at gate_late: the DESSEM file for day D is created mid-afternoon on D-1, so a caller asking for the augmented set at gate_early is refused rather than handed NULLs. DESSEM publishes MW at 30-minute grain; the two half hours are averaged, which is the hours energy.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_wind_mwh IS
  'DESSEM val_ger_eolica for the subsystem-hour, averaged from MW to the hours MWh. Augmented set only, gate_late only.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_solar_mwh IS
  'DESSEM val_ger_fotovoltaica, utility-scale PV: not the same fleet as val_ger_mmgd beside it. Augmented set only, gate_late only.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_mmgd_mwh IS
  'DESSEM val_ger_mmgd: ONS modelled distributed generation, not a metered quantity. Augmented set only, gate_late only.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_hydro_mwh IS
  'DESSEM val_ger_hidraulica + val_ger_pch. The two are summed here because the feature table defines hydro as the pair; the canonical view keeps them apart, as ONS publishes them.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_thermal_mwh IS
  'DESSEM val_ger_termica + val_ger_pct, summed for the reason dessem_hydro_mwh is.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_pumping_mwh IS
  'DESSEM val_cons_elevatoria, pumping load: a consumption and therefore subtracted in the net-export identity rather than added.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_residual_load_mwh IS
  'demand - wind - solar - mmgd, from DESSEM own quantities. The load the dispatchable fleet must serve, day ahead. Set B answer to proxy_residual_load_mwh, and one of the four features that would justify the augmented set trade.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_renewable_load_ratio IS
  '(wind + solar + mmgd) / demand, from DESSEM own quantities. NULL where demand is zero rather than infinite.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_vre_surplus_mwh IS
  '(wind + solar + mmgd) - demand. Positive where the day-ahead VRE expectation exceeds the subsystem own demand, which is the condition export limits bind under.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_inflexible_share IS
  '(hydro + thermal) / demand, from DESSEM own quantities. NULL where demand is zero.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_implied_net_export_mwh IS
  '(hydro + thermal + wind + solar + mmgd) - demand - pumping. DESSEM publishes no exchange column, so net export is derived from the energy identity. Named implied because transmission losses are not modelled and ONS publishes no day-ahead loss figure to model them from: it is a signal for the northern export limits, not a measured flow. The utilisation ratio that would divide it needs an export capability estimate that does not exist yet.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_demand_ramp_1h IS
  'Difference within the day-D DESSEM profile. Legal because a D-1 publication carries the whole of day D at once. NULL at the first hour of the local day, whose predecessor belongs to D-1 own DESSEM file, and NULL wherever the previous row is not the previous hour.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_residual_load_ramp_1h IS
  'Difference of dessem_residual_load_mwh within the day-D profile, with the same edge and adjacency rules as dessem_demand_ramp_1h.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_vre_ramp_1h IS
  'Difference of (wind + solar + mmgd) within the day-D profile, with the same edge and adjacency rules as dessem_demand_ramp_1h.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_residual_load_min_of_day IS
  'Minimum of the 24 DESSEM residual loads of the target date. Day grain: constant across the 24 hours of the day, and not an hourly signal. NULL unless the profile has all 24 hours, because a minimum over a partial day is the minimum of a different day.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_residual_load_rank_in_day IS
  'Rank of the target hour among the 24 DESSEM residual loads of its day, ascending: 1 is the days trough and 24 its peak, matching the direction of dessem_residual_load_min_of_day. NULL unless the profile has all 24 hours.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_wind_capacity_factor IS
  'dessem_wind_mwh / (capacity_wind_mw x 1 h), the fleet read at the gates vintage and the target dates valid time. The same double as-of, and the same reading, as capacity_wind_mw in this row. NULL where the fleet is unknown or zero at that gate, never zero.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_solar_capacity_factor IS
  'dessem_solar_mwh / (capacity_solar_mw x 1 h), on the same terms as dessem_wind_capacity_factor. The numerator is utility-scale PV only, so MMGD is deliberately outside a ratio whose denominator is the registered fleet.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_sin_residual_load_mwh IS
  'Sum of dessem_residual_load_mwh over the four subsystems for this hour. A derived sum, which is the only form a national total may take, because SIN is not a Subsystem. A system fact, broadcast identically to all four rows of the hour. NULL unless all four subsystems reported the hour.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_absorber_residual_load_mwh IS
  'SE dessem_residual_load_mwh, carried onto the N and NE rows: N and NE curtail when SE has no headroom to absorb what they export. A physical asymmetry rather than a statistic. NULL on SE own rows, because a subsystem is not its own absorber, and NULL on S, which this mechanism does not describe.';
--> statement-breakpoint

-- `feature_rows(...)` again — the same function, one more join.
--
-- Restated in full because a function body cannot be patched, and restated from
-- `0024`'s definition rather than from an older copy: `ALTER TYPE ... ADD
-- ATTRIBUTE` appends, so migration order *is* attribute order, and a
-- restatement that rebuilt the select list from `0021` would emit the columns in
-- an order Postgres reports as "returned type X does not match expected type Y
-- in column N" — if it is lucky, and as two silently swapped columns if it is
-- not. Every prior block's columns are in their existing positions and the
-- twenty-one new ones are last.
--
-- The spine is untouched: the signature still holds no instant of any kind, the
-- gate is still resolved per target date inside the loop, and the new block is
-- joined exactly as weather, capacity, calendar, the class-`K` block and the
-- class-`P` block already were. The one difference is that this block is handed
-- the feature set as well — the argument that gates it — and the set is not an
-- instant and cannot become one.
--
-- The fidelity stamp gains one source. DESSEM now feeds features, so its
-- go-live joins the weakest-link rule: a row whose spine had to be answered
-- from a series WattSteer was not yet watching is `revision_optimistic` as a
-- whole, because a consumer cannot use half of it. It joins for both sets, not
-- only the augmented one — a set-A row is not more trustworthy for having asked
-- DESSEM nothing, and a fidelity stamp that moved with the feature set would be
-- a second definition of fidelity.
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
      -- programme the class-`P` block reads, and the DESSEM balance.
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
      dessem.dessem_absorber_residual_load_mwh
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
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. Capacity is a double as-of: valid time D, vintage the gate. The calendar and astronomy block is class T and reads no vintage at all. The class K block is cut on valid_time <= actuals_cutoff(gate, dataset), which is the only cut an observation-sourced feature may rely on. The class P block is ONS day-ahead programming, cut on publication like every other forecast. The class D block is the DESSEM balance: it exists only for dessem_augmented_v1 and only at gate_late, and for dessem_free_v1 it returns no rows at all, so a set-A row carries no DESSEM-sourced value at either gate.';

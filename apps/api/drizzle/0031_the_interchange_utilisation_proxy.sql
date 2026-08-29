-- The interchange utilisation proxy, and its estimated denominator.
--
-- Hand-written, like `0012_canonical_read_axes.sql`, `0016_the_feature_gate.sql`,
-- `0017_capacity_at_the_gate.sql`, `0019_calendar_and_astronomy.sql`,
-- `0021_lagged_actuals_behind_the_cutoff.sql`, `0024_day_ahead_programming.sql`,
-- `0025_dessem_and_the_feature_set.sql`, `0029_the_weather_block.sql` and
-- `0030_the_proxy_residual_load.sql`, and for the same reason: drizzle-kit
-- generates tables and views, not function DDL.
--
-- ## There is no published transfer limit, and this file says so rather than
-- ## working around it
--
-- `docs/specs/feature-engineering.md` §"The interchange utilisation proxy"
-- records the answer to the open question: **no**. The ONS Dados Abertos
-- catalogue was enumerated in full — 84 packages — and contains
-- no transfer-limit dataset at any grain, none. `intercambio-nacional` publishes
-- *realised* flow and, from 2026 only, programmed flow. There is nothing to
-- divide by. Whether limits exist behind ONS Sintegre (authenticated) was not
-- investigated and stays an open question; even if they do, they would be
-- study-horizon values rather than hourly operational limits.
--
-- So the denominator is **estimated**, it is labelled an estimate at every
-- column that divides by it, and it is published per directed corridor **with
-- its sample size** so a screen can show it as one. A ratio with an invented
-- limit in the denominator would be a worse answer than a missing column, and
-- an estimate nobody can tell from a measurement is exactly that.
--
-- ## The estimator, and why each choice is load-bearing
--
--     export_capability_estimate(corridor, gate)
--       = P99.5 of directed flow over the 365 days ending at
--         actuals_cutoff(gate, 'intercambio-nacional')
--
--   * **A high quantile, not a maximum.** A maximum is one outlier hour
--     defining a year of denominators. At hourly grain P99.5 is roughly 44
--     hours a year — plausibly the binding regime, and robust to a single bad
--     record.
--   * **Trailing and gate-bounded**, so the denominator cannot see the future.
--     This matters more than it looks: a naive whole-history maximum leaks a
--     2026 record flow into a 2024 feature, and it does so through a column
--     nobody would think to ablate. The estimator is therefore cut on the same
--     `actuals_cutoff` axis as every other class-`K` read — on `valid_time`,
--     never on a vintage, for `0021`'s reason: over the backfill window
--     `AsOf(gate)` filters nothing at all.
--   * **A minimum sample.** Fewer than 300 non-null hours in the trailing year
--     yields NULL rather than a denominator computed from noise. A P99.5 over
--     twelve observations is the second-largest of twelve, which is a maximum
--     wearing a quantile's name.
--   * **A non-positive estimate is NULL, not a denominator.** A directed
--     corridor whose P99.5 is at or below zero has never carried energy that
--     way in the trailing year; the utilisation of a direction that does not
--     exist is undefined, and dividing by it would produce a sign flip rather
--     than a ratio.
--
-- **The proxy works because of the tautology, not despite it.** When a corridor
-- binds, observed flow *is* the limit — which is why historical maxima
-- approximate it, and equally why it is only meaningful for corridors that
-- actually bind (NE→SE, N→NE). For a corridor that never binds the ratio is a
-- scaled flow, and the model should be allowed to discover that it is
-- uninformative rather than have this file decide it.
--
-- **Named limitation, and it is the one that matters.** This is a *capability*
-- proxy. It cannot see a temporary derate from a line outage — which is
-- exactly the condition the `REL` reason code names (external grid
-- unavailability, `docs/domain-model.md`). So a utilisation of 0.6 on a day
-- half the corridor is out is a corridor at its limit, and nothing in this
-- number says so. That is why the estimate is published per directed corridor
-- with its sample size, and why every column below carries the word "estimate"
-- in its catalogue comment.
--
-- ## One estimate, and no second one anywhere
--
-- Three columns divide by it, and all three reach the *same* function:
--
--   * `observed_export_utilisation_mean_24h_to_cutoff` — class `K`;
--   * `observed_corridor_utilisation_ne_se_max_7d` — class `K`;
--   * `dessem_export_utilisation` — class `D`+`K`, the twenty-second name of
--     the augmented set, which ticket 07 deliberately left out of its
--     twenty-one rather than invent a denominator for.
--
-- That is the point of landing them together. Split across two tickets, the
-- DESSEM ratio and the observed ratios would each have grown a denominator of
-- their own, and the augmented set would carry two disagreeing estimates of the
-- same physical quantity in one row.
--
-- ## The two deferred columns of ticket 05 close here too
--
-- `0021` built the directed corridor *flows* and refused the ratios, in its own
-- words, because "that estimator is its own ticket". This is that ticket. The
-- flows stay where they are — they are levels and belong in the class-`K` block
-- — and the ratios live here beside the estimate they divide by, because a
-- ratio is only as trustworthy as the denominator sitting next to it.
--
-- ## A subsystem's export capability is a sum of its corridors', and that is
-- ## an aggregation rather than a second estimate
--
-- Two of the three columns are per *subsystem* and the estimate is per
-- *directed corridor*, so something has to bridge them. The bridge is the sum
-- of the estimates of the corridors leaving that subsystem, over exactly those
-- corridors that have an estimate — no new quantile, no second window, no
-- second minimum sample. It has one honest caveat, stated at the column: the
-- corridors do not peak together, so a sum of per-corridor P99.5s is an
-- **upper** bound on simultaneous export capability, and the ratio it
-- denominates is correspondingly conservative. That is a bias in a known
-- direction, which is a different thing from a number nobody can reason about.

-- One directed corridor's estimate, with the sample it was computed from.
--
-- The sample size is a returned column rather than a comment because it is the
-- thing that distinguishes an estimate from a measurement to whoever reads it.
-- `export_capability_mwh` is NULL where the sample is short or the direction
-- never carried energy; `sample_hours` is populated either way, so "we have no
-- estimate" and "we have no data" are distinguishable.
CREATE TYPE feature_export_capability_corridor AS (
  from_subsystem subsystem_code,
  to_subsystem subsystem_code,
  export_capability_mwh double precision,
  sample_hours integer
);
--> statement-breakpoint

-- The estimator itself — the one place the denominator is computed.
--
-- A target date and a gate profile and **no instant**, exactly as every block
-- since `0016` has. The trailing year ends at `actuals_cutoff`, which is
-- derived from the target date inside `actuals_cutoff` itself, so there is no
-- argument here through which a hand-chosen window could arrive.
--
-- `canonical_system_exchange` stores one row per *undirected* pair in the
-- canonical orientation (`from_subsystem < to_subsystem` in enum order,
-- positive from → to, enforced by a check constraint on the ingest table). A
-- capability is a property of a **direction**, not of a link — NE→SE and SE→NE
-- are different limits — so the stored row is unfolded into both directions
-- here, the reverse one with its sign flipped. That flip is the whole reason
-- this is not a `GROUP BY from_subsystem, to_subsystem` over the view.
CREATE OR REPLACE FUNCTION feature_export_capability_estimate(
  target_date date, gate_profile text
) RETURNS SETOF feature_export_capability_corridor LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  cut_exchange timestamptz := actuals_cutoff(target_date, gate_profile, 'intercambio-nacional');
BEGIN
  PERFORM feature_apply_gate(target_date, gate_profile);

  RETURN QUERY
  -- Half-open at the bottom and closed at the top, the same frame shape as
  -- every other trailing window in the feature layer.
  WITH trailing_year AS (
    SELECT x.from_subsystem, x.to_subsystem, x.valid_time, x.verified_exchange_mwh
    FROM canonical_system_exchange x
    WHERE x.valid_time > cut_exchange - interval '365 days'
      AND x.valid_time <= cut_exchange
  ),
  -- Both directions of every stored link, the reverse one negated.
  directed AS (
    SELECT t.from_subsystem, t.to_subsystem, t.verified_exchange_mwh AS directed_mwh
    FROM trailing_year t
    UNION ALL
    SELECT t.to_subsystem, t.from_subsystem, -t.verified_exchange_mwh
    FROM trailing_year t
  ),
  estimated AS (
    SELECT d.from_subsystem,
           d.to_subsystem,
           count(d.directed_mwh)::int AS sample_hours,
           percentile_cont(0.995) WITHIN GROUP (ORDER BY d.directed_mwh) AS p995
    FROM directed d
    GROUP BY d.from_subsystem, d.to_subsystem
  )
  SELECT
    estimated.from_subsystem,
    estimated.to_subsystem,
    -- The two refusals, spelled once: too few hours, or a direction that never
    -- carried energy. Both yield NULL, and the sample size beside them says
    -- which.
    CASE
      WHEN estimated.sample_hours >= 300 AND estimated.p995 > 0
      THEN estimated.p995
    END,
    estimated.sample_hours
  FROM estimated
  ORDER BY estimated.from_subsystem, estimated.to_subsystem;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_export_capability_estimate(date, text) IS
  'An ESTIMATE of directed export capability, per directed corridor, with the sample size it was computed from. P99.5 of directed flow over the 365 days ending at actuals_cutoff(gate, intercambio-nacional). No ONS dataset publishes a transfer limit at any grain, so there is nothing to measure this against; it is a capability proxy that cannot see a temporary derate from a line outage, which is the condition the REL reason code names. NULL where the trailing year holds fewer than 300 non-null hours, or where the direction never carried energy. The only denominator in the feature layer: every utilisation ratio reaches this function rather than estimating one of its own.';
--> statement-breakpoint

-- The three ratios, at (subsystem, hour).
--
-- Two class-`K` and one class-`D`+`K`, in one block because they share a
-- denominator and sharing it is the property worth having.
CREATE TYPE feature_interchange_utilisation_hour AS (
  subsystem subsystem_code,
  valid_time timestamptz,
  observed_export_utilisation_mean_24h_to_cutoff double precision,
  observed_corridor_utilisation_ne_se_max_7d double precision,
  dessem_export_utilisation double precision
);
--> statement-breakpoint

-- The utilisation block.
--
-- It is handed the feature set for one reason only: `dessem_export_utilisation`
-- is a class-`D` numerator, and the class-`D` block is the one block whose
-- existence the set decides. At `dessem_free_v1` that block returns no rows, so
-- the DESSEM ratio is NULL because the join found nothing — and the two
-- class-`K` ratios beside it are unaffected, because they are in both sets and
-- read a series that exists in both windows.
--
-- Composition rather than a second read, on `0030`'s rule: the numerator of the
-- DESSEM ratio is `feature_dessem_block`'s own `dessem_implied_net_export_mwh`,
-- so the ratio and the quantity it divides are the same number in the same row
-- and cannot disagree.
CREATE OR REPLACE FUNCTION feature_interchange_utilisation_block(
  target_date date, gate_profile text, feature_set text
) RETURNS SETOF feature_interchange_utilisation_hour LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  cut_exchange timestamptz := actuals_cutoff(target_date, gate_profile, 'intercambio-nacional');
  capability feature_export_capability_corridor[];
  balance feature_dessem_hour[];
BEGIN
  -- Whole, one after the other, before anything is composed. Each writes all
  -- four read axes at its own start; neither may be evaluated inside the
  -- other's.
  SELECT coalesce(array_agg(c), '{}'::feature_export_capability_corridor[])
    INTO capability
  FROM feature_export_capability_estimate(target_date, gate_profile) c;

  SELECT coalesce(array_agg(b), '{}'::feature_dessem_hour[])
    INTO balance
  FROM feature_dessem_block(
    target_date, gate_profile, feature_interchange_utilisation_block.feature_set
  ) b;

  -- Back to this block's own axes before the one view it reads for itself. The
  -- two blocks above each left the axes where their last read wanted them.
  PERFORM feature_apply_gate(target_date, gate_profile);

  RETURN QUERY
  WITH spine AS (
    SELECT s.subsystem, h.valid_time
    FROM unnest(enum_range(NULL::subsystem_code)) AS s(subsystem)
    CROSS JOIN feature_local_day_hours(target_date) AS h(valid_time)
  ),
  -- The corridors that actually have an estimate. Everything below joins
  -- through this, so a corridor with a short sample contributes to no
  -- numerator and to no denominator — rather than to a numerator alone, which
  -- would be a ratio quietly missing a term.
  corridor AS (
    SELECT c.from_subsystem, c.to_subsystem, c.export_capability_mwh
    FROM unnest(capability) AS c
    WHERE c.export_capability_mwh IS NOT NULL
  ),
  -- A subsystem's export capability: the sum over the corridors leaving it.
  -- An aggregation of the one estimate, not a second one. It is an upper bound
  -- — the corridors do not peak together — and the columns that divide by it
  -- say so.
  subsystem_capability AS (
    SELECT corridor.from_subsystem AS subsystem,
           sum(corridor.export_capability_mwh) AS capability_mwh
    FROM corridor
    GROUP BY corridor.from_subsystem
  ),
  -- Seven days of realised flow ending at the cutoff, the same frame the
  -- class-`K` block reads the same view through.
  exchange_window AS (
    SELECT x.from_subsystem, x.to_subsystem, x.valid_time, x.verified_exchange_mwh
    FROM canonical_system_exchange x
    WHERE x.valid_time > cut_exchange - interval '168 hours'
      AND x.valid_time <= cut_exchange
  ),
  directed_hours AS (
    SELECT e.from_subsystem, e.to_subsystem, e.valid_time,
           e.verified_exchange_mwh AS directed_mwh
    FROM exchange_window e
    UNION ALL
    SELECT e.to_subsystem, e.from_subsystem, e.valid_time, -e.verified_exchange_mwh
    FROM exchange_window e
  ),
  -- What the subsystem exported in an hour, over the corridors it has an
  -- estimate for.
  export_hours AS (
    SELECT directed_hours.from_subsystem AS subsystem,
           directed_hours.valid_time,
           sum(directed_hours.directed_mwh) AS export_mwh
    FROM directed_hours
    JOIN corridor
      ON corridor.from_subsystem = directed_hours.from_subsystem
     AND corridor.to_subsystem = directed_hours.to_subsystem
    GROUP BY directed_hours.from_subsystem, directed_hours.valid_time
  ),
  -- The mean of the *ratio* over the last 24 available hours, not the ratio of
  -- the means. The denominator is constant across the window, so the two agree
  -- arithmetically today and would stop agreeing the day the estimate becomes
  -- time-varying; the spec says "mean of flow / capability" and this is that.
  export_utilisation AS (
    SELECT export_hours.subsystem,
           avg(export_hours.export_mwh / subsystem_capability.capability_mwh) AS mean_24h
    FROM export_hours
    JOIN subsystem_capability
      ON subsystem_capability.subsystem = export_hours.subsystem
    WHERE export_hours.valid_time > cut_exchange - interval '24 hours'
    GROUP BY export_hours.subsystem
  ),
  -- The one corridor the spec names, in the one direction it binds in. A
  -- system-level fact, so the same number is broadcast to all four subsystems
  -- — exactly as `0021` broadcasts the corridor flows, and for the same
  -- reason: a corridor is not a property of one end of it.
  corridor_utilisation AS (
    SELECT max(directed_hours.directed_mwh / corridor.export_capability_mwh) AS max_7d
    FROM directed_hours
    JOIN corridor
      ON corridor.from_subsystem = directed_hours.from_subsystem
     AND corridor.to_subsystem = directed_hours.to_subsystem
    WHERE directed_hours.from_subsystem = 'NE'
      AND directed_hours.to_subsystem = 'SE'
  )
  SELECT
    spine.subsystem,
    spine.valid_time,
    export_utilisation.mean_24h,
    corridor_utilisation.max_7d,
    -- The twenty-second name of the augmented set. The numerator is the class-`D`
    -- block's own implied net export and the denominator is the one estimate,
    -- so this column disagrees with neither the quantity above it nor the two
    -- class-`K` ratios beside it.
    balance_hour.dessem_implied_net_export_mwh / subsystem_capability.capability_mwh
  FROM spine
  LEFT JOIN subsystem_capability
    ON subsystem_capability.subsystem = spine.subsystem
  LEFT JOIN export_utilisation
    ON export_utilisation.subsystem = spine.subsystem
  LEFT JOIN unnest(balance) AS balance_hour
    ON balance_hour.subsystem = spine.subsystem
   AND balance_hour.valid_time = spine.valid_time
  CROSS JOIN corridor_utilisation
  ORDER BY spine.valid_time, spine.subsystem;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_interchange_utilisation_block(date, text, text) IS
  'Class K and class D+K: the three utilisation ratios, all dividing by feature_export_capability_estimate and never by an estimate of their own. The two observed ratios are cut on valid_time <= actuals_cutoff(gate, intercambio-nacional), like every other observation-sourced feature. The DESSEM ratio composes feature_dessem_block rather than re-reading the balance, so it cannot disagree with dessem_implied_net_export_mwh in its own row, and it is NULL for dessem_free_v1 because that block returns no rows there.';
--> statement-breakpoint

-- Three columns onto the one declaration, appended.
--
-- `ALTER TYPE ... ADD ATTRIBUTE` appends, so migration order *is* attribute
-- order and this block lands after the class-`P`+`W`+`T` block of `0030`.
-- `docs/specs/forecaster.md` hashes the type's ordered names into a lane's
-- `feature_hash`, which is exactly the visible event that hash exists to make.
-- The two `observed_` names sit after the `proxy_` family rather than beside
-- their class-`K` siblings, and that is what appending means: the row type's
-- order is the tree's history, not a grouping.
ALTER TYPE feature_row ADD ATTRIBUTE observed_export_utilisation_mean_24h_to_cutoff double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE observed_corridor_utilisation_ne_se_max_7d double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE dessem_export_utilisation double precision;--> statement-breakpoint

-- The catalogue copy of the caveats, at the column itself. A caveat a modeller
-- cannot find from the column is a caveat nobody applies — and the caveat here
-- is the whole feature, so the word "estimate" is in all three.
COMMENT ON COLUMN feature_row.observed_export_utilisation_mean_24h_to_cutoff IS
  'Class K. Mean over the last 24 available hours of the subsystem''s realised export divided by an ESTIMATE of its export capability. No ONS dataset publishes a transfer limit at any grain, so the denominator is feature_export_capability_estimate: P99.5 of directed flow over the trailing 365 days ending at the same cutoff, summed over the corridors leaving this subsystem that have an estimate. That sum is an upper bound on simultaneous capability - the corridors do not peak together - so this ratio is conservative in a known direction. It is a capability proxy and cannot see a temporary derate from a line outage, which is the condition REL names. Day grain: the window is anchored to actuals_cutoff rather than to the target hour, so it is constant across the 24 hours of the day. NULL where no corridor leaving the subsystem has an estimate.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.observed_corridor_utilisation_ne_se_max_7d IS
  'Class K. Maximum over the seven days ending at actuals_cutoff of directed NE->SE flow divided by the same ESTIMATE of that corridor''s capability. A system-level fact, broadcast identically to all four subsystems, exactly as observed_corridor_flow_ne_se_lag_168h is: a corridor is not a property of one end of it. NE->SE is one of the two corridors that bind, which is what makes the tautology behind the estimate work: when a corridor binds, observed flow is the limit. Day grain. NULL where the corridor has no estimate.';
--> statement-breakpoint
COMMENT ON COLUMN feature_row.dessem_export_utilisation IS
  'Class D+K. dessem_implied_net_export_mwh divided by the same ESTIMATE of the subsystem''s export capability - the twenty-second name of the augmented set, which drizzle/0025 left out rather than invent a denominator for. The numerator is DESSEM''s day-ahead energy identity and carries its own caveat (transmission losses are not modelled); the denominator is class K, computed from flows observed before the gate, so this one column is the only place in the row where a class-D quantity meets a class-K one. NULL for dessem_free_v1, where the class-D block returns no rows at all, and NULL where the subsystem has no capability estimate.';
--> statement-breakpoint

-- `feature_rows(...)` again — the same function, one wider join.
--
-- Restated in full because a function body cannot be patched, and restated from
-- `0030`'s definition rather than from an older copy: `ALTER TYPE ... ADD
-- ATTRIBUTE` appends, so migration order *is* attribute order, and a
-- restatement that rebuilt the select list from `0029` would emit the columns
-- in an order Postgres reports as "returned type X does not match expected type
-- Y in column N" — if it is lucky, and as two silently swapped columns if it is
-- not. Every prior block's columns are in their existing positions and the
-- three new ones are last.
--
-- The spine is untouched: the signature still holds no instant of any kind, and
-- the gate is still resolved per target date inside the loop. The new CTE *is*
-- handed the feature set, because one of its three columns has a class-`D`
-- numerator — and at `dessem_free_v1` the class-`D` block it composes returns
-- nothing, so `dessem_export_utilisation` is NULL there while the two class-`K`
-- ratios beside it are not.
--
-- The fidelity stamp gains no source: the one series this block reads for
-- itself is `intercambio-nacional`, whose go-live is already in the
-- weakest-link rule below as `exchange_go_live`.
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
      utilisation.dessem_export_utilisation
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
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. Capacity is a double as-of: valid time D, vintage the gate. The class W block is the twelve pinned weather variables capacity-weighted over the frozen centroids, per subsystem, with the weights recomputed per target date. The calendar and astronomy block is class T and reads no vintage at all. The class K block is cut on valid_time <= actuals_cutoff(gate, dataset), which is the only cut an observation-sourced feature may rely on. The class P block is ONS day-ahead programming, cut on publication like every other forecast. The class D block is the DESSEM balance: it exists only for dessem_augmented_v1 and only at gate_late, and for dessem_free_v1 it returns no rows at all, so a set-A row carries no DESSEM-sourced value at either gate. The proxy block is class P+W+T: it composes the class P and class W blocks rather than reading a source of its own, it is in both feature sets so the two views of residual load are comparable, and it is NULL at gate_early because the programme it subtracts from is. The utilisation block is class K and class D+K: three ratios that all divide by feature_export_capability_estimate, an ESTIMATE of directed export capability computed as P99.5 of directed flow over the trailing 365 days ending at the same actuals_cutoff, because no ONS dataset publishes a transfer limit at any grain. There is exactly one such estimate and every ratio reaches it.';

-- The gate, end to end — the spine every feature ticket inherits.
--
-- Hand-written, like `0012_canonical_read_axes.sql` and for the same reason:
-- drizzle-kit generates tables and views, not function DDL, and the whole of
-- this migration is functions.
--
-- ## The one idea
--
-- The point at which the future becomes unknowable is a **function of the
-- target date**, not a property of the caller:
--
--     gate_at(target_date, gate_profile) -> timestamptz
--
-- `feature_rows(...)` takes a date range, a gate profile, a feature set and a
-- threshold. It takes **no instant of any kind** — there is no `as_of`, no
-- `published_at_or_before`, no cutoff parameter, and therefore no place for a
-- caller to put one. Training passes a range and serving passes
-- `target_from = target_to = tomorrow`; both then execute the same loop body
-- over the same views, and train/serve skew stops being something to avoid and
-- becomes something that cannot be written down.
--
-- That property is structural, and these are the three walls holding it up:
--
-- 1. **No function here accepts a cutoff.** `feature_apply_gate` takes a target
--    date and a profile and derives the gate itself. There is no entry point
--    into the feature layer through which a different instant could arrive, so
--    a future feature cannot resolve against one — not because a test forbids
--    it, but because there is nothing to call.
-- 2. **The axes are written here, not by the caller.** The canonical views read
--    `wattsteer.as_of` and friends from the session (`0012`), and every block
--    below writes *all four* before it reads, exactly as `contract/scope.ts`
--    does and for the same reason: a block that wrote only the axes it cared
--    about would inherit the previous block's gate. Whatever the caller had set
--    is overwritten, and `feature_release_axes()` clears them again at the end
--    so that the *next* canonical read in the same transaction raises `22023`
--    rather than quietly inheriting a feature-side gate.
-- 3. **Everything is read through the canonical views.** No ingest table name
--    appears in this file. The feature function is the one place ONS's
--    conventions would get reimplemented, so it must not be able to see a
--    padded code, an average-power value or an end-of-interval timestamp in the
--    first place.
--
-- ## The deliberate asymmetry: features at the gate, labels at now
--
-- Features are read `AsOf(gate)`. Labels are read `AsOf(now)`. This is the one
-- place the point-in-time discipline is broken **on purpose**
-- (`docs/specs/feature-engineering.md` §"Labels"): a model should learn to
-- predict what actually happened, not ONS's first draft of it. Using the
-- settled restatement of a label is measurement-error reduction and not
-- leakage, because the label for hour *t* is a statement about hour *t* and
-- about nothing later. The two vintages are two functions —
-- `feature_apply_gate` and `feature_apply_label_vintage` — so which side of the
-- asymmetry a block is on is visible in the call and cannot be a subtlety of a
-- `WHERE` clause.
--
-- The consequence for the ablation test is the part worth stating: deleting
-- post-gate source rows must not move a **feature**, and is expected to move a
-- **label**. That is why the seam compares the non-`y_` columns.
--
-- ## Fail closed
--
-- `0012` established the posture: `canonical_as_of()` raises rather than
-- defaulting to `now()`, because a default would turn a forgotten axis into a
-- latest-version read indistinguishable from a correct answer. An unresolved
-- gate is the same hazard one layer up, so every one of the following raises
-- `22023` instead of returning NULL or a default: an unknown gate profile, an
-- unknown feature set, a missing or negative threshold, a backwards date range,
-- `dessem_augmented_v1` at `gate_early` (which is structural — DESSEM for day D
-- does not exist at 09:00 on D−1), and a target date that does not have exactly
-- 24 distinct local hours.

-- The gate itself. Brasília local civil time; the window carries no DST
-- transition and this asserts it rather than assuming it.
--
--   gate_early  D−1 09:00 BRT  — the D−1 00Z weather run, no DESSEM
--   gate_late   D−1 19:00 BRT  — the D−1 12Z run, DESSEM published mid-afternoon
--
-- `America/Sao_Paulo` by full IANA name, never a fixed −3 offset: the fixed
-- offset is right today and was wrong every summer before 2019, and a feature
-- window that reaches back before then would shift by an hour with nothing
-- saying so.
CREATE OR REPLACE FUNCTION gate_at(target_date date, gate_profile text)
  RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  local_hour int;
  local_wall timestamp;
  gate timestamptz;
BEGIN
  IF target_date IS NULL THEN
    RAISE EXCEPTION 'gate_at requires a target date: the gate is a function of one'
      USING ERRCODE = '22023';
  END IF;

  local_hour := CASE gate_profile
                  WHEN 'gate_early' THEN 9
                  WHEN 'gate_late' THEN 19
                END;
  IF local_hour IS NULL THEN
    RAISE EXCEPTION 'unknown gate profile %: expected gate_early or gate_late',
      coalesce(gate_profile, '<null>') USING ERRCODE = '22023';
  END IF;

  local_wall := (target_date - 1)::timestamp + make_interval(hours => local_hour);
  gate := local_wall AT TIME ZONE 'America/Sao_Paulo';

  -- The gate must be a real wall-clock instant. Round-tripping it back into
  -- local time catches a spring-forward that swallowed the hour, which would
  -- otherwise silently move the gate.
  IF (gate AT TIME ZONE 'America/Sao_Paulo') <> local_wall THEN
    RAISE EXCEPTION 'gate % for % does not exist in America/Sao_Paulo: a DST transition moved it',
      local_wall, target_date USING ERRCODE = '22023';
  END IF;

  RETURN gate;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION gate_at(date, text) IS
  'The D-1 decision gate as a function of the target date. gate_early = D-1 09:00 BRT, gate_late = D-1 19:00 BRT. Raises 22023 on an unknown profile rather than returning null.';
--> statement-breakpoint

-- The 24 hours of a target date, as UTC instants, in local civil order.
--
-- The row spine is generated from the calendar and never from the data, so a
-- subsystem-hour with no weather and no settled label is still a row — a hole
-- the model can see rather than an absence it cannot.
--
-- This is also the DST canary `docs/specs/feature-engineering.md` §"Timezone"
-- asks for. Brazil has observed no summer time since 2019 and the whole feature
-- window is DST-free, so no DST handling is built; should Brazil reinstate it,
-- the first affected target date fails here instead of quietly duplicating or
-- dropping an hour inside every feature built for it.
CREATE OR REPLACE FUNCTION feature_local_day_hours(target_date date)
  RETURNS SETOF timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE hours timestamptz[];
BEGIN
  SELECT array_agg(h ORDER BY h) INTO hours
  FROM generate_series(
         target_date::timestamp AT TIME ZONE 'America/Sao_Paulo',
         ((target_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
           - interval '1 hour',
         interval '1 hour') AS h;

  IF coalesce(array_length(hours, 1), 0) <> 24 THEN
    RAISE EXCEPTION
      'target date % has % local hours in America/Sao_Paulo, not 24: the DST-free assumption the gate rests on no longer holds',
      target_date, coalesce(array_length(hours, 1), 0) USING ERRCODE = '22023';
  END IF;

  RETURN QUERY SELECT unnest(hours);
END $$;
--> statement-breakpoint

-- `vintageFidelity` in SQL — the third copy, and safe for the reason the second
-- one was.
--
-- `contract/vintage.ts` and `wattsteer_ml/canonical.py` already hold this rule,
-- deliberately: it is two timestamps and an inequality, it is bound in every
-- language by the golden vectors in
-- `packages/core/fixtures/canonical-contract/vintage-fidelity/`, and duplicating
-- it is safe in a way duplicating row-shaping SQL is not. This copy exists
-- because a feature row must carry its own fidelity, and the row is built here.
-- `apps/api/test/database-features.test.ts` runs it against the same vectors.
CREATE OR REPLACE FUNCTION feature_vintage_fidelity(
  window_start timestamptz, go_live_at timestamptz
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    -- A source that has ingested nothing cannot have been watching.
    WHEN go_live_at IS NULL THEN 'revision_optimistic'
    WHEN window_start >= go_live_at THEN 'point_in_time'
    ELSE 'revision_optimistic'
  END
$$;
--> statement-breakpoint

-- The feature-side vintage: everything a feature may see, at the gate.
--
-- **The only way to obtain a feature-side axis in this schema**, and it takes a
-- target date and a profile rather than an instant. That is the wall: there is
-- no function here into which a hand-chosen cutoff could be passed, so a
-- feature that resolves against anything other than `gate_at(...)` cannot be
-- written, only imagined.
--
-- `as_of` and `published_at_or_before` are both the gate, and they are not the
-- same filter. `as_of` cuts on `ingested_at` — what WattSteer had learned.
-- `published_at_or_before` cuts on when the *source* asserted the value, which
-- is what makes a forecast's D−1 availability genuine even in backfill.
-- Forecasts are cut on publication; observations would have to be cut on
-- `valid_time` against a publication lag, which is ticket 05's business and has
-- no feature here yet.
--
-- **A sentence used to stand here and it was false.** It said of `as_of` that
-- "over the backfill window every row was ingested at go-live, so it filters
-- nothing". It filtered *everything*: `ingested_at` is the instant the backfill
-- ran, the gate is a D−1 instant one to two years earlier, and
-- `feature_weather_block('2024-04-10', 'gate_late')` therefore returned zero
-- rows against a database with 2026-ingested weather. Every historical feature
-- row was weatherless. `0039_the_gate_over_a_backfill.sql` replaces the axis
-- this function writes with `feature_as_of(target_date, gate_profile)` and
-- carries the reasoning; it is the current definition of `feature_apply_gate`
-- and the paragraph above is the only part of this one that still holds. This
-- retraction is the sole edit ever made to this file and it changes no DDL.
--
-- The fleet date is the target date: `InstalledCapacityAsOf` is a double as-of,
-- and its valid-time argument is the day being described while its vintage is
-- the gate.
--
-- Every axis is written on every call, absent ones as the empty string, for the
-- reason `contract/scope.ts` states: the settings live on a pooled connection,
-- and a block that wrote only the axes it cared about would inherit the
-- previous block's.
CREATE OR REPLACE FUNCTION feature_apply_gate(target_date date, gate_profile text)
  RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$
DECLARE gate timestamptz := gate_at(target_date, gate_profile);
BEGIN
  PERFORM set_config('wattsteer.as_of', gate::text, true),
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

-- The label-side vintage: the settled restatement, at `AsOf(now())`.
--
-- The other half of the asymmetry, and a separate function so that the choice
-- is a call rather than an argument. Nothing about it varies with the target
-- date, which is exactly why it takes none.
CREATE OR REPLACE FUNCTION feature_apply_label_vintage()
  RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$
DECLARE settled timestamptz := now();
BEGIN
  PERFORM set_config('wattsteer.as_of', settled::text, true),
          set_config('wattsteer.fleet_date', '', true),
          set_config('wattsteer.published_at_or_before', '', true),
          set_config('wattsteer.weather_run_cycle', '', true);
  RETURN settled;
END $$;
--> statement-breakpoint

-- Hand the axes back empty, so the next canonical read in this transaction
-- raises instead of inheriting a gate it never asked for.
CREATE OR REPLACE FUNCTION feature_release_axes()
  RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM set_config('wattsteer.as_of', '', true),
          set_config('wattsteer.fleet_date', '', true),
          set_config('wattsteer.published_at_or_before', '', true),
          set_config('wattsteer.weather_run_cycle', '', true);
END $$;
--> statement-breakpoint

-- One class-`W` weather feature, cut on `published_at <= gate`.
--
-- Class `W` is deliberate: it is the class whose D−1 availability is *genuine*
-- in the backfill window rather than enforced, because a weather row carries
-- its run initialisation as `published_at`. So the cut is provable here, which
-- is what makes this the right single feature to prove the spine with.
--
-- **The geometry is provisional and the gate is not.** The spec defines every
-- weather feature as a capacity-weighted mean over frozen centroids, with wind
-- variables on the wind vector and solar on the solar vector; that weighting,
-- and the centroid-to-subsystem attribution it implies, is ticket 08's, and it
-- needs tickets 03 and 04 first. Until then this is the unweighted mean over
-- every centroid that reported the hour, which is the same number for all four
-- subsystems. Ticket 08 replaces the aggregation and changes nothing about the
-- gate, which is the part this ticket exists to fix.
CREATE TYPE feature_weather_hour AS (
  valid_time timestamptz,
  weather_temperature_2m double precision
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION feature_weather_block(target_date date, gate_profile text)
  RETURNS SETOF feature_weather_hour LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  day_from timestamptz := target_date::timestamp AT TIME ZONE 'America/Sao_Paulo';
  day_to timestamptz := (target_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';
BEGIN
  PERFORM feature_apply_gate(target_date, gate_profile);
  RETURN QUERY
    SELECT w.valid_time, avg(w.temperature2m_c)
    FROM canonical_weather_forecast w
    WHERE w.valid_time >= day_from AND w.valid_time < day_to
    GROUP BY w.valid_time;
END $$;
--> statement-breakpoint

-- The labels, at `AsOf(now())`, aggregated up to the subsystem.
--
-- Aggregating observed entity-hours *upward* is an aggregation of observations
-- and is legal; it is the downward direction — attributing a conjunto's figure
-- to a member plant — that the domain model forbids as an allocation presented
-- as an observation. Nothing here travels downward.
--
-- A technology with no settled entity-hour aggregates to NULL rather than to
-- zero, and that distinction is load-bearing: "no curtailment was reported" and
-- "this hour has not been settled yet" are different statements, and at serve
-- time tomorrow's row is entirely the second one.
CREATE TYPE feature_label_hour AS (
  subsystem subsystem_code,
  valid_time timestamptz,
  wind_mwh double precision,
  solar_mwh double precision
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION feature_label_block(target_date date)
  RETURNS SETOF feature_label_hour LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  day_from timestamptz := target_date::timestamp AT TIME ZONE 'America/Sao_Paulo';
  day_to timestamptz := (target_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';
BEGIN
  PERFORM feature_apply_label_vintage();
  RETURN QUERY
    SELECT c.subsystem,
           c.valid_time,
           sum(c.constrained_off_mwh) FILTER (WHERE c.technology = 'WIND'),
           sum(c.constrained_off_mwh) FILTER (WHERE c.technology = 'SOLAR')
    FROM canonical_curtailment_by_reporting_entity c
    WHERE c.valid_time >= day_from AND c.valid_time < day_to
    GROUP BY c.subsystem, c.valid_time;
END $$;
--> statement-breakpoint

-- The feature row, at (`Subsystem`, `valid_time`) grain: hourly, UTC,
-- start-labelled.
--
-- A composite type rather than an inline `RETURNS TABLE` so that the twelve
-- tickets behind this one add columns to **one** declaration
-- (`ALTER TYPE feature_row ADD ATTRIBUTE ...`) instead of each restating the
-- shape. `docs/specs/forecaster.md` hashes this type's ordered names together
-- with the definition of `feature_rows` into the lane's `feature_hash`, so a
-- column added without a retrain is visible rather than silent.
--
-- Every row is stamped with what was knowable when it was built: the profile,
-- the resolved instant, the feature set, the threshold and the fidelity. A
-- number that cannot say what it was allowed to see is a number nobody can
-- audit later.
CREATE TYPE feature_row AS (
  -- Identity.
  subsystem subsystem_code,
  valid_time timestamptz,
  target_date date,

  -- The stamp. `gate_at` is the resolved instant, not a second copy of a rule.
  gate_profile text,
  gate_at timestamptz,
  feature_set text,
  threshold_mw double precision,
  vintage_fidelity text,

  -- Features. Class `W`, cut on `published_at <= gate`.
  weather_temperature_2m double precision,

  -- Targets. Read at the settled vintage, deliberately.
  y_constrained_off_wind_mwh double precision,
  y_constrained_off_solar_mwh double precision,
  y_constrained_off_total_mwh double precision,
  y_has_curtailment boolean,
  y_magnitude_mwh double precision
);
--> statement-breakpoint

-- `feature_rows(...)` — the entry point, and the whole point.
--
-- Training:  feature_rows('2024-04-01', '2026-08-01', 'gate_late', 'dessem_free_v1', 5)
-- Serving:   feature_rows(tomorrow,     tomorrow,     'gate_late', 'dessem_free_v1', 5)
--
-- One loop body, one gate expression, one set of views. The serving call is the
-- training call with a range of one day, and there is no second code path for
-- it to diverge from — which is why "the training row and the serving row are
-- identical" is a property of the shape of this function rather than a fact a
-- test discovered.
--
-- The gate is resolved **inside** the loop, per target date. That is the sense
-- in which the cut-off is a function of the target date and not a property of
-- the caller: a range query does not have "a gate", it has one gate per day, and
-- the caller could not hold a single one even if the signature let it try.
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
  -- of D-1, so at 09:00 on D-1 the newest one describes D-1 itself. A model
  -- served at the early gate with a DESSEM feature would be waiting eleven
  -- hours for a file it already believes it has.
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
    -- its own start, so the two vintages cannot interleave whichever order the
    -- planner picks them in.
    weather AS MATERIALIZED (
      SELECT * FROM feature_weather_block(d, gate_profile)
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
      -- consumer cannot use half of it.
      CASE
        WHEN feature_vintage_fidelity(spine.valid_time, weather_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, label_go_live) = 'point_in_time'
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
      CASE WHEN total.mwh > feature_rows.threshold_mw THEN total.mwh END
    FROM spine
    LEFT JOIN weather ON weather.valid_time = spine.valid_time
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
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately.';

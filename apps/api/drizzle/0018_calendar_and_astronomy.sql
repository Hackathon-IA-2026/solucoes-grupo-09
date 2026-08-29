-- Calendar, holidays and solar astronomy — the deterministic block, class `T`.
--
-- Hand-written, like `0012_canonical_read_axes.sql` and `0016_the_feature_gate.sql`
-- and for the same reason: drizzle-kit generates tables and views, not function
-- DDL. The tables this reads (`feature_calendar_day`,
-- `feature_calendar_generation`) and the two views it reads through
-- (`canonical_subsystem_state`, `canonical_solar_centroid`) are generated, in
-- `0017`; everything here is functions.
--
-- ## What class `T` means, and what it does not
--
-- Not forecast, not last-known: **simply computable**. The local hour, its
-- cyclical encoding, the day of the year, the weekday, the holiday structure
-- and the solar geometry of the hour are all knowable years in advance, which
-- is why none of them can leak. They still join the spine of
-- `0016_the_feature_gate.sql` rather than re-deriving anything: this file adds
-- no gate, no cutoff and no second definition of a target date's hours.
--
-- ## The one thing that is *not* simply computable, and is stored instead
--
-- The Brazilian holiday calendar. `docs/specs/feature-engineering.md` §"The
-- holiday calendar — data, not a library call" is explicit that it is
-- **materialised into a table, not called at feature time**, and the reason is
-- Carnival: it is a moveable feast, a library upgrade that moved it by a day
-- would silently restate three years of training features, and there would be
-- no migration, no diff and no failing test to show it. So the generator
-- (`apps/ml/src/wattsteer_ml/calendar_generator.py`, pinned to `holidays==0.103`)
-- runs once per version and writes an artifact; the loader
-- (`apps/api/src/features/calendar/calendar-repository.ts`) writes it into
-- `feature_calendar_day` and refuses to restate an existing version; and the
-- functions below read only the table. A regeneration whose diff touches a past
-- date is a **retrain trigger**, and lands as `br_calendar_v2`.
--
-- ## Why these functions take no gate profile
--
-- `0016`'s rule is that a block writes all four read axes before it reads,
-- because a block that wrote only the axes it cared about would inherit the
-- previous block's gate. Neither block here reads anything with a vintage:
-- `feature_calendar_day` is versioned by calendar version rather than by
-- `ingested_at`, and both views are axis-free by construction — `centroid_point`
-- is immutable once a set is frozen, and `canonical_subsystem_state` reads the
-- registry exactly as `canonical_installed_capacity` reads `plant`. There is
-- therefore no axis to write and, more to the point, **no instant these
-- functions could be handed**: they take a target date and nothing else, so the
-- wall `0016` built has no door here either.
--
-- Should a vintage ever be added to one of those views, these blocks raise
-- `22023` from `canonical_as_of()` rather than inheriting whatever the previous
-- block left behind. Failing closed is what makes the omission safe.
--
-- ## `month` and `week_of_year` are absent, deliberately
--
-- They are a coarser quantisation of the same axis as `calendar_doy_sin/cos` —
-- more split points, no information. `docs/specs/feature-engineering.md` §"The
-- rejected list" records them as available-but-redundant rather than
-- overlooked, and this comment is the second half of that record: their absence
-- from `feature_row` is a decision, not an omission to be helpfully repaired.

-- The active calendar version.
--
-- Spelled as a literal in each function rather than resolved from "the newest
-- row", because "whichever calendar happens to be loaded" is exactly the silent
-- restatement this design exists to prevent. Moving to `br_calendar_v2` is an
-- edit to this file, a migration, and a retrain — visible in a diff, which is
-- the point. `apps/api/src/features/calendar/calendar.ts` holds the same string
-- and `features-gate.test.ts` asserts the two agree.

-- Twenty-four hours of deterministic time structure for one target date.
--
-- Every value is computed in `America/Sao_Paulo` from the UTC `valid_time`,
-- because the diurnal and holiday structure belongs to the grid rather than to
-- UTC; everything else in the feature row stays UTC.
CREATE TYPE feature_calendar_hour AS (
  valid_time timestamptz,
  calendar_local_hour integer,
  calendar_hour_sin double precision,
  calendar_hour_cos double precision,
  calendar_doy_sin double precision,
  calendar_doy_cos double precision,
  calendar_day_of_week integer,
  calendar_is_weekend boolean,
  calendar_is_holiday_national boolean,
  calendar_is_day_before_holiday boolean,
  calendar_is_bridge_day boolean,
  solar_zenith_cos double precision,
  solar_extraterrestrial_ghi double precision
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION feature_calendar_block(target_date date)
  RETURNS SETOF feature_calendar_hour LANGUAGE plpgsql STABLE AS $$
DECLARE
  distinct_local_hours int;
  calendar_from date;
  calendar_to date;
  covered boolean;
  holiday_today boolean;
  holiday_tomorrow boolean;
  holiday_yesterday boolean;
  local_dow int := extract(dow FROM target_date)::int;
  is_bridge boolean;
  centroid_lat double precision;
  centroid_lon double precision;
BEGIN
  -- The DST canary, at the place local time actually enters the row.
  --
  -- `feature_local_day_hours` already asserts that a target date generates 24
  -- hourly instants; this asserts the stronger thing the spec asks for — that
  -- they render to 24 **distinct local hours**. The two differ exactly where it
  -- matters: an autumn fall-back produces 25 instants (caught there) and a
  -- repeated 00:00 local hour (caught here), and a feature row built through a
  -- repeated hour would carry two different weather values under one
  -- `calendar_local_hour` with nothing to say which was which.
  --
  -- Brazil has observed no summer time since 2019 and the whole feature window
  -- is DST-free, so no DST handling is built. Should it be reinstated, the
  -- first affected date fails here.
  SELECT count(DISTINCT extract(hour FROM h AT TIME ZONE 'America/Sao_Paulo'))
    INTO distinct_local_hours
  FROM feature_local_day_hours(target_date) AS h;

  IF distinct_local_hours <> 24 THEN
    RAISE EXCEPTION
      'target date % renders % distinct local hours in America/Sao_Paulo, not 24: the DST-free assumption the calendar features rest on no longer holds',
      target_date, distinct_local_hours USING ERRCODE = '22023';
  END IF;

  SELECT g.day_from, g.day_to INTO calendar_from, calendar_to
  FROM feature_calendar_generation g WHERE g.version = 'br_calendar_v1';

  -- The horizon is checked against D-1 and D+1, not against D, because the
  -- bridge-day and day-before features read the neighbours. A date at the very
  -- edge of the loaded calendar therefore reports NULL rather than a `false`
  -- that means "the calendar stops here" — the distinction the spine draws
  -- everywhere else between an absence and a zero.
  covered := calendar_from IS NOT NULL
         AND (target_date - 1) >= calendar_from
         AND (target_date + 1) <= calendar_to;

  IF covered THEN
    SELECT
      bool_or(c.day = target_date),
      bool_or(c.day = target_date + 1),
      bool_or(c.day = target_date - 1)
    INTO holiday_today, holiday_tomorrow, holiday_yesterday
    FROM feature_calendar_day c
    WHERE c.calendar_version = 'br_calendar_v1'
      AND c.uf = 'BR'
      AND c.day BETWEEN target_date - 1 AND target_date + 1;

    holiday_today := coalesce(holiday_today, false);
    holiday_tomorrow := coalesce(holiday_tomorrow, false);
    holiday_yesterday := coalesce(holiday_yesterday, false);

    -- A weekday wedged between a national holiday and a weekend — the Brazilian
    -- *enforcado*. Monday before a Tuesday holiday, Friday after a Thursday
    -- one; a holiday is not a bridge to itself, which is why the day's own
    -- holiday flag excludes it rather than being ignored.
    is_bridge := NOT holiday_today
             AND ((local_dow = 1 AND holiday_tomorrow)
               OR (local_dow = 5 AND holiday_yesterday));
  END IF;

  -- The solar-capacity-weighted centroid of the frozen set. NULL when no set is
  -- frozen, which makes the astronomy a visible hole rather than a fabricated
  -- point at the middle of nowhere.
  SELECT s.latitude, s.longitude INTO centroid_lat, centroid_lon
  FROM canonical_solar_centroid s
  WHERE s.set_version = 'centroid_set_v1';

  RETURN QUERY
  WITH hours AS (
    SELECT
      h AS valid_time,
      (h AT TIME ZONE 'America/Sao_Paulo') AS local_wall,
      -- Solar geometry is computed on the UTC clock, because the sun does not
      -- know about civil time; only the calendar half is local. The half-hour
      -- offset takes the **midpoint** of the start-labelled hour, which is what
      -- makes `solar_extraterrestrial_ghi` comparable with Open-Meteo's
      -- hour-mean `shortwave_radiation` — the clearness index of ticket 08
      -- divides one by the other, and a numerator averaged over the hour under
      -- a denominator sampled at its edge would peak above 1 every morning.
      extract(doy FROM (h AT TIME ZONE 'UTC'))::double precision AS doy_utc,
      extract(hour FROM (h AT TIME ZONE 'UTC'))::double precision + 0.5 AS hour_utc
    FROM feature_local_day_hours(target_date) AS h
  ),
  solar AS (
    SELECT
      hours.*,
      -- NOAA's fractional year, and Spencer's series for the declination and
      -- the equation of time. Named intermediates rather than one expression:
      -- the whole of the astronomy is four numbers and each has a meaning.
      2 * pi() / 365 * (doy_utc - 1 + (hour_utc - 12) / 24) AS gamma,
      2 * pi() * (doy_utc - 1) / 365 AS gamma_orbit
    FROM hours
  ),
  geometry AS (
    SELECT
      solar.*,
      0.006918
        - 0.399912 * cos(gamma) + 0.070257 * sin(gamma)
        - 0.006758 * cos(2 * gamma) + 0.000907 * sin(2 * gamma)
        - 0.002697 * cos(3 * gamma) + 0.001480 * sin(3 * gamma) AS declination,
      229.18 * (0.000075
        + 0.001868 * cos(gamma) - 0.032077 * sin(gamma)
        - 0.014615 * cos(2 * gamma) - 0.040849 * sin(2 * gamma)) AS eq_time_minutes,
      -- The Earth-Sun distance correction. Perihelion is in early January, so
      -- top-of-atmosphere irradiance is ~6.9% higher in the southern summer
      -- than in the southern winter — the same direction as the solar fleet's
      -- output, and therefore not a term the clearness index can drop.
      1.00011
        + 0.034221 * cos(gamma_orbit) + 0.001280 * sin(gamma_orbit)
        + 0.000719 * cos(2 * gamma_orbit) + 0.000077 * sin(2 * gamma_orbit)
        AS eccentricity
    FROM solar
  ),
  sun_position AS (
    SELECT
      geometry.*,
      -- True solar time from the UTC clock: the equation of time, plus four
      -- minutes of clock per degree of longitude. `- 180` turns minutes since
      -- local solar midnight into an hour angle, zero at solar noon.
      radians(
        (hour_utc * 60 + eq_time_minutes + 4 * centroid_lon) / 4 - 180
      ) AS hour_angle,
      -- cos(zenith), signed: negative below the horizon, and left signed
      -- because "how far below" is real information at dawn and dusk that a
      -- clamp would flatten into one long night. NULL when no centroid set is
      -- frozen — a visible hole rather than a point invented at sea.
      sin(radians(centroid_lat)) * sin(declination)
        + cos(radians(centroid_lat)) * cos(declination)
          * cos(radians((hour_utc * 60 + eq_time_minutes + 4 * centroid_lon) / 4 - 180))
        AS zenith_cos
    FROM geometry
  )
  SELECT
    sun_position.valid_time,
    extract(hour FROM local_wall)::int,
    sin(2 * pi() * extract(hour FROM local_wall)::double precision / 24),
    cos(2 * pi() * extract(hour FROM local_wall)::double precision / 24),
    -- 365.25 rather than 365: the encoding has to close on itself across a leap
    -- year as well as an ordinary one, and a 365-day period leaves 29 February
    -- a day out of phase with every other year in the window.
    sin(2 * pi() * extract(doy FROM local_wall)::double precision / 365.25),
    cos(2 * pi() * extract(doy FROM local_wall)::double precision / 365.25),
    -- 0 = Sunday, matching Postgres' own `dow`. Categorical: the encoding of a
    -- seven-valued category is the estimator's business, not the row's.
    extract(dow FROM local_wall)::int,
    extract(dow FROM local_wall)::int IN (0, 6),
    CASE WHEN covered THEN holiday_today END,
    CASE WHEN covered THEN holiday_tomorrow END,
    CASE WHEN covered THEN is_bridge END,
    zenith_cos,
    -- Top-of-atmosphere horizontal irradiance, W/m². The solar constant times
    -- the Earth-Sun distance correction times the cosine of the zenith, clamped
    -- at zero: a negative irradiance is not a darker night, and this one is a
    -- denominator — ticket 08's clearness index divides by `max(this, ε)`.
    --
    -- The clamp is written around a `CASE` rather than as `greatest(x, 0)`
    -- alone, because `greatest` ignores NULLs: with no centroid frozen it would
    -- report a confident zero W/m² at every hour of every day, which is a
    -- perfectly plausible night and completely wrong at noon.
    CASE
      WHEN zenith_cos IS NULL THEN NULL
      ELSE 1361 * eccentricity * greatest(zenith_cos, 0)
    END
  FROM sun_position
  ORDER BY sun_position.valid_time;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_calendar_block(date) IS
  'Class T: the deterministic time structure of a target date, in America/Sao_Paulo, plus the solar geometry of each hour at the frozen solar-capacity-weighted centroid. Takes a target date and nothing else — there is no vintage here to choose.';
--> statement-breakpoint

-- The regional half of the holiday structure, at subsystem grain.
--
-- **A proxy, and labelled one.** `calendar_holiday_state_share` is the share of
-- the subsystem's constituent states observing a state holiday, and it is
-- **unweighted by load**. That is a known crudeness stated rather than
-- smoothed: load is not published per state anywhere in WattSteer's sources, so
-- no honest weight exists, and inventing one from population or GDP would
-- fabricate a parameter to dress up a feature that is likely to be marginal
-- anyway. It ships as a count share and is an early candidate for the
-- forecaster's feature-selection pass.
--
-- The states of a subsystem come from **ONS's electrical assignment**
-- (`canonical_subsystem_state`), never from geography: twelve VRE units in
-- Bahia are assigned to `SE` in ONS's own file, and a map of Brazil would put
-- them in `NE`.
CREATE TYPE feature_holiday_share AS (
  subsystem subsystem_code,
  calendar_holiday_state_share double precision
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION feature_holiday_share_block(target_date date)
  RETURNS SETOF feature_holiday_share LANGUAGE plpgsql STABLE AS $$
DECLARE
  calendar_from date;
  calendar_to date;
BEGIN
  SELECT g.day_from, g.day_to INTO calendar_from, calendar_to
  FROM feature_calendar_generation g WHERE g.version = 'br_calendar_v1';

  IF calendar_from IS NULL OR target_date < calendar_from OR target_date > calendar_to THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    s.subsystem,
    -- Distinct states on both sides: a state observing two holidays on one day
    -- is one observing state, and Minas Gerais does exactly that on Tiradentes.
    count(DISTINCT s.uf) FILTER (WHERE c.uf IS NOT NULL)::double precision
      / nullif(count(DISTINCT s.uf), 0)
  FROM canonical_subsystem_state s
  LEFT JOIN feature_calendar_day c
    ON c.calendar_version = 'br_calendar_v1'
   AND c.day = target_date
   AND c.uf = s.uf
  GROUP BY s.subsystem;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION feature_holiday_share_block(date) IS
  'The share of a subsystem''s ONS-assigned states observing a state holiday. Unweighted by load, and labelled a proxy for that reason: no per-state load exists in WattSteer''s sources. National holidays are not counted here — they are a separate binary.';
--> statement-breakpoint

-- The row grows by thirteen columns, appended.
--
-- `ALTER TYPE ... ADD ATTRIBUTE` is the mechanism `0016` was shaped for: the
-- twelve tickets behind it add columns to **one** declaration rather than each
-- restating the row. Appending is the only order available, so the calendar
-- block lands after the labels; `docs/specs/forecaster.md` hashes the type's
-- ordered names into a lane's `feature_hash`, and this is exactly the visible
-- event that hash exists to make visible.
ALTER TYPE feature_row ADD ATTRIBUTE calendar_local_hour integer;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE calendar_hour_sin double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE calendar_hour_cos double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE calendar_doy_sin double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE calendar_doy_cos double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE calendar_day_of_week integer;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE calendar_is_weekend boolean;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE calendar_is_holiday_national boolean;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE calendar_holiday_state_share double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE calendar_is_day_before_holiday boolean;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE calendar_is_bridge_day boolean;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE solar_zenith_cos double precision;--> statement-breakpoint
ALTER TYPE feature_row ADD ATTRIBUTE solar_extraterrestrial_ghi double precision;--> statement-breakpoint

-- `feature_rows(...)` again — the same function, two more joins.
--
-- Restated in full because a function body cannot be patched, and restated
-- **without touching the spine**: the signature is unchanged, the gate is still
-- resolved per target date inside the loop, and the two new blocks are joined
-- exactly as the weather and label blocks already were. Nothing here is a
-- second place a cutoff could enter, because neither new block has an argument
-- that could carry one.
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
  IF feature_set = 'dessem_augmented_v1' AND gate_profile IS DISTINCT FROM 'gate_late' THEN
    RAISE EXCEPTION 'dessem_augmented_v1 exists only at gate_late: DESSEM for day D is not published until the evening of D-1'
      USING ERRCODE = '22023';
  END IF;
  PERFORM gate_at(target_from, gate_profile);

  SELECT g.go_live_at INTO weather_go_live
  FROM canonical_read_go_live g WHERE g.read = 'weather-forecast';
  SELECT g.go_live_at INTO label_go_live
  FROM canonical_read_go_live g WHERE g.read = 'curtailment-by-reporting-entity';

  FOR d IN SELECT generate_series(target_from, target_to, interval '1 day')::date LOOP
    gate := gate_at(d, gate_profile);

    RETURN QUERY
    WITH spine AS (
      SELECT s.subsystem, h.valid_time
      FROM unnest(enum_range(NULL::subsystem_code)) AS s(subsystem)
      CROSS JOIN feature_local_day_hours(d) AS h(valid_time)
    ),
    weather AS MATERIALIZED (
      SELECT * FROM feature_weather_block(d, gate_profile)
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
    )
    SELECT
      spine.subsystem,
      spine.valid_time,
      d,
      feature_rows.gate_profile,
      gate,
      feature_rows.feature_set,
      feature_rows.threshold_mw,
      CASE
        WHEN feature_vintage_fidelity(spine.valid_time, weather_go_live) = 'point_in_time'
         AND feature_vintage_fidelity(spine.valid_time, label_go_live) = 'point_in_time'
        THEN 'point_in_time' ELSE 'revision_optimistic'
      END,
      weather.weather_temperature_2m,
      labels.wind_mwh,
      labels.solar_mwh,
      total.mwh,
      total.mwh > feature_rows.threshold_mw,
      CASE WHEN total.mwh > feature_rows.threshold_mw THEN total.mwh END,
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
      calendar.solar_extraterrestrial_ghi
    FROM spine
    LEFT JOIN weather ON weather.valid_time = spine.valid_time
    LEFT JOIN labels
      ON labels.subsystem = spine.subsystem
     AND labels.valid_time = spine.valid_time
    LEFT JOIN calendar ON calendar.valid_time = spine.valid_time
    LEFT JOIN shares ON shares.subsystem = spine.subsystem
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
  'Gate-stamped feature rows at (Subsystem, valid_time) grain. Training passes a range, serving passes target_from = target_to = tomorrow; the gate is derived per row from the target date, so the two calls execute the same expression over the same canonical views. Features are read AsOf(gate); labels are read AsOf(now), deliberately. The calendar and astronomy block is class T and reads no vintage at all.';

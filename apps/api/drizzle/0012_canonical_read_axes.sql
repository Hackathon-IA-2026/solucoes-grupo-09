-- The read axes of the canonical contract, as database functions.
--
-- A view cannot take an argument, and the canonical reads are all functions of
-- an `as_of` (and two of them of a fleet date besides). The axes therefore
-- travel as session settings, and these functions are the single place they are
-- read and interpreted. `apps/api/src/contract/scope.ts` and
-- `apps/ml/src/wattsteer_ml/canonical_reads.py` set them; nothing else may.
--
-- The important property is the `raise`: `canonical_as_of()` has **no default**.
-- A view that fell back to `now()` when the setting was missing would silently
-- return the latest version of every row instead of the version that was
-- current at the cut, which looks exactly like a correct answer and is the one
-- regression this whole layer exists to make impossible. Failing loudly is the
-- point.
CREATE OR REPLACE FUNCTION canonical_as_of() RETURNS timestamptz
  LANGUAGE plpgsql STABLE AS $$
DECLARE raw text := nullif(current_setting('wattsteer.as_of', true), '');
BEGIN
  IF raw IS NULL THEN
    RAISE EXCEPTION 'canonical read attempted with no as_of: set wattsteer.as_of first'
      USING ERRCODE = '22023';
  END IF;
  RETURN raw::timestamptz;
END $$;
--> statement-breakpoint
-- The fleet date of a registry read, truncated to a UTC day here rather than by
-- the caller — the two consumers are two languages, and "which day" is exactly
-- the kind of rule that drifts when it is written twice.
CREATE OR REPLACE FUNCTION canonical_fleet_date() RETURNS timestamptz
  LANGUAGE plpgsql STABLE AS $$
DECLARE raw text := nullif(current_setting('wattsteer.fleet_date', true), '');
BEGIN
  IF raw IS NULL THEN
    RAISE EXCEPTION 'registry read attempted with no fleet date: set wattsteer.fleet_date first'
      USING ERRCODE = '22023';
  END IF;
  RETURN date_trunc('day', (raw::timestamptz) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
END $$;
--> statement-breakpoint
-- The forecast gate, and one of two optional axes where null means "no cut".
--
-- It lives inside the view rather than being applied by the caller because it
-- is applied *before* the as-of pick, not after: the row wanted is the latest
-- ingested one among those published at or before the gate, which is not the
-- same as the latest ingested one, discarded if it was published late.
CREATE OR REPLACE FUNCTION canonical_published_at_or_before() RETURNS timestamptz
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('wattsteer.published_at_or_before', true), '')::timestamptz $$;
--> statement-breakpoint
-- The weather diagnostic axis, inside the view for the same reason: restricting
-- to the 00Z run means "the latest version of the 00Z run", not "the latest
-- version, if it happens to be 00Z".
CREATE OR REPLACE FUNCTION canonical_weather_run_cycle() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('wattsteer.weather_run_cycle', true), '') $$;

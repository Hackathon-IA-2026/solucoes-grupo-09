-- The four axis writers, restated with the fifth axis written empty.
--
-- Nothing else about them changes, and the copies below are the definitions
-- that landed in 0016 and 0039 line for line with one `set_config` added. The
-- property being preserved is `contract/scope.ts`'s first: every axis is
-- written on every call, so no block can inherit the axes of the read before
-- it. For this axis that means a feature build answers on whole reference days
-- whatever a caller asked for in the same transaction — the feature layer is
-- the consumer that would be silently wrong on a partial day, since
-- `feature_rows` ranks and minimises over the whole day it is handed.
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
          set_config('wattsteer.weather_run_cycle', '', true),
          -- Never admitted: a feature that divided a partial day by 24 hours
          -- would be wrong in a way the row could not show.
          set_config('wattsteer.partial_reference_days', '', true);
  RETURN gate;
END $$;--> statement-breakpoint

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
          set_config('wattsteer.weather_run_cycle', '', true),
          set_config('wattsteer.partial_reference_days', '', true);
  RETURN gate;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION feature_apply_label_vintage()
  RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$
DECLARE settled timestamptz := now();
BEGIN
  PERFORM set_config('wattsteer.as_of', settled::text, true),
          set_config('wattsteer.fleet_date', '', true),
          set_config('wattsteer.published_at_or_before', '', true),
          set_config('wattsteer.weather_run_cycle', '', true),
          set_config('wattsteer.partial_reference_days', '', true);
  RETURN settled;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION feature_release_axes()
  RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM set_config('wattsteer.as_of', '', true),
          set_config('wattsteer.fleet_date', '', true),
          set_config('wattsteer.published_at_or_before', '', true),
          set_config('wattsteer.weather_run_cycle', '', true),
          set_config('wattsteer.partial_reference_days', '', true),
          set_config('wattsteer.feature_ingestion_history_from', '', true);
END $$;

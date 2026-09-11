-- A partial reference day, admitted and stated.
--
-- ONS has published 34 of its 470 DESSEM reference days short — a contiguous
-- prefix or suffix of the civil day, never a day with interior holes, and short
-- in every subsystem. Data-platform 25 re-read every one of them from its
-- payload and established that 29 carry a solar profile sitting exactly where
-- `assertDaylightAlignment` requires it, 12–22 GW at midday and nothing at
-- night, which pins the period index absolutely. Those 29 days are real DESSEM
-- forecast half hours and they were being thrown away.
--
-- They were thrown away for a reason that was true of the *table* rather than
-- of the data: a 46-patamar day written here was indistinguishable from a
-- 48-patamar one, so `canonical_day_ahead_balance` would have answered 46 rows
-- for it and said nothing. That is not hypothetical — `feature_rows` computes
-- `dessem_residual_load_min_of_day` and `dessem_residual_load_rank_in_day` over
-- the whole day it finds in that view, and on a 21-patamar day those would be a
-- minimum and a rank over ten hours wearing a day's name.
--
-- So this migration gives the shortfall somewhere to live, and gives the read a
-- way to be asked for it:
--
--   * `reference_day_patamares` — how many half hours ONS published for the
--     row's reference day.
--   * `reference_day_half_hours` — how many the local civil day contains, which
--     is 48 across the whole DESSEM window but is measured rather than assumed:
--     in this database a DST-start day is 46 half hours (2018-11-04) and a
--     DST-end day is 50 (2019-02-16), and hard-coding 48 would read such a day
--     as permanently two short.
--   * `canonical_partial_reference_days()` — a fifth read axis, and the first
--     boolean one. **Absent is whole days only**, which is byte-for-byte the
--     answer every reader got before this migration. A default that quietly
--     admitted partial days would be worse than the refusal it replaces.
--
-- The five days whose run never reaches midday stay refused, as `coverage`:
-- 2025-08-09 (42…48), 2025-08-16 (1…13), 2025-08-27 (32…48), 2025-09-03
-- (45…48) and 2026-01-09 (44…48). Nothing in those files pins the index, so
-- admitting them would be admitting rows whose meaning is a guess.
--
-- **The backfill is derived, not minted.** Every row already in this table was
-- written by an adapter that refused any day that was not the full civil length
-- in every subsystem, so the count is recoverable from the rows themselves —
-- `count(distinct valid_time)` per reference day and subsystem — and the civil
-- day's length from the zone. Measured on the working database before this was
-- written: 1,460 reference-day × subsystem groups, all 1,460 of them exactly 48.
-- The guard below re-checks that on whatever database this runs against and
-- refuses to continue if it does not hold, because a group that is short is
-- either rows lost after the fact or a day this platform never should have
-- stored, and silently relabelling it "partial" would hide both.

-- The fifth axis. False when the setting is missing or empty, which is the
-- whole-days read: unlike the two instant axes, where absent means "no cut",
-- absent here means "apply the cut". `apps/ml`'s mirror does not write this
-- axis and does not need to — a read that never sets it can only ever get the
-- default — and `feature_apply_gate` below writes it empty with the other four
-- so that a feature build cannot inherit somebody else's ask.
CREATE OR REPLACE FUNCTION canonical_partial_reference_days() RETURNS boolean
  LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('wattsteer.partial_reference_days', true), '')::boolean, false) $$;--> statement-breakpoint

COMMENT ON FUNCTION canonical_partial_reference_days() IS
  'Whether the day-ahead balance read admits reference days ONS published short. False when wattsteer.partial_reference_days is unset or empty, which answers whole reference days only - the answer every reader got before the axis existed. A partial day carries real DESSEM half hours but cannot be divided by a day, so a reader that did not ask for one is never handed it.';--> statement-breakpoint

DROP VIEW "public"."canonical_day_ahead_balance";--> statement-breakpoint

-- Nullable first, then derived, then NOT NULL. `ADD COLUMN ... NOT NULL` with
-- no default is what drizzle-kit emits and it would fail on the 70,080 rows
-- already here; a default of 48 would have been the assumption this pair exists
-- to remove.
ALTER TABLE "dessem_balance_half_hour" ADD COLUMN "reference_day_patamares" integer;--> statement-breakpoint
ALTER TABLE "dessem_balance_half_hour" ADD COLUMN "reference_day_half_hours" integer;--> statement-breakpoint

UPDATE "dessem_balance_half_hour" d
SET "reference_day_patamares" = c.patamares,
    "reference_day_half_hours" = c.half_hours
FROM (
  SELECT run_label,
         subsystem,
         count(DISTINCT valid_time) AS patamares,
         (extract(epoch FROM
            ((((run_label::date) + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
           - (((run_label::date))::timestamp AT TIME ZONE 'America/Sao_Paulo')))
          / (30 * 60))::integer AS half_hours
    FROM "dessem_balance_half_hour"
   GROUP BY run_label, subsystem
) c
WHERE d.run_label = c.run_label
  AND d.subsystem = c.subsystem;--> statement-breakpoint

-- The claim the backfill rests on, re-checked against the rows it just read.
DO $$
DECLARE short integer;
BEGIN
  SELECT count(*) INTO short
    FROM "dessem_balance_half_hour"
   WHERE "reference_day_patamares" IS DISTINCT FROM "reference_day_half_hours";
  IF short > 0 THEN
    RAISE EXCEPTION 'dessem_balance_half_hour holds % rows whose reference day is not the full civil day, but every day in it was written by an adapter that refused short days: the coverage backfill would be relabelling lost rows as a partial publication', short
      USING ERRCODE = '22023';
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "dessem_balance_half_hour" ALTER COLUMN "reference_day_patamares" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dessem_balance_half_hour" ALTER COLUMN "reference_day_half_hours" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dessem_balance_half_hour" ADD CONSTRAINT "dessem_balance_reference_day_coverage" CHECK ("dessem_balance_half_hour"."reference_day_patamares" between 1 and "dessem_balance_half_hour"."reference_day_half_hours");--> statement-breakpoint

CREATE VIEW "public"."canonical_day_ahead_balance" AS (
  select distinct on (subsystem, valid_time)
    subsystem,
    valid_time,
    forecast_producer,
    run_label,
    demand_mw,
    hydro_generation_mw,
    small_hydro_generation_mw,
    thermal_generation_mw,
    small_thermal_generation_mw,
    wind_generation_mw,
    solar_generation_mw,
    mmgd_generation_mw,
    pumping_consumption_mw,
    data_version,
    published_at,
    ingested_at,
    reference_day_patamares,
    reference_day_half_hours
  from dessem_balance_half_hour
  where ingested_at <= canonical_as_of()
    and (canonical_published_at_or_before() is null
         or published_at <= canonical_published_at_or_before())
    and (canonical_partial_reference_days()
         or reference_day_patamares = reference_day_half_hours)
  order by subsystem, valid_time, ingested_at desc, data_version desc
);

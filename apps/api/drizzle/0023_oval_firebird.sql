DROP VIEW "public"."canonical_read_go_live";--> statement-breakpoint
ALTER TABLE "programmed_load_half_hour" ADD CONSTRAINT "programmed_load_is_a_forecast" CHECK ("programmed_load_half_hour"."published_at" < "programmed_load_half_hour"."valid_time");--> statement-breakpoint
CREATE VIEW "public"."canonical_programmed_load" AS (
  with half_hours as (
    select distinct on (area_code, valid_time)
      subsystem,
      valid_time,
      programmed_load_mwh,
      data_version,
      published_at,
      ingested_at
    from programmed_load_half_hour
    where subsystem is not null
      and ingested_at <= canonical_as_of()
      and (canonical_published_at_or_before() is null
           or published_at <= canonical_published_at_or_before())
    order by area_code, valid_time, ingested_at desc, data_version desc
  )
  select
    subsystem,
    date_trunc('hour', valid_time) as valid_time,
    sum(programmed_load_mwh) as programmed_load_mwh,
    max(data_version) as data_version,
    max(published_at) as published_at,
    max(ingested_at) as ingested_at
  from half_hours
  group by subsystem, date_trunc('hour', valid_time)
  having count(*) = 2
);--> statement-breakpoint
CREATE VIEW "public"."canonical_read_go_live" AS (
  select 'curtailment-by-reporting-entity' as read,
         min(ingested_at) as go_live_at from curtailment_report_hour
  union all
  select 'curtailment-by-plant', min(ingested_at) from plant_detail_hour
  union all
  select 'system-context', min(ingested_at) from subsystem_energy_balance_hour
  union all
  select 'system-exchange', min(ingested_at) from subsystem_exchange_hour
  union all
  select 'day-ahead-balance', min(ingested_at) from dessem_balance_half_hour
  union all
  select 'programmed-load', min(ingested_at) from programmed_load_half_hour
  union all
  select 'weather-forecast', min(ingested_at) from weather_forecast_hour
  union all
  select 'installed-capacity', min(ingested_at) from generating_unit
  union all
  select 'conjunto-membership', min(ingested_at) from conjunto_membership
);
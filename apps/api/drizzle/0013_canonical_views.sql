CREATE VIEW "public"."canonical_conjunto_membership" AS (
  with latest as (
    select distinct on (plant_ons_code, conjunto_code, member_from)
      plant_ons_code, plant_ceg_core, conjunto_code, member_from, member_to,
      data_version, published_at, ingested_at
    from conjunto_membership
    where ingested_at <= canonical_as_of()
    order by plant_ons_code, conjunto_code, member_from,
             ingested_at desc, data_version desc
  )
  select
    plant_ons_code,
    conjunto_code,
    plant_ceg_core,
    member_from,
    member_to,
    data_version,
    published_at,
    ingested_at
  from latest
  where member_from <= canonical_fleet_date()
    and (member_to is null or member_to >= canonical_fleet_date())
);--> statement-breakpoint
CREATE VIEW "public"."canonical_curtailment_by_plant" AS (
  select distinct on (plant_ons_code, technology, valid_time)
    plant_ons_code,
    technology,
    valid_time,
    estimated_generation_mwh,
    verified_generation_mwh,
    case technology when 'WIND' then 'wind_speed_ms' else 'irradiance_wm2' end
      as measured_quantity,
    case technology
      when 'WIND' then measured_wind_speed_ms
      else measured_irradiance_wm2
    end as measurement_value,
    (measurement_invalid = 1) as measurement_invalid,
    half_hours_observed,
    data_version,
    published_at,
    ingested_at
  from plant_detail_hour
  where ingested_at <= canonical_as_of()
  order by plant_ons_code, technology, valid_time,
           ingested_at desc, data_version desc
);--> statement-breakpoint
CREATE VIEW "public"."canonical_curtailment_by_reporting_entity" AS (
  select distinct on (c.reporting_entity_code, c.technology, c.valid_time)
    c.reporting_entity_code,
    e.kind as reporting_entity_kind,
    c.technology,
    c.valid_time,
    c.constrained_off_mwh,
    c.verified_generation_mwh,
    c.reference_generation_mwh,
    c.final_reference_generation_mwh,
    c.available_capacity_mw,
    c.half_hours_observed,
    c.reason as restriction_reason,
    c.origin as restriction_origin,
    c.restriction_description,
    (c.cause_mixed = 1) as restriction_cause_mixed,
    c.data_version,
    c.published_at,
    c.ingested_at
  from curtailment_report_hour c
  join reporting_entity e on e.ons_code = c.reporting_entity_code
  where c.ingested_at <= canonical_as_of()
  order by c.reporting_entity_code, c.technology, c.valid_time,
           c.ingested_at desc, c.data_version desc
);--> statement-breakpoint
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
    ingested_at
  from dessem_balance_half_hour
  where ingested_at <= canonical_as_of()
    and (canonical_published_at_or_before() is null
         or published_at <= canonical_published_at_or_before())
  order by subsystem, valid_time, ingested_at desc, data_version desc
);--> statement-breakpoint
CREATE VIEW "public"."canonical_installed_capacity" AS (
  with live_units as (
    select distinct on (plant_ceg_core, equipment_code)
      plant_ceg_core, equipment_code, rated_power_mw,
      commissioned_on, decommissioned_on
    from generating_unit
    where ingested_at <= canonical_as_of()
    order by plant_ceg_core, equipment_code, ingested_at desc, data_version desc
  )
  select
    p.subsystem,
    p.technology,
    count(distinct live_units.plant_ceg_core)::int as plants,
    count(*)::int as units,
    sum(live_units.rated_power_mw) as capacity_mw
  from live_units
  join plant p on p.ceg_core = live_units.plant_ceg_core
  where live_units.commissioned_on <= canonical_fleet_date()
    and (live_units.decommissioned_on is null
         or live_units.decommissioned_on > canonical_fleet_date())
  group by p.subsystem, p.technology
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
  select 'weather-forecast', min(ingested_at) from weather_forecast_hour
  union all
  select 'installed-capacity', min(ingested_at) from generating_unit
  union all
  select 'conjunto-membership', min(ingested_at) from conjunto_membership
);--> statement-breakpoint
CREATE VIEW "public"."canonical_system_context" AS (
  select distinct on (subsystem, valid_time)
    subsystem,
    valid_time,
    load_mwh,
    wind_generation_mwh,
    solar_generation_mwh,
    hydro_generation_mwh,
    thermal_generation_mwh,
    net_exchange_mwh,
    data_version,
    published_at,
    ingested_at
  from subsystem_energy_balance_hour
  where ingested_at <= canonical_as_of()
  order by subsystem, valid_time, ingested_at desc, data_version desc
);--> statement-breakpoint
CREATE VIEW "public"."canonical_system_exchange" AS (
  select distinct on (from_subsystem, to_subsystem, valid_time)
    from_subsystem,
    to_subsystem,
    valid_time,
    verified_exchange_mwh,
    programmed_exchange_mwh,
    data_version,
    published_at,
    ingested_at
  from subsystem_exchange_hour
  where ingested_at <= canonical_as_of()
  order by from_subsystem, to_subsystem, valid_time,
           ingested_at desc, data_version desc
);--> statement-breakpoint
CREATE VIEW "public"."canonical_weather_forecast" AS (
  select distinct on (centroid_id, valid_time)
    centroid_id,
    valid_time,
    run_cycle,
    grid_latitude,
    grid_longitude,
    grid_elevation_m,
    run_age_hours,
    wind_speed100m_kmh,
    wind_speed120m_kmh,
    wind_direction120m_deg,
    wind_gusts10m_kmh,
    temperature2m_c,
    surface_pressure_hpa,
    relative_humidity2m_pct,
    precipitation_mm,
    shortwave_radiation_wm2,
    direct_normal_irradiance_wm2,
    diffuse_radiation_wm2,
    cloud_cover_pct,
    data_version,
    published_at,
    ingested_at
  from weather_forecast_hour
  where ingested_at <= canonical_as_of()
    and (canonical_weather_run_cycle() is null
         or run_cycle::text = canonical_weather_run_cycle())
  order by centroid_id, valid_time, ingested_at desc, data_version desc
);
DROP VIEW "public"."canonical_curtailment_by_reporting_entity";--> statement-breakpoint
DROP VIEW "public"."canonical_weather_forecast";--> statement-breakpoint
CREATE VIEW "public"."canonical_curtailment_by_reporting_entity" AS (
  select distinct on (c.reporting_entity_code, c.technology, c.valid_time)
    c.reporting_entity_code,
    e.kind as reporting_entity_kind,
    e.subsystem,
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
    and (canonical_published_at_or_before() is null
         or published_at <= canonical_published_at_or_before())
    and (canonical_weather_run_cycle() is null
         or run_cycle::text = canonical_weather_run_cycle())
  order by centroid_id, valid_time, ingested_at desc, data_version desc
);
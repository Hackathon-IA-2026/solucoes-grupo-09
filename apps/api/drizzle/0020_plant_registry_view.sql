CREATE VIEW "public"."canonical_plant_registry" AS (
  with live_units as (
    select distinct on (plant_ceg_core, equipment_code)
      plant_ceg_core, equipment_code, rated_power_mw,
      commissioned_on, decommissioned_on, ingested_at
    from generating_unit
    where ingested_at <= canonical_as_of()
    order by plant_ceg_core, equipment_code, ingested_at desc, data_version desc
  ),
  capacity as (
    select plant_ceg_core,
           sum(rated_power_mw) as installed_capacity_mw,
           count(*)::int as generating_units,
           max(ingested_at) as ingested_at
    from live_units
    where commissioned_on <= canonical_fleet_date()
      and (decommissioned_on is null
           or decommissioned_on > canonical_fleet_date())
    group by plant_ceg_core
  ),
  location as (
    select distinct on (plant_ceg_core)
      plant_ceg_core, latitude, longitude, location_source,
      municipality_name, municipality_uf, withdrawn_on, ingested_at
    from plant_geo
    where ingested_at <= canonical_as_of()
    order by plant_ceg_core, ingested_at desc, data_version desc
  )
  select
    p.ceg_core,
    p.ceg_raw,
    p.ons_plant_code,
    p.name,
    p.subsystem,
    p.state_code,
    p.technology,
    p.operation_modality,
    p.owner_name,
    p.operator_name,
    capacity.installed_capacity_mw,
    capacity.generating_units,
    l.latitude,
    l.longitude,
    coalesce(l.location_source, 'unlocated') as location_source,
    l.municipality_name,
    l.municipality_uf,
    greatest(capacity.ingested_at,
             coalesce(l.ingested_at, capacity.ingested_at)) as ingested_at
  from capacity
  join plant p on p.ceg_core = capacity.plant_ceg_core
  left join location l
    on l.plant_ceg_core = p.ceg_core and l.withdrawn_on is null
);
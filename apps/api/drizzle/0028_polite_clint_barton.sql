CREATE VIEW "public"."canonical_capacity_weight" AS (
  with fleet as (
    select subsystem, technology, installed_capacity_mw, latitude, longitude
    from canonical_plant_registry
    where installed_capacity_mw > 0
  ),
  scope_totals as (
    select
      subsystem,
      technology,
      sum(installed_capacity_mw) as scope_capacity_mw,
      coalesce(sum(installed_capacity_mw)
                 filter (where latitude is not null), 0) as located_mw,
      coalesce(sum(installed_capacity_mw)
                 filter (where latitude is null), 0) as unlocated_mw
    from fleet
    group by subsystem, technology
  ),
  assigned as (
    select
      fleet.subsystem,
      fleet.technology,
      fleet.installed_capacity_mw,
      nearest.centroid_id,
      nearest.distance_km
    from fleet
    cross join lateral (
      select
        c.centroid_id,
        2 * 6371.0088 * asin(least(1, sqrt(
          sin(radians(c.latitude - fleet.latitude) / 2) ^ 2
          + cos(radians(fleet.latitude)) * cos(radians(c.latitude))
            * sin(radians(c.longitude - fleet.longitude) / 2) ^ 2))) as distance_km
      from centroid_point c
      where c.set_version = 'centroid_set_v1'
        and c.technology = fleet.technology
      order by distance_km
      limit 1
    ) nearest
    where fleet.latitude is not null and fleet.longitude is not null
  ),
  by_centroid as (
    select
      subsystem,
      technology,
      centroid_id,
      sum(installed_capacity_mw) as centroid_mw,
      sum(distance_km * installed_capacity_mw) as distance_mw_km
    from assigned
    group by subsystem, technology, centroid_id
  )
  select
    'centroid_set_v1' as set_version,
    by_centroid.subsystem,
    by_centroid.technology,
    by_centroid.centroid_id,
    by_centroid.centroid_mw / scope_totals.located_mw as weight,
    (by_centroid.centroid_mw / scope_totals.located_mw)
      * (scope_totals.located_mw + scope_totals.unlocated_mw) as capacity_mw,
    by_centroid.distance_mw_km / by_centroid.centroid_mw as distance_km,
    scope_totals.scope_capacity_mw,
    scope_totals.located_mw + scope_totals.unlocated_mw as scope_placed_mw
  from by_centroid
  join scope_totals
    on scope_totals.subsystem = by_centroid.subsystem
   and scope_totals.technology = by_centroid.technology
  where scope_totals.located_mw > 0
);
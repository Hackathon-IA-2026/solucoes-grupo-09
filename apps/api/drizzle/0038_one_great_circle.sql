-- The great-circle distance, given a name.
--
-- Data-platform ticket 18, residual 4. Feature-engineering 08 needed capacity
-- weighting inside a plpgsql feature function; it could not call
-- `apps/api/src/features/capacity-weights.ts`, and `centroid_point` is on the
-- forbidden-ingest-table list for everything above the feature layer, so it
-- wrote a second implementation of the haversine and bound it to the TypeScript
-- authority with a parity test. That was the right disclosure and it still left
-- two implementations of one formula.
--
-- Ticket 18 decided the second branch it offered — the duplication is accepted,
-- and the parity binding the two is made explicit and hard to delete. This
-- migration is that decision's SQL half, and it does two things:
--
--  1. **The formula gets a name.** It was an anonymous expression spelled out
--     inline in the `assigned` CTE of `canonical_capacity_weight`. A named
--     function is what makes "there are two of these, here and here" a
--     statement anybody can check, and it is what
--     `packages/core/fixtures/great-circle/` can address: a golden vector
--     cannot be asserted against an expression buried in a view's body.
--     It also means a *third* copy now has something to be a copy of — a future
--     feature function that needs a distance calls this rather than pasting the
--     expression, and the count stays at two.
--  2. **`canonical_capacity_weight` calls it**, so there is exactly one SQL
--     spelling of the haversine rather than one per view that wants a distance.
--
-- Nothing about the answer changes. The expression below is the one that was
-- inline, character for character, including the `least(1, …)` clamp — which is
-- not decoration: `sqrt` of a floating-point sum can exceed 1 by an ulp for two
-- coincident points, and `asin` of that is a domain error rather than zero.
-- `packages/core/fixtures/great-circle/01-*` is that input.
--
-- The radius is IUGG's mean Earth radius, 6371.0088 km, which is also
-- `EARTH_RADIUS_KM` in `capacity-weights.ts` and in the vector builder. It is a
-- choice rather than a derivation, which is why all three name it and why the
-- suites assert the literal.

CREATE OR REPLACE FUNCTION great_circle_km(
  lat_a double precision,
  lon_a double precision,
  lat_b double precision,
  lon_b double precision
) RETURNS double precision
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  select 2 * 6371.0088 * asin(least(1, sqrt(
    sin(radians(lat_b - lat_a) / 2) ^ 2
    + cos(radians(lat_a)) * cos(radians(lat_b))
      * sin(radians(lon_b - lon_a) / 2) ^ 2)))
$$;--> statement-breakpoint

COMMENT ON FUNCTION great_circle_km(double precision, double precision,
                                    double precision, double precision) IS
  'Great-circle distance in km, haversine, IUGG mean radius. The SQL half of a '
  'deliberate two-implementation parity — the other is haversineKm in '
  'apps/api/src/features/capacity-weights.ts, and the two are bound by '
  'packages/core/fixtures/great-circle/. Neither may become the other''s '
  'authority: TypeScript weights candidate geometry that has no rows yet, SQL '
  'weights the frozen set from inside a feature function that cannot call '
  'TypeScript. See that directory''s README.';--> statement-breakpoint

-- `CREATE OR REPLACE` rather than drop-and-recreate: the column list, its order
-- and every column's type are unchanged, so nothing that depends on this view
-- has to be dropped and rebuilt to accept a body that reads the same.
CREATE OR REPLACE VIEW "public"."canonical_capacity_weight" AS (
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
        great_circle_km(fleet.latitude, fleet.longitude,
                        c.latitude, c.longitude) as distance_km
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

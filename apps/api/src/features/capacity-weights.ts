import { sql } from "drizzle-orm";
import {
  combineFidelity,
  type VintageFidelity,
  vintageFidelity,
} from "../contract/vintage.js";
import type { Database } from "../database/connection.js";
import { type SubsystemCode, toUtcDay } from "../ingest/normalise.js";
import { readPlantCapacityAsOf } from "../ingest/registry-repository.js";
import { readPlantLocationsAsOf } from "../ingest/siga-repository.js";
import type { Coordinate, PlantLocationSource, Technology } from "../ingest/types.js";
import {
  CENTROID_SET_VERSION,
  CENTROIDS,
  type Centroid,
} from "../ingest/weather/centroids.js";

/**
 * `CapacityWeight(centroid, technology, t)` — the weight vector the weather
 * aggregate is built on.
 *
 * `centroids.ts` owns the geometry and says why it is frozen; this module owns
 * the half that is **not** frozen. Every number here is a function of a fleet
 * date, because `InstalledCapacityAsOf` is a function and not a column: a
 * plant's capacity is the sum over the units live on that date, and the units
 * of one plant routinely commission months apart.
 *
 * **Time-varying is settled by measurement, not by caution.**
 * `docs/research/plant-registry.md` §5 measured 25.8% of today's curtailed-fleet
 * MW as commissioned *after* the training window opens, fixed 2026-08 weights as
 * misallocating 50.4% of the SE-solar weight mass at window start, and the SE
 * solar capacity centroid as moving 94 km — more than seven Open-Meteo grid
 * cells — between 2024-04 and 2026-08. A static vector would leak today's fleet
 * composition into the earliest features and quietly contaminate every backtest
 * built on them.
 *
 * **Two time axes, and they are not interchangeable** — the same pair
 * `registry-repository.ts` takes. `asOf` is the vintage axis (what WattSteer had
 * learned by then); `on` is the fleet date (which units existed that day).
 */

/**
 * Mean Earth radius, IUGG. Only used for great-circle distances.
 *
 * Spelled the same in `great_circle_km` (`drizzle/0038_one_great_circle.sql`)
 * and in `packages/core/scripts/build-great-circle-vectors.py`. A radius is a
 * choice rather than a derivation, so all three name it and the vector suites
 * assert the literal.
 */
const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in km. Plants and centroids are hundreds of km apart.
 *
 * **There is a second implementation of this formula, in SQL, and it is
 * deliberate.** `great_circle_km` (`drizzle/0038_one_great_circle.sql`) is what
 * `canonical_capacity_weight` evaluates, because the feature layer weights the
 * frozen centroid set from inside a plpgsql function that cannot call
 * TypeScript. This one exists because `centroid-generator.ts` weights *candidate*
 * geometry while deciding where the frozen points go — there are no
 * `centroid_point` rows to read at that moment — so neither side can become the
 * other's authority.
 *
 * The two are bound by `packages/core/fixtures/great-circle/`: golden vectors
 * whose expected kilometres come from a third formula (Vincenty on a sphere),
 * asserted by `apps/api/test/great-circle-vectors.test.ts` here and by
 * `apps/ml/tests/test_great_circle_vectors.py` against a real Postgres there.
 * Neither suite compares the two implementations against each other, and both
 * fail if the directory holds a vector they did not enumerate. Data-platform
 * ticket 18 took that branch explicitly over making one side authoritative; the
 * directory's README carries the reasoning.
 */
export function haversineKm(a: Coordinate, b: Coordinate): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The grid cell a frozen point snapped to, as Open-Meteo echoed it.
 *
 * Four decimals, the same rendering `assertNoGridCollisions` compares on, so
 * "these two points are one cell" means the same thing in both places.
 */
export function gridCellKey(cell: Coordinate): string {
  return `${cell.latitude.toFixed(4)},${cell.longitude.toFixed(4)}`;
}

/**
 * One weighting target: a model grid cell, and every frozen centroid in it.
 *
 * On the normal path `memberIds` has one element. It has two when two frozen
 * points snapped to the same cell — the case `docs/specs/feature-engineering.md`
 * calls a build error and instructs the generator to fix by *merging the points
 * and summing their weights*. Merging is what happens here: one cell entering a
 * weighted mean twice under two different weights is a silently doubled region,
 * and Open-Meteo returns the identical series for both, so summing the weights
 * is not an approximation of the right answer — it is the right answer.
 *
 * `assertNoGridCollisions` refuses a colliding response at ingest, so on
 * `centroid_set_v1` this path is expected to be inert — measured against
 * `ecmwf_ifs` on 2026-08-28, all nineteen points resolve to distinct cells. It
 * is here for the case that assertion is *acted on*: merging two points and
 * cutting a new set version leaves two ids sharing a cell on purpose, and the
 * weighting has to keep summing them rather than double-counting the region.
 */
export interface WeightedCell {
  /** The lowest-ordered member in frozen set order — the series to read. */
  centroidId: string;
  memberIds: string[];
  /** The snapped cell, when one was known. Null means dedupe had nothing to go on. */
  cell: Coordinate | null;
  /** Share of the scope's placed capacity. The cells of a vector sum to 1. */
  weight: number;
  /** Placed MW behind that share. */
  capacityMw: number;
}

/**
 * How a scope's MW got onto the centroids — every megawatt accounted for.
 *
 * The three located categories and `proRataMw` sum to `placedMw`; add
 * `unattributedMw` and the total is `InstalledCapacityAsOf` for the scope. No
 * capacity is dropped for want of a coordinate, and none is placed by guessing.
 */
export interface CapacityAttribution {
  /** Plants carrying SIGA's own validated coordinate. */
  sigaCoordinateMw: number;
  /** Plants placed at their municipality's centroid — DP-05's fallback. */
  municipalityCentroidMw: number;
  /**
   * Plants with no point at all, spread over the scope's located mass in
   * proportion to it.
   *
   * `location_source = 'unlocated'` is a real state — 1.72% of operating SIGA
   * rows are at Null Island and lose their point — and a plant with no
   * coordinate still generates. Dropping its MW would shrink the denominator
   * and silently reweight everyone else; giving it a plausible-looking point
   * would invent geography. Spreading it pro rata does neither: the weights
   * still sum to 1, the scope's total MW is still `InstalledCapacityAsOf`, and
   * the plant's own location is still recorded as unknown.
   */
  proRataMw: number;
  /**
   * MW that could not be placed at all: the scope has no located plant to
   * spread it over. Reported rather than distributed evenly, because an even
   * spread over the frozen points would be a fabricated location.
   */
  unattributedMw: number;
  /** Sum of the first three. The denominator the weights are shares of. */
  placedMw: number;
  plants: number;
  unlocatedPlants: number;
}

/** One (subsystem, technology) weight vector at a fleet date. */
export interface CapacityWeightVector {
  subsystem: SubsystemCode;
  technology: Technology;
  /** `InstalledCapacityAsOf(subsystem, technology, on)` — placed or not. */
  capacityMw: number;
  attribution: CapacityAttribution;
  /** Empty exactly when nothing could be placed. */
  cells: WeightedCell[];
  /**
   * Capacity-weighted mean plant-to-centroid distance, km.
   *
   * The drift metric `docs/specs/feature-engineering.md` asks the generator to
   * record at freeze time: a 25% rise means the fleet has grown away from the
   * frozen points and the set needs regenerating — which is a new centroid set
   * version, a new feature-set version and a retrain, never an edit in place.
   */
  meanDistanceKm: number | null;
  /**
   * Capacity-weighted mean plant position — the number the research measured
   * moving 94 km for SE solar. Not a query point and never used as one.
   */
  capacityCentroid: Coordinate | null;
}

/** Every vector at one fleet date, and how honest the reads behind it were. */
export interface CapacityWeightSet {
  /** Fleet date: which units existed. */
  on: Date;
  /** Vintage axis: what WattSteer had learned by then. */
  asOf: Date;
  /** The geometry these weights are attached to. Weights outlive no version. */
  centroidSetVersion: string;
  vectors: CapacityWeightVector[];
  /** The weaker of the registry and SIGA reads — never the flattering one. */
  vintageFidelity: VintageFidelity;
}

/** One plant as the weighting sees it: capacity, scope, and maybe a point. */
export interface WeightablePlant {
  cegCore: string;
  subsystem: SubsystemCode;
  technology: Technology;
  capacityMw: number;
  coordinate: Coordinate | null;
  locationSource: PlantLocationSource;
}

export interface CapacityWeightInput {
  plants: readonly WeightablePlant[];
  /** The frozen geometry. Defaults to the whole current set. */
  centroids?: readonly Centroid[];
  /**
   * Snapped grid cell per centroid id, as echoed by Open-Meteo and stored on
   * `weather_forecast_hour`. Absent for a centroid that has never been queried,
   * in which case that centroid simply cannot collide with anything.
   */
  gridCells?: ReadonlyMap<string, Coordinate>;
}

interface ScopeKey {
  subsystem: SubsystemCode;
  technology: Technology;
}

const scopeId = (scope: ScopeKey): string => `${scope.subsystem}|${scope.technology}`;

/** A plant's nearest centroid **of its own technology**, and how far away. */
function nearestCentroid(
  coordinate: Coordinate,
  candidates: readonly Centroid[],
): { centroid: Centroid; distanceKm: number } | null {
  let best: { centroid: Centroid; distanceKm: number } | null = null;
  for (const centroid of candidates) {
    const distanceKm = haversineKm(coordinate, centroid);
    if (!best || distanceKm < best.distanceKm) {
      best = { centroid, distanceKm };
    }
  }
  return best;
}

interface Accumulator {
  capacityMw: number;
  plants: number;
  unlocatedPlants: number;
  unlocatedMw: number;
  sigaCoordinateMw: number;
  municipalityCentroidMw: number;
  /** Placed MW per centroid id, before the grid-cell merge. */
  byCentroid: Map<string, number>;
  distanceMwKm: number;
  latMw: number;
  lonMw: number;
}

const emptyAccumulator = (): Accumulator => ({
  capacityMw: 0,
  plants: 0,
  unlocatedPlants: 0,
  unlocatedMw: 0,
  sigaCoordinateMw: 0,
  municipalityCentroidMw: 0,
  byCentroid: new Map(),
  distanceMwKm: 0,
  latMw: 0,
  lonMw: 0,
});

/**
 * Fold the per-centroid mass onto grid cells.
 *
 * Preserves frozen set order, and names the cell by its lowest-ordered member
 * so the representative is deterministic rather than whichever row Postgres
 * happened to return first.
 */
function toCells(
  byCentroid: ReadonlyMap<string, number>,
  centroids: readonly Centroid[],
  gridCells: ReadonlyMap<string, Coordinate> | undefined,
  locatedMw: number,
  placedMw: number,
): WeightedCell[] {
  const cells: WeightedCell[] = [];
  const index = new Map<string, WeightedCell>();
  for (const centroid of centroids) {
    const mw = byCentroid.get(centroid.id);
    if (mw === undefined || mw === 0) {
      continue;
    }
    const cell = gridCells?.get(centroid.id);
    // No echoed cell means nothing to merge on: the centroid stands alone under
    // its own id rather than being folded in with a point it might not share.
    const key = cell ? gridCellKey(cell) : `centroid:${centroid.id}`;
    const existing = index.get(key);
    if (existing) {
      existing.memberIds.push(centroid.id);
      existing.capacityMw += mw;
      continue;
    }
    const created: WeightedCell = {
      centroidId: centroid.id,
      memberIds: [centroid.id],
      cell: cell ?? null,
      weight: 0,
      capacityMw: mw,
    };
    index.set(key, created);
    cells.push(created);
  }
  // Weights are shares of the **located** mass, and the placed MW behind each
  // share is that share of the *placed* mass. That is what spreads an unlocated
  // plant pro rata: the shape of the vector is untouched and the megawatts
  // behind it add up to the scope's capacity.
  for (const cell of cells) {
    cell.weight = locatedMw > 0 ? cell.capacityMw / locatedMw : 0;
    cell.capacityMw = cell.weight * placedMw;
  }
  return cells;
}

/**
 * `CapacityWeight(centroid, technology, t)` for every scope present in the
 * fleet at one date.
 *
 * Each plant is assigned to the nearest centroid **of its own technology** —
 * wind and solar carry separate vectors because the two fleets sit in different
 * places: NE wind is the Bahia/Piauí interior and the RN/CE coast, while more
 * than half of SE solar is three municipality clusters in northern Minas
 * Gerais. One shared vector would put solar weight on wind's coast.
 */
export function computeCapacityWeights(
  input: CapacityWeightInput,
): CapacityWeightVector[] {
  const centroids = input.centroids ?? CENTROIDS;
  const byTechnology = new Map<Technology, Centroid[]>();
  for (const centroid of centroids) {
    const bucket = byTechnology.get(centroid.technology);
    if (bucket) {
      bucket.push(centroid);
    } else {
      byTechnology.set(centroid.technology, [centroid]);
    }
  }

  const scopes = new Map<string, { scope: ScopeKey; totals: Accumulator }>();
  for (const plant of input.plants) {
    if (plant.capacityMw <= 0) {
      continue;
    }
    const scope: ScopeKey = {
      subsystem: plant.subsystem,
      technology: plant.technology,
    };
    const id = scopeId(scope);
    let entry = scopes.get(id);
    if (!entry) {
      entry = { scope, totals: emptyAccumulator() };
      scopes.set(id, entry);
    }
    const totals = entry.totals;
    totals.capacityMw += plant.capacityMw;
    totals.plants += 1;

    const candidates = byTechnology.get(plant.technology) ?? [];
    const nearest = plant.coordinate
      ? nearestCentroid(plant.coordinate, candidates)
      : null;
    if (!(plant.coordinate && nearest)) {
      totals.unlocatedPlants += 1;
      totals.unlocatedMw += plant.capacityMw;
      continue;
    }
    if (plant.locationSource === "siga_municipality_centroid") {
      totals.municipalityCentroidMw += plant.capacityMw;
    } else {
      totals.sigaCoordinateMw += plant.capacityMw;
    }
    totals.byCentroid.set(
      nearest.centroid.id,
      (totals.byCentroid.get(nearest.centroid.id) ?? 0) + plant.capacityMw,
    );
    totals.distanceMwKm += nearest.distanceKm * plant.capacityMw;
    totals.latMw += plant.coordinate.latitude * plant.capacityMw;
    totals.lonMw += plant.coordinate.longitude * plant.capacityMw;
  }

  const vectors: CapacityWeightVector[] = [];
  for (const { scope, totals } of scopes.values()) {
    const locatedMw = totals.sigaCoordinateMw + totals.municipalityCentroidMw;
    // Pro rata over the located mass: the shape of the vector is unchanged and
    // the scope's total MW is preserved. With no located mass there is nothing
    // to be proportional to, and the capacity stays unattributed.
    const placedMw = locatedMw > 0 ? locatedMw + totals.unlocatedMw : 0;
    const cells = toCells(
      totals.byCentroid,
      centroids,
      input.gridCells,
      locatedMw,
      placedMw,
    );
    vectors.push({
      subsystem: scope.subsystem,
      technology: scope.technology,
      capacityMw: totals.capacityMw,
      attribution: {
        sigaCoordinateMw: totals.sigaCoordinateMw,
        municipalityCentroidMw: totals.municipalityCentroidMw,
        proRataMw: locatedMw > 0 ? totals.unlocatedMw : 0,
        unattributedMw: locatedMw > 0 ? 0 : totals.unlocatedMw,
        placedMw,
        plants: totals.plants,
        unlocatedPlants: totals.unlocatedPlants,
      },
      cells,
      meanDistanceKm: locatedMw > 0 ? totals.distanceMwKm / locatedMw : null,
      capacityCentroid:
        locatedMw > 0
          ? {
              latitude: totals.latMw / locatedMw,
              longitude: totals.lonMw / locatedMw,
            }
          : null,
    });
  }
  vectors.sort((a, b) =>
    a.subsystem === b.subsystem
      ? a.technology.localeCompare(b.technology)
      : a.subsystem.localeCompare(b.subsystem),
  );
  return vectors;
}

/**
 * Half the L1 distance between two weight vectors: the fraction of weight mass
 * one vector puts somewhere the other does not.
 *
 * The measure `docs/research/plant-registry.md` §5 reports fixed-versus-as-of
 * weights with (0.504 for SE solar at window start), reproduced here so the
 * claim is a computation the test suite can make rather than a number copied
 * out of a document.
 */
export function weightMisallocation(
  a: readonly WeightedCell[],
  b: readonly WeightedCell[],
): number {
  const keys = new Set([...a, ...b].map((cell) => cell.centroidId));
  const weightOf = (cells: readonly WeightedCell[], id: string): number =>
    cells.find((cell) => cell.centroidId === id)?.weight ?? 0;
  let total = 0;
  for (const key of keys) {
    total += Math.abs(weightOf(a, key) - weightOf(b, key));
  }
  return total / 2;
}

export interface CapacityWeightQuery {
  /** Vintage axis: what WattSteer had learned by this instant. */
  asOf: Date;
  /** Fleet date. Truncated to UTC midnight — weights are recomputed per day. */
  on: Date;
  subsystem?: SubsystemCode;
  technology?: Technology;
  centroids?: readonly Centroid[];
  gridCells?: ReadonlyMap<string, Coordinate>;
}

/**
 * The weight set for one fleet date, composed from the two as-of reads that
 * already exist: per-plant capacity from ONS, coordinates from SIGA.
 *
 * The join is on `ceg_core` and nowhere else — `docs/domain-model.md` §3: the
 * two sides' raw CEG strings match 0 of 1,614 times compared verbatim, and
 * names agree only 94.5% of the time.
 *
 * A plant with no `plant_geo` row at all is treated exactly like an `unlocated`
 * one. That is the honest reading: SIGA lags new entrants — twelve plants were
 * being curtailed while SIGA still showed them as `Construção` at 0 kW — so a
 * missing row means "ANEEL has not registered a location", not "no capacity".
 */
export async function readCapacityWeightsAsOf(
  db: Database,
  query: CapacityWeightQuery,
): Promise<CapacityWeightSet> {
  // The fleet date may legitimately be *after* the vintage, and routinely is:
  // the D−1 serving path asks today's registry which units will be live
  // tomorrow. `on` is a question about the calendar, `asOf` about what had been
  // learned — only the second bounds what is readable.
  const on = toUtcDay(query.on);
  const [plants, locations] = await Promise.all([
    readPlantCapacityAsOf(db, {
      asOf: query.asOf,
      on,
      subsystem: query.subsystem,
      technology: query.technology,
    }),
    readPlantLocationsAsOf(db, { asOf: query.asOf }),
  ]);

  const located = new Map(locations.rows.map((row) => [row.cegCore, row]));
  const weightable: WeightablePlant[] = plants.map((plant) => {
    const location = located.get(plant.cegCore);
    return {
      cegCore: plant.cegCore,
      subsystem: plant.subsystem,
      technology: plant.technology,
      capacityMw: plant.capacityMw,
      coordinate: location?.coordinate ?? null,
      locationSource: location?.locationSource ?? "unlocated",
    };
  });

  // Fidelity is the weaker of the two reads. The registry's own read reports
  // per-query fidelity against `generating_unit`'s go-live, which is what the
  // fleet date is answered from; SIGA's is against `plant_geo`'s.
  const registry = await readPlantCapacityFidelity(db, query.asOf, on);
  // The composition rule, from the one place it is written: a weight vector
  // assembled from a point-in-time fleet and revision-optimistic coordinates is
  // revision-optimistic as a whole, because a consumer cannot use half of it.
  const fidelity: VintageFidelity = combineFidelity([
    { read: "installed-capacity", vintageFidelity: registry, goLiveAt: null },
    {
      read: "plant-locations",
      vintageFidelity: locations.vintageFidelity,
      goLiveAt: null,
    },
  ]);

  return {
    on,
    asOf: query.asOf,
    centroidSetVersion: CENTROID_SET_VERSION,
    vectors: computeCapacityWeights({
      plants: weightable,
      centroids: query.centroids,
      gridCells: query.gridCells,
    }),
    vintageFidelity: fidelity,
  };
}

/**
 * `generating_unit`'s go-live against the fleet date.
 *
 * `readPlantCapacityAsOf` returns rows and no fidelity — the grouped read next
 * to it carries that — so the same question is asked directly here rather than
 * running the heavier grouped query for one boolean.
 */
async function readPlantCapacityFidelity(
  db: Database,
  asOf: Date,
  on: Date,
): Promise<VintageFidelity> {
  const [row] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from generating_unit
        where ingested_at <= ${asOf.toISOString()}::timestamptz`,
  );
  const goLiveAt = row?.go_live ? new Date(row.go_live) : null;
  return vintageFidelity(on, goLiveAt);
}

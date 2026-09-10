import { TECHNOLOGIES } from "@wattsteer/core/domain";
import { BadInputError } from "../../errors.js";
import {
  type CapacityWeightVector,
  computeCapacityWeights,
  gridCellKey,
  haversineKm,
  type WeightablePlant,
} from "../../features/capacity-weights.js";
import type { Coordinate } from "../types.js";
import {
  type Centroid,
  type CentroidTechnology,
  GridCellCollisionError,
} from "./centroids.js";

/**
 * The centroid generator — where the frozen points come from.
 *
 * `centroids.ts` holds `centroid_set_v1`: nineteen points transcribed from
 * `docs/research/weather-sources.md`, two of which (W11, W12) were never
 * computed from SIGA municipality centroids at all. This module computes a
 * whole set from the registry instead, so that the geometry is reproducible,
 * every point is derived, and regenerating is a reviewable diff rather than an
 * edit to a literal.
 *
 * **Points are frozen, weights are not.** Nothing here produces a weight.
 * `CapacityWeight(centroid, technology, t)` stays a function of the target date
 * and stays in `features/capacity-weights.ts`; a generated set is geometry and
 * a freeze-time measurement of how far the fleet sits from it. Regenerating
 * **cuts a new centroid set version** — a new feature-set version and a retrain
 * — because moving a query point moves the Open-Meteo grid cell underneath an
 * existing series, which is a covariate shift nothing in the data would show.
 * See `centroid-set-repository.ts`, which refuses to restate a frozen version.
 *
 * The pipeline, in order, and every step deterministic:
 *
 * 1. **Aggregate by municipality.** The research's points are "centroids of
 *    ANEEL SIGA plant coordinates aggregated by municipality"; a municipality
 *    is the unit ANEEL actually reports and the unit SIGA's own fallback uses.
 * 2. **Cluster municipalities by single linkage** at `clusterRadiusKm`, within
 *    a technology. Wind and solar never share a cluster: the two fleets sit in
 *    different places and carry separate weight vectors.
 * 3. **Drop clusters below `minClusterMw`.** Their plants are not dropped —
 *    the weighting assigns every plant to its nearest centroid of its own
 *    technology, so a discarded cluster's MW joins a kept one.
 * 4. **Merge grid-cell collisions**, summing the MW behind them.
 * 5. **Assert cell uniqueness** and freeze.
 */

/** One plant as the generator sees it: the weighting's view plus its municipality. */
export interface GeneratorPlant extends WeightablePlant {
  /** SIGA's municipality, when it named exactly one. */
  municipality: { name: string; uf: string } | null;
}

/**
 * Single-linkage radius, km.
 *
 * 75 km is chosen against the set it has to be able to reproduce the shape of:
 * the closest same-technology pair in `centroid_set_v1` is W1/W2 at 103.5 km,
 * so 75 km keeps every v1 cluster distinct with ~28 km of margin, while being
 * far above the 9–13 km grid the points are eventually snapped to. Larger and
 * the interior-Bahia clusters chain into one point over a 1,500 km fleet;
 * smaller and every municipality becomes its own query point, which is the
 * per-plant approach the research rejected on cost and on information.
 */
export const DEFAULT_CLUSTER_RADIUS_KM = 75;

/**
 * MW floor for a cluster to become a query point.
 *
 * 400 MW sits just under W12 (426 MW), the smallest cluster the research kept,
 * so the floor admits everything v1 admits and nothing smaller. A cluster below
 * it is not worth a column of its own; its plants attach to the nearest kept
 * centroid and keep every megawatt in the weight vector.
 */
export const DEFAULT_MIN_CLUSTER_MW = 400;

export interface CentroidGeneratorOptions {
  /** Single-linkage radius between municipality points, km. */
  clusterRadiusKm?: number;
  /** MW a cluster must carry to earn a query point. */
  minClusterMw?: number;
  /**
   * The model grid **as Open-Meteo echoed it**, keyed by `pointKey` of the
   * coordinate that was asked about — never a grid this repository models.
   *
   * The generator therefore cannot snap a point it has not been told about. Any
   * candidate point missing from the map comes back in `pendingProbe`, the set
   * comes back `collisionCheck: "unchecked"`, and the repository refuses to
   * freeze it. `regenerateCentroids` closes that loop: probe, feed the cells
   * back in, generate again, until nothing is pending. A merge moves a point,
   * and a moved point has to be asked about again.
   */
  observedGridCells?: ReadonlyMap<string, Coordinate>;
}

/**
 * How a coordinate is named when asking "which cell did this land in?".
 *
 * Six decimals, the same rounding the generated points carry, so a point and
 * the probe that asked about it agree on their own identity.
 */
export function pointKey(point: Coordinate): string {
  return `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
}

/** A point of a generated set: a `Centroid`, plus how it came to be one. */
export interface GeneratedCentroid extends Centroid {
  /** `"Janaúba, MG"` — the municipalities whose plants make up the cluster. */
  municipalities: string[];
  plants: number;
  /**
   * Cluster keys folded into this point after the geometry was computed —
   * the grid-cell merges, in the order they were made. Empty on the normal path.
   */
  mergedFrom: string[];
  /** The cell Open-Meteo snapped this point to, when a snap was available. */
  gridCell: Coordinate | null;
}

/** A cluster that did not become a query point, and why. */
export interface DiscardedCluster {
  key: string;
  technology: CentroidTechnology;
  latitude: number;
  longitude: number;
  representedMw: number;
  plants: number;
  reason: "below_mw_floor" | "cross_technology_collision";
}

/** Two clusters that landed in one cell, and what was done about it. */
export interface CentroidMerge {
  /** The surviving cluster key. */
  kept: string;
  merged: string;
  reason: "grid_cell" | "cross_technology";
  cell: string;
}

export interface GeneratedCentroidSet {
  version: string;
  centroids: GeneratedCentroid[];
  parameters: {
    clusterRadiusKm: number;
    minClusterMw: number;
  };
  /** Whether the grid-cell uniqueness question was actually asked. */
  collisionCheck: "asserted" | "unchecked";
  /**
   * Candidate points whose snapped cell is not known yet. Empty exactly when
   * `collisionCheck` is `"asserted"`; non-empty is an instruction to the
   * caller — probe these and generate again.
   */
  pendingProbe: Coordinate[];
  merges: CentroidMerge[];
  discarded: DiscardedCluster[];
  /** Located MW the points carry, and the located MW there was to carry. */
  representedMw: number;
  locatedMw: number;
  plants: number;
  /** Plants with capacity but no usable coordinate — geometry cannot see them. */
  unlocatedPlants: number;
}

/** A municipality's plants, reduced to one capacity-weighted point. */
interface MunicipalityPoint {
  key: string;
  technology: CentroidTechnology;
  latitude: number;
  longitude: number;
  capacityMw: number;
  plants: number;
}

/** A cluster of municipality points, before it earns an id. */
interface Cluster {
  key: string;
  technology: CentroidTechnology;
  latitude: number;
  longitude: number;
  capacityMw: number;
  plants: number;
  municipalities: string[];
  mergedFrom: string[];
}

const municipalityKey = (plant: GeneratorPlant): string =>
  plant.municipality
    ? `${plant.municipality.uf}|${plant.municipality.name}`
    : // No municipality is not a licence to invent one: the plant stands as its
      // own group, and clustering decides whether it joins anything.
      `ceg|${plant.cegCore}`;

const municipalityLabel = (key: string): string => {
  const [uf, name] = key.split("|");
  return name && uf !== "ceg" ? `${name}, ${uf}` : (key.split("|")[1] ?? key);
};

/**
 * Capacity-weighted mean of a set of points.
 *
 * Weighted by MW rather than by plant count, because a cluster's point should
 * sit where its megawatts are: one 400 MW plant and four 5 MW ones is not a
 * five-plant average.
 */
function weightedMean(
  points: readonly { latitude: number; longitude: number; capacityMw: number }[],
): Coordinate {
  let latMw = 0;
  let lonMw = 0;
  let mw = 0;
  for (const point of points) {
    latMw += point.latitude * point.capacityMw;
    lonMw += point.longitude * point.capacityMw;
    mw += point.capacityMw;
  }
  return { latitude: latMw / mw, longitude: lonMw / mw };
}

/** Municipality points, one per (technology, municipality), in key order. */
function toMunicipalityPoints(
  plants: readonly GeneratorPlant[],
): Map<CentroidTechnology, MunicipalityPoint[]> {
  const groups = new Map<string, { key: string; members: GeneratorPlant[] }>();
  for (const plant of plants) {
    const key = `${plant.technology}|${municipalityKey(plant)}`;
    const group = groups.get(key);
    if (group) {
      group.members.push(plant);
    } else {
      groups.set(key, { key, members: [plant] });
    }
  }

  const byTechnology = new Map<CentroidTechnology, MunicipalityPoint[]>();
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    if (!group) {
      continue;
    }
    const members = group.members.map((plant) => ({
      // Filtered before the call: every plant here has a coordinate.
      latitude: (plant.coordinate as Coordinate).latitude,
      longitude: (plant.coordinate as Coordinate).longitude,
      capacityMw: plant.capacityMw,
    }));
    const centre = weightedMean(members);
    const technology = group.members[0]?.technology as CentroidTechnology;
    const point: MunicipalityPoint = {
      key: key.slice(technology.length + 1),
      technology,
      latitude: centre.latitude,
      longitude: centre.longitude,
      capacityMw: members.reduce((sum, member) => sum + member.capacityMw, 0),
      plants: members.length,
    };
    const bucket = byTechnology.get(technology);
    if (bucket) {
      bucket.push(point);
    } else {
      byTechnology.set(technology, [point]);
    }
  }
  return byTechnology;
}

/**
 * Single-linkage agglomeration at a fixed radius — a union-find over the
 * municipality points, joined pairwise when they are within the radius.
 *
 * Single linkage rather than k-means: k-means needs a k, and the number of
 * meteorologically distinct clusters is not something to guess, whereas the
 * radius is a statement about weather correlation length that can be defended.
 * It is also deterministic — no seeding, no restarts, and re-running on the
 * same input reproduces the same partition exactly, which is what makes a
 * regenerated set diffable.
 */
function clusterByLinkage(
  points: readonly MunicipalityPoint[],
  radiusKm: number,
): MunicipalityPoint[][] {
  const parent = points.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root] as number;
    }
    let walk = index;
    while (parent[walk] !== root) {
      const next = parent[walk] as number;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i] as MunicipalityPoint;
      const b = points[j] as MunicipalityPoint;
      if (haversineKm(a, b) <= radiusKm) {
        const rootA = find(i);
        const rootB = find(j);
        if (rootA !== rootB) {
          // Lowest index wins, so the partition does not depend on scan order.
          const [keep, drop] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
          parent[drop as number] = keep as number;
        }
      }
    }
  }
  const groups = new Map<number, MunicipalityPoint[]>();
  for (let index = 0; index < points.length; index += 1) {
    const root = find(index);
    const group = groups.get(root);
    const point = points[index] as MunicipalityPoint;
    if (group) {
      group.push(point);
    } else {
      groups.set(root, [point]);
    }
  }
  return [...groups.values()];
}

/** Fold municipality points into one cluster, keyed by its largest member. */
function toCluster(members: readonly MunicipalityPoint[]): Cluster {
  const ordered = [...members].sort(
    (a, b) => b.capacityMw - a.capacityMw || a.key.localeCompare(b.key),
  );
  const centre = weightedMean(ordered);
  const head = ordered[0] as MunicipalityPoint;
  return {
    key: head.key,
    technology: head.technology,
    latitude: centre.latitude,
    longitude: centre.longitude,
    capacityMw: ordered.reduce((sum, member) => sum + member.capacityMw, 0),
    plants: ordered.reduce((sum, member) => sum + member.plants, 0),
    municipalities: ordered.map((member) => municipalityLabel(member.key)),
    mergedFrom: [],
  };
}

/** Merge `other` into `cluster`: the MW sum, and the point that follows it. */
function absorb(cluster: Cluster, other: Cluster): Cluster {
  const centre = weightedMean([cluster, other]);
  return {
    key: cluster.key,
    technology: cluster.technology,
    latitude: centre.latitude,
    longitude: centre.longitude,
    capacityMw: cluster.capacityMw + other.capacityMw,
    plants: cluster.plants + other.plants,
    municipalities: [...cluster.municipalities, ...other.municipalities],
    mergedFrom: [...cluster.mergedFrom, other.key, ...other.mergedFrom],
  };
}

/**
 * Resolve grid-cell collisions, and say what was done.
 *
 * **Same technology: merge and sum the MW.** Open-Meteo returns the identical
 * series for both points, so one cell entering a weighted mean twice under two
 * different weights is a silently doubled region. Summing is not an
 * approximation of the right answer — it is the right answer.
 *
 * **Different technologies: the smaller cluster leaves the geometry.** Its
 * point cannot be merged into the other one, because a centroid carries a
 * technology and the two fleets carry separate weight vectors. Nudging it would
 * invent geography. It is therefore dropped from the *geometry* — and no
 * megawatt is lost, because the weighting assigns every plant to the nearest
 * centroid of its own technology, so its plants simply weight a neighbour.
 *
 * The loop repeats until a pass makes no change: a merge moves a point, and a
 * moved point can land in a different cell.
 */
function resolveCollisions(
  clusters: readonly Cluster[],
  cells: ReadonlyMap<string, Coordinate>,
): {
  clusters: Cluster[];
  merges: CentroidMerge[];
  discarded: DiscardedCluster[];
  pending: Coordinate[];
} {
  let current = [...clusters];
  const merges: CentroidMerge[] = [];
  const discarded: DiscardedCluster[] = [];
  let pending: Coordinate[] = [];

  // Bounded: every pass either removes a cluster or stops, so at most one pass
  // per cluster plus the one that finds nothing.
  for (let pass = 0; pass <= clusters.length; pass += 1) {
    const seen = new Map<string, Cluster>();
    let collided = false;
    const next: Cluster[] = [];
    pending = [];
    for (const cluster of current) {
      const snapped = cells.get(pointKey(round2(cluster)));
      if (!snapped) {
        // Nothing is known about this point's cell, so nothing can be concluded
        // about it. It survives the pass and is reported for probing.
        pending.push(round2(cluster));
        next.push(cluster);
        continue;
      }
      const cell = gridCellKey(snapped);
      const previous = seen.get(cell);
      if (!previous) {
        seen.set(cell, cluster);
        next.push(cluster);
        continue;
      }
      collided = true;
      if (previous.technology === cluster.technology) {
        const merged = absorb(previous, cluster);
        merges.push({
          kept: previous.key,
          merged: cluster.key,
          reason: "grid_cell",
          cell,
        });
        seen.set(cell, merged);
        next[next.indexOf(previous)] = merged;
        continue;
      }
      // Cross-technology: the smaller cluster yields, deterministically.
      const [keep, drop] =
        previous.capacityMw >= cluster.capacityMw
          ? [previous, cluster]
          : [cluster, previous];
      merges.push({ kept: keep.key, merged: drop.key, reason: "cross_technology", cell });
      discarded.push({
        key: drop.key,
        technology: drop.technology,
        latitude: drop.latitude,
        longitude: drop.longitude,
        representedMw: drop.capacityMw,
        plants: drop.plants,
        reason: "cross_technology_collision",
      });
      seen.set(cell, keep);
      if (keep === cluster) {
        next[next.indexOf(previous)] = cluster;
      }
    }
    current = next;
    if (!collided) {
      break;
    }
  }
  return { clusters: current, merges, discarded, pending };
}

/** A cluster's point at the precision the frozen set carries it. */
const round2 = (point: { latitude: number; longitude: number }): Coordinate => ({
  latitude: round(point.latitude),
  longitude: round(point.longitude),
});

/**
 * Ids, assigned by weight rather than by geography.
 *
 * `W1` is the largest wind cluster, `S1` the largest solar one, ties broken
 * north-to-south then west-to-east. The alternative — geographic order — is not
 * stable under regeneration: one new cluster in the middle of Bahia would
 * renumber every point south of it, and an id is the business key of every
 * weather row. Ordering by MW renumbers on a change of *rank*, which is a real
 * change in the fleet, and — because ids never move between versions — a
 * renumbering is confined to the new version anyway.
 */
const ID_PREFIX: Record<CentroidTechnology, string> = { WIND: "W", SOLAR: "S" };

function assignIds(clusters: readonly Cluster[]): GeneratedCentroid[] {
  const byTechnology = new Map<CentroidTechnology, Cluster[]>();
  for (const cluster of clusters) {
    const bucket = byTechnology.get(cluster.technology);
    if (bucket) {
      bucket.push(cluster);
    } else {
      byTechnology.set(cluster.technology, [cluster]);
    }
  }
  const centroids: GeneratedCentroid[] = [];
  for (const technology of TECHNOLOGIES) {
    const bucket = byTechnology.get(technology) ?? [];
    bucket.sort(
      (a, b) =>
        b.capacityMw - a.capacityMw ||
        a.latitude - b.latitude ||
        a.longitude - b.longitude ||
        a.key.localeCompare(b.key),
    );
    for (const [index, cluster] of bucket.entries()) {
      const municipalities = [...new Set(cluster.municipalities)];
      centroids.push({
        id: `${ID_PREFIX[technology]}${index + 1}`,
        label: labelOf(municipalities),
        latitude: round(cluster.latitude),
        longitude: round(cluster.longitude),
        technology,
        representedMw: round(cluster.capacityMw),
        // Every point in a generated set is computed from SIGA municipality
        // centroids, which is exactly what `provisional` says is not true of
        // W11 and W12 in v1.
        provisional: false,
        municipalities,
        plants: cluster.plants,
        mergedFrom: cluster.mergedFrom,
        gridCell: null,
      });
    }
  }
  return centroids;
}

/**
 * Six decimals — ~11 cm, far below any grid the points are snapped to, and
 * enough that the same input reproduces the same literal on any machine.
 */
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

function labelOf(municipalities: readonly string[]): string {
  const named = municipalities.slice(0, 2).join(" + ");
  const rest = municipalities.length - 2;
  return rest > 0 ? `${named} (+${rest} more)` : named;
}

/**
 * Generate a centroid set from the fleet.
 *
 * Pure and deterministic: the same plants, options and observed cells produce a
 * byte-identical set. That is the acceptance condition — a regenerated set that
 * differs from the stored one for no reason in the registry would make the
 * whole exercise a slower way of hand-transcribing.
 */
export function generateCentroidSet(
  version: string,
  plants: readonly GeneratorPlant[],
  options: CentroidGeneratorOptions = {},
): GeneratedCentroidSet {
  if (!version.trim()) {
    throw new BadInputError("A generated centroid set must be given a version");
  }
  const clusterRadiusKm = options.clusterRadiusKm ?? DEFAULT_CLUSTER_RADIUS_KM;
  const minClusterMw = options.minClusterMw ?? DEFAULT_MIN_CLUSTER_MW;

  const usable = plants.filter((plant) => plant.capacityMw > 0);
  const located = usable.filter((plant) => plant.coordinate !== null);
  const locatedMw = located.reduce((sum, plant) => sum + plant.capacityMw, 0);

  const discarded: DiscardedCluster[] = [];
  const kept: Cluster[] = [];
  for (const points of toMunicipalityPoints(located).values()) {
    for (const group of clusterByLinkage(points, clusterRadiusKm)) {
      const cluster = toCluster(group);
      if (cluster.capacityMw < minClusterMw) {
        discarded.push({
          key: cluster.key,
          technology: cluster.technology,
          latitude: round(cluster.latitude),
          longitude: round(cluster.longitude),
          representedMw: round(cluster.capacityMw),
          plants: cluster.plants,
          reason: "below_mw_floor",
        });
        continue;
      }
      kept.push(cluster);
    }
  }
  // Deterministic input to every step after this one.
  kept.sort(
    (a, b) => a.technology.localeCompare(b.technology) || a.key.localeCompare(b.key),
  );

  const cells = options.observedGridCells ?? new Map<string, Coordinate>();
  const resolved = resolveCollisions(kept, cells);
  discarded.push(...resolved.discarded);

  const centroids = assignIds(resolved.clusters);
  const pending: Coordinate[] = [...resolved.pending];
  for (const centroid of centroids) {
    const cell = cells.get(pointKey(centroid));
    centroid.gridCell = cell ? { ...cell } : null;
    if (!cell) {
      pending.push({ latitude: centroid.latitude, longitude: centroid.longitude });
    }
  }
  const unchecked = new Map(pending.map((point) => [pointKey(point), point]));
  if (unchecked.size === 0) {
    assertGeneratedCellsUnique(centroids);
  }

  return {
    version,
    centroids,
    parameters: { clusterRadiusKm, minClusterMw },
    collisionCheck: unchecked.size === 0 ? "asserted" : "unchecked",
    pendingProbe: [...unchecked.values()],
    merges: resolved.merges,
    discarded: discarded.sort((a, b) => a.key.localeCompare(b.key)),
    representedMw: round(
      centroids.reduce((sum, centroid) => sum + centroid.representedMw, 0),
    ),
    locatedMw: round(locatedMw),
    plants: usable.length,
    unlocatedPlants: usable.length - located.length,
  };
}

/**
 * The uniqueness the set is frozen under.
 *
 * `assertNoGridCollisions` in `centroids.ts` asks the same question of an
 * answered request, pairing centroids with the locations that came back; this
 * asks it of a set that has already recorded its own snapped cells, which is
 * the only form the question takes before any weather has been fetched. Both
 * compare on `gridCellKey`, so "these two points are one cell" means the same
 * thing in both places.
 */
export function assertGeneratedCellsUnique(
  centroids: readonly GeneratedCentroid[],
): void {
  const seen = new Map<string, string>();
  for (const centroid of centroids) {
    if (!centroid.gridCell) {
      continue;
    }
    const cell = gridCellKey(centroid.gridCell);
    const previous = seen.get(cell);
    if (previous) {
      throw new GridCellCollisionError(
        `Generated centroids ${previous} and ${centroid.id} both snap to grid cell ${cell}. ` +
          "The generator merges same-technology collisions and drops the smaller " +
          "side of a cross-technology one; a pair surviving both is a bug in that " +
          "resolution, not a set to freeze.",
      );
    }
    seen.set(cell, centroid.id);
  }
}

/**
 * The freeze-time drift metric: capacity-weighted mean plant-to-centroid
 * distance, in km, over every scope at once.
 *
 * Computed by `computeCapacityWeights` rather than by a second distance loop —
 * it already assigns each plant to the nearest centroid of its own technology
 * and reports `meanDistanceKm` per (subsystem, technology). The number here is
 * those means recombined over their located mass, so the metric a scheduled job
 * recomputes is the same arithmetic the weights are built from.
 *
 * Null when nothing could be placed: a mean over no megawatts is not zero.
 */
export interface CentroidDistance {
  meanDistanceKm: number | null;
  /** MW the mean is weighted by — the located mass. */
  locatedMw: number;
  plants: number;
  unlocatedPlants: number;
}

export function measureCentroidDistance(
  plants: readonly WeightablePlant[],
  centroids: readonly Centroid[],
): CentroidDistance {
  return meanDistanceOf(computeCapacityWeights({ plants, centroids }));
}

/**
 * The same metric from weight vectors that have already been computed — what
 * the scheduled drift check has in hand after `readCapacityWeightsAsOf`, and
 * the reason that check and the freeze-time baseline cannot drift apart.
 */
export function meanDistanceOf(
  vectors: readonly CapacityWeightVector[],
): CentroidDistance {
  let distanceMwKm = 0;
  let locatedMw = 0;
  let counted = 0;
  let unlocated = 0;
  for (const vector of vectors) {
    const located =
      vector.attribution.sigaCoordinateMw + vector.attribution.municipalityCentroidMw;
    counted += vector.attribution.plants;
    unlocated += vector.attribution.unlocatedPlants;
    if (vector.meanDistanceKm === null || located <= 0) {
      continue;
    }
    distanceMwKm += vector.meanDistanceKm * located;
    locatedMw += located;
  }
  return {
    meanDistanceKm: locatedMw > 0 ? distanceMwKm / locatedMw : null,
    locatedMw,
    plants: counted,
    unlocatedPlants: unlocated,
  };
}

import { sql } from "drizzle-orm";
import type { Database } from "../../database/connection.js";
import { centroidDriftCheck, centroidPoint, centroidSet } from "../../database/schema.js";
import { BadInputError } from "../../errors.js";
import type { Technology } from "../types.js";
import { digestValues } from "../versioned-write.js";
import type { CentroidDistance, GeneratedCentroidSet } from "./centroid-generator.js";
import { CENTROID_SET_VERSION, CENTROIDS, type Centroid } from "./centroids.js";

/**
 * Persistence for the frozen centroid sets.
 *
 * One rule runs through the whole module: **a frozen set is never restated.**
 * `freezeCentroidSet` is idempotent for identical geometry and refuses anything
 * else, so a regeneration that produces different points cannot be written as a
 * correction — it has to be written as a new version. The reason is not
 * bookkeeping: weather rows are keyed by `centroid_id`, and moving a point moves
 * the Open-Meteo grid cell underneath a series already ingested at the old one.
 * The series would change because the question changed, and nothing in the data
 * would say so.
 *
 * A new version is therefore a new feature-set version and a retrain, which is
 * exactly why cutting one is a deliberate act rather than a migration.
 */

/** Refusal to restate a version whose geometry is already frozen. */
export class CentroidSetImmutableError extends BadInputError {
  constructor(message: string) {
    super(message);
    this.name = "CentroidSetImmutableError";
  }
}

/** One stored point, as the geometry was frozen. */
export interface StoredCentroidPoint extends Centroid {
  municipalities: string[];
  plants: number;
  mergedFrom: string[];
  gridCell: { latitude: number; longitude: number } | null;
  origin: "municipality_centroid" | "hand_transcribed";
}

/** A frozen set: its provenance, its drift baseline and its geometry. */
export interface StoredCentroidSet {
  version: string;
  source: "hand_transcribed" | "generated";
  geometryDigest: string;
  centroidCount: number;
  representedMw: number;
  registryAsOf: Date;
  fleetOn: Date;
  freezeMeanDistanceKm: number | null;
  freezeLocatedMw: number;
  freezePlants: number;
  clusterRadiusKm: number | null;
  minClusterMw: number | null;
  collisionCheck: "asserted" | "unchecked";
  frozenAt: Date;
  points: StoredCentroidPoint[];
}

/**
 * Digest of a set's geometry, and of nothing else.
 *
 * Deliberately narrow: the id, the point, the technology. Not the label, not
 * the represented MW, not the municipality list — those are provenance and may
 * be restated as the registry improves without the geometry having moved, and
 * the whole question this digest answers is "did a point move?".
 */
export function centroidGeometryDigest(points: readonly Centroid[]): string {
  const ordered = [...points].sort((a, b) => a.id.localeCompare(b.id));
  return digestValues(
    ordered.flatMap((point) => [
      point.id,
      point.latitude,
      point.longitude,
      point.technology,
    ]),
  );
}

const joinList = (values: readonly string[]): string => values.join("; ");
const splitList = (value: string): string[] =>
  value === "" ? [] : value.split("; ").map((part) => part.trim());

/** A point as the freeze path takes it — a `Centroid` plus its provenance. */
export interface FreezablePoint extends Centroid {
  municipalities: readonly string[];
  plants: number;
  mergedFrom: readonly string[];
  gridCell: { latitude: number; longitude: number } | null;
}

export interface FreezeCentroidSetInput {
  version: string;
  source: "hand_transcribed" | "generated";
  points: readonly FreezablePoint[];
  /** Whether grid-cell uniqueness was actually checked. Only `asserted` freezes. */
  collisionCheck: "asserted" | "unchecked";
  /** Generator parameters, so a regeneration is reproducible from the row. Null for a transcribed set. */
  parameters: { clusterRadiusKm: number; minClusterMw: number } | null;
  /** Located MW the points carried at freeze time. */
  representedMw: number;
  /** The freeze-time drift baseline, measured over the same fleet. */
  distance: CentroidDistance;
  /** Vintage axis of the registry read the geometry was computed from. */
  registryAsOf: Date;
  /** Fleet date the geometry was computed at. */
  fleetOn: Date;
}

export interface FreezeCentroidSetResult {
  version: string;
  /** True when this call wrote the set; false when it was already frozen. */
  frozen: boolean;
  geometryDigest: string;
  centroidCount: number;
}

/**
 * Freeze a set — or confirm that it is already frozen, unchanged.
 *
 * Three refusals, each with a reason a caller can act on:
 *
 * - **An unchecked set is not freezable.** A collision is a build error, and a
 *   set whose points were never snapped has not answered the question. Freezing
 *   it would record an invariant nobody checked.
 * - **Different geometry under an existing version** is the mistake this whole
 *   module exists to prevent, and it fails loudly rather than updating.
 * - **Identical geometry under an existing version** is not an error at all: it
 *   is the acceptance condition — regenerating reproduces the stored set — so
 *   it succeeds and writes nothing.
 */
export async function freezeCentroidSet(
  db: Database,
  input: FreezeCentroidSetInput,
): Promise<FreezeCentroidSetResult> {
  if (input.collisionCheck !== "asserted") {
    throw new BadInputError(
      `Refusing to freeze ${input.version}: its points were never snapped to the ` +
        "model grid, so grid-cell uniqueness is unchecked. Two centroids in one " +
        "cell is a build error; supply the snapped cells Open-Meteo echoes and " +
        "generate again.",
    );
  }
  if (input.points.length === 0) {
    throw new BadInputError(`Refusing to freeze ${input.version}: it has no points`);
  }

  const geometryDigest = centroidGeometryDigest(input.points);
  const existing = await readCentroidSet(db, input.version);
  if (existing) {
    if (existing.geometryDigest === geometryDigest) {
      return {
        version: input.version,
        frozen: false,
        geometryDigest,
        centroidCount: existing.centroidCount,
      };
    }
    throw new CentroidSetImmutableError(
      `${input.version} is already frozen with different geometry ` +
        `(stored ${existing.geometryDigest.slice(0, 12)}, generated ` +
        `${geometryDigest.slice(0, 12)}). A centroid set is immutable once frozen: ` +
        "weather has been ingested at those points, and moving one moves the grid " +
        "cell underneath its series. Cut a new version — which is a new feature-set " +
        "version and a retrain — rather than restating this one.",
    );
  }

  await db.transaction(async (tx) => {
    await tx.insert(centroidSet).values({
      version: input.version,
      source: input.source,
      geometryDigest,
      centroidCount: input.points.length,
      representedMw: input.representedMw,
      registryAsOf: input.registryAsOf,
      fleetOn: input.fleetOn,
      freezeMeanDistanceKm: input.distance.meanDistanceKm,
      freezeLocatedMw: input.distance.locatedMw,
      freezePlants: input.distance.plants,
      clusterRadiusKm: input.parameters?.clusterRadiusKm ?? null,
      minClusterMw: input.parameters?.minClusterMw ?? null,
      collisionCheck: input.collisionCheck,
    });
    await tx.insert(centroidPoint).values(
      input.points.map((point) => ({
        setVersion: input.version,
        centroidId: point.id,
        label: point.label,
        latitude: point.latitude,
        longitude: point.longitude,
        technology: point.technology as Technology,
        representedMw: point.representedMw,
        origin: point.provisional
          ? ("hand_transcribed" as const)
          : ("municipality_centroid" as const),
        municipalities: joinList(point.municipalities),
        plants: point.plants,
        mergedFrom: joinList(point.mergedFrom),
        gridLatitude: point.gridCell?.latitude ?? null,
        gridLongitude: point.gridCell?.longitude ?? null,
      })),
    );
  });

  return {
    version: input.version,
    frozen: true,
    geometryDigest,
    centroidCount: input.points.length,
  };
}

export interface FreezeGeneratedSetInput {
  set: GeneratedCentroidSet;
  distance: CentroidDistance;
  registryAsOf: Date;
  fleetOn: Date;
}

/** Freeze what the generator produced, provenance and parameters included. */
export async function freezeGeneratedCentroidSet(
  db: Database,
  input: FreezeGeneratedSetInput,
): Promise<FreezeCentroidSetResult> {
  return freezeCentroidSet(db, {
    version: input.set.version,
    source: "generated",
    points: input.set.centroids,
    collisionCheck: input.set.collisionCheck,
    parameters: input.set.parameters,
    representedMw: input.set.representedMw,
    distance: input.distance,
    registryAsOf: input.registryAsOf,
    fleetOn: input.fleetOn,
  });
}

interface SetRow {
  version: string;
  source: "hand_transcribed" | "generated";
  geometry_digest: string;
  centroid_count: number;
  represented_mw: number;
  registry_as_of: string;
  fleet_on: string;
  freeze_mean_distance_km: number | null;
  freeze_located_mw: number;
  freeze_plants: number;
  cluster_radius_km: number | null;
  min_cluster_mw: number | null;
  collision_check: "asserted" | "unchecked";
  frozen_at: string;
}

interface PointRow {
  centroid_id: string;
  label: string;
  latitude: number;
  longitude: number;
  technology: Technology;
  represented_mw: number;
  origin: "municipality_centroid" | "hand_transcribed";
  municipalities: string;
  plants: number;
  merged_from: string;
  grid_latitude: number | null;
  grid_longitude: number | null;
}

/** A frozen set with its points, or null if that version was never frozen. */
export async function readCentroidSet(
  db: Database,
  version: string,
): Promise<StoredCentroidSet | null> {
  const [row] = await db.execute<SetRow & Record<string, unknown>>(
    sql`select * from centroid_set where version = ${version}`,
  );
  if (!row) {
    return null;
  }
  const points = await db.execute<PointRow & Record<string, unknown>>(
    sql`select * from centroid_point where set_version = ${version}
        order by technology, represented_mw desc, centroid_id`,
  );
  return {
    version: row.version,
    source: row.source,
    geometryDigest: row.geometry_digest,
    centroidCount: row.centroid_count,
    representedMw: Number(row.represented_mw),
    registryAsOf: new Date(row.registry_as_of),
    fleetOn: new Date(row.fleet_on),
    freezeMeanDistanceKm:
      row.freeze_mean_distance_km === null ? null : Number(row.freeze_mean_distance_km),
    freezeLocatedMw: Number(row.freeze_located_mw),
    freezePlants: row.freeze_plants,
    clusterRadiusKm:
      row.cluster_radius_km === null ? null : Number(row.cluster_radius_km),
    minClusterMw: row.min_cluster_mw === null ? null : Number(row.min_cluster_mw),
    collisionCheck: row.collision_check,
    frozenAt: new Date(row.frozen_at),
    points: [...points].map((point) => ({
      id: point.centroid_id,
      label: point.label,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      technology: point.technology,
      representedMw: Number(point.represented_mw),
      provisional: point.origin === "hand_transcribed",
      municipalities: splitList(point.municipalities),
      plants: point.plants,
      mergedFrom: splitList(point.merged_from),
      gridCell:
        point.grid_latitude === null || point.grid_longitude === null
          ? null
          : {
              latitude: Number(point.grid_latitude),
              longitude: Number(point.grid_longitude),
            },
      origin: point.origin,
    })),
  };
}

/** Every frozen version, newest first — what an operator asks for by name. */
export async function listCentroidSetVersions(db: Database): Promise<string[]> {
  const rows = await db.execute<{ version: string }>(
    sql`select version from centroid_set order by frozen_at desc, version desc`,
  );
  return [...rows].map((row) => row.version);
}

export interface SeedCentroidSetV1Input {
  /** The freeze-time baseline for v1, measured over the fleet it is used on. */
  distance: CentroidDistance;
  registryAsOf: Date;
  fleetOn: Date;
}

/**
 * Record `centroid_set_v1` — the hand-transcribed nineteen — as a frozen set.
 *
 * v1 is not generated and never will be: it is the geometry weather has already
 * been ingested at, and the point of writing it here is that the drift watch
 * needs a baseline for the set actually in use, not only for the one a
 * generator would produce today. Its two hand-transcribed points (W11, W12) are
 * stored with `origin = 'hand_transcribed'`, so the row says what the constant
 * says rather than quietly claiming a derivation.
 */
export async function seedCentroidSetV1(
  db: Database,
  input: SeedCentroidSetV1Input,
): Promise<FreezeCentroidSetResult> {
  return freezeCentroidSet(db, {
    version: CENTROID_SET_VERSION,
    source: "hand_transcribed",
    points: CENTROIDS.map((centroid) => ({
      ...centroid,
      municipalities: [],
      plants: 0,
      mergedFrom: [],
      // v1's cells were measured against `ecmwf_ifs` on 2026-08-28 and all
      // nineteen were distinct; they are not restated here, because a snapped
      // cell is a fact about an answered request and this row is a fact about
      // the geometry. `assertNoGridCollisions` re-checks it on every request.
      gridCell: null,
    })),
    collisionCheck: "asserted",
    // A transcribed set has no generator parameters, and a number in those
    // columns would claim a derivation that did not happen.
    parameters: null,
    representedMw: CENTROIDS.reduce((sum, centroid) => sum + centroid.representedMw, 0),
    distance: input.distance,
    registryAsOf: input.registryAsOf,
    fleetOn: input.fleetOn,
  });
}

export interface CentroidDriftRecord {
  setVersion: string;
  fleetOn: Date;
  registryAsOf: Date;
  meanDistanceKm: number | null;
  baselineMeanDistanceKm: number | null;
  driftRatio: number | null;
  triggerRatio: number;
  outcome: "within_tolerance" | "regeneration_triggered";
  locatedMw: number;
  plants: number;
}

/** Append one drift check. Every check is recorded, including the quiet ones. */
export async function recordCentroidDriftCheck(
  db: Database,
  record: CentroidDriftRecord,
): Promise<void> {
  await db.insert(centroidDriftCheck).values(record);
}

/** The most recent drift check for a set, or null if it has never been checked. */
export async function readLatestDriftCheck(
  db: Database,
  version: string,
): Promise<CentroidDriftRecord | null> {
  const [row] = await db.execute<{
    set_version: string;
    fleet_on: string;
    registry_as_of: string;
    mean_distance_km: number | null;
    baseline_mean_distance_km: number | null;
    drift_ratio: number | null;
    trigger_ratio: number;
    outcome: "within_tolerance" | "regeneration_triggered";
    located_mw: number;
    plants: number;
  }>(
    sql`select * from centroid_drift_check where set_version = ${version}
        order by checked_at desc limit 1`,
  );
  if (!row) {
    return null;
  }
  return {
    setVersion: row.set_version,
    fleetOn: new Date(row.fleet_on),
    registryAsOf: new Date(row.registry_as_of),
    meanDistanceKm: row.mean_distance_km === null ? null : Number(row.mean_distance_km),
    baselineMeanDistanceKm:
      row.baseline_mean_distance_km === null
        ? null
        : Number(row.baseline_mean_distance_km),
    driftRatio: row.drift_ratio === null ? null : Number(row.drift_ratio),
    triggerRatio: Number(row.trigger_ratio),
    outcome: row.outcome,
    locatedMw: Number(row.located_mw),
    plants: row.plants,
  };
}

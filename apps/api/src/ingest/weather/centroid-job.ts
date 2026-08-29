import type { Database } from "../../database/connection.js";
import { BadInputError } from "../../errors.js";
import { readCapacityWeightsAsOf } from "../../features/capacity-weights.js";
import type { Execute } from "../../jobs/index.js";
import { toUtcDay } from "../normalise.js";
import { readPlantCapacityAsOf } from "../registry-repository.js";
import { readPlantLocationsAsOf } from "../siga-repository.js";
import type { Coordinate } from "../types.js";
import {
  type CentroidDistance,
  type CentroidGeneratorOptions,
  type GeneratedCentroidSet,
  type GeneratorPlant,
  generateCentroidSet,
  meanDistanceOf,
  measureCentroidDistance,
  pointKey,
} from "./centroid-generator.js";
import {
  freezeGeneratedCentroidSet,
  readCentroidSet,
  recordCentroidDriftCheck,
  seedCentroidSetV1,
} from "./centroid-set-repository.js";
import { CENTROID_SET_VERSION, CENTROIDS } from "./centroids.js";

/**
 * The two operations that run against a frozen centroid set: **cutting one**,
 * and **watching the fleet grow away from it**.
 *
 * They are one module because they share a read — the fleet, joined from the
 * ONS registry's capacities and SIGA's coordinates — and because they are two
 * halves of one policy. The generator records the capacity-weighted mean
 * plant-to-centroid distance at freeze time; the scheduled check recomputes it;
 * a 25% increase means the geometry no longer represents the fleet, and what
 * follows is a **new centroid set version, a new feature-set version and a
 * retrain** — never an in-place edit of the points.
 *
 * Nothing here touches weights. `CapacityWeight(centroid, technology, t)` stays
 * a function of the target date; this module only ever *reads* it, and only for
 * the distance it reports.
 */

/**
 * The drift trigger: a 25% increase in the capacity-weighted mean
 * plant-to-centroid distance over the freeze-time baseline.
 *
 * A ratio rather than an absolute distance, because the baseline is a property
 * of the set: v1's mean is whatever the 2026-08 fleet made it, and the question
 * is whether the fleet has moved, not whether the number is large.
 */
export const DRIFT_TRIGGER_RATIO = 1.25;

/**
 * The fleet as the generator and the drift check both see it.
 *
 * The join is `ceg_core` and nowhere else — `docs/domain-model.md` §3 — and it
 * is the same join `readCapacityWeightsAsOf` makes, for the same reason: ONS
 * knows the capacity and the subsystem, SIGA knows the point and the
 * municipality, and neither knows the other's half.
 */
export async function readGeneratorPlants(
  db: Database,
  query: { asOf: Date; on: Date },
): Promise<GeneratorPlant[]> {
  const on = toUtcDay(query.on);
  const [plants, locations] = await Promise.all([
    readPlantCapacityAsOf(db, { asOf: query.asOf, on }),
    readPlantLocationsAsOf(db, { asOf: query.asOf }),
  ]);
  const located = new Map(locations.rows.map((row) => [row.cegCore, row]));
  return plants.map((plant) => {
    const location = located.get(plant.cegCore);
    return {
      cegCore: plant.cegCore,
      subsystem: plant.subsystem,
      technology: plant.technology,
      capacityMw: plant.capacityMw,
      coordinate: location?.coordinate ?? null,
      locationSource: location?.locationSource ?? "unlocated",
      municipality: location?.municipality ?? null,
    };
  });
}

/** A probe of the model grid: the cells Open-Meteo echoes for these points. */
export type GridProbe = (points: readonly Coordinate[]) => Promise<readonly Coordinate[]>;

export interface RegenerateCentroidsInput {
  /** The version to cut. Never an existing one — a frozen set is immutable. */
  version: string;
  /** Vintage axis. Defaults to now. */
  asOf?: Date;
  /** Fleet date the geometry is computed at. Defaults to `asOf`'s day. */
  on?: Date;
  options?: CentroidGeneratorOptions;
  /**
   * How the model grid is observed. The only authority on which cell a point
   * lands in is Open-Meteo's echo, so without a probe the set stays
   * `unchecked` and cannot be frozen.
   */
  probe?: GridProbe;
  /** Compute and report without writing anything. */
  dryRun?: boolean;
}

export interface RegenerateCentroidsResult {
  set: GeneratedCentroidSet;
  distance: CentroidDistance;
  /** The active frozen geometry's distance over the same fleet, for comparison. */
  baselineDistance: CentroidDistance;
  frozen: boolean;
  dryRun: boolean;
  /** Probe rounds it took to settle. A merge moves a point, and a moved point re-probes. */
  probeRounds: number;
}

/**
 * How many probe/merge rounds are allowed before the generator gives up.
 *
 * Each round either resolves every remaining unknown cell or merges points and
 * asks again; four is far beyond what a set of ~20 points with no measured
 * collisions needs, and a run that exceeds it is a signal rather than a case to
 * keep grinding on.
 */
const MAX_PROBE_ROUNDS = 4;

/**
 * Generate a set from the registry and freeze it under a **new** version.
 *
 * The version is a required argument and is never defaulted to the active one:
 * the single most damaging thing this code could do is quietly replace the
 * geometry a series was ingested at. `freezeCentroidSet` refuses that too, but
 * refusing it twice — once in the signature, once in the database — is
 * proportionate to the cost of getting it wrong.
 *
 * The loop is the interesting part. Generation is pure and knows only the cells
 * it has been handed, so the first pass comes back with every point pending a
 * probe. The probe answers; a second pass may then find two points in one cell,
 * merge them — which moves a point — and pend that new point in turn. It
 * settles when nothing is pending, which is also the only state that can be
 * frozen.
 */
export async function regenerateCentroids(
  db: Database,
  input: RegenerateCentroidsInput,
): Promise<RegenerateCentroidsResult> {
  if (input.version === CENTROID_SET_VERSION) {
    throw new BadInputError(
      `Refusing to regenerate ${CENTROID_SET_VERSION} — it is the set in use and ` +
        "weather has been ingested at its points. Cut a new version instead; that " +
        "is a new feature-set version and a retrain, which is the point.",
    );
  }
  const asOf = input.asOf ?? new Date();
  const on = toUtcDay(input.on ?? asOf);
  const plants = await readGeneratorPlants(db, { asOf, on });

  const cells = new Map<string, Coordinate>(input.options?.observedGridCells ?? []);
  let set = generateCentroidSet(input.version, plants, {
    ...input.options,
    observedGridCells: cells,
  });
  let probeRounds = 0;
  while (input.probe && set.pendingProbe.length > 0 && probeRounds < MAX_PROBE_ROUNDS) {
    const asked = set.pendingProbe;
    const answered = await input.probe(asked);
    if (answered.length !== asked.length) {
      throw new BadInputError(
        `Probed ${asked.length} points and got ${answered.length} cells back; the ` +
          "pairing by request order is no longer sound.",
      );
    }
    for (const [index, point] of asked.entries()) {
      const cell = answered[index] as Coordinate;
      cells.set(pointKey(point), {
        latitude: cell.latitude,
        longitude: cell.longitude,
      });
    }
    probeRounds += 1;
    set = generateCentroidSet(input.version, plants, {
      ...input.options,
      observedGridCells: cells,
    });
  }

  const distance = measureCentroidDistance(plants, set.centroids);
  const baselineDistance = measureCentroidDistance(plants, CENTROIDS);

  if (input.dryRun) {
    return { set, distance, baselineDistance, frozen: false, dryRun: true, probeRounds };
  }
  const result = await freezeGeneratedCentroidSet(db, {
    set,
    distance,
    registryAsOf: asOf,
    fleetOn: on,
  });
  return {
    set,
    distance,
    baselineDistance,
    frozen: result.frozen,
    dryRun: false,
    probeRounds,
  };
}

export interface CentroidDriftPayload {
  /** Which frozen set to check. Defaults to the one in use. */
  version?: string;
  /** Fleet date. Defaults to today. */
  on?: string;
  /** Vintage axis. Defaults to now. */
  asOf?: string;
  /** Override the trigger. Rarely correct — the policy is 25%. */
  triggerRatio?: number;
  /**
   * Freeze the active hand-transcribed set if it has never been recorded, so
   * the very first check has a baseline to compare against. On by default: a
   * drift watch with no baseline is not a watch.
   */
  seedBaseline?: boolean;
}

export interface CentroidDriftResult {
  version: string;
  fleetOn: string;
  meanDistanceKm: number | null;
  baselineMeanDistanceKm: number | null;
  driftRatio: number | null;
  triggerRatio: number;
  regenerationTriggered: boolean;
  locatedMw: number;
  plants: number;
  unlocatedPlants: number;
  /** True when this run wrote the baseline for a set that had none. */
  baselineSeeded: boolean;
}

export interface CentroidDriftDeps {
  db: Database;
}

/**
 * The scheduled drift check.
 *
 * Recomputes the freeze-time metric against **the stored geometry**, not
 * against the code constant: the set being watched is the one that was frozen,
 * and reading the points back is what makes the check meaningful for a version
 * that is no longer the one in the source file.
 *
 * A trigger is loud and does nothing else. Regeneration is a decision with a
 * retrain attached, and a job that cut a new version on its own would be making
 * that decision at 05:00 on a Monday with nobody watching.
 */
export function createCentroidDriftCheck(
  deps: CentroidDriftDeps,
): Execute<CentroidDriftPayload, CentroidDriftResult> {
  return async (payload, report) => {
    report({ done: 0, total: 3 });
    const version = payload.version ?? CENTROID_SET_VERSION;
    const asOf = payload.asOf ? new Date(payload.asOf) : new Date();
    const on = toUtcDay(payload.on ? new Date(payload.on) : asOf);
    const triggerRatio = payload.triggerRatio ?? DRIFT_TRIGGER_RATIO;

    let stored = await readCentroidSet(deps.db, version);
    let baselineSeeded = false;
    if (!stored && version === CENTROID_SET_VERSION && payload.seedBaseline !== false) {
      const plants = await readGeneratorPlants(deps.db, { asOf, on });
      await seedCentroidSetV1(deps.db, {
        distance: measureCentroidDistance(plants, CENTROIDS),
        registryAsOf: asOf,
        fleetOn: on,
      });
      baselineSeeded = true;
      stored = await readCentroidSet(deps.db, version);
    }
    if (!stored) {
      throw new BadInputError(
        `Centroid set ${version} has never been frozen, so there is no baseline to ` +
          "check drift against.",
      );
    }
    report({ done: 1, total: 3 });

    // The stored geometry, not the constant: a set is watched as it was frozen.
    const weights = await readCapacityWeightsAsOf(deps.db, {
      asOf,
      on,
      centroids: stored.points,
    });
    const distance = meanDistanceOf(weights.vectors);
    report({ done: 2, total: 3 });

    const baseline = stored.freezeMeanDistanceKm;
    const driftRatio =
      baseline !== null && baseline > 0 && distance.meanDistanceKm !== null
        ? distance.meanDistanceKm / baseline
        : null;
    const regenerationTriggered = driftRatio !== null && driftRatio >= triggerRatio;

    await recordCentroidDriftCheck(deps.db, {
      setVersion: version,
      fleetOn: on,
      registryAsOf: asOf,
      meanDistanceKm: distance.meanDistanceKm,
      baselineMeanDistanceKm: baseline,
      driftRatio,
      triggerRatio,
      outcome: regenerationTriggered ? "regeneration_triggered" : "within_tolerance",
      locatedMw: distance.locatedMw,
      plants: distance.plants,
    });
    report({ done: 3, total: 3 });

    if (regenerationTriggered) {
      console.warn(
        `⚠️  Centroid drift: ${version} mean plant-to-centroid distance is ` +
          `${distance.meanDistanceKm?.toFixed(1)} km against a ${baseline?.toFixed(1)} km ` +
          `baseline (×${driftRatio?.toFixed(2)}, trigger ×${triggerRatio.toFixed(2)}). ` +
          "The fleet has grown away from the frozen points. Regenerate as a NEW " +
          "centroid set version — a new feature-set version and a retrain — and " +
          "never by editing the points in place.",
      );
    }

    return {
      version,
      fleetOn: on.toISOString().slice(0, 10),
      meanDistanceKm: distance.meanDistanceKm,
      baselineMeanDistanceKm: baseline,
      driftRatio,
      triggerRatio,
      regenerationTriggered,
      locatedMw: distance.locatedMw,
      plants: distance.plants,
      unlocatedPlants: distance.unlocatedPlants,
      baselineSeeded,
    };
  };
}

import { combineFidelity, type VintageFidelity } from "../contract/vintage.js";
import type { Database } from "../database/connection.js";
import { type SubsystemCode, toUtcDay } from "../ingest/normalise.js";
import type { Coordinate } from "../ingest/types.js";
import type { RunCycle } from "../ingest/weather/single-runs.js";
import { readWeatherForecastAsOf } from "../ingest/weather-repository.js";
import {
  type CapacityWeightSet,
  type CapacityWeightVector,
  readCapacityWeightsAsOf,
  type WeightedCell,
} from "./capacity-weights.js";

/**
 * Point weather becomes one feature vector per subsystem per hour.
 *
 * `weather_forecast_hour` stores twelve variables at frozen cluster centroids.
 * The model does not consume centroids: `docs/specs/feature-engineering.md`
 * §"Weather — class W" defines every weather feature as a capacity-weighted
 * mean over those points, with **wind variables on the wind weight vector,
 * solar variables on the solar vector, and the shared variables on combined
 * VRE capacity**. That split is this module's whole reason to exist — the wind
 * fleet and the solar fleet sit in different places, so one shared vector would
 * put solar weight on wind's coast.
 *
 * The weights come from `capacity-weights.ts` and are recomputed **per target
 * date**, which is what keeps today's fleet composition out of 2024's features.
 */

/** Which vector a variable is weighted by. Never inferred at the call site. */
export type WeightBasis = "WIND" | "SOLAR" | "VRE";

/** One centroid's contribution to one hour, as the aggregate consumes it. */
export interface WeatherPoint {
  centroidId: string;
  validTime: Date;
  runAgeHours: number;
  windSpeed100mKmh: number | null;
  windSpeed120mKmh: number | null;
  windDirection120mDeg: number | null;
  windGusts10mKmh: number | null;
  temperature2mC: number | null;
  surfacePressureHpa: number | null;
  relativeHumidity2mPct: number | null;
  precipitationMm: number | null;
  shortwaveRadiationWm2: number | null;
  directNormalIrradianceWm2: number | null;
  diffuseRadiationWm2: number | null;
  cloudCoverPct: number | null;
}

/**
 * The class-`W` feature vector for one subsystem-hour.
 *
 * Twelve stored variables become thirteen features: `wind_direction_120m` is
 * not averaged as a number — 350° and 10° do not average to 180° — so it enters
 * as the sin/cos of the weighted vector mean.
 *
 * The derived features built *on top* of this row (`weather_clearness_index`,
 * `weather_wind_power_curve_cf`, the ramps and the centred windows) are the
 * feature-builder's business, not the aggregate's: every one of them is a
 * function of these numbers plus calendar or capacity, and computing them here
 * would put the definition in two places.
 */
export interface SubsystemWeatherHour {
  subsystem: SubsystemCode;
  /** Start of the forecast hour, UTC. */
  validTime: Date;
  /** Fleet date whose weights produced this row. */
  weightsOn: Date;

  windSpeed100mKmh: number | null;
  windSpeed120mKmh: number | null;
  /** Circular encoding of the capacity-weighted mean wind direction. */
  windDirection120mSin: number | null;
  windDirection120mCos: number | null;
  windGusts10mKmh: number | null;
  temperature2mC: number | null;
  surfacePressureHpa: number | null;
  relativeHumidity2mPct: number | null;
  precipitationMm: number | null;
  shortwaveRadiationWm2: number | null;
  directNormalIrradianceWm2: number | null;
  diffuseRadiationWm2: number | null;
  cloudCoverPct: number | null;

  /**
   * `weather_centroid_coverage` — the share of this subsystem's weight mass
   * that a centroid actually reported for.
   *
   * The spec words it as "fraction of centroids returning non-null". A count is
   * the wrong denominator once the points are weighted: losing W12 (426 MW) and
   * losing W7 (4,172 MW) are the same fraction of centroids and are not the
   * same event. This is the weighted reading, and 1 still means everything
   * arrived.
   */
  centroidCoverage: number;
  /**
   * `weather_run_age_hours` — the **oldest** run behind any contributing
   * centroid, in hours. 0 on the normal path; 12 or 24 when a scheduled run was
   * missing from the archive and an earlier cycle stood in.
   *
   * The max rather than a mean, because the feature exists to tell the model
   * that this row is staler than the rows around it, and a mean would dilute
   * one stale point into invisibility.
   */
  runAgeHours: number | null;
}

/** Numeric variables aggregated as a plain weighted mean, and their basis. */
const MEAN_VARIABLES = [
  ["windSpeed100mKmh", "WIND"],
  ["windSpeed120mKmh", "WIND"],
  ["windGusts10mKmh", "WIND"],
  ["temperature2mC", "VRE"],
  ["surfacePressureHpa", "VRE"],
  ["relativeHumidity2mPct", "VRE"],
  ["precipitationMm", "VRE"],
  // biome-ignore lint/security/noSecrets: a column name, not a secret
  ["shortwaveRadiationWm2", "SOLAR"],
  ["directNormalIrradianceWm2", "SOLAR"],
  ["diffuseRadiationWm2", "SOLAR"],
  ["cloudCoverPct", "SOLAR"],
] as const satisfies readonly (readonly [keyof WeatherPoint, WeightBasis])[];

/** Weight per representative centroid id, for one basis, summing to ≤ 1. */
type WeightMap = Map<string, number>;

const toWeightMap = (cells: readonly WeightedCell[]): WeightMap =>
  new Map(cells.map((cell) => [cell.centroidId, cell.weight]));

/**
 * Combined VRE weights: the two technology vectors blended by their own
 * installed capacity.
 *
 * A centroid appearing in both vectors gets both contributions — that is not a
 * double count, because the wind mass and the solar mass behind it are
 * different megawatts.
 */
function vreWeights(
  wind: CapacityWeightVector | undefined,
  solar: CapacityWeightVector | undefined,
): WeightMap {
  const windMw = wind?.attribution.placedMw ?? 0;
  const solarMw = solar?.attribution.placedMw ?? 0;
  const total = windMw + solarMw;
  const combined: WeightMap = new Map();
  if (total === 0) {
    return combined;
  }
  for (const [vector, mw] of [
    [wind, windMw],
    [solar, solarMw],
  ] as const) {
    for (const cell of vector?.cells ?? []) {
      combined.set(
        cell.centroidId,
        (combined.get(cell.centroidId) ?? 0) + (cell.weight * mw) / total,
      );
    }
  }
  return combined;
}

/**
 * Weighted mean over the centroids that reported a value.
 *
 * **Renormalised over the reporters, not divided by the full weight mass.** A
 * missing centroid is a hole in the sample, not a zero: dividing by the full
 * mass would pull the mean toward zero in proportion to the hole and produce a
 * number that looks like weather. The size of the hole is reported separately,
 * on `centroidCoverage`, so the serve path can refuse the row.
 */
function weightedMean(
  points: readonly WeatherPoint[],
  weights: WeightMap,
  key: keyof WeatherPoint,
): number | null {
  let sum = 0;
  let mass = 0;
  for (const point of points) {
    const weight = weights.get(point.centroidId);
    if (weight === undefined || weight === 0) {
      continue;
    }
    const value = point[key];
    if (typeof value !== "number") {
      continue;
    }
    sum += weight * value;
    mass += weight;
  }
  return mass > 0 ? sum / mass : null;
}

/**
 * Capacity-weighted **vector** mean of wind direction, returned as sin/cos.
 *
 * Each centroid contributes a unit vector at its own bearing, weighted by
 * capacity; the resultant is renormalised to unit length so the pair is a
 * direction and not a directional-consistency score. The resultant collapsing
 * to zero — opposed directions cancelling exactly — has no direction to report,
 * and nulls rather than picking one.
 */
function weightedDirection(
  points: readonly WeatherPoint[],
  weights: WeightMap,
): { sin: number | null; cos: number | null } {
  let sinSum = 0;
  let cosSum = 0;
  let mass = 0;
  for (const point of points) {
    const weight = weights.get(point.centroidId);
    const degrees = point.windDirection120mDeg;
    if (weight === undefined || weight === 0 || degrees === null) {
      continue;
    }
    const radians = (degrees * Math.PI) / 180;
    sinSum += weight * Math.sin(radians);
    cosSum += weight * Math.cos(radians);
    mass += weight;
  }
  if (mass === 0) {
    return { sin: null, cos: null };
  }
  const length = Math.hypot(sinSum, cosSum);
  if (length === 0) {
    return { sin: null, cos: null };
  }
  return { sin: sinSum / length, cos: cosSum / length };
}

/** Share of a basis's weight mass that reported anything at all this hour. */
function coverage(points: readonly WeatherPoint[], weights: WeightMap): number {
  if (weights.size === 0) {
    return 0;
  }
  const present = new Set(points.map((point) => point.centroidId));
  let covered = 0;
  let total = 0;
  for (const [centroidId, weight] of weights) {
    total += weight;
    if (present.has(centroidId)) {
      covered += weight;
    }
  }
  return total > 0 ? covered / total : 0;
}

/**
 * One subsystem-hour from the points that reported it.
 *
 * `points` must already be the rows for a single `valid_time`; the caller owns
 * the grouping because it also owns which fleet date's weights apply.
 */
export function aggregateSubsystemHour(
  subsystem: SubsystemCode,
  validTime: Date,
  points: readonly WeatherPoint[],
  weights: CapacityWeightSet,
): SubsystemWeatherHour {
  const vectorFor = (technology: "WIND" | "SOLAR") =>
    weights.vectors.find(
      (vector) => vector.subsystem === subsystem && vector.technology === technology,
    );
  const wind = vectorFor("WIND");
  const solar = vectorFor("SOLAR");
  const basis: Record<WeightBasis, WeightMap> = {
    WIND: toWeightMap(wind?.cells ?? []),
    SOLAR: toWeightMap(solar?.cells ?? []),
    VRE: vreWeights(wind, solar),
  };

  const values = {} as Record<(typeof MEAN_VARIABLES)[number][0], number | null>;
  for (const [key, weightBasis] of MEAN_VARIABLES) {
    values[key] = weightedMean(points, basis[weightBasis], key);
  }
  const direction = weightedDirection(points, basis.WIND);

  // Staleness is a property of the rows that actually entered this subsystem's
  // aggregate, so centroids carrying no weight here cannot make it look stale.
  const contributing = points.filter(
    (point) => (basis.VRE.get(point.centroidId) ?? 0) > 0,
  );
  const runAgeHours =
    contributing.length > 0
      ? Math.max(...contributing.map((point) => point.runAgeHours))
      : null;

  return {
    subsystem,
    validTime,
    weightsOn: weights.on,
    ...values,
    windDirection120mSin: direction.sin,
    windDirection120mCos: direction.cos,
    centroidCoverage: coverage(points, basis.VRE),
    runAgeHours,
  };
}

export interface SubsystemWeatherQuery {
  /** Vintage axis: what WattSteer had learned by this instant. */
  asOf: Date;
  /** Inclusive lower bound on `valid_time`. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
  subsystem?: SubsystemCode;
  /** Diagnostic: read one cycle rather than letting supersession decide. */
  runCycle?: RunCycle;
}

export interface SubsystemWeatherResult {
  hours: SubsystemWeatherHour[];
  /** One entry per UTC day covered — the weights are the row's provenance. */
  weights: CapacityWeightSet[];
  /** Weaker of the weather read's fidelity and every weight set's. */
  vintageFidelity: VintageFidelity;
}

/**
 * The whole path: point forecasts and a time-varying fleet in, one vector per
 * subsystem per hour out.
 *
 * **Weights are recomputed per UTC day, not once for the range.** A range query
 * across the training window that reused one vector would be exactly the
 * contamination this module exists to prevent — and it is the same query the
 * serving path makes for a single day, which is what keeps train and serve the
 * same object rather than two implementations that agree today.
 *
 * The grid cells the weights dedupe on come from the weather rows themselves:
 * `weather_forecast_hour` stores the cell Open-Meteo echoed for each point, so
 * two frozen centroids that collapsed into one cell are detected from measured
 * data rather than from an assumption about the model's resolution.
 */
export async function readSubsystemWeatherAsOf(
  db: Database,
  query: SubsystemWeatherQuery,
): Promise<SubsystemWeatherResult> {
  const weather = await readWeatherForecastAsOf(db, {
    asOf: query.asOf,
    from: query.from,
    to: query.to,
    runCycle: query.runCycle,
  });

  const gridCells = new Map<string, Coordinate>();
  for (const row of weather.rows) {
    gridCells.set(row.centroidId, {
      latitude: row.gridLatitude,
      longitude: row.gridLongitude,
    });
  }

  const byHour = new Map<number, WeatherPoint[]>();
  for (const row of weather.rows) {
    const hour = row.validTime.getTime();
    const bucket = byHour.get(hour);
    const point: WeatherPoint = {
      centroidId: row.centroidId,
      validTime: row.validTime,
      runAgeHours: row.runAgeHours,
      windSpeed100mKmh: row.windSpeed100mKmh,
      windSpeed120mKmh: row.windSpeed120mKmh,
      windDirection120mDeg: row.windDirection120mDeg,
      windGusts10mKmh: row.windGusts10mKmh,
      temperature2mC: row.temperature2mC,
      surfacePressureHpa: row.surfacePressureHpa,
      relativeHumidity2mPct: row.relativeHumidity2mPct,
      precipitationMm: row.precipitationMm,
      shortwaveRadiationWm2: row.shortwaveRadiationWm2,
      directNormalIrradianceWm2: row.directNormalIrradianceWm2,
      diffuseRadiationWm2: row.diffuseRadiationWm2,
      cloudCoverPct: row.cloudCoverPct,
    };
    if (bucket) {
      bucket.push(point);
    } else {
      byHour.set(hour, [point]);
    }
  }

  const weightsByDay = new Map<number, CapacityWeightSet>();
  const hours: SubsystemWeatherHour[] = [];
  for (const hour of [...byHour.keys()].sort((a, b) => a - b)) {
    const validTime = new Date(hour);
    const day = toUtcDay(validTime);
    let weights = weightsByDay.get(day.getTime());
    if (!weights) {
      weights = await readCapacityWeightsAsOf(db, {
        asOf: query.asOf,
        on: day,
        subsystem: query.subsystem,
        gridCells,
      });
      weightsByDay.set(day.getTime(), weights);
    }
    const points = byHour.get(hour) ?? [];
    const subsystems = new Set(weights.vectors.map((vector) => vector.subsystem));
    for (const subsystem of [...subsystems].sort()) {
      hours.push(aggregateSubsystemHour(subsystem, validTime, points, weights));
    }
  }

  const weights = [...weightsByDay.values()].sort(
    (a, b) => a.on.getTime() - b.on.getTime(),
  );
  // The composition rule, from the one place it is written: the aggregate is
  // only as honest as its weakest input, and a fleet date that predates go-live
  // degrades the whole series rather than the day it weighted.
  const vintageFidelity: VintageFidelity = combineFidelity([
    {
      read: "weather-forecast",
      vintageFidelity: weather.vintageFidelity,
      goLiveAt: null,
    },
    ...weights.map((set) => ({
      read: "installed-capacity",
      vintageFidelity: set.vintageFidelity,
      goLiveAt: null,
    })),
  ]);

  return { hours, weights, vintageFidelity };
}

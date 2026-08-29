import { UpstreamError } from "../../errors.js";
import type { WeatherForecastHour, WeatherRunParse, WeatherValues } from "../types.js";
import { assertNoGridCollisions, type Centroid } from "./centroids.js";
import {
  ACCUMULATED_VARIABLES,
  runAgeHours as ageBetween,
  type ModelRunResponse,
  type RawLocation,
  runCycleOf,
  UndefinedWeatherVariableError,
  WEATHER_MODEL,
  WEATHER_VARIABLES,
  type WeatherVariable,
} from "./single-runs.js";

/**
 * The Single Runs response → canonical rows.
 *
 * Three things happen here and nothing else does: the run's own hour zero is
 * dropped, every requested variable is checked for having come back with no
 * data at all, and the echoed grid cells are checked for collisions. All three
 * are assertions rather than transformations — the numbers themselves are
 * stored exactly as ECMWF produced them, in the API's own units.
 */

/**
 * Which stored field each requested variable lands in.
 *
 * The unit suffixes are what make two of these long enough to trip the
 * high-entropy-string heuristic. Keeping the unit in the field name is the
 * point — a silent unit is how a wind speed in km/h reaches a power curve that
 * expects m/s — so the rule is suppressed rather than the names shortened.
 */
export const FIELD_FOR_VARIABLE: Record<WeatherVariable, keyof WeatherValues> = {
  wind_speed_100m: "windSpeed100mKmh",
  wind_speed_120m: "windSpeed120mKmh",
  // biome-ignore lint/security/noSecrets: a column name, not a secret
  wind_direction_120m: "windDirection120mDeg",
  wind_gusts_10m: "windGusts10mKmh",
  temperature_2m: "temperature2mC",
  surface_pressure: "surfacePressureHpa",
  relative_humidity_2m: "relativeHumidity2mPct",
  precipitation: "precipitationMm",
  // biome-ignore lint/security/noSecrets: a column name, not a secret
  shortwave_radiation: "shortwaveRadiationWm2",
  direct_normal_irradiance: "directNormalIrradianceWm2",
  diffuse_radiation: "diffuseRadiationWm2",
  cloud_cover: "cloudCoverPct",
};

/** Every stored field null — the starting point a location's series fills in. */
function emptyValues(): WeatherValues {
  return {
    windSpeed100mKmh: null,
    windSpeed120mKmh: null,
    windDirection120mDeg: null,
    windGusts10mKmh: null,
    temperature2mC: null,
    surfacePressureHpa: null,
    relativeHumidity2mPct: null,
    precipitationMm: null,
    shortwaveRadiationWm2: null,
    directNormalIrradianceWm2: null,
    diffuseRadiationWm2: null,
    cloudCoverPct: null,
  };
}

export interface ParseModelRunOptions {
  /** In request order — the pairing with the response is positional. */
  centroids: readonly Centroid[];
  runInit: Date;
  /**
   * The run the pipeline *asked* for. Equal to `runInit` on the normal path;
   * newer than it when the scheduled run was missing from the archive.
   */
  scheduledRunInit?: Date;
  /** Defaults to all twelve; must match what was requested. */
  variables?: readonly WeatherVariable[];
}

/** `2024-04-09T13:00` (the API's own form, GMT) → a UTC instant. */
function instantOf(value: unknown, index: number): Date {
  if (typeof value !== "string") {
    throw new UpstreamError(`Weather hour ${index} has no timestamp`);
  }
  const parsed = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(parsed)) {
    throw new UpstreamError(`Weather hour ${index} has an unparseable time '${value}'`);
  }
  return new Date(parsed);
}

/**
 * Read one variable's series, and refuse the two shapes of "no data".
 *
 * `"units": "undefined"` is Open-Meteo's marker for a variable the model does
 * not serve, and it comes with an all-null array on an HTTP 200. Both are
 * checked, because a future model could produce one without the other and
 * either one, stored, is a column of NULLs that reads as weather nobody
 * forecast.
 *
 * The all-null test ignores the run's own hour zero, which is legitimately null
 * for the accumulated variables — otherwise the loud failure would fire on
 * every single-hour request.
 */
function seriesOf(
  location: RawLocation,
  variable: WeatherVariable,
  centroidId: string,
  runLabel: string,
  hourZeroIndex: number,
): (number | null)[] {
  const raw = location.hourly[variable];
  if (!Array.isArray(raw)) {
    throw new UndefinedWeatherVariableError(
      `Model run ${runLabel} (${WEATHER_MODEL}) returned no '${variable}' series at ` +
        `centroid ${centroidId}. A requested variable that is absent is a failure, ` +
        "not missing data.",
    );
  }
  const series = raw.map((value) => (typeof value === "number" ? value : null));

  const units = location.hourly_units[variable];
  if (units === "undefined") {
    throw new UndefinedWeatherVariableError(
      `Model run ${runLabel} (${WEATHER_MODEL}) reports units "undefined" for ` +
        `'${variable}' at centroid ${centroidId} — the model does not serve this ` +
        "variable. Open-Meteo answers HTTP 200 with an all-null array rather than " +
        "an error, so this is checked rather than trusted.",
    );
  }

  const meaningful = series.filter(
    (_, index) => !(index === hourZeroIndex && ACCUMULATED_VARIABLES.has(variable)),
  );
  if (meaningful.length > 0 && meaningful.every((value) => value === null)) {
    throw new UndefinedWeatherVariableError(
      `Model run ${runLabel} (${WEATHER_MODEL}) returned ${meaningful.length} null ` +
        `values and nothing else for '${variable}' at centroid ${centroidId}. ` +
        "Storing that would be indistinguishable from weather that was never forecast.",
    );
  }
  return series;
}

/**
 * Turn one answered model run into canonical rows.
 *
 * The run's own hour zero is dropped **as a whole row**, not nulled per column:
 * five of the twelve variables have no accumulation window there, and a row
 * that is seven-twelfths present is a row nothing downstream can use without a
 * special case. For a D−1 run every target hour is at lead ≥ 15 h, so the drop
 * never costs a usable hour — but a naive "write everything" ingest would store
 * one NULL per run per accumulated variable, forever.
 */
export function parseModelRun(
  response: ModelRunResponse,
  options: ParseModelRunOptions,
): WeatherRunParse {
  const centroids = options.centroids;
  const variables = options.variables ?? WEATHER_VARIABLES;
  const runInit = options.runInit;
  const runCycle = runCycleOf(runInit);
  const scheduled = options.scheduledRunInit ?? runInit;
  const age = ageBetween(scheduled, runInit);
  const runLabel = runInit.toISOString();

  assertNoGridCollisions(centroids, response.locations);

  const rows: WeatherForecastHour[] = [];
  let hourZeroRowsExcluded = 0;
  let nullValues = 0;

  for (const [index, centroid] of centroids.entries()) {
    const location = response.locations[index] as RawLocation;
    const times = location.hourly.time;
    if (!Array.isArray(times)) {
      throw new UpstreamError(
        `Model run ${runLabel} returned no time axis at centroid ${centroid.id}`,
      );
    }
    const instants = times.map(instantOf);
    // The run's own hour zero is the element whose instant *is* the run
    // initialisation. Found rather than assumed to be element 0, so that a
    // future `start_hour` parameter cannot silently move it.
    const hourZeroIndex = instants.findIndex(
      (instant) => instant.getTime() === runInit.getTime(),
    );

    const series = new Map<WeatherVariable, (number | null)[]>();
    for (const variable of variables) {
      series.set(
        variable,
        seriesOf(location, variable, centroid.id, runLabel, hourZeroIndex),
      );
    }

    for (const [hour, validTime] of instants.entries()) {
      if (hour === hourZeroIndex) {
        hourZeroRowsExcluded += 1;
        continue;
      }
      const values = emptyValues();
      for (const variable of variables) {
        const value = (series.get(variable) as (number | null)[])[hour] ?? null;
        if (value === null) {
          nullValues += 1;
        }
        values[FIELD_FOR_VARIABLE[variable]] = value;
      }
      rows.push({
        centroidId: centroid.id,
        validTime,
        gridLatitude: location.latitude,
        gridLongitude: location.longitude,
        gridElevationM: location.elevation,
        runInitTime: runInit,
        runCycle,
        runAgeHours: age,
        ...values,
      });
    }
  }

  return { rows, hourZeroRowsExcluded, nullValues };
}

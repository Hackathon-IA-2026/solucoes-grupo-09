import { BadInputError, UpstreamError } from "../../errors.js";

/**
 * Transport for the Open-Meteo **Single Runs API** — weather recovered from
 * named model runs, never from the stitched archive.
 *
 * This module sits beside `ons/carga-api.ts` rather than inside
 * `bulk-resource.ts` for the same reason that one does: there is no file to
 * `HEAD`, no fingerprint and no conditional download. The unit of work is an
 * HTTP call for one model run over a batch of points, and what it shares with
 * every other source is the versioned write, not the acquisition path.
 *
 * Every rule below defends a measured failure. In descending order of danger:
 *
 * 1. **`best_match` silently swaps models between lead offsets.** Probed at
 *    (−12.5, −41.5): day 0 is ECMWF IFS, day 1 is DWD ICON, with no null, no
 *    warning and plausible numbers in between
 *    (`docs/research/weather-lead-time.md` §2). The Single Runs API's own
 *    default is worse still — `ncep_gfs025`, which has no 2024 archive at all.
 *    So `models=` is written by this module and is not a caller parameter:
 *    there is no code path that omits it and none that sends anything else.
 * 2. **An unsupported variable returns HTTP 200 with an all-null array** and
 *    `"units": "undefined"`. Measured on `temperature_120m` for `ecmwf_ifs`:
 *    24/24 null, units `undefined`. A NULL column would be indistinguishable
 *    from weather that genuinely was not forecast, so it throws.
 * 3. **The stitched Historical Forecast archive is measurably easier weather.**
 *    It is bit-identical to `_previous_day0` — the shortest-lead slice of each
 *    run — and training on it inflates the intervals the product promises
 *    (RMSE 4.38 km/h train↔serve on `wind_speed_120m` against a field sd of
 *    8.87). This module cannot address that endpoint at all; `run=` is
 *    required on every request.
 * 4. **Accumulated variables have no value at the run's own hour zero.**
 *    Measured: `precipitation`, `shortwave_radiation`, `wind_gusts_10m`,
 *    `direct_normal_irradiance` and `diffuse_radiation` are all null at the
 *    initialisation hour and non-null thereafter, while `wind_speed_120m` is
 *    present. There is no preceding accumulation window, so the hour is
 *    excluded rather than stored as twelve values one of which is missing.
 * 5. **The endpoint returns no rate-limit headers.** No `X-RateLimit-*`, no
 *    `Retry-After`; 429s appear at modest concurrency. Backoff is therefore
 *    driven by the status alone.
 * 6. **The run archive has gaps.** 5 of 112 sampled run slots were missing in
 *    2025-08. A missing run is a named error so the job above can fall back to
 *    an older cycle and *record* that it did, rather than silently producing a
 *    shorter series.
 */

/**
 * Default host. Configuration rather than a constant so that the commercial
 * tier — `https://customer-single-runs-api.open-meteo.com` plus an `apikey` —
 * is an environment change and not a rewrite. The whole historical family,
 * Single Runs included, is Professional-tier the moment WattSteer monetises.
 */
export const SINGLE_RUNS_HOST = "https://single-runs-api.open-meteo.com";

/** The one path this API serves. */
export const SINGLE_RUNS_PATH = "/v1/forecast";

/**
 * The pinned model, written on every request and never taken from a caller.
 *
 * ECMWF IFS HRES is the model the archive and `best_match` actually use over
 * Brazil, it is the most accurate of the candidates when scored against ERA5,
 * and it is the only model with real depth in this archive.
 */
export const WEATHER_MODEL = "ecmwf_ifs";

/**
 * First run this archive serves for `ecmwf_ifs`, measured exactly:
 * `run=2024-03-10T00:00` errors, `run=2024-03-14T00:00` returns 48/48 non-null.
 * It clears the 2024-04-01 training-window start by 18 days.
 */
export const MODEL_COVERAGE_START = "2024-03-14";

/**
 * The twelve variables, settled in `docs/specs/feature-engineering.md`.
 *
 * Twelve is chosen against Open-Meteo's call weighting (a request over ten
 * variables is billed as multiple calls) and matches the 20-location ×
 * 12-variable request measured at 84 KB / 10.5 s. The order is the order sent,
 * so the recorded request URL is stable across runs and diffable.
 *
 * Not requested, each for a stated reason: `boundary_layer_height` and
 * `temperature_120m` (`temperature_120m` is all-null under this model);
 * `wind_speed_180m` and `cape` (available here, held out to keep twelve);
 * `wind_speed_10m` / `_80m` (collinear); `cloud_cover_low/mid/high`;
 * `direct_radiation` (recoverable from DNI and the zenith angle);
 * `global_tilted_irradiance` (would fabricate a tilt assumption);
 * `wind_direction_100m` (one direction suffices).
 */
export const WEATHER_VARIABLES = [
  "wind_speed_100m",
  "wind_speed_120m",
  "wind_direction_120m",
  "wind_gusts_10m",
  "temperature_2m",
  "surface_pressure",
  "relative_humidity_2m",
  "precipitation",
  "shortwave_radiation",
  "direct_normal_irradiance",
  "diffuse_radiation",
  "cloud_cover",
] as const;

export type WeatherVariable = (typeof WEATHER_VARIABLES)[number];

/**
 * The accumulated and time-averaged variables — the ones with no value at the
 * run's own hour zero, because there is no preceding accumulation window.
 *
 * Measured rather than assumed: at `run=2024-04-09T12:00` these five are null
 * at 12:00 and non-null from 13:00, while the instantaneous variables carry a
 * value at 12:00.
 */
export const ACCUMULATED_VARIABLES: ReadonlySet<WeatherVariable> =
  new Set<WeatherVariable>([
    "precipitation",
    "shortwave_radiation",
    "direct_normal_irradiance",
    "diffuse_radiation",
    "wind_gusts_10m",
  ]);

/**
 * The two run cycles WattSteer ingests.
 *
 * The 00 Z run publishes sooner and buys operators notice; the 12 Z run is
 * measurably better at every metric (RMSE 4.38 vs 4.76 km/h on
 * `wind_speed_120m`), especially in the evening hours where curtailment risk
 * concentrates. 06 Z and 18 Z exist from 2025 but not in 2024, so they are not
 * in the vocabulary — a cycle that cannot cover the window is not a cycle this
 * platform can train on.
 */
export const RUN_CYCLES = ["00Z", "12Z"] as const;

export type RunCycle = (typeof RUN_CYCLES)[number];

/** UTC initialisation hour of each cycle. The whole definition of the noun. */
export const RUN_CYCLE_HOUR: Record<RunCycle, number> = { "00Z": 0, "12Z": 12 };

const MS_PER_HOUR = 3_600_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse and validate a `YYYY-MM-DD` day, returning its UTC midnight. */
function utcDay(value: string): number {
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new BadInputError(`Expected a YYYY-MM-DD date, got '${value}'`);
  }
  return Date.parse(`${value}T00:00:00Z`);
}

/**
 * The run that a real day-ahead pipeline would have received for target day
 * `day`: the named cycle of **D−1**.
 *
 * The lead this produces varies across the day — roughly 15 h to 38 h from the
 * 12 Z run — which is exactly what a real pipeline experiences and exactly what
 * the whole-day offsets of the Previous Runs API cannot express.
 */
export function scheduledRunFor(day: string, cycle: RunCycle): Date {
  return new Date(utcDay(day) - 86_400_000 + RUN_CYCLE_HOUR[cycle] * MS_PER_HOUR);
}

/** Which cycle an initialisation instant is. Throws on any other hour. */
export function runCycleOf(runInit: Date): RunCycle {
  if (runInit.getUTCMinutes() !== 0 || runInit.getUTCSeconds() !== 0) {
    throw new BadInputError(
      `Run initialisation ${runInit.toISOString()} is not on the hour — a model run is`,
    );
  }
  for (const cycle of RUN_CYCLES) {
    if (runInit.getUTCHours() === RUN_CYCLE_HOUR[cycle]) {
      return cycle;
    }
  }
  throw new BadInputError(
    `Run initialisation ${runInit.toISOString()} is not a 00Z or 12Z cycle. ` +
      "06Z and 18Z exist from 2025 but not in 2024, so they cannot cover the window.",
  );
}

/** The `run=` parameter's form: minute-resolution UTC, no zone suffix. */
export function runParam(runInit: Date): string {
  return runInit.toISOString().slice(0, 16);
}

/** Step one cycle (12 h) back from a run initialisation. */
export function previousRun(runInit: Date): Date {
  return new Date(runInit.getTime() - 12 * MS_PER_HOUR);
}

/** Whole hours between a scheduled run and the older one actually used. */
export function runAgeHours(scheduled: Date, used: Date): number {
  return Math.round((scheduled.getTime() - used.getTime()) / MS_PER_HOUR);
}

/** One point to query. `id` is WattSteer's, not Open-Meteo's. */
export interface QueryPoint {
  id: string;
  latitude: number;
  longitude: number;
}

/** What to ask one model run for. The model is not among the options. */
export interface ModelRunRequest {
  runInit: Date;
  points: readonly QueryPoint[];
  /** Defaults to all twelve. Narrowed only by tests and diagnostics. */
  variables?: readonly WeatherVariable[];
  /** Forecast days from the run's own initialisation. Defaults to 3. */
  forecastDays?: number;
  /** Host, so the commercial tier is an environment change. */
  baseUrl?: string;
  /** Commercial-tier key, sent as `apikey`. Absent on the free tier. */
  apiKey?: string;
  fetch?: typeof fetch;
  backoff?: BackoffOptions;
}

/**
 * Backoff driven by the 429 status alone.
 *
 * The endpoint returns no `X-RateLimit-*` and no `Retry-After`, so there is
 * nothing to read and nothing to obey — the status is the whole signal. The
 * measured behaviour is 429s at 6-way concurrency against a nominal 600
 * calls/min, so this is a routine condition on a backfill rather than an
 * incident.
 */
export interface BackoffOptions {
  /** Attempts after the first before giving up. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected so a test can prove the schedule without waiting for it. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so the jitter is deterministic under test. */
  random?: () => number;
}

const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, "sleep" | "random">> = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
};

/**
 * Exponential backoff with full jitter, capped.
 *
 * Pure and exported so the schedule is a tested property rather than a claim:
 * `attempt` is 1-based, and the jitter spreads a fleet of concurrent backfill
 * workers instead of synchronising them into a second thundering herd.
 */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const base = options.baseDelayMs ?? DEFAULT_BACKOFF.baseDelayMs;
  const max = options.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs;
  const ceiling = Math.min(max, base * 2 ** (attempt - 1));
  return Math.round(ceiling * (0.5 + 0.5 * random()));
}

/** The run exists in no archive — 4.5% of slots in the sampled fortnight. */
export class ModelRunUnavailableError extends UpstreamError {
  constructor(message: string) {
    super(message);
    this.name = "ModelRunUnavailableError";
  }
}

/**
 * A requested variable came back with no data at all.
 *
 * Thrown rather than stored. `"units": "undefined"` with an all-null array is
 * how Open-Meteo reports a variable a model does not serve, and it is HTTP 200
 * — indistinguishable, downstream, from weather that genuinely was not
 * forecast.
 */
export class UndefinedWeatherVariableError extends UpstreamError {
  constructor(message: string) {
    super(message);
    this.name = "UndefinedWeatherVariableError";
  }
}

/** Rate limiting outlasted the backoff schedule. */
export class WeatherRateLimitError extends UpstreamError {
  constructor(message: string) {
    super(message);
    this.name = "WeatherRateLimitError";
  }
}

/** One location object of a Single Runs response, before normalisation. */
export interface RawLocation {
  latitude: number;
  longitude: number;
  elevation: number;
  hourly_units: Record<string, string>;
  hourly: Record<string, unknown>;
}

/** One answered run request: its locations and where and when they came from. */
export interface ModelRunResponse {
  /** In request order — the API preserves it, and the parse relies on that. */
  locations: RawLocation[];
  url: string;
  fetchedAt: Date;
  /** The bytes as received, for the content digest and the raw archive. */
  body: string;
  httpStatus: number;
  /** 429s absorbed by the backoff. Recorded so a backfill can report pressure. */
  rateLimitRetries: number;
}

/**
 * Build the request URL.
 *
 * Exported so a test can assert the two things that are invisible in a
 * response: that `models=ecmwf_ifs` is present on every single request, and
 * that `run=` is too. Neither is a caller's choice.
 */
export function singleRunsUrl(request: ModelRunRequest): string {
  const variables = request.variables ?? WEATHER_VARIABLES;
  if (variables.length === 0) {
    throw new BadInputError("A weather request must name at least one variable");
  }
  if (request.points.length === 0) {
    throw new BadInputError("A weather request must name at least one point");
  }
  // Validates the cycle before anything is sent.
  runCycleOf(request.runInit);

  const url = new URL(`${request.baseUrl ?? SINGLE_RUNS_HOST}${SINGLE_RUNS_PATH}`);
  url.searchParams.set("latitude", request.points.map((p) => p.latitude).join(","));
  url.searchParams.set("longitude", request.points.map((p) => p.longitude).join(","));
  url.searchParams.set("hourly", variables.join(","));
  url.searchParams.set("run", runParam(request.runInit));
  url.searchParams.set("forecast_days", String(request.forecastDays ?? 3));
  // GMT, always: a wall-clock offset would put the run's own hour zero
  // somewhere other than the first element and break the exclusion below.
  url.searchParams.set("timezone", "GMT");
  // The pin. Written here and nowhere else.
  url.searchParams.set("models", WEATHER_MODEL);
  if (request.apiKey) {
    url.searchParams.set("apikey", request.apiKey);
  }
  return url.toString();
}

/**
 * Normalise the two response shapes into one.
 *
 * A single-point request returns a bare object; a comma-separated request
 * returns an array of them. Collapsing that here means nothing downstream has
 * to care how many points it asked for.
 */
export function locationsOf(value: unknown): RawLocation[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => {
    const location = entry as Partial<RawLocation>;
    if (
      typeof location?.latitude !== "number" ||
      typeof location?.longitude !== "number" ||
      typeof location?.hourly !== "object" ||
      location.hourly === null
    ) {
      throw new UpstreamError("Single Runs response is not a location object");
    }
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      elevation: typeof location.elevation === "number" ? location.elevation : 0,
      hourly_units: (location.hourly_units ?? {}) as Record<string, string>,
      hourly: location.hourly as Record<string, unknown>,
    };
  });
}

/** Open-Meteo's error envelope: `{ error: true, reason: "…" }`, on a 4xx. */
function reasonOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; reason?: unknown };
    return parsed?.error === true && typeof parsed.reason === "string"
      ? parsed.reason
      : null;
  } catch {
    return null;
  }
}

/**
 * Fetch one named model run, retrying on 429 and nothing else.
 *
 * A 429 is capacity and is retried; a 400 is an answer — usually "the requested
 * model run is not available", which is a fact about the archive and is raised
 * as its own error so the job can fall back a cycle and record that it did.
 */
export async function fetchModelRun(request: ModelRunRequest): Promise<ModelRunResponse> {
  const fetchImpl = request.fetch ?? fetch;
  const url = singleRunsUrl(request);
  const backoff = request.backoff ?? {};
  const maxRetries = backoff.maxRetries ?? DEFAULT_BACKOFF.maxRetries;
  const sleep =
    backoff.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let rateLimitRetries = 0;
  for (;;) {
    const response = await fetchImpl(url);

    if (response.status === 429) {
      if (rateLimitRetries >= maxRetries) {
        throw new WeatherRateLimitError(
          `GET ${redact(url)} was rate-limited ${rateLimitRetries + 1} times. ` +
            "This endpoint returns no rate-limit headers, so backoff has nothing " +
            "to obey but the status; the schedule is exhausted.",
        );
      }
      rateLimitRetries += 1;
      await sleep(backoffDelayMs(rateLimitRetries, backoff, backoff.random));
      continue;
    }

    const body = await response.text();
    if (!response.ok) {
      const reason = reasonOf(body);
      if (reason && /model run is not available/i.test(reason)) {
        throw new ModelRunUnavailableError(
          `Model run ${runParam(request.runInit)} (${WEATHER_MODEL}) is not in the ` +
            `archive: ${reason}`,
        );
      }
      throw new UpstreamError(
        `GET ${redact(url)} failed: HTTP ${response.status}${reason ? ` — ${reason}` : ""}`,
      );
    }

    return {
      locations: locationsOf(JSON.parse(body)),
      url: redact(url),
      fetchedAt: new Date(),
      body,
      httpStatus: response.status,
      rateLimitRetries,
    };
  }
}

/**
 * The recorded URL with the key removed.
 *
 * The request URL is provenance and is stored on every run request, so a
 * commercial key must never be one of the bytes it stores.
 */
export function redact(url: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has("apikey")) {
    parsed.searchParams.set("apikey", "REDACTED");
  }
  return parsed.toString();
}

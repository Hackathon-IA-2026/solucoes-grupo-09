import { config } from "../config.js";
import type { Database } from "../database/connection.js";
import { BadInputError } from "../errors.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import {
  asQueryPoints,
  CENTROID_SET_VERSION,
  type Centroid,
  resolveCentroids,
} from "./weather/centroids.js";
import { parseModelRun } from "./weather/parse.js";
import {
  type BackoffOptions,
  fetchModelRun,
  MODEL_COVERAGE_START,
  ModelRunUnavailableError,
  previousRun,
  RUN_CYCLES,
  type RunCycle,
  runAgeHours,
  scheduledRunFor,
  WEATHER_VARIABLES,
  WeatherRateLimitError,
} from "./weather/single-runs.js";
import {
  readHeldRunInits,
  recordWeatherRunRequest,
  writeWeatherForecast,
} from "./weather-repository.js";

/**
 * Ingestion for weather from named model runs.
 *
 * The unit of work is **one model run for all centroids at once**. That is not
 * an optimisation: Open-Meteo answers a comma-separated multi-point request
 * with one object per point, snapped to each point's own grid cell, and the
 * measured cost of 20 locations × 12 variables × 3 forecast days in one request
 * is 84 KB and 10.5 s. Splitting it per point would multiply the call count by
 * twenty against an endpoint that already 429s at 6-way concurrency.
 *
 * **A model run is immutable, so a run already held is never fetched again.**
 * The bulk sources spend a `HEAD` to learn that a file has not moved; here the
 * equivalent question is answered locally, from the provenance table, because
 * ECMWF does not rewrite a published run. That is what makes it affordable for
 * the refresh sweep to plan the same slots over and over — see the tier note in
 * `refresh.ts`. A slot answered only by an *older* fallback run is deliberately
 * not counted as held, so a later pass can pick up a run that published late.
 *
 * Both cycles are ingested for every target day. The 00 Z run publishes sooner
 * and buys operators notice; the 12 Z run is measurably better, especially in
 * the evening hours where curtailment risk concentrates. Nothing in this job
 * expresses "12 Z supersedes 00 Z" — the run initialisation is the row's
 * publication time, so the later run is simply a newer vintage of the same
 * valid hours and the shared versioned write does the rest.
 */

/** One target day range. Runs are always D−1 of each day in it. */
export interface IngestWeatherPayload {
  /** `YYYY-MM-DD` target days, inclusive. Runs fetched are D−1. */
  from: string;
  to: string;
  /** Defaults to both. Narrowed to compare the two cycles or to catch up. */
  runCycles?: RunCycle[];
  /** Defaults to the whole frozen centroid set. */
  centroidIds?: string[];
  /**
   * Forecast days from the run's own initialisation. Three covers the whole of
   * target day D from either cycle with room for the Brasília-local day, which
   * runs 03:00 Z on D to 02:00 Z on D+1.
   */
  forecastDays?: number;
  /**
   * How many 12-hour steps back to try when a scheduled run is missing.
   *
   * The archive is not gapless — 5 of 112 sampled run slots were missing, all
   * clustered in one 2025-08 week — and a missing run is not a reason to leave
   * a hole. Two steps reaches 24 h back, which covered every observed gap.
   * Zero disables the fallback and makes a missing run a hard failure.
   */
  maxRunFallbackSteps?: number;
  /**
   * Re-fetch run slots already answered by the run that was asked for.
   *
   * Off by default, and that default is what lets the refresh sweep plan the
   * same slots repeatedly at no cost: a model run is immutable, so the only
   * reason to fetch one twice is to reprocess bytes, never to discover a
   * revision. See `readHeldRunInits`.
   */
  force?: boolean;
  /**
   * Which end of the window to start from. `newest_first` (the default) is
   * the live sweep's rule — under a bounded allowance the serving day must be
   * reached first. `oldest_first` is the backfill's: `writeWeatherForecast`
   * never lets a key's publication time go backwards, so a window walked from
   * its newest slot keeps only the newest run of every hour and throws the
   * older runs away as superseded. Measured on the AWS instance on 26/09: July
   * and August 2026 came back with one version per hour, the target day's own
   * 00Z run, published after the morning gate, and the feature read at that
   * gate saw no weather at all. Walked oldest first, each run lands before the
   * one that supersedes it, and the versions accumulate exactly as they do
   * when the sweep meets the runs one day at a time.
   */
  order?: SlotOrder;
  /**
   * Weighted call units this invocation may spend before it stops.
   *
   * The free tier's allowance is a **daily** one and the endpoint publishes no
   * `X-RateLimit-*` or `Retry-After`, so the only way to respect it is to count
   * what is spent rather than to discover the ceiling by being refused.
   * Forecaster 37 measured what discovery costs: on 2026-09-11 the weather
   * source recorded **2 ok and 27 failed**, the head did not move for 69
   * minutes, and every one of four forward attempts was refused before it
   * reached a forward valid time at all.
   *
   * Units are :func:`callBudget`'s, which applies Open-Meteo's own weighting
   * pessimistically. `undefined` means unbounded, which is the right default
   * for a commercial key and the wrong one for the free tier — `config`
   * supplies the bound, so the tier is a variable rather than a code change.
   */
  maxWeightedUnits?: number;
}

/** What one run contributed, and which run it actually was. */
export interface WeatherRunSummary {
  targetDay: string;
  cycle: RunCycle;
  scheduledRunInit: string;
  /** Older than `scheduledRunInit` when the archive was missing that run. */
  runInit: string | null;
  runAgeHours: number;
  rows: number;
  /** True when no run within the fallback window existed. */
  missing: boolean;
}

export interface IngestWeatherResult {
  centroidSetVersion: string;
  centroidIds: string[];
  variables: string[];
  /** Run slots asked for — target days × cycles. */
  runsScheduled: number;
  /**
   * Slots skipped because the scheduled run was already held. The number that
   * makes a repeated sweep cheap, so it is reported rather than inferred.
   */
  runsAlreadyHeld: number;
  /** Runs that produced rows. */
  runsIngested: number;
  /** Slots where the scheduled run was missing and an older one was used. */
  runsFallenBack: number;
  /** Slots where no run existed within the fallback window. */
  runsMissing: number;
  /** HTTP calls actually made, including the misses. One per run tried. */
  requests: number;
  /** 429s absorbed by backoff across the whole ingest. */
  rateLimitRetries: number;
  /** Rows dropped as the run's own hour zero. */
  hourZeroRowsExcluded: number;
  /** Individual missing values in stored rows. A hole, not a failure. */
  nullValues: number;
  inserted: number;
  revised: number;
  unchanged: number;
  /**
   * Rows dropped because a newer run already answered that hour. Zero on the
   * ordinary path; non-zero when a backfill is re-run, because the second pass
   * fetches the 00Z run again after the 12Z run is already stored.
   */
  supersededByNewerRun: number;
  runs: WeatherRunSummary[];
  /**
   * Weighted units this invocation spent, by :func:`callBudget`'s weighting.
   * Reported so a sweep's cost is a number in the record rather than an
   * inference from `requests`.
   */
  weightedUnitsSpent: number;
  /**
   * Why the sweep ended. `complete` means every slot was reached.
   *
   * The other two are **outcomes, not failures**, and that distinction is the
   * point: a sweep that ran out of allowance has ingested everything it paid
   * for and left a head that moved. Throwing instead — which is what a
   * propagating `WeatherRateLimitError` did — discards the whole invocation's
   * work and writes a failed `ingestion_run`, which is how 27 failures got
   * recorded for a source that was working exactly as well as its quota let it.
   */
  stoppedBecause: "complete" | "budget_exhausted" | "rate_limited";
}

export interface WeatherIngestorDeps {
  db: Database;
  /** Injected so the job is testable without the network. */
  fetch?: typeof fetch;
  /** Where raw responses are retained. Absent means custody is off. */
  archive?: PayloadArchive;
  /**
   * Host. Defaults to `WATTSTEER_OPEN_METEO_HOST`, then to the free-tier host —
   * so moving to the Professional tier's `customer-` hostname is an environment
   * change and not a rewrite. A test passes it explicitly.
   */
  baseUrl?: string;
  /**
   * Commercial-tier key, defaulting to `WATTSTEER_OPEN_METEO_KEY`. Redacted out
   * of the stored request URL.
   */
  apiKey?: string;
  backoff?: BackoffOptions;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Inclusive `YYYY-MM-DD` day list. */
export function targetDays(from: string, to: string): string[] {
  for (const value of [from, to]) {
    if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      throw new BadInputError(`Expected a YYYY-MM-DD date, got '${value}'`);
    }
  }
  const end = Date.parse(`${to}T00:00:00Z`);
  if (end < Date.parse(`${from}T00:00:00Z`)) {
    throw new BadInputError(`Range ends before it starts: ${from} → ${to}`);
  }
  const days: string[] = [];
  for (
    let cursor = Date.parse(`${from}T00:00:00Z`);
    cursor <= end;
    cursor += MS_PER_DAY
  ) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * The documented call budget for a backfill of this window.
 *
 * Exported and tested rather than left in a comment, because "completes within
 * the documented call budget" is only checkable if the budget is a value. The
 * weighting is Open-Meteo's own, applied pessimistically: a request over ten
 * variables is billed as multiple calls, and it is not published whether a
 * multi-location request is billed per location, so this assumes it is.
 */
/** One run slot: the target day, the cycle, and the run that answers it. */
export interface RunSlot {
  day: string;
  cycle: RunCycle;
  scheduled: Date;
}

/**
 * The slots a sweep will walk, **newest run first**.
 *
 * The order is the whole of forecaster 37's fix, and it is a fix
 * about *priority* rather than about capacity. The order used to be
 * chronological, which under a bounded allowance starts at the wrong end: the
 * sweep spent its quota on the oldest backfill target and was refused "before
 * it reaches a forward valid time at all", so the serving day — the only slot
 * a forecast needs — was never reached, four attempts running.
 *
 * Reversed, an exhausted allowance leaves the head moved and the backfill
 * behind. That is the recoverable direction: yesterday's history can be caught
 * up tomorrow, and tomorrow's forecast cannot be published late.
 *
 * Pure and exported so the ordering is checkable without a database, which is
 * what the ingest tests need to be gated on.
 */
export type SlotOrder = "newest_first" | "oldest_first";

export function plannedSlots(
  days: string[],
  cycles: RunCycle[],
  order: SlotOrder = "newest_first",
): RunSlot[] {
  const sign = order === "oldest_first" ? 1 : -1;
  return days
    .flatMap((day) =>
      cycles.map((cycle) => ({ day, cycle, scheduled: scheduledRunFor(day, cycle) })),
    )
    .sort((a, b) => sign * (a.scheduled.getTime() - b.scheduled.getTime()));
}

export function callBudget(options: {
  days: number;
  cycles: number;
  centroids: number;
  variables?: number;
}): { requests: number; weightedUnits: number } {
  const requests = options.days * options.cycles;
  const variableMultiplier =
    (options.variables ?? WEATHER_VARIABLES.length) > 10 ? 1.2 : 1;
  return {
    requests,
    weightedUnits: Math.round(requests * options.centroids * variableMultiplier),
  };
}

/**
 * Find the newest run at or before `scheduled` that the archive actually holds.
 *
 * Steps back a whole cycle at a time, which alternates 12 Z and 00 Z. A run
 * before `ecmwf_ifs` coverage begins is not tried at all — that is a fact about
 * the archive, not a gap in it, and asking would spend a call to be told so.
 */
async function fetchWithFallback(
  scheduled: Date,
  points: ReturnType<typeof asQueryPoints>,
  deps: WeatherIngestorDeps,
  maxSteps: number,
  forecastDays: number,
): Promise<{
  response: Awaited<ReturnType<typeof fetchModelRun>> | null;
  runInit: Date | null;
  requests: number;
}> {
  const coverageStart = Date.parse(`${MODEL_COVERAGE_START}T00:00:00Z`);
  let requests = 0;
  let runInit = scheduled;

  for (let step = 0; step <= maxSteps; step += 1) {
    if (runInit.getTime() < coverageStart) {
      break;
    }
    try {
      requests += 1;
      const response = await fetchModelRun({
        runInit,
        points,
        forecastDays,
        baseUrl: deps.baseUrl,
        apiKey: deps.apiKey,
        fetch: deps.fetch,
        backoff: deps.backoff,
      });
      return { response, runInit, requests };
    } catch (error) {
      if (!(error instanceof ModelRunUnavailableError)) {
        throw error;
      }
      runInit = previousRun(runInit);
    }
  }
  return { response: null, runInit: null, requests };
}

/** Which of these slots are already answered by the exact run asked for. */
async function heldSlots(
  db: WeatherIngestorDeps["db"],
  slots: { scheduled: Date }[],
): Promise<Set<string>> {
  if (slots.length === 0) {
    return new Set();
  }
  const times = slots.map((slot) => slot.scheduled.getTime());
  return readHeldRunInits(db, {
    from: new Date(Math.min(...times)),
    to: new Date(Math.max(...times)),
  });
}

/**
 * Build the job handler.
 *
 * One HTTP call per (target day, cycle) on the normal path — 880 days × 1 cycle
 * is 880 requests for the whole training window, ~30 min at 3-way concurrency,
 * and 1–2 requests a day thereafter.
 */
export function createWeatherIngestor(
  deps: WeatherIngestorDeps,
): Execute<IngestWeatherPayload, IngestWeatherResult> {
  // Host and key come from the environment unless a caller overrides them, so
  // the commercial tier is a variable rather than a code change.
  const configured: WeatherIngestorDeps = {
    ...deps,
    baseUrl: deps.baseUrl ?? config.openMeteoHost,
    apiKey: deps.apiKey ?? config.openMeteoApiKey,
  };

  return async (payload, report) => {
    const days = targetDays(payload.from, payload.to);
    const cycles = payload.runCycles ?? [...RUN_CYCLES];
    for (const cycle of cycles) {
      if (!RUN_CYCLES.includes(cycle)) {
        throw new BadInputError(`Unknown run cycle '${cycle}'`);
      }
    }
    const centroids: Centroid[] = resolveCentroids(payload.centroidIds);
    const points = asQueryPoints(centroids);
    const forecastDays = payload.forecastDays ?? 3;
    const maxSteps = payload.maxRunFallbackSteps ?? 2;

    const result: IngestWeatherResult = {
      centroidSetVersion: CENTROID_SET_VERSION,
      centroidIds: centroids.map((centroid) => centroid.id),
      variables: [...WEATHER_VARIABLES],
      runsScheduled: days.length * cycles.length,
      runsAlreadyHeld: 0,
      runsIngested: 0,
      runsFallenBack: 0,
      runsMissing: 0,
      requests: 0,
      rateLimitRetries: 0,
      hourZeroRowsExcluded: 0,
      nullValues: 0,
      inserted: 0,
      revised: 0,
      unchanged: 0,
      supersededByNewerRun: 0,
      runs: [],
      weightedUnitsSpent: 0,
      stoppedBecause: "complete",
    };

    // The local probe, read once for the whole range rather than per slot: it
    // is the thing that stops a sweep re-downloading an immutable archive.
    //
    // **Newest first.** The order used to be chronological, and under a bounded
    // allowance that is the wrong end to start from: forecaster 37 measured a
    // sweep refused on its *first* model run, "before it reaches a forward
    // valid time at all", so the oldest backfill target consumed the quota and
    // the serving day — the only slot the forecast needs — was never reached.
    // Reversing it means an exhausted allowance leaves the head moved and the
    // backfill behind, which is the direction that can be caught up later.
    const slots = plannedSlots(days, cycles, payload.order);
    const held = payload.force ? new Set<string>() : await heldSlots(deps.db, slots);

    // One slot's cost, in the same units the budget is denominated in.
    const unitsPerSlot = callBudget({
      days: 1,
      cycles: 1,
      centroids: centroids.length,
    }).weightedUnits;
    const ceiling = payload.maxWeightedUnits ?? config.openMeteoMaxWeightedUnits;

    let done = 0;
    for (const { day, cycle, scheduled } of slots) {
      if (held.has(scheduled.toISOString())) {
        result.runsAlreadyHeld += 1;
        done += 1;
        report({ done, total: result.runsScheduled });
        continue;
      }
      // Checked *before* spending, not after: a budget discovered by being
      // refused is the failure mode this replaces. A held slot costs nothing
      // and is skipped above, so a repeated sweep still walks the whole range
      // for free.
      if (ceiling !== undefined && result.weightedUnitsSpent + unitsPerSlot > ceiling) {
        result.stoppedBecause = "budget_exhausted";
        break;
      }
      let attempt: Awaited<ReturnType<typeof fetchWithFallback>>;
      try {
        attempt = await fetchWithFallback(
          scheduled,
          points,
          configured,
          maxSteps,
          forecastDays,
        );
      } catch (error) {
        // A rate limit that outlasted the backoff is the allowance answering,
        // and everything already ingested in this invocation is good. Stop and
        // say so; anything else is not this error and still throws.
        if (error instanceof WeatherRateLimitError) {
          result.stoppedBecause = "rate_limited";
          break;
        }
        throw error;
      }
      result.requests += attempt.requests;
      result.weightedUnitsSpent += unitsPerSlot;
      done += 1;

      if (!(attempt.response && attempt.runInit)) {
        result.runsMissing += 1;
        result.runs.push({
          targetDay: day,
          cycle,
          scheduledRunInit: scheduled.toISOString(),
          runInit: null,
          runAgeHours: 0,
          rows: 0,
          missing: true,
        });
        report({ done, total: result.runsScheduled });
        continue;
      }

      const { response, runInit } = attempt;
      result.rateLimitRetries += response.rateLimitRetries;

      // Parsed before anything is recorded: an all-null variable or a grid
      // collision must abort the ingest, not leave a provenance row claiming
      // a run was successfully taken in.
      const parsed = parseModelRun(response, {
        centroids,
        runInit,
        scheduledRunInit: scheduled,
      });

      const sourceVersionId = await recordWeatherRunRequest(
        deps.db,
        {
          runInit,
          scheduledRunInit: scheduled,
          centroidCount: centroids.length,
          forecastDays,
          rowCount: parsed.rows.length,
          response,
        },
        deps.archive,
      );

      const written = await writeWeatherForecast(deps.db, {
        rows: parsed.rows,
        sourceVersionId,
      });

      result.runsIngested += 1;
      if (runInit.getTime() !== scheduled.getTime()) {
        result.runsFallenBack += 1;
      }
      result.hourZeroRowsExcluded += parsed.hourZeroRowsExcluded;
      result.nullValues += parsed.nullValues;
      result.inserted += written.inserted;
      result.revised += written.revised;
      result.unchanged += written.unchanged;
      result.supersededByNewerRun += written.supersededByNewerRun;
      result.runs.push({
        targetDay: day,
        cycle,
        scheduledRunInit: scheduled.toISOString(),
        runInit: runInit.toISOString(),
        runAgeHours: runAgeHours(scheduled, runInit),
        rows: parsed.rows.length,
        missing: false,
      });

      report({ done, total: result.runsScheduled });
    }

    return result;
  };
}

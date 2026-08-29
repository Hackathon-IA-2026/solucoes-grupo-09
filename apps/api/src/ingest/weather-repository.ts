import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { weatherForecastHour, weatherRunRequest } from "../database/schema.js";
import { UpstreamError } from "../errors.js";
import type { VintageFidelity } from "./repository.js";
import type { WeatherForecastHour } from "./types.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";
import { CENTROID_SET_VERSION } from "./weather/centroids.js";
import {
  type ModelRunResponse,
  type RunCycle,
  runCycleOf,
  WEATHER_MODEL,
  WEATHER_VARIABLES,
  type WeatherVariable,
} from "./weather/single-runs.js";

/**
 * Bitemporal persistence for weather from named model runs.
 *
 * The append-and-version algorithm is the shared one (`versioned-write.ts`);
 * this source differs from the bulk ones in how its bytes are *acquired*, not
 * in how a revision is recorded.
 *
 * What this table does that no other does: **`published_at` is a genuine
 * publication instant rather than a fallback.** Every other source in the
 * platform stamps a file's `Last-Modified` or a fetch time and marks the
 * coarseness; a model run has a real initialisation time, and the D−1 12Z run
 * superseding the D−1 00Z run is therefore just `data_version` 2 of the same
 * business key. Nothing here implements supersession, because there is nothing
 * to implement.
 *
 * The one rule this module adds to the shared write is its converse:
 * **publication time never goes backwards for a key.** A re-run of a backfill
 * fetches the 00Z run again after the 12Z run is already stored, and appending
 * it would quietly make the older forecast the current answer.
 */

/** The request that produced one model run's rows, recorded before anything else. */
export interface RecordedWeatherRunRequest {
  runInit: Date;
  /** The run asked for. Equals `runInit` unless the archive was missing it. */
  scheduledRunInit?: Date;
  centroidSetVersion?: string;
  centroidCount: number;
  variables?: readonly WeatherVariable[];
  forecastDays: number;
  /** Canonical rows the response yielded, after hour-zero exclusion. */
  rowCount: number;
  response: ModelRunResponse;
}

/**
 * Record one answered model-run call and return its id.
 *
 * Written unconditionally, before the facts: the fact rows carry a foreign key
 * to it, and it is also the only record that this run was requested at all —
 * which is what makes a fallback to an older cycle explicable rather than an
 * unexplained hole in the series.
 */
export async function recordWeatherRunRequest(
  db: Database,
  request: RecordedWeatherRunRequest,
): Promise<string> {
  const { response } = request;
  const [inserted] = await db
    .insert(weatherRunRequest)
    .values({
      model: WEATHER_MODEL,
      runInit: request.runInit,
      runCycle: runCycleOf(request.runInit),
      scheduledRunInit: request.scheduledRunInit ?? request.runInit,
      centroidSetVersion: request.centroidSetVersion ?? CENTROID_SET_VERSION,
      centroidCount: request.centroidCount,
      variables: (request.variables ?? WEATHER_VARIABLES).join(","),
      forecastDays: request.forecastDays,
      requestUrl: response.url,
      httpStatus: response.httpStatus,
      rowCount: request.rowCount,
      contentSha256: createHash("sha256").update(response.body).digest("hex"),
      byteSize: Buffer.byteLength(response.body),
      rateLimitRetries: response.rateLimitRetries,
      fetchedAt: response.fetchedAt,
    })
    .returning({ id: weatherRunRequest.id });

  if (!inserted) {
    throw new UpstreamError("Failed to record the Single Runs API request");
  }
  return inserted.id;
}

/**
 * Digest of a weather row's stored values, and nothing else.
 *
 * The run identity is deliberately excluded — not just `published_at`, which
 * the shared rule already excludes, but `run_cycle`, `run_age_hours` and the
 * grid cell too. Including any of them would make the 12Z run a revision of the
 * 00Z run *by definition*, and the table would record which cycles ran rather
 * than whether the forecast actually changed. A 12Z run that reproduces the
 * 00Z numbers exactly has not restated anything, and writes nothing.
 */
export function weatherForecastDigest(row: WeatherForecastHour): string {
  return digestValues([
    row.centroidId,
    row.validTime.toISOString(),
    row.windSpeed100mKmh,
    row.windSpeed120mKmh,
    row.windDirection120mDeg,
    row.windGusts10mKmh,
    row.temperature2mC,
    row.surfacePressureHpa,
    row.relativeHumidity2mPct,
    row.precipitationMm,
    row.shortwaveRadiationWm2,
    row.directNormalIrradianceWm2,
    row.diffuseRadiationWm2,
    row.cloudCoverPct,
  ]);
}

const WEATHER_SPEC: VersionedTableSpec<
  WeatherForecastHour,
  typeof weatherForecastHour.$inferInsert
> = {
  table: weatherForecastHour,
  tableName: "weather_forecast_hour",
  keyColumns: ["centroid_id", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) => `${row.centroidId}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: weatherForecastDigest,
  toInsert: (row, version, vintage) => ({
    centroidId: row.centroidId,
    validTime: row.validTime,
    gridLatitude: row.gridLatitude,
    gridLongitude: row.gridLongitude,
    gridElevationM: row.gridElevationM,
    runCycle: row.runCycle,
    runAgeHours: row.runAgeHours,
    dataVersion: version.dataVersion,
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
    // The row's own run initialisation, never the vintage stamp's fallback.
    // Taking it from the row rather than from the write is what lets a single
    // write hold rows from more than one run without inventing a special case.
    publishedAt: row.runInitTime,
    publishedAtPrecision: "file",
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceRequestId: vintage.sourceVersionId,
  }),
};

/**
 * What to write. `publishedAt` is not a caller's choice — it comes off each row
 * as the run initialisation — but the shared write's `VintageStamp` requires
 * one, so the ingest time and provenance travel here and the publication does
 * not.
 */
export interface WeatherForecastWrite {
  rows: WeatherForecastHour[];
  /** The `weather_run_request` row these facts came from. */
  sourceVersionId: string;
  /** Overridable so a test can place a write at a chosen instant. */
  ingestedAt?: Date;
}

export interface WeatherWriteResult extends VersionedWriteResult {
  /**
   * Rows dropped because a **newer run** already answers that hour.
   *
   * Zero on the ordinary path, where runs arrive in publication order. Non-zero
   * when a backfill is re-run: the second pass fetches the 00Z run again after
   * the 12Z run is already stored, and appending it would make the *older*
   * forecast the current answer.
   */
  supersededByNewerRun: number;
}

/**
 * Which run currently answers each key in a batch's valid-time range.
 *
 * The one query this table needs beyond the shared write, and it exists to
 * enforce a single rule: **publication time never goes backwards for a key.**
 * That is not supersession logic — supersession is free, because the run
 * initialisation is the publication time — it is the refusal to *regress* a
 * vintage, which the shared write cannot know about because it compares values
 * rather than publication instants.
 */
async function latestRunPerKey(
  db: Database,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const rows = await db.execute<{
    centroid_id: string;
    valid_time: string;
    latest_run: string;
  }>(sql`
    select centroid_id, valid_time, max(published_at) as latest_run
    from weather_forecast_hour
    where valid_time >= ${from.toISOString()}::timestamptz
      and valid_time <= ${to.toISOString()}::timestamptz
    group by centroid_id, valid_time
  `);
  const latest = new Map<string, number>();
  for (const row of rows) {
    latest.set(
      `${row.centroid_id}|${new Date(row.valid_time).toISOString()}`,
      new Date(row.latest_run).getTime(),
    );
  }
  return latest;
}

/**
 * Append the weather rows whose values actually changed. Idempotent.
 *
 * Re-running the same run writes nothing, because every digest matches the
 * version already stored — which is what makes a retry after a partial backfill
 * failure safe, and what makes an 880-day backfill resumable. Re-running an
 * older run over a newer one writes nothing either, for a different reason: it
 * is dropped before the digest is even consulted.
 */
export async function writeWeatherForecast(
  db: Database,
  write: WeatherForecastWrite,
): Promise<WeatherWriteResult> {
  if (write.rows.length === 0) {
    return { inserted: 0, revised: 0, unchanged: 0, supersededByNewerRun: 0 };
  }
  const times = write.rows.map((row) => row.validTime.getTime());
  const latest = await latestRunPerKey(
    db,
    new Date(Math.min(...times)),
    new Date(Math.max(...times)),
  );
  const rows = write.rows.filter((row) => {
    const stored = latest.get(`${row.centroidId}|${row.validTime.toISOString()}`);
    return stored === undefined || row.runInitTime.getTime() >= stored;
  });
  const supersededByNewerRun = write.rows.length - rows.length;

  const vintage: VintageStamp = {
    // Never stored: `toInsert` takes `published_at` from each row's own run
    // initialisation. Present only because the shared stamp requires the field,
    // and set to the batch's run so that a mis-wiring is visible rather than
    // plausible.
    publishedAt: write.rows[0]?.runInitTime ?? new Date(0),
    publishedAtPrecision: "file",
    sourceVersionId: write.sourceVersionId,
    ingestedAt: write.ingestedAt,
  };
  const written = await writeVersioned(db, WEATHER_SPEC, rows, vintage);
  return { ...written, supersededByNewerRun };
}

/** One row of an as-of read, carrying the vintage and the run it came from. */
export interface WeatherForecastAsOfRow extends WeatherForecastHour {
  dataVersion: number;
  ingestedAt: Date;
}

export interface WeatherForecastAsOfResult {
  rows: WeatherForecastAsOfRow[];
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

export interface WeatherAsOfQuery {
  asOf: Date;
  from: Date;
  to: Date;
  centroidIds?: readonly string[];
  /**
   * Restrict to one cycle.
   *
   * Absent — the normal read — the latest version wins whichever run produced
   * it, which is exactly the supersession the schema encodes. Present, it
   * answers the diagnostic question "what did the 00Z run say?" without the
   * table needing a second copy of anything.
   */
  runCycle?: RunCycle;
}

/**
 * `AsOf(t)` over the weather forecast — the only sanctioned read of the table.
 *
 * `DISTINCT ON` over (`centroid_id`, `valid_time`) ordered by descending
 * `ingested_at` returns exactly one row per key or none. Because
 * `published_at` is the run initialisation, ordering by `data_version` within
 * an ingest instant orders by run: the 12Z row is the later version of the same
 * key, and no clause in this query mentions a cycle to make that so.
 */
export async function readWeatherForecastAsOf(
  db: Database,
  query: WeatherAsOfQuery,
): Promise<WeatherForecastAsOfResult> {
  const centroidFilter =
    query.centroidIds && query.centroidIds.length > 0
      ? sql`and centroid_id in (${sql.join(
          query.centroidIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;
  const cycleFilter = query.runCycle
    ? sql`and run_cycle = ${query.runCycle}::weather_run_cycle`
    : sql``;

  const rows = await db.execute<{
    centroid_id: string;
    valid_time: string;
    grid_latitude: number;
    grid_longitude: number;
    grid_elevation_m: number;
    run_cycle: RunCycle;
    run_age_hours: number;
    data_version: number;
    wind_speed100m_kmh: number | null;
    wind_speed120m_kmh: number | null;
    wind_direction120m_deg: number | null;
    wind_gusts10m_kmh: number | null;
    temperature2m_c: number | null;
    surface_pressure_hpa: number | null;
    relative_humidity2m_pct: number | null;
    precipitation_mm: number | null;
    shortwave_radiation_wm2: number | null;
    direct_normal_irradiance_wm2: number | null;
    diffuse_radiation_wm2: number | null;
    cloud_cover_pct: number | null;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select distinct on (centroid_id, valid_time)
      centroid_id, valid_time, grid_latitude, grid_longitude, grid_elevation_m,
      run_cycle, run_age_hours, data_version,
      wind_speed100m_kmh, wind_speed120m_kmh, wind_direction120m_deg,
      wind_gusts10m_kmh, temperature2m_c, surface_pressure_hpa,
      relative_humidity2m_pct, precipitation_mm, shortwave_radiation_wm2,
      direct_normal_irradiance_wm2, diffuse_radiation_wm2, cloud_cover_pct,
      published_at, ingested_at
    from weather_forecast_hour
    where ingested_at <= ${query.asOf.toISOString()}::timestamptz
      and valid_time >= ${query.from.toISOString()}::timestamptz
      and valid_time < ${query.to.toISOString()}::timestamptz
      ${centroidFilter}
      ${cycleFilter}
    order by centroid_id, valid_time, ingested_at desc, data_version desc
  `);

  const [live] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from weather_forecast_hour`,
  );
  const goLiveAt = live?.go_live ? new Date(live.go_live) : null;
  const number = (value: number | null): number | null =>
    value === null ? null : Number(value);

  return {
    rows: [...rows].map((row) => ({
      centroidId: row.centroid_id,
      validTime: new Date(row.valid_time),
      gridLatitude: Number(row.grid_latitude),
      gridLongitude: Number(row.grid_longitude),
      gridElevationM: Number(row.grid_elevation_m),
      runInitTime: new Date(row.published_at),
      runCycle: row.run_cycle,
      runAgeHours: Number(row.run_age_hours),
      dataVersion: row.data_version,
      ingestedAt: new Date(row.ingested_at),
      windSpeed100mKmh: number(row.wind_speed100m_kmh),
      windSpeed120mKmh: number(row.wind_speed120m_kmh),
      windDirection120mDeg: number(row.wind_direction120m_deg),
      windGusts10mKmh: number(row.wind_gusts10m_kmh),
      temperature2mC: number(row.temperature2m_c),
      surfacePressureHpa: number(row.surface_pressure_hpa),
      relativeHumidity2mPct: number(row.relative_humidity2m_pct),
      precipitationMm: number(row.precipitation_mm),
      shortwaveRadiationWm2: number(row.shortwave_radiation_wm2),
      directNormalIrradianceWm2: number(row.direct_normal_irradiance_wm2),
      diffuseRadiationWm2: number(row.diffuse_radiation_wm2),
      cloudCoverPct: number(row.cloud_cover_pct),
    })),
    vintageFidelity:
      goLiveAt && query.from >= goLiveAt ? "point_in_time" : "revision_optimistic",
    goLiveAt,
  };
}

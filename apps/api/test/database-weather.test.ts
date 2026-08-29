import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import {
  createWeatherIngestor,
  locationsOf,
  type ModelRunResponse,
  parseModelRun,
  readWeatherForecastAsOf,
  recordWeatherRunRequest,
  resolveCentroids,
  UndefinedWeatherVariableError,
  type WeatherForecastHour,
  writeWeatherForecast,
} from "../src/ingest/index.js";

// Seam 2 for weather, gated exactly like `database-load.test.ts` — the
// `test:db` script supplies the URL, and the default `bun test` skips this file
// entirely.
//
// What only a real Postgres can prove here is the ticket's central claim: that
// **the D−1 12Z run superseding the D−1 00Z run needs no special case**. It is
// a property of a DISTINCT ON over (centroid_id, valid_time) plus a
// `published_at` that *is* the run initialisation — and there is no code in the
// repository that mentions supersession at all, so a mock would only be
// re-asserting the absence.
//
// Spin one up:
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:17-alpine
// Not named `URL`: the ingest job builds `new URL(...)` from the stubbed fetch
// input, and a module-level shadow of the global turns that into a bewildering
// "is not a constructor".
const TEST_DATABASE_URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURES = join(import.meta.dir, "fixtures", "weather");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const RUN_12Z = read("single-runs-ecmwf-2024-04-09T12Z.json");
const RUN_00Z = read("single-runs-ecmwf-2024-04-09T00Z.json");
const UNAVAILABLE = read("single-runs-unavailable.json");
const UNDEFINED_VARIABLE = read("single-runs-undefined-variable.json");

const CENTROIDS = resolveCentroids(["W1", "W7", "S5"]);
const INIT_12Z = new Date("2024-04-09T12:00:00.000Z");
const INIT_00Z = new Date("2024-04-09T00:00:00.000Z");
/** An hour both runs cover, well inside the target day. */
const TARGET_HOUR = new Date("2024-04-10T18:00:00.000Z");

const responseOf = (body: string): ModelRunResponse => ({
  locations: locationsOf(JSON.parse(body)),
  url: "https://single-runs-api.open-meteo.com/v1/forecast?models=ecmwf_ifs",
  fetchedAt: new Date("2026-08-28T00:00:00.000Z"),
  body,
  httpStatus: 200,
  rateLimitRetries: 0,
});

suite("weather · bitemporal store (real Postgres)", () => {
  const handle = createDatabase(TEST_DATABASE_URL as string, 5);
  const { db } = handle;

  const truncate = async () => {
    await db.execute(sql`truncate table weather_forecast_hour`);
    await db.execute(sql`truncate table weather_run_request cascade`);
  };

  const ingest = async (body: string, runInit: Date, ingestedAt: Date) => {
    const response = responseOf(body);
    const parsed = parseModelRun(response, { centroids: CENTROIDS, runInit });
    const sourceVersionId = await recordWeatherRunRequest(db, {
      runInit,
      centroidCount: CENTROIDS.length,
      forecastDays: 3,
      rowCount: parsed.rows.length,
      response,
    });
    return {
      parsed,
      sourceVersionId,
      written: await writeWeatherForecast(db, {
        rows: parsed.rows,
        sourceVersionId,
        ingestedAt,
      }),
    };
  };

  beforeAll(truncate);
  afterAll(() => handle.close());

  /**
   * Assert a statement was refused by a named CHECK.
   *
   * Drizzle wraps the driver error in a "Failed query" message, so the
   * constraint name lives on the cause — and the name is the whole point: a
   * test that merely asserted "it threw" would pass on a typo in the SQL.
   */
  const rejectedBy = async (attempt: Promise<unknown>, constraint: string) => {
    const error = await attempt.then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).not.toBeNull();
    const cause = (error as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe(constraint);
  };

  describe("the run initialisation is the publication time", () => {
    let requestId = "";

    beforeAll(async () => {
      await truncate();
      const { sourceVersionId } = await ingest(
        RUN_12Z,
        INIT_12Z,
        new Date("2026-08-28T01:00:00.000Z"),
      );
      requestId = sourceVersionId;
    });

    it("stores the run's own instant, at file precision", async () => {
      const [row] = await db.execute<{
        published_at: string;
        published_at_precision: string;
        run_cycle: string;
      }>(sql`
        select published_at, published_at_precision, run_cycle
        from weather_forecast_hour
        where centroid_id = 'W1' and valid_time = ${TARGET_HOUR.toISOString()}::timestamptz
      `);
      expect(new Date(row?.published_at as string).toISOString()).toBe(
        INIT_12Z.toISOString(),
      );
      // Run-grained, exactly as a bulk file's `Last-Modified` is file-grained.
      expect(row?.published_at_precision).toBe("file");
      expect(row?.run_cycle).toBe("12Z");
    });

    it("refuses a published_at that is not a run initialisation", async () => {
      // The identity is what the whole supersession argument rests on, so it is
      // a CHECK rather than a convention: without it another writer could stamp
      // a fetch time here and nothing would notice.
      const attempt = (async () => {
        await db.execute(sql`
        insert into weather_forecast_hour
          (centroid_id, valid_time, grid_latitude, grid_longitude, grid_elevation_m,
           run_cycle, run_age_hours, data_version, published_at,
           published_at_precision, ingested_at, value_digest, source_request_id)
        select 'W1', ${TARGET_HOUR.toISOString()}::timestamptz, -11.2, -41.3, 741,
               '12Z', 0, 99, '2024-04-09T13:37:00Z'::timestamptz,
               'file', now(), 'forged', ${requestId}::uuid
        `);
      })();
      await rejectedBy(attempt, "weather_forecast_published_at_is_run_init");
    });

    it("refuses a run_cycle that disagrees with its own publication hour", async () => {
      const attempt = (async () => {
        await db.execute(sql`
        insert into weather_forecast_hour
          (centroid_id, valid_time, grid_latitude, grid_longitude, grid_elevation_m,
           run_cycle, run_age_hours, data_version, published_at,
           published_at_precision, ingested_at, value_digest, source_request_id)
        select 'W1', ${TARGET_HOUR.toISOString()}::timestamptz, -11.2, -41.3, 741,
               '00Z', 0, 98, ${INIT_12Z.toISOString()}::timestamptz,
               'file', now(), 'forged', ${requestId}::uuid
        `);
      })();
      await rejectedBy(attempt, "weather_forecast_published_at_is_run_init");
    });
  });

  describe("12Z supersedes 00Z with no special case", () => {
    beforeAll(async () => {
      await truncate();
      await ingest(RUN_00Z, INIT_00Z, new Date("2024-04-09T06:00:00.000Z"));
      await ingest(RUN_12Z, INIT_12Z, new Date("2024-04-09T18:00:00.000Z"));
    });

    it("returns the later run as the current vintage", async () => {
      const result = await readWeatherForecastAsOf(db, {
        asOf: new Date("2026-08-28T00:00:00.000Z"),
        from: TARGET_HOUR,
        to: new Date(TARGET_HOUR.getTime() + 3_600_000),
      });
      // Exactly one row per (centroid, valid_time) — three centroids, one hour.
      expect(result.rows).toHaveLength(3);
      expect(result.rows.every((row) => row.runCycle === "12Z")).toBe(true);
      expect(result.rows.every((row) => row.dataVersion === 2)).toBe(true);
    });

    it("still answers what the earlier run said, at the earlier as-of", async () => {
      const result = await readWeatherForecastAsOf(db, {
        asOf: new Date("2024-04-09T12:00:00.000Z"),
        from: TARGET_HOUR,
        to: new Date(TARGET_HOUR.getTime() + 3_600_000),
      });
      expect(result.rows).toHaveLength(3);
      expect(result.rows.every((row) => row.runCycle === "00Z")).toBe(true);
      expect(result.rows.every((row) => row.dataVersion === 1)).toBe(true);
    });

    it("keeps both cycles distinguishable and comparable", async () => {
      const cycle = async (runCycle: "00Z" | "12Z") =>
        (
          await readWeatherForecastAsOf(db, {
            asOf: new Date("2026-08-28T00:00:00.000Z"),
            from: TARGET_HOUR,
            to: new Date(TARGET_HOUR.getTime() + 3_600_000),
            centroidIds: ["W7"],
            runCycle,
          })
        ).rows[0];
      const early = await cycle("00Z");
      const late = await cycle("12Z");
      expect(early?.runInitTime.toISOString()).toBe(INIT_00Z.toISOString());
      expect(late?.runInitTime.toISOString()).toBe(INIT_12Z.toISOString());
      // The early view and the better view both exist, on the same hour — which
      // is what makes the measured 4.76-vs-4.38 km/h comparison a standing
      // metric rather than a one-off study.
      expect(early?.windSpeed120mKmh).not.toBe(late?.windSpeed120mKmh as number);
    });

    it("writes nothing at all when the same run is ingested twice", async () => {
      const { written } = await ingest(
        RUN_12Z,
        INIT_12Z,
        new Date("2024-04-10T00:00:00.000Z"),
      );
      expect(written.inserted).toBe(0);
      expect(written.revised).toBe(0);
      expect(written.unchanged).toBe(CENTROIDS.length * 71);
    });
  });

  describe("the ingest job", () => {
    beforeEach(truncate);

    /** The handler is a plain `Execute`; the job runner around it is not under test. */
    const run = (
      ingestor: ReturnType<typeof createWeatherIngestor>,
      payload: Parameters<ReturnType<typeof createWeatherIngestor>>[0],
    ) => ingestor(payload, () => {});

    /** A fetch that answers by `run=`, and 400s for anything it has no run for. */
    const archive = (runs: Record<string, string>, seen?: string[]): typeof fetch =>
      (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const run = url.searchParams.get("run") ?? "";
        seen?.push(url.toString());
        const body = runs[run];
        return body
          ? new Response(body, { status: 200 })
          : new Response(UNAVAILABLE, { status: 400 });
      }) as typeof fetch;

    it("ingests both cycles for a target day in two requests", async () => {
      const seen: string[] = [];
      const ingestor = createWeatherIngestor({
        db,
        fetch: archive(
          { "2024-04-09T00:00": RUN_00Z, "2024-04-09T12:00": RUN_12Z },
          seen,
        ),
      });
      const result = await run(ingestor, {
        from: "2024-04-10",
        to: "2024-04-10",
        centroidIds: ["W1", "W7", "S5"],
      });

      expect(result.runsScheduled).toBe(2);
      expect(result.runsIngested).toBe(2);
      expect(result.requests).toBe(2);
      expect(result.runsFallenBack).toBe(0);
      expect(result.hourZeroRowsExcluded).toBe(6);
      // Every request pinned the model and named a run. This is the only
      // evidence that exists — the response never says which model produced it.
      expect(seen).toHaveLength(2);
      expect(seen.every((url) => url.includes("models=ecmwf_ifs"))).toBe(true);
      expect(seen.every((url) => url.includes("run=2024-04-09"))).toBe(true);

      const stored = await db.execute<{ n: string }>(
        sql`select count(*) as n from weather_run_request`,
      );
      expect(Number(stored[0]?.n)).toBe(2);
    });

    it("falls back to an older cycle when the archive is missing a run", async () => {
      // Measured: 5 of 112 sampled run slots were missing, all clustered in one
      // 2025-08 week. A hole in the series is not an acceptable answer.
      const ingestor = createWeatherIngestor({
        db,
        fetch: archive({ "2024-04-09T00:00": RUN_00Z }),
      });
      const result = await run(ingestor, {
        from: "2024-04-10",
        to: "2024-04-10",
        runCycles: ["12Z"],
        centroidIds: ["W1", "W7", "S5"],
      });

      expect(result.runsIngested).toBe(1);
      expect(result.runsFallenBack).toBe(1);
      // Two calls: the missing 12Z, then the 00Z twelve hours before it.
      expect(result.requests).toBe(2);
      expect(result.runs[0]?.runAgeHours).toBe(12);
      expect(result.runs[0]?.runInit).toBe(INIT_00Z.toISOString());

      const [row] = await db.execute<{ run_age_hours: number; run_cycle: string }>(sql`
        select run_age_hours, run_cycle from weather_forecast_hour
        where centroid_id = 'W1' and valid_time = ${TARGET_HOUR.toISOString()}::timestamptz
      `);
      // The row says it is older than the schedule wanted, rather than the
      // pipeline failing open and saying nothing.
      expect(Number(row?.run_age_hours)).toBe(12);
      expect(row?.run_cycle).toBe("00Z");

      const [request] = await db.execute<{
        run_init: string;
        scheduled_run_init: string;
      }>(sql`select run_init, scheduled_run_init from weather_run_request`);
      expect(new Date(request?.run_init as string).toISOString()).toBe(
        INIT_00Z.toISOString(),
      );
      expect(new Date(request?.scheduled_run_init as string).toISOString()).toBe(
        INIT_12Z.toISOString(),
      );
    });

    it("reports a run slot with nothing in the fallback window as missing", async () => {
      const ingestor = createWeatherIngestor({ db, fetch: archive({}) });
      const result = await run(ingestor, {
        from: "2024-04-10",
        to: "2024-04-10",
        runCycles: ["12Z"],
        centroidIds: ["W1"],
      });
      expect(result.runsMissing).toBe(1);
      expect(result.runsIngested).toBe(0);
      expect(result.runs[0]?.missing).toBe(true);
    });

    it("aborts before recording provenance when a variable comes back all-null", async () => {
      const ingestor = createWeatherIngestor({
        db,
        fetch: archive({ "2024-04-09T12:00": UNDEFINED_VARIABLE }),
      });
      // The response is for one point; asking for three is the count mismatch
      // that would otherwise pair centroids to the wrong cells, and it fails
      // for that reason first. Ask for one, and the all-null check is what
      // fires — on an HTTP 200 carrying plausible-looking JSON.
      await expect(
        run(ingestor, {
          from: "2024-04-10",
          to: "2024-04-10",
          runCycles: ["12Z"],
          centroidIds: ["W1"],
        }),
      ).rejects.toThrow(UndefinedWeatherVariableError);

      const stored = await db.execute<{ n: string }>(
        sql`select count(*) as n from weather_run_request`,
      );
      // No provenance row claiming a run was successfully taken in.
      expect(Number(stored[0]?.n)).toBe(0);
    });

    it("is idempotent across a re-run of the same window", async () => {
      const ingestor = createWeatherIngestor({
        db,
        fetch: archive({ "2024-04-09T00:00": RUN_00Z, "2024-04-09T12:00": RUN_12Z }),
      });
      const payload = {
        from: "2024-04-10",
        to: "2024-04-10",
        centroidIds: ["W1", "W7", "S5"],
      };
      const first = await run(ingestor, payload);
      const second = await run(ingestor, payload);
      expect(first.inserted + first.revised).toBeGreaterThan(0);
      expect(second.inserted).toBe(0);
      expect(second.revised).toBe(0);
      // The second pass re-fetches the 00Z run after the 12Z run is already
      // stored. Those hours are dropped rather than appended — publication time
      // never goes backwards for a key — and the 12Z hours match their digests.
      expect(second.supersededByNewerRun).toBeGreaterThan(0);
      expect(second.unchanged + second.supersededByNewerRun).toBe(
        first.inserted + first.revised + first.unchanged + first.supersededByNewerRun,
      );
    });
  });

  describe("the wide row survives the round trip", () => {
    beforeAll(async () => {
      await truncate();
      await ingest(RUN_12Z, INIT_12Z, new Date("2026-08-28T02:00:00.000Z"));
    });

    it("returns all twelve variables with the values ECMWF produced", async () => {
      const result = await readWeatherForecastAsOf(db, {
        asOf: new Date("2026-08-28T03:00:00.000Z"),
        from: TARGET_HOUR,
        to: new Date(TARGET_HOUR.getTime() + 3_600_000),
        centroidIds: ["S5"],
      });
      const stored = result.rows[0] as WeatherForecastHour;
      const parsed = parseModelRun(responseOf(RUN_12Z), {
        centroids: CENTROIDS,
        runInit: INIT_12Z,
      }).rows.find(
        (row) =>
          row.centroidId === "S5" && row.validTime.getTime() === TARGET_HOUR.getTime(),
      ) as WeatherForecastHour;

      for (const field of [
        "windSpeed100mKmh",
        "windSpeed120mKmh",
        "windDirection120mDeg",
        "windGusts10mKmh",
        "temperature2mC",
        "surfacePressureHpa",
        "relativeHumidity2mPct",
        "precipitationMm",
        "shortwaveRadiationWm2",
        "directNormalIrradianceWm2",
        "diffuseRadiationWm2",
        "cloudCoverPct",
      ] as const) {
        expect(stored[field]).toBe(parsed[field] as number);
      }
      expect(stored.gridLatitude).toBeCloseTo(parsed.gridLatitude, 6);
    });
  });
});

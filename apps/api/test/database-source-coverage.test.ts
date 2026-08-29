import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createIngestHealthRoute } from "../src/api/ingest-health.js";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion, payloadCustody } from "../src/database/schema.js";
import {
  createDirectoryArchive,
  locationsOf,
  type ModelRunResponse,
  type PayloadArchive,
  parseModelRun,
  type RegistryPlant,
  type ResolvedPlantLocation,
  recordWeatherRunRequest,
  resolveCentroids,
  upsertPlants,
  writePlantLocations,
  writeWeatherForecast,
} from "../src/ingest/index.js";

// Seam — the two sources that landed after the observability work, watched by
// the same endpoint as the other nine. Gated on a test database like every
// other suite here; spin one up with
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:17-alpine
//
// The property under test is the one the ticket exists for and the one a mock
// cannot show: **silence turns the endpoint red**. `GET /ingest/health` reads
// the fact tables, not the run log, so it can only be proved against tables
// that really hold — and really stop holding — rows.
//
// Not named `URL`: a module-level shadow of the global breaks `new URL(...)`.
const TEST_DATABASE_URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const WEATHER_FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "weather",
  "single-runs-ecmwf-2024-04-09T12Z.json",
);
const RUN_INIT = new Date("2024-04-09T12:00:00.000Z");
const CENTROIDS = resolveCentroids(["W1", "W7", "S5"]);
const PLANT = "EOL.CV.RN.028443-2";

const registryPlant = (cegCore: string): RegistryPlant => ({
  cegCore,
  cegRaw: `${cegCore}.01`,
  onsPlantCode: null,
  name: `PLANT ${cegCore}`,
  subsystem: "NE",
  stateCode: "RN",
  technology: "WIND",
  operationModality: "TIPO_II_C",
  ownerName: "AGENTE",
  operatorName: "AGENTE",
});

const sigaLocation = (cegCore: string): ResolvedPlantLocation => ({
  cegCore,
  cegRaw: `${cegCore}.1`,
  sigaName: "Alegria II",
  coordinate: { latitude: -5.124_305_56, longitude: -36.383_305_56 },
  locationSource: "siga_coordinate",
  coordinateRejection: null,
  municipality: { name: "Guamaré", uf: "RN" },
  municipalitiesRaw: "Guamaré - RN",
  ownership: "100% para NEW ENERGY OPTIONS - 04.245.220/0001-36 (PIE)",
  withdrawnOn: null,
});

suite("source coverage · SIGA and weather are watched (real Postgres)", () => {
  const handle = createDatabase(TEST_DATABASE_URL as string, 5);
  const { db } = handle;
  const route = createIngestHealthRoute({ db });
  let sourceVersionId = "";

  /** The endpoint, called for real: status and the `stale` list it returns. */
  const health = async (): Promise<{ status: number; stale: string[] }> => {
    const response = await route.handle(new Request("http://localhost/ingest/health"));
    const body = (await response.json()) as { stale?: string[] };
    return { status: response.status, stale: body.stale ?? [] };
  };

  const clearWeather = async () => {
    await db.execute(sql`truncate table weather_forecast_hour`);
    await db.execute(sql`truncate table weather_run_request cascade`);
  };
  const clearSiga = async () => {
    await db.execute(sql`truncate table plant_geo cascade`);
  };

  const ingestWeather = async (ingestedAt: Date, archive?: PayloadArchive) => {
    const body = readFileSync(WEATHER_FIXTURE, "utf8");
    const response: ModelRunResponse = {
      locations: locationsOf(JSON.parse(body)),
      url: "https://single-runs-api.open-meteo.com/v1/forecast?models=ecmwf_ifs",
      fetchedAt: ingestedAt,
      body,
      httpStatus: 200,
      rateLimitRetries: 0,
    };
    const parsed = parseModelRun(response, { centroids: CENTROIDS, runInit: RUN_INIT });
    const sourceRequestId = await recordWeatherRunRequest(
      db,
      {
        runInit: RUN_INIT,
        centroidCount: CENTROIDS.length,
        forecastDays: 3,
        rowCount: parsed.rows.length,
        response,
      },
      archive,
    );
    await writeWeatherForecast(db, {
      rows: parsed.rows,
      sourceVersionId: sourceRequestId,
      ingestedAt,
    });
  };

  const ingestSiga = async (ingestedAt: Date) =>
    writePlantLocations(db, {
      locations: [sigaLocation(PLANT)],
      observedOn: new Date("2026-08-28T00:00:00.000Z"),
      publishedAt: ingestedAt,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt,
    });

  beforeAll(async () => {
    await clearSiga();
    await db.execute(sql`truncate table siga_snapshot cascade`);
    await db.execute(sql`truncate table plant cascade`);
    await clearWeather();
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "siga-sistema-de-informacoes-de-geracao-da-aneel",
        resourceName: "siga-empreendimentos-geracao-diario.csv",
        resourceUrl: "https://example.invalid/siga-empreendimentos-geracao-diario.csv",
        format: "CSV",
        changeKey: `siga-coverage|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";
    await upsertPlants(db, [registryPlant(PLANT)]);
  });

  afterAll(() => handle.close());

  it("reports both sources at all, which is the gap this closes", async () => {
    const response = await route.handle(new Request("http://localhost/ingest/health"));
    const body = (await response.json()) as { sources: { source: string }[] };
    const named = body.sources.map((source) => source.source);
    expect(named).toContain("siga");
    expect(named).toContain("weather");
  });

  it("goes 503 while neither source has ever produced a fact", async () => {
    // Never ingested is stale, not unknown — a source that has produced nothing
    // is exactly as useless as one that stopped.
    const { status, stale } = await health();
    expect(status).toBe(503);
    expect(stale).toContain("siga");
    expect(stale).toContain("weather");
  });

  it("clears both once a snapshot and a run have landed", async () => {
    const now = new Date();
    await ingestWeather(now);
    await ingestSiga(now);

    const { stale } = await health();
    // Only these two are asserted: the other sources' emptiness depends on what
    // else has run against this database, so the endpoint stays 503 overall.
    expect(stale).not.toContain("siga");
    expect(stale).not.toContain("weather");
  });

  it("turns red again when the weather runs stop arriving", async () => {
    // The failure this endpoint exists for: nothing throws when Open-Meteo goes
    // quiet. The sweep still runs, every run is logged `ok`, and the forecast
    // silently ages out from under the product.
    await clearWeather();
    const { status, stale } = await health();
    expect(status).toBe(503);
    expect(stale).toContain("weather");
    expect(stale).not.toContain("siga");
  });

  it("turns red again when the SIGA snapshot stops arriving", async () => {
    await ingestWeather(new Date());
    await clearSiga();
    const { status, stale } = await health();
    expect(status).toBe(503);
    expect(stale).toContain("siga");
    expect(stale).not.toContain("weather");
  });

  it("keeps the weather transport's payloads, as it keeps the carga API's", async () => {
    // A model run is never republished and Open-Meteo archives no responses of
    // its own, so the JSON body WattSteer holds is the only copy there will
    // ever be of what ECMWF said for this run.
    const root = await mkdtemp(join(tmpdir(), "wattsteer-weather-custody-"));
    try {
      await db.execute(sql`truncate table payload_custody`);
      await clearWeather();
      const archive = createDirectoryArchive(root);
      await ingestWeather(new Date(), archive);

      const [custody] = await db.select().from(payloadCustody);
      expect(custody?.provenance).toBe("weather_run_request");
      // Its own archive family, so a transport that acquires bytes a different
      // way is not filed under `bulk/`.
      expect(custody?.archiveUri.startsWith("weather/ecmwf_ifs/")).toBe(true);

      const held = await archive.get(custody?.archiveUri as string);
      expect(new TextDecoder().decode(held as Uint8Array)).toBe(
        readFileSync(WEATHER_FIXTURE, "utf8"),
      );

      // The provenance row carries the locator too, so provenance alone answers
      // "where are the bytes?".
      const [request] = await db.execute<{ archive_uri: string | null }>(
        sql`select archive_uri from weather_run_request limit 1`,
      );
      expect(request?.archive_uri).toBe(custody?.archiveUri as string);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

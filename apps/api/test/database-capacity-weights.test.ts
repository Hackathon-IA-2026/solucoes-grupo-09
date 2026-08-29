import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  computeCapacityWeights,
  readCapacityWeightsAsOf,
  readSubsystemWeatherAsOf,
  type WeightablePlant,
  weightMisallocation,
} from "../src/features/index.js";
import {
  type ModelRunResponse,
  type RegistryGeneratingUnit,
  type RegistryPlant,
  type ResolvedPlantLocation,
  recordWeatherRunRequest,
  upsertPlants,
  type WeatherForecastHour,
  writeGeneratingUnits,
  writePlantLocations,
  writeWeatherForecast,
} from "../src/ingest/index.js";

// Ticket 10's central claim is a claim about SQL: that a weight vector computed
// **as of a fleet date** differs materially from one computed from today's
// fleet, because `InstalledCapacityAsOf` reconstructs the units live on that
// date from per-unit commissioning dates. A mock of the registry read would only
// re-assert the arithmetic `capacity-weights.test.ts` already covers; the thing
// worth proving is that the reconstruction happens in the database and that the
// weights follow it.
//
// Gated exactly like the other Postgres suites. Spin one up:
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:17-alpine
const TEST_DATABASE_URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Vintage: one ingest, so every read below is point-in-time against it. */
const INGESTED_AT = new Date("2026-08-28T09:00:00.000Z");
/** Window start and window end — the two dates the research contrasts. */
const WINDOW_START = new Date("2024-04-01T00:00:00.000Z");
const TODAY = new Date("2026-08-28T00:00:00.000Z");

/**
 * A miniature SE-solar fleet with the shape the research measured.
 *
 * Two clusters in northern Minas Gerais: Pirapora (S7) was already operating at
 * window start, and the Paracatu/Arinos build-out (S6) — 200 km north-west —
 * arrived after it. That is the 50.4% weight-mass misallocation and the 94 km
 * centroid move in miniature, and it is what makes the difference between
 * static and as-of weights a fact of the fleet rather than of the test.
 */
const SE_SOLAR = [
  { ceg: "UFV.RS.MG.000001", lat: -17.47, lon: -44.84, mw: 100, from: "2023-06-01" },
  { ceg: "UFV.RS.MG.000002", lat: -17.4, lon: -44.9, mw: 50, from: "2023-09-01" },
  { ceg: "UFV.RS.MG.000003", lat: -16.48, lon: -46.41, mw: 300, from: "2025-02-01" },
  { ceg: "UFV.RS.MG.000004", lat: -16.4, lon: -46.3, mw: 150, from: "2025-11-01" },
];

/** One NE wind plant whose SIGA coordinate was refused — the fallback case. */
const NE_WIND_UNLOCATED = "EOL.CV.RN.000005";
/** One NE wind plant with a real point, so the scope has located mass. */
const NE_WIND_LOCATED = "EOL.CV.RN.000006";

const registryPlant = (
  cegCore: string,
  overrides: Partial<RegistryPlant> = {},
): RegistryPlant => ({
  cegCore,
  cegRaw: `${cegCore}.01`,
  onsPlantCode: null,
  name: `PLANT ${cegCore}`,
  subsystem: "SE",
  stateCode: "MG",
  technology: "SOLAR",
  operationModality: "TIPO_II_C",
  ownerName: "AGENTE",
  operatorName: "AGENTE",
  ...overrides,
});

const unit = (
  plantCegCore: string,
  ratedPowerMw: number,
  commissionedOn: string,
): RegistryGeneratingUnit => ({
  plantCegCore,
  equipmentCode: `${plantCegCore}-U1`,
  unitNumber: "1",
  name: `${plantCegCore} UG1`,
  ratedPowerMw,
  testEntryOn: null,
  commissionedOn: new Date(`${commissionedOn}T00:00:00.000Z`),
  decommissionedOn: null,
});

const location = (
  cegCore: string,
  coordinate: { latitude: number; longitude: number } | null,
  overrides: Partial<ResolvedPlantLocation> = {},
): ResolvedPlantLocation => ({
  cegCore,
  cegRaw: `${cegCore}.1`,
  sigaName: `SIGA ${cegCore}`,
  coordinate,
  locationSource: coordinate === null ? "unlocated" : "siga_coordinate",
  coordinateRejection: coordinate === null ? "null_island" : null,
  municipality: null,
  municipalitiesRaw: "Pirapora - MG",
  ownership: "100% para AGENTE (PIE)",
  withdrawnOn: null,
  ...overrides,
});

/** Frozen points these tests weight onto — a slice of `centroid_set_v1`. */
const S6 = { id: "S6", latitude: -16.48, longitude: -46.41 };
const S7 = { id: "S7", latitude: -17.47, longitude: -44.84 };
const W7 = { id: "W7", latitude: -5.4, longitude: -36.05 };

const weatherRow = (
  centroidId: string,
  validTime: Date,
  grid: { latitude: number; longitude: number },
  values: Partial<WeatherForecastHour> = {},
): WeatherForecastHour => ({
  centroidId,
  validTime,
  gridLatitude: grid.latitude,
  gridLongitude: grid.longitude,
  gridElevationM: 500,
  runInitTime: new Date("2026-08-27T12:00:00.000Z"),
  runCycle: "12Z",
  runAgeHours: 0,
  windSpeed100mKmh: 18,
  windSpeed120mKmh: 20,
  windDirection120mDeg: 90,
  windGusts10mKmh: 30,
  temperature2mC: 25,
  surfacePressureHpa: 1010,
  relativeHumidity2mPct: 60,
  precipitationMm: 0,
  shortwaveRadiationWm2: 800,
  directNormalIrradianceWm2: 700,
  diffuseRadiationWm2: 100,
  cloudCoverPct: 10,
  ...values,
});

const runResponse = (): ModelRunResponse => ({
  locations: [],
  url: "https://single-runs-api.open-meteo.com/v1/forecast?models=ecmwf_ifs",
  fetchedAt: INGESTED_AT,
  body: "{}",
  httpStatus: 200,
  rateLimitRetries: 0,
});

suite("capacity weights · as-of fleet (real Postgres)", () => {
  const handle = createDatabase(TEST_DATABASE_URL as string, 5);
  const { db } = handle;
  const seSolar = (set: Awaited<ReturnType<typeof readCapacityWeightsAsOf>>) => {
    const vector = set.vectors.find(
      (candidate) => candidate.subsystem === "SE" && candidate.technology === "SOLAR",
    );
    if (!vector) {
      throw new Error("no SE/SOLAR vector");
    }
    return vector;
  };

  beforeAll(async () => {
    await db.execute(sql`truncate table weather_forecast_hour`);
    await db.execute(sql`truncate table weather_run_request cascade`);
    await db.execute(sql`truncate table plant_geo cascade`);
    await db.execute(sql`truncate table generating_unit cascade`);
    await db.execute(sql`truncate table plant cascade`);

    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "capacidade-geracao",
        resourceName: "capacidade-geracao.csv",
        resourceUrl: "https://example.invalid/capacidade-geracao.csv",
        format: "CSV",
        changeKey: `weights-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    const sourceVersionId = version?.id ?? "";

    await upsertPlants(db, [
      ...SE_SOLAR.map((row) => registryPlant(row.ceg)),
      registryPlant(NE_WIND_LOCATED, {
        subsystem: "NE",
        stateCode: "RN",
        technology: "WIND",
      }),
      registryPlant(NE_WIND_UNLOCATED, {
        subsystem: "NE",
        stateCode: "RN",
        technology: "WIND",
      }),
    ]);

    await writeGeneratingUnits(db, {
      units: [
        ...SE_SOLAR.map((row) => unit(row.ceg, row.mw, row.from)),
        unit(NE_WIND_LOCATED, 400, "2023-01-01"),
        unit(NE_WIND_UNLOCATED, 100, "2023-01-01"),
      ],
      publishedAt: INGESTED_AT,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: INGESTED_AT,
    });

    await writePlantLocations(db, {
      locations: [
        ...SE_SOLAR.map((row) =>
          location(row.ceg, { latitude: row.lat, longitude: row.lon }),
        ),
        location(NE_WIND_LOCATED, { latitude: -5.53, longitude: -35.82 }),
        // SIGA wrote (0,0) and there is no municipality to fall back to, so
        // this plant keeps its 100 MW and loses only its weather sample.
        location(NE_WIND_UNLOCATED, null),
      ],
      observedOn: TODAY,
      publishedAt: INGESTED_AT,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: INGESTED_AT,
    });
  });

  afterAll(() => handle.close());

  it("reconstructs the fleet that existed at the fleet date", async () => {
    const atStart = await readCapacityWeightsAsOf(db, {
      asOf: INGESTED_AT,
      on: WINDOW_START,
    });
    const now = await readCapacityWeightsAsOf(db, { asOf: INGESTED_AT, on: TODAY });

    // 150 MW of SE solar existed at window start; 600 MW exists today. This is
    // `InstalledCapacityAsOf`, and it is why the weights cannot be static.
    expect(seSolar(atStart).capacityMw).toBe(150);
    expect(seSolar(now).capacityMw).toBe(600);
    expect(atStart.vintageFidelity).toBe("revision_optimistic");
  });

  it("shows static and as-of weights differing materially at window start", async () => {
    const atStart = seSolar(
      await readCapacityWeightsAsOf(db, { asOf: INGESTED_AT, on: WINDOW_START }),
    );
    const now = seSolar(
      await readCapacityWeightsAsOf(db, { asOf: INGESTED_AT, on: TODAY }),
    );

    // At window start the whole SE solar fleet is Pirapora; today three
    // quarters of it is the Paracatu/Arinos build-out 200 km away.
    expect(atStart.cells.map((cell) => cell.centroidId)).toEqual([S7.id]);
    expect(now.cells.find((cell) => cell.centroidId === S6.id)?.weight).toBeCloseTo(
      0.75,
      12,
    );

    // The research's own measure: ½·L1 between the two vectors, reported as
    // 0.504 for SE solar at 2024-04. Anything of that order is "material"; a
    // static vector would put three quarters of the weight in the wrong place.
    const misallocated = weightMisallocation(now.cells, atStart.cells);
    expect(misallocated).toBeCloseTo(0.75, 12);
    expect(misallocated).toBeGreaterThan(0.5);

    // And as centroid displacement — the 94 km the research measured, here 200.
    const displacement = Math.hypot(
      (now.capacityCentroid?.latitude ?? 0) - (atStart.capacityCentroid?.latitude ?? 0),
      (now.capacityCentroid?.longitude ?? 0) - (atStart.capacityCentroid?.longitude ?? 0),
    );
    // More than one degree — an order of magnitude past Open-Meteo's 9–13 km cell.
    expect(displacement).toBeGreaterThan(1);
  });

  it("keeps an unlocated plant's capacity in the scope and out of the geometry", async () => {
    const set = await readCapacityWeightsAsOf(db, { asOf: INGESTED_AT, on: TODAY });
    const wind = set.vectors.find(
      (vector) => vector.subsystem === "NE" && vector.technology === "WIND",
    );
    expect(wind?.capacityMw).toBe(500);
    expect(wind?.attribution.proRataMw).toBe(100);
    expect(wind?.attribution.unattributedMw).toBe(0);
    expect(wind?.attribution.unlocatedPlants).toBe(1);
    // All 500 MW is behind the weights, which still sum to one.
    expect(wind?.cells.reduce((sum, cell) => sum + cell.capacityMw, 0)).toBeCloseTo(
      500,
      9,
    );
    expect(wind?.cells.reduce((sum, cell) => sum + cell.weight, 0)).toBeCloseTo(1, 12);
  });

  it("dedupes two centroids that Open-Meteo snapped to one grid cell", async () => {
    const sourceVersionId = await recordWeatherRunRequest(db, {
      runInit: new Date("2026-08-27T12:00:00.000Z"),
      centroidCount: 2,
      forecastDays: 2,
      rowCount: 2,
      response: runResponse(),
    });
    const hour = new Date("2026-08-28T15:00:00.000Z");
    // A collision, echoed by the API: both frozen points came back on the same
    // cell centre. Nothing but the echoed coordinates can reveal this.
    const cell = { latitude: -17.0, longitude: -45.5 };
    await writeWeatherForecast(db, {
      rows: [
        weatherRow(S6.id, hour, cell, { shortwaveRadiationWm2: 500 }),
        weatherRow(S7.id, hour, cell, { shortwaveRadiationWm2: 500 }),
      ],
      sourceVersionId,
      ingestedAt: INGESTED_AT,
    });

    const result = await readSubsystemWeatherAsOf(db, {
      asOf: INGESTED_AT,
      from: hour,
      to: new Date(hour.getTime() + 3_600_000),
      subsystem: "SE",
    });
    const weights = result.weights[0];
    const solar = weights?.vectors.find(
      (vector) => vector.subsystem === "SE" && vector.technology === "SOLAR",
    );
    // One weighting target, not two: S6 and S7 are folded together and their
    // weights summed, so the cell enters the mean once at full weight.
    expect(solar?.cells).toHaveLength(1);
    expect(solar?.cells[0]?.memberIds.sort()).toEqual([S6.id, S7.id]);
    expect(solar?.cells[0]?.weight).toBeCloseTo(1, 12);
    expect(solar?.cells[0]?.centroidId).toBe(S6.id);
  });

  it("produces one vector per subsystem per hour from the composed read", async () => {
    const sourceVersionId = await recordWeatherRunRequest(db, {
      runInit: new Date("2026-08-27T12:00:00.000Z"),
      centroidCount: 3,
      forecastDays: 2,
      rowCount: 6,
      response: runResponse(),
    });
    const hours = [
      new Date("2026-08-28T18:00:00.000Z"),
      new Date("2026-08-28T19:00:00.000Z"),
    ];
    await writeWeatherForecast(db, {
      rows: hours.flatMap((hour) => [
        weatherRow(S6.id, hour, S6, { shortwaveRadiationWm2: 900 }),
        weatherRow(S7.id, hour, S7, { shortwaveRadiationWm2: 100 }),
        weatherRow(W7.id, hour, W7, { windSpeed120mKmh: 44 }),
      ]),
      sourceVersionId,
      ingestedAt: INGESTED_AT,
    });

    const result = await readSubsystemWeatherAsOf(db, {
      asOf: INGESTED_AT,
      from: hours[0] as Date,
      to: new Date((hours[1] as Date).getTime() + 3_600_000),
    });

    // Two subsystems in the fleet × two hours.
    expect(result.hours).toHaveLength(4);
    const se = result.hours.filter((row) => row.subsystem === "SE");
    const ne = result.hours.filter((row) => row.subsystem === "NE");
    expect(se).toHaveLength(2);
    expect(ne).toHaveLength(2);

    // SE solar is 0.75 on S6 and 0.25 on S7 today.
    expect(se[0]?.shortwaveRadiationWm2).toBeCloseTo(0.75 * 900 + 0.25 * 100, 9);
    // NE wind sits entirely on W7 and is untouched by the SE points.
    expect(ne[0]?.windSpeed120mKmh).toBeCloseTo(44, 9);
    expect(ne[0]?.centroidCoverage).toBeCloseTo(1, 12);
    expect(se[0]?.weightsOn).toEqual(TODAY);
    // Weights are read once per UTC day, not once per hour.
    expect(result.weights).toHaveLength(1);
  });

  it("agrees with the pure computation given the same fleet", async () => {
    // The read is a composition, not a second implementation: this pins that.
    const set = await readCapacityWeightsAsOf(db, { asOf: INGESTED_AT, on: TODAY });
    const plants: WeightablePlant[] = SE_SOLAR.map((row) => ({
      cegCore: row.ceg,
      subsystem: "SE",
      technology: "SOLAR",
      capacityMw: row.mw,
      coordinate: { latitude: row.lat, longitude: row.lon },
      locationSource: "siga_coordinate",
    }));
    const direct = computeCapacityWeights({ plants });
    expect(seSolar(set).cells.map((cell) => [cell.centroidId, cell.weight])).toEqual(
      direct[0]?.cells.map((cell) => [cell.centroidId, cell.weight]) ?? [],
    );
  });
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  CentroidSetImmutableError,
  createCentroidDriftCheck,
  DRIFT_TRIGGER_RATIO,
  freezeCentroidSet,
  type GridProbe,
  listCentroidSetVersions,
  measureCentroidDistance,
  type RegistryGeneratingUnit,
  type RegistryPlant,
  type ResolvedPlantLocation,
  readCentroidSet,
  readGeneratorPlants,
  readLatestDriftCheck,
  regenerateCentroids,
  seedCentroidSetV1,
  upsertPlants,
  writeGeneratingUnits,
  writePlantLocations,
} from "../src/ingest/index.js";
import type { Coordinate } from "../src/ingest/types.js";
import { CENTROID_SET_VERSION, CENTROIDS } from "../src/ingest/weather/centroids.js";

// What is worth proving in Postgres, as opposed to in the pure generator suite,
// is the discipline: that a frozen set cannot be restated, that regenerating
// against the same registry vintage writes nothing the second time, and that the
// drift watch reads the fleet through the same as-of machinery the weights do.
//
// Gated exactly like the other Postgres suites. Spin one up:
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:17-alpine
const TEST_DATABASE_URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const INGESTED_AT = new Date("2026-08-28T09:00:00.000Z");
const WINDOW_START = new Date("2024-04-01T00:00:00.000Z");
const TODAY = new Date("2026-08-28T00:00:00.000Z");

/** S5 and W7 of `centroid_set_v1` — the two points this fleet sits near. */
const S5 = { latitude: -15.62, longitude: -43.6 };
const W7 = { latitude: -5.4, longitude: -36.05 };

/**
 * A fleet placed *off* the frozen points on purpose.
 *
 * The early plants sit ~0.2° from their centroid, so the freeze-time baseline is
 * a real distance rather than zero — a baseline of zero would make every ratio
 * undefined and the trigger untestable. The late plant sits in São Paulo state,
 * hundreds of km from every v1 solar point, which is the fleet growing away from
 * the geometry.
 */
const FLEET = [
  {
    ceg: "UFV.RS.MG.000001",
    lat: S5.latitude + 0.2,
    lon: S5.longitude,
    mw: 1000,
    from: "2023-06-01",
    technology: "SOLAR" as const,
    subsystem: "SE" as const,
    state: "MG",
    municipality: { name: "Janaúba", uf: "MG" },
  },
  {
    ceg: "EOL.CV.RN.000002",
    lat: W7.latitude + 0.2,
    lon: W7.longitude,
    mw: 1400,
    from: "2023-06-01",
    technology: "WIND" as const,
    subsystem: "NE" as const,
    state: "RN",
    municipality: { name: "João Câmara", uf: "RN" },
  },
  {
    ceg: "UFV.RS.SP.000003",
    lat: -20.5,
    lon: -47.0,
    mw: 1200,
    from: "2025-11-01",
    technology: "SOLAR" as const,
    subsystem: "SE" as const,
    state: "SP",
    municipality: { name: "Franca", uf: "SP" },
  },
];

const registryPlant = (row: (typeof FLEET)[number]): RegistryPlant => ({
  cegCore: row.ceg,
  cegRaw: `${row.ceg}.01`,
  onsPlantCode: null,
  name: `PLANT ${row.ceg}`,
  subsystem: row.subsystem,
  stateCode: row.state,
  technology: row.technology,
  operationModality: "TIPO_II_C",
  ownerName: "AGENTE",
  operatorName: "AGENTE",
});

const unit = (row: (typeof FLEET)[number]): RegistryGeneratingUnit => ({
  plantCegCore: row.ceg,
  equipmentCode: `${row.ceg}-U1`,
  unitNumber: "1",
  name: `${row.ceg} UG1`,
  ratedPowerMw: row.mw,
  testEntryOn: null,
  commissionedOn: new Date(`${row.from}T00:00:00.000Z`),
  decommissionedOn: null,
});

const location = (row: (typeof FLEET)[number]): ResolvedPlantLocation => ({
  cegCore: row.ceg,
  cegRaw: `${row.ceg}.1`,
  sigaName: `SIGA ${row.ceg}`,
  coordinate: { latitude: row.lat, longitude: row.lon },
  locationSource: "siga_coordinate",
  coordinateRejection: null,
  municipality: row.municipality,
  municipalitiesRaw: `${row.municipality.name} - ${row.municipality.uf}`,
  ownership: "100% para AGENTE (PIE)",
  withdrawnOn: null,
});

/**
 * A stand-in for Open-Meteo's echo: a 0.01° grid, far finer than ECMWF IFS's
 * 9–13 km, so that these clusters — hundreds of km apart — never collide. The
 * merge path is exercised in the pure suite, where the grid can be made coarse
 * on purpose.
 */
const probe: GridProbe = async (points: readonly Coordinate[]) =>
  points.map((point) => ({
    latitude: Math.round(point.latitude * 100) / 100,
    longitude: Math.round(point.longitude * 100) / 100,
  }));

suite("centroid sets · frozen geometry and the drift watch (real Postgres)", () => {
  const handle = createDatabase(TEST_DATABASE_URL as string, 5);
  const { db } = handle;

  beforeAll(async () => {
    await db.execute(sql`truncate table centroid_drift_check`);
    await db.execute(sql`truncate table centroid_point`);
    await db.execute(sql`truncate table centroid_set cascade`);
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
        changeKey: `centroid-set-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    const sourceVersionId = version?.id ?? "";

    await upsertPlants(db, FLEET.map(registryPlant));
    await writeGeneratingUnits(db, {
      units: FLEET.map(unit),
      publishedAt: INGESTED_AT,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: INGESTED_AT,
    });
    await writePlantLocations(db, {
      locations: FLEET.map(location),
      observedOn: TODAY,
      publishedAt: INGESTED_AT,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: INGESTED_AT,
    });
  });

  afterAll(() => handle.close());

  it("reconstructs the fleet the generator clusters, as of a fleet date", async () => {
    const atStart = await readGeneratorPlants(db, {
      asOf: INGESTED_AT,
      on: WINDOW_START,
    });
    // The São Paulo plant is commissioned in 2025 and did not exist yet: the
    // geometry a generator cuts is a function of the fleet date exactly as the
    // weights are.
    expect(atStart.map((plant) => plant.cegCore).sort()).toEqual([
      "EOL.CV.RN.000002",
      "UFV.RS.MG.000001",
    ]);
    expect(atStart[0]?.municipality).toEqual({ name: "João Câmara", uf: "RN" });

    const today = await readGeneratorPlants(db, { asOf: INGESTED_AT, on: TODAY });
    expect(today).toHaveLength(3);
  });

  it("freezes the hand-transcribed nineteen with a measured baseline", async () => {
    const plants = await readGeneratorPlants(db, {
      asOf: INGESTED_AT,
      on: WINDOW_START,
    });
    const distance = measureCentroidDistance(plants, CENTROIDS);
    const result = await seedCentroidSetV1(db, {
      distance,
      registryAsOf: INGESTED_AT,
      fleetOn: WINDOW_START,
    });
    expect(result.frozen).toBe(true);
    expect(result.centroidCount).toBe(19);

    const stored = await readCentroidSet(db, CENTROID_SET_VERSION);
    expect(stored?.source).toBe("hand_transcribed");
    expect(stored?.points).toHaveLength(19);
    expect(stored?.freezeMeanDistanceKm).toBeCloseTo(distance.meanDistanceKm ?? 0, 9);
    // W11 and W12 are recorded for what they are, rather than claiming a
    // derivation from SIGA municipality centroids that never happened.
    const transcribed = stored?.points.filter(
      (point) => point.origin === "hand_transcribed",
    );
    expect(transcribed?.map((point) => point.id).sort()).toEqual(["W11", "W12"]);
    // No generator parameters, because it was not generated.
    expect(stored?.clusterRadiusKm).toBeNull();
  });

  it("re-freezing the same geometry writes nothing", async () => {
    const plants = await readGeneratorPlants(db, { asOf: INGESTED_AT, on: TODAY });
    const again = await seedCentroidSetV1(db, {
      // A different baseline, deliberately: the geometry is what is frozen, and
      // a restatement of provenance is not a new version.
      distance: measureCentroidDistance(plants, CENTROIDS),
      registryAsOf: INGESTED_AT,
      fleetOn: TODAY,
    });
    expect(again.frozen).toBe(false);
    expect(again.centroidCount).toBe(19);
  });

  it("refuses to restate a frozen version with different geometry", async () => {
    const moved = CENTROIDS.map((centroid, index) => ({
      ...centroid,
      // One point nudged by a tenth of a degree — the silent covariate shift
      // this whole module exists to make impossible.
      latitude: index === 0 ? centroid.latitude + 0.1 : centroid.latitude,
      municipalities: [],
      plants: 0,
      mergedFrom: [],
      gridCell: null,
    }));
    await expect(
      freezeCentroidSet(db, {
        version: CENTROID_SET_VERSION,
        source: "hand_transcribed",
        points: moved,
        collisionCheck: "asserted",
        parameters: null,
        representedMw: 0,
        distance: { meanDistanceKm: 1, locatedMw: 1, plants: 1, unlocatedPlants: 0 },
        registryAsOf: INGESTED_AT,
        fleetOn: TODAY,
      }),
    ).rejects.toBeInstanceOf(CentroidSetImmutableError);
  });

  it("refuses to freeze a set whose cells were never checked", async () => {
    await expect(
      freezeCentroidSet(db, {
        version: "centroid_set_unchecked",
        source: "generated",
        points: [
          {
            ...(CENTROIDS[0] as (typeof CENTROIDS)[number]),
            municipalities: [],
            plants: 0,
            mergedFrom: [],
            gridCell: null,
          },
        ],
        collisionCheck: "unchecked",
        parameters: null,
        representedMw: 0,
        distance: { meanDistanceKm: 1, locatedMw: 1, plants: 1, unlocatedPlants: 0 },
        registryAsOf: INGESTED_AT,
        fleetOn: TODAY,
      }),
    ).rejects.toThrow(/never snapped/);
  });

  it("generates a set from the registry and freezes it as a new version", async () => {
    const result = await regenerateCentroids(db, {
      version: "centroid_set_v2",
      asOf: INGESTED_AT,
      on: TODAY,
      probe,
      options: { minClusterMw: 500 },
    });
    expect(result.frozen).toBe(true);
    expect(result.set.collisionCheck).toBe("asserted");
    // Three municipalities, three clusters, every point derived.
    expect(result.set.centroids).toHaveLength(3);
    expect(result.set.centroids.every((point) => point.provisional === false)).toBe(true);

    const stored = await readCentroidSet(db, "centroid_set_v2");
    expect(stored?.source).toBe("generated");
    expect(stored?.points.map((point) => point.origin)).toEqual([
      "municipality_centroid",
      "municipality_centroid",
      "municipality_centroid",
    ]);
    expect(stored?.clusterRadiusKm).toBe(75);
    expect(stored?.freezeMeanDistanceKm).toBeCloseTo(
      result.distance.meanDistanceKm ?? 0,
      9,
    );
    // The generated geometry sits closer to the fleet than the frozen nineteen
    // do — which is the whole reason a regeneration is ever considered.
    expect(result.distance.meanDistanceKm ?? 0).toBeLessThan(
      result.baselineDistance.meanDistanceKm ?? 0,
    );
    // Both versions coexist. Nothing about v1 changed.
    expect((await listCentroidSetVersions(db)).sort()).toEqual([
      "centroid_set_v1",
      "centroid_set_v2",
    ]);
  });

  it("regenerating against the same registry reproduces the stored set exactly", async () => {
    const again = await regenerateCentroids(db, {
      version: "centroid_set_v2",
      asOf: INGESTED_AT,
      on: TODAY,
      probe,
      options: { minClusterMw: 500 },
    });
    // Frozen already, identical geometry: the acceptance condition, and the
    // reason it is not an error.
    expect(again.frozen).toBe(false);
    const stored = await readCentroidSet(db, "centroid_set_v2");
    expect(stored?.centroidCount).toBe(3);
    for (const point of again.set.centroids) {
      const found = stored?.points.find((row) => row.id === point.id);
      expect(found?.latitude).toBeCloseTo(point.latitude, 9);
      expect(found?.longitude).toBeCloseTo(point.longitude, 9);
    }
  });

  it("refuses to regenerate the set in use", async () => {
    await expect(
      regenerateCentroids(db, { version: CENTROID_SET_VERSION, probe }),
    ).rejects.toThrow(/set in use/);
  });

  it("records a quiet drift check when the fleet has not moved", async () => {
    const check = createCentroidDriftCheck({ db });
    const result = await check(
      { asOf: INGESTED_AT.toISOString(), on: WINDOW_START.toISOString() },
      () => {},
    );
    // Same fleet date the baseline was measured at, so the ratio is 1.
    expect(result.driftRatio).toBeCloseTo(1, 9);
    expect(result.regenerationTriggered).toBe(false);
    expect(result.triggerRatio).toBe(DRIFT_TRIGGER_RATIO);
    expect((await readLatestDriftCheck(db, CENTROID_SET_VERSION))?.outcome).toBe(
      "within_tolerance",
    );
  });

  it("raises a regeneration trigger when the fleet grows away from the points", async () => {
    const check = createCentroidDriftCheck({ db });
    const result = await check(
      { asOf: INGESTED_AT.toISOString(), on: TODAY.toISOString() },
      () => {},
    );
    // 1,200 MW commissioned in São Paulo, hundreds of km from every frozen
    // solar point, against a baseline measured before it existed.
    expect(result.driftRatio ?? 0).toBeGreaterThan(DRIFT_TRIGGER_RATIO);
    expect(result.regenerationTriggered).toBe(true);
    const recorded = await readLatestDriftCheck(db, CENTROID_SET_VERSION);
    expect(recorded?.outcome).toBe("regeneration_triggered");
    expect(recorded?.meanDistanceKm).toBeCloseTo(result.meanDistanceKm ?? 0, 9);
    // The trigger is a warning and nothing else: no new version appeared.
    expect((await listCentroidSetVersions(db)).sort()).toEqual([
      "centroid_set_v1",
      "centroid_set_v2",
    ]);
  });
});

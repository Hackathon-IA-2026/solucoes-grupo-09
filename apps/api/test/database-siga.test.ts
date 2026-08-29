import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  createSigaIngestor,
  findWithdrawnPlants,
  type RegistryPlant,
  type ResolvedPlantLocation,
  readCurrentPlantLocations,
  readPlantLocationsAsOf,
  readPreviousMatchRate,
  readRegistryPlantKeys,
  recordSigaSnapshot,
  upsertPlants,
  writePlantLocations,
} from "../src/ingest/index.js";

// Seam 2, SIGA half — `plant_geo` against real Postgres. Gated on a test
// database exactly like `database.test.ts`; spin one up with
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:17-alpine
//
// Three properties here are SQL properties and cannot be shown with a mock:
// the latest-version projection returns one row per plant, the check
// constraints refuse a half-coordinate and a Null Island point whoever writes
// them, and a withdrawal survives as a *revision* rather than as a deletion.
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

const R1 = new Date("2026-08-26T09:00:00.000Z");
const R2 = new Date("2026-08-27T09:00:00.000Z");
const R3 = new Date("2026-08-28T09:00:00.000Z");
const DAY_1 = new Date("2026-08-26T00:00:00.000Z");
const DAY_2 = new Date("2026-08-27T00:00:00.000Z");
const DAY_3 = new Date("2026-08-28T00:00:00.000Z");

const PLANT = "EOL.CV.RN.028443-2";
const NULL_ISLAND_PLANT = "EOL.CV.CE.028770-9";

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

const location = (
  cegCore: string,
  overrides: Partial<ResolvedPlantLocation> = {},
): ResolvedPlantLocation => ({
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
  ...overrides,
});

suite("plant_geo · SIGA locations (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    await db.execute(sql`truncate table plant_geo cascade`);
    await db.execute(sql`truncate table siga_snapshot cascade`);
    await db.execute(sql`truncate table plant cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "siga-sistema-de-informacoes-de-geracao-da-aneel",
        resourceName: "siga-empreendimentos-geracao-diario.csv",
        resourceUrl: "https://example.invalid/siga-empreendimentos-geracao-diario.csv",
        format: "CSV",
        changeKey: `siga-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";

    await upsertPlants(db, [registryPlant(PLANT), registryPlant(NULL_ISLAND_PLANT)]);
  });

  afterAll(() => handle.close());

  const write = (
    locations: ResolvedPlantLocation[],
    observedOn: Date,
    ingestedAt: Date,
  ) =>
    writePlantLocations(db, {
      locations,
      observedOn,
      publishedAt: ingestedAt,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt,
    });

  it("reads the registry's identity columns as the match-rate denominator", async () => {
    const keys = await readRegistryPlantKeys(db);
    expect(keys.map((key) => key.cegCore).sort()).toEqual(
      [PLANT, NULL_ISLAND_PLANT].sort(),
    );
    // ONS's rendering, zero-padded — the string that matches no `CodCEG`.
    expect(keys.every((key) => key.cegRaw.endsWith(".01"))).toBe(true);
  });

  it("writes the first snapshot at data_version 1", async () => {
    const result = await write(
      [
        location(PLANT),
        location(NULL_ISLAND_PLANT, {
          sigaName: "Enacel",
          coordinate: { latitude: -4.6009, longitude: -37.6421 },
          locationSource: "siga_municipality_centroid",
          coordinateRejection: "null_island",
          municipality: { name: "Aracati", uf: "CE" },
          municipalitiesRaw: "Aracati - CE",
        }),
      ],
      DAY_1,
      R1,
    );
    expect(result).toEqual({ inserted: 2, revised: 0, unchanged: 0 });
  });

  it("writes nothing when the daily extract restates the same locations", async () => {
    // The property that makes a daily poll storable: ANEEL republishes the
    // same 1,600 coordinates every morning, and only the snapshot date moved.
    const result = await write(
      [
        location(PLANT),
        location(NULL_ISLAND_PLANT, {
          sigaName: "Enacel",
          coordinate: { latitude: -4.6009, longitude: -37.6421 },
          locationSource: "siga_municipality_centroid",
          coordinateRejection: "null_island",
          municipality: { name: "Aracati", uf: "CE" },
          municipalitiesRaw: "Aracati - CE",
        }),
      ],
      DAY_2,
      R2,
    );
    expect(result).toEqual({ inserted: 0, revised: 0, unchanged: 2 });
    const stored = await readCurrentPlantLocations(db);
    // And `observed_on` still records when the belief began, not today.
    expect(stored.get(PLANT)?.observedOn).toEqual(DAY_1);
  });

  it("appends a revision when ANEEL corrects a coordinate", async () => {
    const result = await write(
      [location(PLANT, { coordinate: { latitude: -5.2, longitude: -36.4 } })],
      DAY_3,
      R3,
    );
    expect(result).toEqual({ inserted: 0, revised: 1, unchanged: 0 });

    const current = await readCurrentPlantLocations(db);
    expect(current.get(PLANT)?.dataVersion).toBe(2);
    expect(current.get(PLANT)?.coordinate?.latitude).toBeCloseTo(-5.2, 6);

    // The prior belief is still answerable — SIGA has no archive, so this is
    // the only place the old coordinate exists at all.
    const before = await readPlantLocationsAsOf(db, { asOf: R2 });
    expect(
      before.rows.find((row) => row.cegCore === PLANT)?.coordinate?.latitude,
    ).toBeCloseTo(-5.124_305_56, 6);
    expect(before.vintageFidelity).toBe("point_in_time");
  });

  it("returns exactly one row per plant however many versions exist", async () => {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from plant_geo where plant_ceg_core = ${PLANT}`,
    );
    expect([...rows][0]?.n).toBe(2);
    const latest = await readPlantLocationsAsOf(db, { asOf: R3 });
    expect(latest.rows.filter((row) => row.cegCore === PLANT)).toHaveLength(1);
  });

  it("records a withdrawal as a revision of the plant's own row", async () => {
    const previous = await readCurrentPlantLocations(db);
    const withdrawn = findWithdrawnPlants(previous, new Set([PLANT]), DAY_3);
    expect(withdrawn.map((row) => row.cegCore)).toEqual([NULL_ISLAND_PLANT]);

    const result = await write(withdrawn, DAY_3, R3);
    expect(result).toEqual({ inserted: 0, revised: 1, unchanged: 0 });

    // Gone from the default read, still fully recoverable from the table.
    const live = await readPlantLocationsAsOf(db, { asOf: R3 });
    expect(live.rows.map((row) => row.cegCore)).toEqual([PLANT]);

    const all = await readPlantLocationsAsOf(db, { asOf: R3, includeWithdrawn: true });
    const gone = all.rows.find((row) => row.cegCore === NULL_ISLAND_PLANT);
    expect(gone?.withdrawnOn).toEqual(DAY_3);
    // Its last known location was not destroyed to record its absence.
    expect(gone?.coordinate).not.toBeNull();
  });

  it("filters to plants a weather sample can actually use", async () => {
    await write(
      [
        location(PLANT, {
          coordinate: null,
          locationSource: "unlocated",
          coordinateRejection: "out_of_bounds",
        }),
      ],
      DAY_3,
      R3,
    );
    const located = await readPlantLocationsAsOf(db, { asOf: R3, locatedOnly: true });
    expect(located.rows).toHaveLength(0);
  });

  /**
   * Insert a raw row, bypassing the adapter, and report which constraint
   * refused it.
   *
   * Raw SQL on purpose: these three checks exist to bind **any** writer, not
   * only `writePlantLocations`. Drizzle wraps the driver error, so the
   * constraint name is read off the cause rather than matched in the message.
   */
  const violation = async (values: string, version: number): Promise<string> => {
    try {
      await db.execute(sql`
        insert into plant_geo (plant_ceg_core, ceg_raw, siga_name, latitude, longitude,
          location_source, municipalities_raw, ownership, observed_on,
          data_version, published_at, published_at_precision, value_digest, source_version_id)
        values (${PLANT}, 'x', 'x', ${sql.raw(values)}, 'x', 'x',
          ${DAY_3.toISOString()}::timestamptz, ${version},
          ${DAY_3.toISOString()}::timestamptz, 'file', 'digest',
          ${sourceVersionId}::uuid)
      `);
    } catch (error) {
      const cause = (error as { cause?: { constraint_name?: string } }).cause;
      return cause?.constraint_name ?? String(error);
    }
    return "no violation";
  };

  it("refuses half a coordinate whoever writes it", async () => {
    expect(await violation("-5.1, null, 'siga_coordinate'", 99)).toBe(
      "plant_geo_coordinate_pair",
    );
  });

  it("refuses Null Island as a stored location whoever writes it", async () => {
    expect(await violation("0, 0, 'siga_coordinate'", 98)).toBe(
      "plant_geo_within_brazil",
    );
  });

  it("refuses a located row that calls itself unlocated", async () => {
    expect(await violation("-5.1, -36.4, 'unlocated'", 97)).toBe(
      "plant_geo_location_source",
    );
  });

  it("keeps the previous match rate readable so a slide can be caught", async () => {
    expect(await readPreviousMatchRate(db)).toBeNull();
    await recordSigaSnapshot(db, {
      snapshotDate: DAY_3,
      sourceVersionId,
      sourceRows: 25_124,
      fleetRows: 1693,
      registryPlants: 1619,
      matchedPlants: 1615,
      matchRate: 1615 / 1619,
      verbatimMatchedPlants: 0,
      nullIslandRows: 436,
      outOfBoundsRows: 1,
      locatedPlants: 1611,
      centroidFallbackPlants: 4,
      unlocatedPlants: 0,
      withdrawnPlants: 0,
    });
    const previous = await readPreviousMatchRate(db);
    expect(previous).toBeCloseTo(0.997_53, 5);
  });
});

// ---------------------------------------------------------------------------
// The whole job, over the real fixture, against real Postgres.
// ---------------------------------------------------------------------------

const ANEEL = join(import.meta.dir, "fixtures", "aneel");
const SIGA_CSV = readFileSync(
  join(ANEEL, "siga-empreendimentos-geracao-diario.registry.csv"),
  "utf8",
);
const PACKAGE = readFileSync(join(ANEEL, "package-show-siga.json"), "utf8");
const DAILY_URL_FRAGMENT = "siga-empreendimentos-geracao-diario.csv";

/** ANEEL's CKAN, its `HEAD` and its bytes, without the network. */
const stubFetch = (csv: string, etag: string): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("package_show")) {
      return new Response(PACKAGE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (!url.includes(DAILY_URL_FRAGMENT)) {
      throw new Error(`unexpected fetch of ${url} — the monthly cut must not be read`);
    }
    const headers = {
      etag,
      "content-length": String(csv.length),
      "last-modified": "Fri, 28 Aug 2026 10:42:02 GMT",
    };
    return init?.method === "HEAD"
      ? new Response(null, { status: 200, headers })
      : new Response(csv, { status: 200, headers });
  }) as typeof fetch;

suite("SIGA ingest · the whole job (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  const noop = () => {};

  // The nine VRE plants the ONS capacity fixture carries, plus the two
  // null-island plants — both of which ONS really does list — so the
  // municipality fallback is exercised end to end rather than in isolation.
  const SEEDED = [
    "EOL.CV.BA.034778-7",
    "EOL.CV.BA.034779-5",
    "EOL.CV.CE.028699-0",
    "EOL.CV.CE.033756-0",
    "EOL.CV.MA.033682-3",
    "EOL.CV.MA.033683-1",
    "EOL.CV.RN.028443-2",
    "EOL.CV.RN.030339-9",
    "UFV.RS.PE.040725-9",
    "EOL.CV.CE.028770-9",
    "UFV.RS.MG.049441-0",
  ];

  beforeAll(async () => {
    await db.execute(sql`truncate table plant_geo cascade`);
    await db.execute(sql`truncate table siga_snapshot cascade`);
    await db.execute(sql`truncate table plant cascade`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
    await upsertPlants(db, SEEDED.map(registryPlant));
  });

  afterAll(() => handle.close());

  it("ingests the daily extract and locates every registry plant", async () => {
    const run = createSigaIngestor({ db, fetch: stubFetch(SIGA_CSV, '"v1"') });
    const result = await run({}, noop);

    expect(result.resourceName).toBe("siga-empreendimentos-geracao-diario.csv");
    expect(result.downloaded).toBe(true);
    expect(result.snapshotDate).toBe("2026-08-28");

    // The join, asserted: every seeded plant matched on the core, none on the
    // raw string.
    expect(result.registryPlants).toBe(11);
    expect(result.matchedPlants).toBe(11);
    expect(result.matchRate).toBe(1);
    expect(result.verbatimMatchedPlants).toBe(0);
    expect(result.previousMatchRate).toBeNull();

    // Nine sited from SIGA's own coordinates, two from their municipality.
    expect(result.locatedPlants).toBe(9);
    expect(result.centroidFallbackPlants).toBe(2);
    expect(result.unlocatedPlants).toBe(0);
    expect(result.locations).toEqual({ inserted: 11, revised: 0, unchanged: 0 });

    // SIGA's own capacity is reported as a filtered diagnostic and nothing is
    // stored from it — capacity lives in `generating_unit`, from ONS.
    expect(result.fleetRows).toBe(14);
    const [columns] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from information_schema.columns
      where table_name = 'plant_geo' and column_name like '%capacit%'
    `);
    expect(columns?.n).toBe(0);
  });

  it("writes nothing on a re-run of the same extract", async () => {
    // Same bytes, a new fingerprint — so it downloads and diffs, and finds
    // that ANEEL restated exactly what it said yesterday.
    const run = createSigaIngestor({ db, fetch: stubFetch(SIGA_CSV, '"v2"') });
    const result = await run({}, noop);
    expect(result.locations).toEqual({ inserted: 0, revised: 0, unchanged: 11 });
    expect(result.previousMatchRate).toBe(1);
  });

  it("detects a retirement as the row ceasing to exist", async () => {
    // ANEEL deletes rather than tombstones. Enacel simply stops being there.
    const withoutEnacel = SIGA_CSV.split("\n")
      .filter((line) => !line.includes("EOL.CV.CE.028770-9"))
      .join("\n");
    const run = createSigaIngestor({ db, fetch: stubFetch(withoutEnacel, '"v3"') });
    // The thresholds are relaxed for the fixture's scale, and the reason is
    // worth stating: one plant of eleven is a 9% drop, where one plant of the
    // live 1,619 is 0.06% — well inside the default tolerance. The assertion
    // is calibrated for a registry, not for a slice of one, and a deletion
    // large enough to move it by half a percent *should* stop the ingest.
    const result = await run({ matchRateFloor: 0.9, matchRateTolerance: 0.2 }, noop);

    expect(result.withdrawnPlants).toBe(1);
    expect(result.matchedPlants).toBe(10);

    const live = await readPlantLocationsAsOf(db, { asOf: new Date() });
    expect(live.rows.map((row) => row.cegCore)).not.toContain("EOL.CV.CE.028770-9");
    const all = await readPlantLocationsAsOf(db, {
      asOf: new Date(),
      includeWithdrawn: true,
    });
    expect(
      all.rows.find((row) => row.cegCore === "EOL.CV.CE.028770-9")?.withdrawnOn,
    ).toEqual(new Date("2026-08-28T00:00:00.000Z"));
  });

  it("fails the ingest, before writing, when the join collapses", async () => {
    // The scenario the ticket exists for: ANEEL changes the CEG rendering and
    // the core key stops matching. Simulated by mangling the identifier.
    const mangled = SIGA_CSV.replaceAll('"EOL.CV.', '"XXX.CV.');
    const before = await readPlantLocationsAsOf(db, {
      asOf: new Date(),
      includeWithdrawn: true,
    });
    const run = createSigaIngestor({ db, fetch: stubFetch(mangled, '"v4"') });

    await expect(run({}, noop)).rejects.toThrow(/match rate is below/);

    // Nothing was written on the run that detected the problem — the whole
    // reason the assertion happens before the write.
    const after = await readPlantLocationsAsOf(db, {
      asOf: new Date(),
      includeWithdrawn: true,
    });
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.rows.map((row) => row.dataVersion)).toEqual(
      before.rows.map((row) => row.dataVersion),
    );
  });
});

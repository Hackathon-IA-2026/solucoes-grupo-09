import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  type CurtailmentReportHour,
  createEnergyBalanceIngestor,
  createPlantRegistryIngestor,
  type EnergyBalanceHour,
  type RegistryGeneratingUnit,
  type RegistryPlant,
  readConjuntoMembershipAsOf,
  readCurtailmentAsOf,
  readEnergyBalanceAsOf,
  readInstalledCapacityAsOf,
  readPlantCapacityAsOf,
  upsertConjuntos,
  upsertPlants,
  upsertReportingEntities,
  writeConjuntoMemberships,
  writeCurtailment,
  writeEnergyBalance,
  writeGeneratingUnits,
} from "../src/ingest/index.js";
import { createInProcessRunner } from "../src/jobs/inprocess.js";

// Seam 2 — as-of reads against real Postgres. Runs only with a test database
// (the `test:db` script sets it), the same gating the template used for its
// database suite, so the default `bun test` needs no network and no server.
//
// Spin one up:
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:16-alpine
//
// A mock would prove nothing here: the thing under test is a SQL property —
// that `DISTINCT ON` over the business key returns exactly one row per key.
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** A distant valid-time window, so a repeated run cannot collide with itself. */
const HOUR_ONE = new Date("2024-04-01T03:00:00.000Z");
const HOUR_TWO = new Date("2024-04-01T04:00:00.000Z");

const balance = (
  validTime: Date,
  loadMwh: number,
  subsystem: EnergyBalanceHour["subsystem"] = "SE",
): EnergyBalanceHour => ({
  subsystem,
  validTime,
  loadMwh,
  hydroGenerationMwh: 1,
  thermalGenerationMwh: 2,
  windGenerationMwh: 3,
  solarGenerationMwh: 4,
  netExchangeMwh: 5,
});

suite("bitemporal store · as-of reads (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    // Schema is applied by `bun run db:push` (see the `test:db` script).
    // Append-only tables accumulate, so the suite starts from a clean slate.
    await db.execute(sql`truncate table subsystem_energy_balance_hour`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "balanco-energia-subsistema",
        resourceName: "Balanco_de_Energia_Subsistema-2024",
        resourceUrl: "https://example.invalid/BALANCO_ENERGIA_SUBSISTEMA_2024.parquet",
        format: "PARQUET",
        changeKey: 'test|1|"a"',
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";
  });

  afterAll(() => handle.close());

  const write = (rows: EnergyBalanceHour[], ingestedAt: Date, publishedAt: Date) =>
    writeEnergyBalance(db, {
      rows,
      publishedAt,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt,
    });

  const T1 = new Date("2026-05-01T00:00:00.000Z");
  const T2 = new Date("2026-06-01T00:00:00.000Z");
  const T3 = new Date("2026-07-01T00:00:00.000Z");

  it("writes the first vintage at data_version 1", async () => {
    const result = await write(
      [balance(HOUR_ONE, 100), balance(HOUR_TWO, 200)],
      T1,
      new Date("2026-04-30T15:00:00.000Z"),
    );
    expect(result).toEqual({ inserted: 2, revised: 0, unchanged: 0 });
  });

  it("writes no new version when a re-ingest reproduces identical values", async () => {
    // Vintage history must record ONS restatements, not WattSteer's polling
    // schedule — so a later fetch of the same numbers is a no-op even though
    // the file's publication time moved.
    const result = await write(
      [balance(HOUR_ONE, 100), balance(HOUR_TWO, 200)],
      T2,
      new Date("2026-05-31T15:00:00.000Z"),
    );
    expect(result).toEqual({ inserted: 0, revised: 0, unchanged: 2 });
  });

  it("is idempotent on retry — the same job run twice changes nothing", async () => {
    const result = await write([balance(HOUR_ONE, 100)], T2, T2);
    expect(result.unchanged).toBe(1);
    expect(result.inserted + result.revised).toBe(0);
  });

  it("appends a version rather than overwriting when a value changes", async () => {
    const result = await write(
      [balance(HOUR_ONE, 111), balance(HOUR_TWO, 200)],
      T3,
      new Date("2026-06-30T15:00:00.000Z"),
    );
    expect(result).toEqual({ inserted: 0, revised: 1, unchanged: 1 });

    const [{ versions }] = await db.execute<{ versions: number }>(sql`
      select count(*)::int as versions from subsystem_energy_balance_hour
      where subsystem = 'SE' and valid_time = ${HOUR_ONE.toISOString()}::timestamptz
    `);
    // The prior belief survives — nothing was destroyed.
    expect(versions).toBe(2);
  });

  it("returns exactly one row per key for an as-of read", async () => {
    const after = await readEnergyBalanceAsOf(db, {
      asOf: new Date("2026-08-01T00:00:00.000Z"),
      from: HOUR_ONE,
      to: new Date("2024-04-01T05:00:00.000Z"),
    });
    expect(after.rows).toHaveLength(2);
    expect(
      after.rows.find((row) => row.validTime.getTime() === HOUR_ONE.getTime()),
    ).toMatchObject({ loadMwh: 111, dataVersion: 2 });
  });

  it("answers with what was believed then, not with what is believed now", async () => {
    const before = await readEnergyBalanceAsOf(db, {
      // Between the first write and the revision.
      asOf: new Date("2026-06-15T00:00:00.000Z"),
      from: HOUR_ONE,
      to: new Date("2024-04-01T05:00:00.000Z"),
    });
    expect(before.rows).toHaveLength(2);
    expect(
      before.rows.find((row) => row.validTime.getTime() === HOUR_ONE.getTime()),
    ).toMatchObject({ loadMwh: 100, dataVersion: 1 });
  });

  it("returns nothing for an as-of before anything was ingested", async () => {
    const result = await readEnergyBalanceAsOf(db, {
      asOf: new Date("2026-01-01T00:00:00.000Z"),
      from: HOUR_ONE,
      to: new Date("2024-04-01T05:00:00.000Z"),
    });
    expect(result.rows).toEqual([]);
  });

  it("flags a window that predates go-live as revision-optimistic", async () => {
    const result = await readEnergyBalanceAsOf(db, {
      asOf: new Date("2026-08-01T00:00:00.000Z"),
      from: HOUR_ONE,
      to: new Date("2024-04-01T05:00:00.000Z"),
    });
    // The valid-time window is 2024-04; ingestion go-live is 2026-05. What ONS
    // said in 2024 is unrecoverable, so this can never be point-in-time.
    expect(result.goLiveAt?.toISOString()).toBe(T1.toISOString());
    expect(result.vintageFidelity).toBe("revision_optimistic");
  });

  it("filters by subsystem without fanning out the key", async () => {
    await write([balance(HOUR_ONE, 50, "S")], T3, T3);
    const result = await readEnergyBalanceAsOf(db, {
      asOf: new Date("2026-08-01T00:00:00.000Z"),
      from: HOUR_ONE,
      to: new Date("2024-04-01T05:00:00.000Z"),
      subsystem: "S",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.subsystem).toBe("S");
  });

  it("writes nothing for an empty parse", async () => {
    expect(await write([], T3, T3)).toEqual({
      inserted: 0,
      revised: 0,
      unchanged: 0,
    });
  });
});

/**
 * The ingestion job end to end, on the existing job runner, with the network
 * stubbed by the captured fixtures. Needs Postgres because the whole point of
 * the job is what it writes, so it is gated with the suite above.
 */
suite("ingestion job · balanco-energia-subsistema (real Postgres, stub network)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  const FIXTURES = join(import.meta.dir, "fixtures", "ons");
  const HEAD_HEADERS = {
    "last-modified": "Fri, 28 Aug 2026 15:00:33 GMT",
    "content-length": "1393352",
    etag: '"591d0f65d881b5bb016cc7e0d83aec19"',
  };

  /** Counts what the job actually asked the network for. */
  let requests: string[] = [];

  const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("package_show")) {
      return new Response(
        await Bun.file(
          join(FIXTURES, "package-show-balanco-energia-subsistema.json"),
        ).text(),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (init?.method === "HEAD") {
      return new Response(null, { headers: HEAD_HEADERS });
    }
    return new Response(
      await Bun.file(
        join(FIXTURES, "BALANCO_ENERGIA_SUBSISTEMA_2026.parquet"),
      ).arrayBuffer(),
      { headers: HEAD_HEADERS },
    );
  }) as typeof fetch;

  beforeAll(async () => {
    await db.execute(sql`truncate table subsystem_energy_balance_hour`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
  });
  afterAll(() => handle.close());

  it("ingests a year through the job runner and writes canonical rows", async () => {
    requests = [];
    const runner = createInProcessRunner(
      createEnergyBalanceIngestor({ db, fetch: stubFetch }),
    );
    const id = await runner.submit({ year: 2026 });

    let record = await runner.status(id);
    for (let i = 0; i < 600 && record?.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = await runner.status(id);
    }
    await runner.close();

    expect(record?.status).toBe("completed");
    expect(record?.result).toMatchObject({
      format: "PARQUET",
      changed: true,
      downloaded: true,
      aggregateRowsFiltered: 5712,
      rowsRejected: 0,
      revised: 0,
      unchanged: 0,
    });
    expect(record?.result?.inserted).toBe(22_848);
  }, 60_000);

  it("detects an unchanged file without downloading it", async () => {
    requests = [];
    const ingest = createEnergyBalanceIngestor({ db, fetch: stubFetch });
    const result = await ingest({ year: 2026 }, () => {});

    expect(result).toMatchObject({ changed: false, downloaded: false });
    // One catalogue call and one HEAD. No GET of the 1.4 MB file.
    expect(requests).toEqual([
      expect.stringContaining("package_show"),
      expect.stringContaining("HEAD https://ons-aws-prod-opendata.s3.amazonaws.com"),
    ]);
  }, 60_000);

  it("re-parsing the same bytes writes no new version", async () => {
    const ingest = createEnergyBalanceIngestor({ db, fetch: stubFetch });
    const result = await ingest({ year: 2026, force: true }, () => {});
    expect(result.downloaded).toBe(true);
    expect(result.inserted + result.revised).toBe(0);
    expect(result.unchanged).toBe(22_848);
  }, 60_000);
});

/** A distant window of its own, so the two suites cannot collide. */
const CURTAILED_HOUR = new Date("2024-05-01T12:00:00.000Z");
const ENTITY = "CJU_TEST1";

const report = (
  constrainedOffMwh: number,
  cause: CurtailmentReportHour["cause"] = null,
): CurtailmentReportHour => ({
  reportingEntityCode: ENTITY,
  technology: "WIND",
  validTime: CURTAILED_HOUR,
  verifiedGenerationMwh: 100,
  constrainedOffMwh,
  referenceGenerationMwh: 150,
  finalReferenceGenerationMwh: null,
  availableCapacityMw: 200,
  halfHoursObserved: 2,
  cause,
  causeMixed: false,
});

suite("constrained-off · bitemporal store (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    await db.execute(sql`truncate table curtailment_report_hour`);
    await db.execute(sql`truncate table reporting_entity cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "restricao_coff_eolica_usi",
        resourceName: "Restricoes_coff_eolicas-2024-05",
        resourceUrl: "https://example.invalid/RESTRICAO_COFF_EOLICA_2024_05.csv",
        format: "CSV",
        changeKey: `curtailment-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";

    await upsertReportingEntities(db, [
      {
        onsCode: ENTITY,
        kind: "CONJUNTO",
        cegCore: null,
        name: "CONJ. TEST",
        subsystem: "NE",
        stateCode: "BA",
      },
    ]);
  });

  afterAll(() => handle.close());

  it("upserts an entity idempotently and keeps first_seen_at fixed", async () => {
    const before = await db.execute<{ first_seen_at: string; last_seen_at: string }>(
      sql`select first_seen_at, last_seen_at from reporting_entity where ons_code = ${ENTITY}`,
    );
    const later = new Date(Date.now() + 60_000);
    await upsertReportingEntities(
      db,
      [
        {
          onsCode: ENTITY,
          kind: "CONJUNTO",
          cegCore: null,
          name: "CONJ. TEST RENAMED",
          subsystem: "NE",
          stateCode: "BA",
        },
      ],
      later,
    );
    const after = await db.execute<{
      first_seen_at: string;
      last_seen_at: string;
      name: string;
    }>(
      sql`select first_seen_at, last_seen_at, name from reporting_entity where ons_code = ${ENTITY}`,
    );
    expect([...after][0]?.name).toBe("CONJ. TEST RENAMED");
    expect([...after][0]?.first_seen_at).toEqual([...before][0]?.first_seen_at);
    expect(new Date([...after][0]?.last_seen_at ?? 0).getTime()).toBeGreaterThan(
      new Date([...before][0]?.last_seen_at ?? 0).getTime(),
    );
  });

  it("writes a first version, then treats an identical re-ingest as unchanged", async () => {
    const first = await writeCurtailment(db, {
      rows: [report(10)],
      publishedAt: new Date("2024-06-01T00:00:00.000Z"),
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: new Date("2024-06-01T01:00:00.000Z"),
    });
    expect(first).toEqual({ inserted: 1, revised: 0, unchanged: 0 });

    const again = await writeCurtailment(db, {
      rows: [report(10)],
      publishedAt: new Date("2024-06-02T00:00:00.000Z"),
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: new Date("2024-06-02T01:00:00.000Z"),
    });
    // A later publication of the same numbers is not a restatement.
    expect(again).toEqual({ inserted: 0, revised: 0, unchanged: 1 });
  });

  it("stores a retroactive backfill of a closed month as a new vintage", async () => {
    // ONS rewrites closed months years later. The old belief must survive.
    const revised = await writeCurtailment(db, {
      rows: [report(42)],
      publishedAt: new Date("2026-05-04T00:00:00.000Z"),
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: new Date("2026-05-04T01:00:00.000Z"),
    });
    expect(revised).toEqual({ inserted: 0, revised: 1, unchanged: 0 });

    const before = await readCurtailmentAsOf(db, {
      asOf: new Date("2024-06-01T12:00:00.000Z"),
      from: CURTAILED_HOUR,
      to: new Date(CURTAILED_HOUR.getTime() + 3_600_000),
    });
    const after = await readCurtailmentAsOf(db, {
      asOf: new Date("2026-06-01T00:00:00.000Z"),
      from: CURTAILED_HOUR,
      to: new Date(CURTAILED_HOUR.getTime() + 3_600_000),
    });

    // What we believed then, and what we believe now — both answerable.
    expect(before.rows[0]?.constrainedOffMwh).toBe(10);
    expect(before.rows[0]?.dataVersion).toBe(1);
    expect(after.rows[0]?.constrainedOffMwh).toBe(42);
    expect(after.rows[0]?.dataVersion).toBe(2);
    expect(after.rows).toHaveLength(1);
  });

  it("treats a changed reason with unchanged numbers as a restatement", async () => {
    // The cause is part of the value: CNF becoming ENE is a real revision even
    // when not one megawatt-hour moves.
    const first = await writeCurtailment(db, {
      rows: [report(42, { reason: "CNF", origin: "LOC", description: null })],
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: new Date("2026-06-01T01:00:00.000Z"),
    });
    expect(first.revised).toBe(1);

    const second = await writeCurtailment(db, {
      rows: [report(42, { reason: "ENE", origin: "LOC", description: null })],
      publishedAt: new Date("2026-06-02T00:00:00.000Z"),
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: new Date("2026-06-02T01:00:00.000Z"),
    });
    expect(second.revised).toBe(1);

    const now = await readCurtailmentAsOf(db, {
      asOf: new Date("2026-07-01T00:00:00.000Z"),
      from: CURTAILED_HOUR,
      to: new Date(CURTAILED_HOUR.getTime() + 3_600_000),
    });
    expect(now.rows[0]?.cause).toEqual({
      reason: "ENE",
      origin: "LOC",
      description: null,
    });
  });

  it("refuses a half-populated cause at the database, not just in TypeScript", async () => {
    // The domain model calls half-populated an *illegal state*, not a
    // discouraged one. TypeScript enforces it on the way in through this
    // codebase; the CHECK is what makes it true for any other writer.
    let caught: unknown;
    try {
      await db.execute(sql`
        insert into curtailment_report_hour (
          reporting_entity_code, technology, valid_time, data_version,
          verified_generation_mwh, constrained_off_mwh, half_hours_observed,
          reason, origin, cause_mixed,
          published_at, published_at_precision, value_digest, source_version_id
        ) values (
          ${ENTITY}, 'WIND',
          ${new Date("2024-05-02T12:00:00.000Z").toISOString()}::timestamptz, 99,
          1, 1, 2,
          'ENE', null, 0,
          now(), 'file', 'half-populated-probe', ${sourceVersionId}::uuid
        )
      `);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    // Drizzle wraps the driver error, so the constraint name is on the cause.
    const cause = (caught as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe("curtailment_cause_whole");
  });

  it("reports a read before go-live as revision-optimistic", async () => {
    const result = await readCurtailmentAsOf(db, {
      asOf: new Date("2026-07-01T00:00:00.000Z"),
      from: CURTAILED_HOUR,
      to: new Date(CURTAILED_HOUR.getTime() + 3_600_000),
    });
    // The window predates our first ingestion, so ONS's current restatement is
    // the only "past" available. Reported, never silently answered.
    expect(result.vintageFidelity).toBe("revision_optimistic");
    expect(result.goLiveAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ONS fleet registry (ticket 04) — as-of capacity and time-resolved membership.
// ---------------------------------------------------------------------------

/** A plant of our own, so these suites cannot collide with the ones above. */
const TEST_PLANT = "EOL.TT.BA.000001-1";
const TEST_PLANT_SE = "UFV.TT.BA.000002-9";

const registryPlant = (
  cegCore: string,
  overrides: Partial<RegistryPlant> = {},
): RegistryPlant => ({
  cegCore,
  cegRaw: `${cegCore}.01`,
  onsPlantCode: null,
  name: `PLANT ${cegCore}`,
  subsystem: "NE",
  stateCode: "BA",
  technology: "WIND",
  operationModality: "TIPO_II_C",
  ownerName: "AGENTE",
  operatorName: "AGENTE",
  ...overrides,
});

const registryUnit = (
  plantCegCore: string,
  equipmentCode: string,
  ratedPowerMw: number,
  commissionedOn: string,
  decommissionedOn: string | null = null,
): RegistryGeneratingUnit => ({
  plantCegCore,
  equipmentCode,
  unitNumber: equipmentCode.slice(-1),
  name: `UG ${equipmentCode}`,
  ratedPowerMw,
  testEntryOn: null,
  commissionedOn: new Date(`${commissionedOn}T00:00:00.000Z`),
  decommissionedOn:
    decommissionedOn === null ? null : new Date(`${decommissionedOn}T00:00:00.000Z`),
});

suite("registry · installed capacity as of a date (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  const R1 = new Date("2026-08-01T00:00:00.000Z");
  const R2 = new Date("2026-08-15T00:00:00.000Z");
  const LATER = new Date("2026-09-01T00:00:00.000Z");

  beforeAll(async () => {
    await db.execute(sql`truncate table generating_unit`);
    await db.execute(sql`truncate table conjunto_membership`);
    await db.execute(sql`truncate table plant cascade`);
    await db.execute(sql`truncate table conjunto cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "capacidade-geracao",
        resourceName: "Capacidade_Geracao",
        resourceUrl: "https://example.invalid/CAPACIDADE_GERACAO.csv",
        format: "CSV",
        changeKey: `registry-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";

    await upsertPlants(db, [
      registryPlant(TEST_PLANT),
      // State BA, subsystem SE — the electrical assignment, not the state.
      registryPlant(TEST_PLANT_SE, { subsystem: "SE", technology: "SOLAR" }),
    ]);
  });

  afterAll(() => handle.close());

  const write = (units: RegistryGeneratingUnit[], ingestedAt: Date) =>
    writeGeneratingUnits(db, {
      units,
      publishedAt: ingestedAt,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt,
    });

  it("writes the first snapshot at data_version 1", async () => {
    const result = await write(
      [
        registryUnit(TEST_PLANT, "UG1", 10, "2024-01-15"),
        registryUnit(TEST_PLANT, "UG2", 20, "2025-06-01"),
        registryUnit(TEST_PLANT_SE, "UG3", 30, "2024-01-15"),
      ],
      R1,
    );
    expect(result).toEqual({ inserted: 3, revised: 0, unchanged: 0 });
  });

  it("writes nothing when the daily snapshot reproduces itself", async () => {
    // The file is overwritten twice a day. Version history has to record ONS's
    // corrections, not the refresh schedule.
    const result = await write(
      [
        registryUnit(TEST_PLANT, "UG1", 10, "2024-01-15"),
        registryUnit(TEST_PLANT, "UG2", 20, "2025-06-01"),
        registryUnit(TEST_PLANT_SE, "UG3", 30, "2024-01-15"),
      ],
      R2,
    );
    expect(result).toEqual({ inserted: 0, revised: 0, unchanged: 3 });
  });

  it("sums unit capacity to plant grain at a date, and only what existed then", async () => {
    const early = await readInstalledCapacityAsOf(db, {
      asOf: LATER,
      on: new Date("2024-06-01T00:00:00.000Z"),
    });
    // UG2 has not commissioned yet, so 20 MW of today's fleet is not there.
    expect(early.totalMw).toBeCloseTo(40, 6);

    const late = await readInstalledCapacityAsOf(db, {
      asOf: LATER,
      on: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(late.totalMw).toBeCloseTo(60, 6);
  });

  it("groups by the plant's electrical subsystem, never by its state", async () => {
    const result = await readInstalledCapacityAsOf(db, {
      asOf: LATER,
      on: new Date("2026-01-01T00:00:00.000Z"),
    });
    // Both plants are in BA. One is electrically SE, and stays there.
    expect(result.groups).toEqual([
      { subsystem: "NE", technology: "WIND", plants: 1, units: 2, capacityMw: 30 },
      { subsystem: "SE", technology: "SOLAR", plants: 1, units: 1, capacityMw: 30 },
    ]);
  });

  it("filters by scope and technology without double counting", async () => {
    const result = await readInstalledCapacityAsOf(db, {
      asOf: LATER,
      on: new Date("2026-01-01T00:00:00.000Z"),
      subsystem: "SE",
      technology: "SOLAR",
    });
    expect(result.totalMw).toBeCloseTo(30, 6);
    expect(result.groups).toHaveLength(1);
  });

  it("counts a unit from its commissioning day and drops it on its deactivation day", async () => {
    await write(
      [registryUnit(TEST_PLANT, "UG4", 5, "2026-02-01", "2026-03-01")],
      new Date("2026-08-20T00:00:00.000Z"),
    );
    const inside = await readInstalledCapacityAsOf(db, {
      asOf: LATER,
      on: new Date("2026-02-01T00:00:00.000Z"),
      subsystem: "NE",
    });
    const onExit = await readInstalledCapacityAsOf(db, {
      asOf: LATER,
      on: new Date("2026-03-01T00:00:00.000Z"),
      subsystem: "NE",
    });
    // `[commissioned_on, decommissioned_on)` — closed at the start, open at the
    // end, exactly as `docs/domain-model.md` defines `InstalledCapacityAsOf`.
    expect(inside.totalMw).toBeCloseTo(35, 6);
    expect(onExit.totalMw).toBeCloseTo(30, 6);
  });

  it("stores a corrected commissioning date as a new vintage, not an overwrite", async () => {
    // ONS's snapshot is today's record of the past, and the correction changes
    // the fleet on every day between the two dates. Both readings survive.
    const revised = await write(
      [registryUnit(TEST_PLANT, "UG2", 20, "2025-01-01")],
      new Date("2026-08-25T00:00:00.000Z"),
    );
    expect(revised).toEqual({ inserted: 0, revised: 1, unchanged: 0 });

    const believedBefore = await readInstalledCapacityAsOf(db, {
      asOf: new Date("2026-08-20T00:00:00.000Z"),
      on: new Date("2025-03-01T00:00:00.000Z"),
      subsystem: "NE",
    });
    const believedNow = await readInstalledCapacityAsOf(db, {
      asOf: LATER,
      on: new Date("2025-03-01T00:00:00.000Z"),
      subsystem: "NE",
    });
    expect(believedBefore.totalMw).toBeCloseTo(10, 6);
    expect(believedNow.totalMw).toBeCloseTo(30, 6);
  });

  it("reports a fleet date before go-live as revision-optimistic", async () => {
    const result = await readInstalledCapacityAsOf(db, {
      asOf: LATER,
      on: new Date("2024-06-01T00:00:00.000Z"),
    });
    expect(result.goLiveAt?.toISOString()).toBe(R1.toISOString());
    expect(result.vintageFidelity).toBe("revision_optimistic");
  });

  it("answers at plant grain for capacity weighting", async () => {
    const rows = await readPlantCapacityAsOf(db, {
      asOf: LATER,
      on: new Date("2026-01-01T00:00:00.000Z"),
      subsystem: "NE",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cegCore: TEST_PLANT,
      technology: "WIND",
      operationModality: "TIPO_II_C",
      units: 2,
      capacityMw: 30,
    });
  });

  it("writes nothing for an empty snapshot", async () => {
    expect(await write([], LATER)).toEqual({
      inserted: 0,
      revised: 0,
      unchanged: 0,
    });
  });
});

suite("registry · conjunto membership as of a date (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  const MOVER = "BAEABL";
  const FIRST = "CJU_TESTA";
  const SECOND = "CJU_TESTB";
  const INGESTED = new Date("2026-08-01T00:00:00.000Z");
  const ASOF = new Date("2026-09-01T00:00:00.000Z");

  beforeAll(async () => {
    await db.execute(sql`truncate table conjunto_membership`);
    await db.execute(sql`truncate table conjunto cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "usina_conjunto",
        resourceName: "Relacionamento_Usina_Conjunto",
        resourceUrl: "https://example.invalid/RELACIONAMENTO_USINA_CONJUNTO.csv",
        format: "CSV",
        changeKey: `membership-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";

    await upsertConjuntos(db, [
      {
        onsConjuntoCode: FIRST,
        name: "Conj. A",
        subsystem: "NE",
        stateCode: "BA",
        technology: "WIND",
        sourceTypeCode: "UEE",
      },
      {
        onsConjuntoCode: SECOND,
        name: "Conj. B",
        subsystem: "NE",
        stateCode: "BA",
        technology: "WIND",
        sourceTypeCode: "UEE",
      },
    ]);

    await writeConjuntoMemberships(db, {
      memberships: [
        {
          plantOnsCode: MOVER,
          plantCegCore: "EOL.CV.BA.031402-1",
          conjuntoCode: FIRST,
          memberFrom: new Date("2021-12-11T00:00:00.000Z"),
          memberTo: new Date("2024-10-29T00:00:00.000Z"),
        },
        {
          plantOnsCode: MOVER,
          plantCegCore: "EOL.CV.BA.031402-1",
          conjuntoCode: SECOND,
          memberFrom: new Date("2024-10-30T00:00:00.000Z"),
          memberTo: null,
        },
      ],
      publishedAt: INGESTED,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: INGESTED,
    });
  });

  afterAll(() => handle.close());

  it("returns exactly one conjunto for a plant on any given day", async () => {
    for (const on of ["2022-06-01", "2024-10-29", "2024-10-30", "2026-08-28"]) {
      const result = await readConjuntoMembershipAsOf(db, {
        asOf: ASOF,
        on: new Date(`${on}T00:00:00.000Z`),
        plantOnsCode: MOVER,
      });
      expect(result.rows).toHaveLength(1);
    }
  });

  it("honours member_to as the inclusive last day of membership", async () => {
    // Measured against the live file: the successor starts the next day, so
    // 2024-10-29 still belongs to the first conjunto. An exclusive reading
    // would leave that day unattributed.
    const lastDay = await readConjuntoMembershipAsOf(db, {
      asOf: ASOF,
      on: new Date("2024-10-29T00:00:00.000Z"),
      plantOnsCode: MOVER,
    });
    const nextDay = await readConjuntoMembershipAsOf(db, {
      asOf: ASOF,
      on: new Date("2024-10-30T00:00:00.000Z"),
      plantOnsCode: MOVER,
    });
    expect(lastDay.rows[0]?.conjuntoCode).toBe(FIRST);
    expect(nextDay.rows[0]?.conjuntoCode).toBe(SECOND);
  });

  it("attributes a plant to the conjunto it was in, not the one it is in", async () => {
    const midWindow = await readConjuntoMembershipAsOf(db, {
      asOf: ASOF,
      on: new Date("2024-05-01T00:00:00.000Z"),
      conjuntoCode: SECOND,
    });
    // The plant is in SECOND today; it was not in May 2024. A snapshot join
    // would report it here and misattribute two and a half years of history.
    expect(midWindow.rows).toEqual([]);
  });

  it("returns nothing before the membership began", async () => {
    const result = await readConjuntoMembershipAsOf(db, {
      asOf: ASOF,
      on: new Date("2021-12-10T00:00:00.000Z"),
      plantOnsCode: MOVER,
    });
    expect(result.rows).toEqual([]);
  });

  it("records a membership being closed as a revision, keeping the prior belief", async () => {
    const before = await readConjuntoMembershipAsOf(db, {
      asOf: ASOF,
      on: new Date("2026-08-28T00:00:00.000Z"),
      plantOnsCode: MOVER,
    });
    expect(before.rows[0]?.memberTo).toBeNull();

    const closedAt = new Date("2026-09-15T00:00:00.000Z");
    const revised = await writeConjuntoMemberships(db, {
      memberships: [
        {
          plantOnsCode: MOVER,
          plantCegCore: "EOL.CV.BA.031402-1",
          conjuntoCode: SECOND,
          memberFrom: new Date("2024-10-30T00:00:00.000Z"),
          memberTo: new Date("2026-09-10T00:00:00.000Z"),
        },
      ],
      publishedAt: closedAt,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: closedAt,
    });
    expect(revised).toEqual({ inserted: 0, revised: 1, unchanged: 0 });

    const after = await readConjuntoMembershipAsOf(db, {
      asOf: new Date("2026-10-01T00:00:00.000Z"),
      on: new Date("2026-09-11T00:00:00.000Z"),
      plantOnsCode: MOVER,
    });
    expect(after.rows).toEqual([]);
    // What we believed on 2026-09-01 is still answerable.
    expect(before.rows[0]?.dataVersion).toBe(1);
  });

  it("refuses a membership that ends before it starts, at the database", async () => {
    let caught: unknown;
    try {
      await db.execute(sql`
        insert into conjunto_membership (
          plant_ons_code, conjunto_code, member_from, member_to, data_version,
          published_at, published_at_precision, value_digest, source_version_id
        ) values (
          'BACKWARDS', ${FIRST},
          '2024-06-30T00:00:00Z'::timestamptz, '2024-01-01T00:00:00Z'::timestamptz, 1,
          now(), 'file', 'backwards-probe', ${sourceVersionId}::uuid
        )
      `);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe("conjunto_membership_ordered");
  });
});

/**
 * The registry job end to end on the real job runner, with the network stubbed
 * by the captured fixtures. Needs Postgres because what the job does *is* what
 * it writes.
 */
suite("ingestion job · ONS fleet registry (real Postgres, stub network)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  const FIXTURES = join(import.meta.dir, "fixtures", "ons");
  const CAPACITY_HEAD = {
    "last-modified": "Fri, 28 Aug 2026 22:00:39 GMT",
    "content-length": "1277484",
    etag: '"39f066df4ed00307ca98b1adaf2dadfe"',
  };
  const BRIDGE_HEAD = {
    "last-modified": "Fri, 28 Aug 2026 22:04:55 GMT",
    "content-length": "325169",
    etag: '"e2426c37974df3a25d97c8e462fc7086"',
  };

  let requests: string[] = [];

  const isBridge = (url: string) => url.includes("USINA_CONJUNTO");

  const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("package_show")) {
      const file = url.includes("usina_conjunto")
        ? "package-show-usina_conjunto.json"
        : "package-show-capacidade-geracao.json";
      return new Response(await Bun.file(join(FIXTURES, file)).text(), {
        headers: { "content-type": "application/json" },
      });
    }
    const headers = isBridge(url) ? BRIDGE_HEAD : CAPACITY_HEAD;
    if (init?.method === "HEAD") {
      return new Response(null, { headers });
    }
    const file = isBridge(url)
      ? "RELACIONAMENTO_USINA_CONJUNTO.registry.csv"
      : "CAPACIDADE_GERACAO.registry.csv";
    return new Response(await Bun.file(join(FIXTURES, file)).arrayBuffer(), { headers });
  }) as typeof fetch;

  beforeAll(async () => {
    await db.execute(sql`truncate table generating_unit`);
    await db.execute(sql`truncate table conjunto_membership`);
    await db.execute(sql`truncate table plant cascade`);
    await db.execute(sql`truncate table conjunto cascade`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
  });
  afterAll(() => handle.close());

  it("ingests both halves of the registry through the job runner", async () => {
    requests = [];
    const runner = createInProcessRunner(
      createPlantRegistryIngestor({ db, fetch: stubFetch }),
    );
    const id = await runner.submit({});

    let record = await runner.status(id);
    for (let i = 0; i < 600 && record?.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = await runner.status(id);
    }
    await runner.close();

    expect(record?.status).toBe("completed");
    expect(record?.result).toMatchObject({
      changed: true,
      downloaded: true,
      // 37 fixture lines: one header, seven hydro/thermal/nuclear, 29 VRE units.
      unitRowsParsed: 29,
      unitRowsRejected: 0,
      outOfScopeRowsFiltered: 7,
      inconsistentUnitDates: 3,
      plantsSeen: 9,
      membershipRowsParsed: 15,
      membershipRowsRejected: 0,
      conjuntosSeen: 6,
      // DELTA 3 I and II appear in both files, so both acquire an ONS code.
      plantCodesLinked: 2,
      // EOL.CV.RN.047240-9 is RNST6 *and* RNST06; neither is guessed.
      plantCodesAmbiguous: 1,
    });
  }, 60_000);

  it("recovers the ONS plant code the capacity file does not carry", async () => {
    const rows = await db.execute<{ ceg_core: string; ons_plant_code: string | null }>(
      sql`select ceg_core, ons_plant_code from plant order by ceg_core`,
    );
    const byCore = new Map([...rows].map((row) => [row.ceg_core, row.ons_plant_code]));
    expect(byCore.get("EOL.CV.MA.033682-3")).toBe("MAEDT1");
    // No conjunto membership names this Tipo I plant, so its ONS code is
    // genuinely unknown — null, rather than a name-based guess.
    expect(byCore.get("EOL.CV.CE.028699-0")).toBeNull();
  });

  it("detects an unchanged snapshot without downloading either file", async () => {
    requests = [];
    const ingest = createPlantRegistryIngestor({ db, fetch: stubFetch });
    const result = await ingest({}, () => {});

    expect(result).toMatchObject({ changed: false, downloaded: false });
    // Two catalogue calls and two HEADs. No GET of either file.
    expect(requests.filter((request) => request.startsWith("GET https://ons"))).toEqual(
      [],
    );
    expect(requests.filter((request) => request.startsWith("HEAD"))).toHaveLength(2);
  }, 60_000);

  it("re-parsing the same snapshot writes no new version", async () => {
    const ingest = createPlantRegistryIngestor({ db, fetch: stubFetch });
    const result = await ingest({ force: true }, () => {});
    expect(result.downloaded).toBe(true);
    expect(result.units).toEqual({ inserted: 0, revised: 0, unchanged: 29 });
    expect(result.memberships).toEqual({ inserted: 0, revised: 0, unchanged: 15 });
  }, 60_000);

  it("answers the fleet build-up from the ingested snapshot", async () => {
    const asOf = new Date("2027-01-01T00:00:00.000Z");
    const atWindowOpen = await readInstalledCapacityAsOf(db, {
      asOf,
      on: new Date("2024-04-01T00:00:00.000Z"),
    });
    const today = await readInstalledCapacityAsOf(db, {
      asOf,
      on: new Date("2026-08-28T00:00:00.000Z"),
    });
    // SERRA DAS ALMAS I and II commission in 2025, so the fixture fleet grows.
    expect(today.totalMw).toBeGreaterThan(atWindowOpen.totalMw);
    // And the SE-assigned Bahia plants are in SE, where ONS put them.
    expect(today.groups.some((group) => group.subsystem === "SE")).toBe(true);
  });
});

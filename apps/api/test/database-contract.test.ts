import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import {
  readCurtailment,
  readDayAheadBalance,
  readOnly,
  readPlantMeasurements,
  readSystemContext,
  readTrainingWindow,
} from "../src/contract/index.js";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  type CurtailmentReportHour,
  type DessemBalanceHalfHour,
  type EnergyBalanceHour,
  upsertReportingEntities,
  writeCurtailment,
  writeDessemBalance,
  writeEnergyBalance,
} from "../src/ingest/index.js";

// Seam 2 for the canonical read contract — the claims that are only true of a
// real database, gated exactly as the other `database-*.test.ts` suites are.
//
// Three of them cannot be proved anywhere else: that an as-of read returns
// exactly one row per business key across a revision, that a window straddling
// go-live is reported as revision-optimistic, and that the contract's
// transaction genuinely refuses a write rather than merely intending to.
//
// Spin one up:
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:17-alpine
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** A window of this suite's own, so a repeated run cannot collide with itself. */
const HOUR_ONE = new Date("2024-07-01T03:00:00.000Z");
const HOUR_TWO = new Date("2024-07-01T04:00:00.000Z");
const WINDOW_FROM = new Date("2024-07-01T00:00:00.000Z");
const WINDOW_TO = new Date("2024-07-02T00:00:00.000Z");
const ENTITY = "CJU_CONTRACT";

/** Ingest instants: the go-live, a later revision, and a read-time far ahead. */
const GO_LIVE = new Date("2026-04-01T00:00:00.000Z");
const REVISED_AT = new Date("2026-05-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

const report = (
  validTime: Date,
  constrainedOffMwh: number,
  cause: CurtailmentReportHour["cause"] = null,
): CurtailmentReportHour => ({
  reportingEntityCode: ENTITY,
  technology: "WIND",
  validTime,
  generationMwh: 100,
  constrainedOffMwh,
  referenceGenerationMwh: 150,
  finalReferenceGenerationMwh: null,
  availabilityMw: 200,
  halfHoursObserved: 2,
  cause,
  causeMixed: false,
});

const balance = (validTime: Date, loadMwh: number): EnergyBalanceHour => ({
  subsystem: "NE",
  validTime,
  loadMwh,
  hydroGenerationMwh: 1,
  thermalGenerationMwh: 2,
  windGenerationMwh: 3,
  solarGenerationMwh: 4,
  netExchangeMwh: 5,
});

/** D−1 evening, so the row is structurally a forecast of `HOUR_ONE`. */
const DESSEM_PUBLISHED = new Date("2024-06-30T21:00:00.000Z");
const REFERENCE_DAY = "2024-07-01";

const dessem = (validTime: Date, demandMw: number): DessemBalanceHalfHour => ({
  subsystem: "NE",
  validTime,
  referenceDay: REFERENCE_DAY,
  demandMw,
  hydroGenerationMw: 1,
  smallHydroGenerationMw: 2,
  thermalGenerationMw: 3,
  smallThermalGenerationMw: 4,
  windGenerationMw: 5,
  solarGenerationMw: 6,
  mmgdGenerationMw: 7,
  pumpingConsumptionMw: 8,
});

suite("canonical read contract (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    await db.execute(sql`truncate table curtailment_report_hour`);
    await db.execute(sql`truncate table subsystem_energy_balance_hour`);
    await db.execute(sql`truncate table dessem_balance_half_hour`);
    await db.execute(sql`truncate table plant_detail_hour`);
    await db.execute(sql`truncate table reporting_entity cascade`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "restricao_coff_eolica_conj",
        resourceName: "Restricoes_coff_eolicas-2024-07",
        resourceUrl: "https://example.invalid/CONTRACT_2024_07.csv",
        format: "CSV",
        changeKey: `contract-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";

    await upsertReportingEntities(db, [
      {
        onsCode: ENTITY,
        kind: "CONJUNTO",
        cegCore: null,
        name: "CONJ. CONTRACT",
        subsystem: "NE",
        stateCode: "BA",
      },
    ]);

    const stamp = (ingestedAt: Date, publishedAt: Date) => ({
      publishedAt,
      publishedAtPrecision: "file" as const,
      sourceVersionId,
      ingestedAt,
    });

    // Two hours at go-live, then one of them restated. The restatement is what
    // makes "exactly one row per key" a claim worth checking.
    await writeCurtailment(db, {
      rows: [
        report(HOUR_ONE, 10, { reason: "CNF", origin: "LOC", description: "line 1" }),
        report(HOUR_TWO, 20),
      ],
      ...stamp(GO_LIVE, new Date("2024-07-05T00:00:00.000Z")),
    });
    await writeCurtailment(db, {
      rows: [
        report(HOUR_ONE, 11, { reason: "ENE", origin: "SIS", description: "line 1" }),
      ],
      ...stamp(REVISED_AT, new Date("2024-08-05T00:00:00.000Z")),
    });

    await writeEnergyBalance(db, {
      rows: [balance(HOUR_ONE, 500), balance(HOUR_TWO, 600)],
      ...stamp(GO_LIVE, new Date("2024-07-05T00:00:00.000Z")),
    });

    await writeDessemBalance(db, {
      rows: [dessem(HOUR_ONE, 700)],
      ...stamp(GO_LIVE, DESSEM_PUBLISHED),
    });
  });

  afterAll(() => handle.close());

  const window = (asOf: Date) => ({ asOf, from: WINDOW_FROM, to: WINDOW_TO });

  it("returns exactly one row per business key at each as-of", async () => {
    const atGoLive = await readCurtailment(db, window(GO_LIVE));
    const now = await readCurtailment(db, window(NOW));

    for (const result of [atGoLive, now]) {
      const keys = result.rows.map(
        (row) =>
          `${row.reportingEntityCode}|${row.technology}|${row.validTime.toISOString()}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toHaveLength(2);
    }

    // The earlier as-of still holds the earlier belief. Nothing was destroyed.
    const before = atGoLive.rows.find(
      (row) => row.validTime.getTime() === HOUR_ONE.getTime(),
    );
    const after = now.rows.find((row) => row.validTime.getTime() === HOUR_ONE.getTime());
    expect(before?.constrainedOffMwh).toBe(10);
    expect(after?.constrainedOffMwh).toBe(11);
    expect(after?.dataVersion).toBe(2);
  });

  it("speaks the domain model's names, not the ingest layer's", async () => {
    const { rows } = await readCurtailment(db, window(NOW));
    const row = rows[0];
    expect(row).toBeDefined();
    // `generationMwh` and `availabilityMw` upstream; §4 names them these.
    expect(row?.verifiedGenerationMwh).toBe(100);
    expect(row?.availableCapacityMw).toBe(200);
    expect(Object.keys(row ?? {})).not.toContain("generationMwh");
    expect(Object.keys(row ?? {})).not.toContain("availabilityMw");
  });

  it("carries the restriction cause as a whole value, at the grain it exists", async () => {
    const { rows } = await readCurtailment(db, window(NOW));
    const row = rows.find((r) => r.validTime.getTime() === HOUR_ONE.getTime());
    expect(row?.restrictionCause).toEqual({
      reason: "ENE",
      origin: "SIS",
      description: "line 1",
    });
    // The other hour had none — absent as a whole rather than half-filled.
    const uncaused = rows.find((r) => r.validTime.getTime() === HOUR_TWO.getTime());
    expect(uncaused?.restrictionCause).toBeNull();
  });

  it("offers no cause at all at plant grain, even with rows present", async () => {
    const result = await readPlantMeasurements(db, window(NOW));
    expect(result.read).toBe("curtailment-by-plant");
    for (const row of result.rows) {
      expect(Object.keys(row)).not.toContain("restrictionCause");
    }
  });

  it("names the run behind a forecast and never behind an observation", async () => {
    const forecast = await readDayAheadBalance(db, window(NOW));
    expect(forecast.kind).toBe("forecast");
    const row = forecast.rows[0];
    expect(row?.origin).toEqual({
      producer: "ons_dessem",
      runLabel: REFERENCE_DAY,
      publishedAt: DESSEM_PUBLISHED,
    });
    // The structural discriminator: a forecast is published before the instant
    // it describes, and it is the only kind of row with an origin.
    expect(row?.origin.publishedAt.getTime()).toBeLessThan(
      row?.validTime.getTime() as number,
    );

    const observation = await readSystemContext(db, window(NOW));
    expect(observation.kind).toBe("observation");
    for (const observed of observation.rows) {
      expect(Object.keys(observed)).not.toContain("origin");
      expect(observed.publishedAt.getTime()).toBeGreaterThan(
        observed.validTime.getTime(),
      );
    }
  });

  it("flags a window that predates ingestion go-live as revision-optimistic", async () => {
    // The valid-time window is 2024-07; ingestion went live in 2026. Everything
    // this read returns is ONS's *current* restatement of that week.
    const backfilled = await readSystemContext(db, window(NOW));
    expect(backfilled.vintage.vintageFidelity).toBe("revision_optimistic");
    expect(backfilled.vintage.goLiveAt?.getTime()).toBe(GO_LIVE.getTime());
    expect(backfilled.vintage.asOf).toEqual(NOW);
    expect(backfilled.vintage.window).toEqual({ from: WINDOW_FROM, to: WINDOW_TO });
    expect(backfilled.vintage.sources).toEqual([
      {
        read: "system-context",
        vintageFidelity: "revision_optimistic",
        goLiveAt: GO_LIVE,
      },
    ]);
  });

  it("flags a window that post-dates go-live as point-in-time", async () => {
    const live = await readSystemContext(db, {
      asOf: NOW,
      from: new Date("2026-04-02T00:00:00.000Z"),
      to: new Date("2026-04-03T00:00:00.000Z"),
    });
    expect(live.rows).toHaveLength(0);
    // Empty and honest: the window is after go-live, so an absence of rows is
    // an absence of curtailment rather than an absence of knowledge.
    expect(live.vintage.vintageFidelity).toBe("point_in_time");
  });

  it("gives a composed window one receipt, degraded by its weakest source", async () => {
    const bundle = await readTrainingWindow(db, window(NOW));
    // Seven sources, one per family read.
    expect(bundle.vintage.sources).toHaveLength(7);
    expect(bundle.vintage.vintageFidelity).toBe("revision_optimistic");
    // Weather and the exchange have ingested nothing in this suite, so there is
    // no instant from which the *whole* window would have been knowable.
    expect(bundle.vintage.goLiveAt).toBeNull();
    expect(bundle.curtailment.rows).toHaveLength(2);
    expect(bundle.systemContext.rows).toHaveLength(2);
    expect(bundle.dayAheadBalance.rows).toHaveLength(1);
    // The fleet date defaults to the window start rather than its end.
    expect(bundle.vintage.fleetDate).toEqual(WINDOW_FROM);
  });

  /**
   * The SQLSTATE Postgres raises, dug out of the driver error Drizzle wraps.
   *
   * Asserting on the code rather than the message: `25006
   * read_only_sql_transaction` is the guarantee, and a message is a locale and
   * a version away from changing.
   */
  const sqlStateOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
    } catch (error) {
      return (error as { cause?: { code?: string } }).cause?.code ?? String(error);
    }
    return "no error was thrown";
  };

  it("refuses a write from inside a contract read, at the database", async () => {
    // The guarantee that does not depend on anyone remembering it: Postgres
    // refuses, not a lint rule and not a code review.
    const state = await sqlStateOf(() =>
      readOnly(db, async (tx) => {
        await tx.execute(
          sql`insert into reporting_entity (ons_code, kind, name, subsystem, state_code)
              values ('CJU_NOPE', 'CONJUNTO', 'nope', 'NE', 'BA')`,
        );
      }),
    );
    expect(state).toBe("25006");

    const survivors = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from reporting_entity where ons_code = 'CJU_NOPE'`,
    );
    expect([...survivors][0]?.count).toBe(0);
  });

  it("refuses DDL from inside a contract read too — no migration rights", async () => {
    const state = await sqlStateOf(() =>
      readOnly(db, async (tx) => {
        await tx.execute(sql`create table contract_should_not_exist (id int)`);
      }),
    );
    expect(state).toBe("25006");
  });
});

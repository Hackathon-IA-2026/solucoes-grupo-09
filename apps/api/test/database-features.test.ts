import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Database } from "../src/database/connection.js";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  FEATURE_ROW_COLUMNS,
  type FeatureRow,
  isFeatureColumn,
  readFeatureRows,
  readServingRows,
} from "../src/features/index.js";
import {
  type CurtailmentReportHour,
  type RegistryGeneratingUnit,
  type RegistryPlant,
  recordWeatherRunRequest,
  upsertPlants,
  upsertReportingEntities,
  type WeatherForecastHour,
  writeCurtailment,
  writeGeneratingUnits,
  writeWeatherForecast,
} from "../src/ingest/index.js";

// The gate, against a real Postgres — where the two acceptance seams live.
//
// Everything that can be asserted without a database is in
// `features-gate.test.ts`, and it is the more important half: it asserts that a
// leaky feature cannot be *written*. This file asserts that the one feature
// which exists is not leaking, and it does so generically — the ablation
// compares every column it finds rather than the columns it was told about, so
// the twelve tickets behind this one inherit the test rather than each writing
// their own.
//
// Spin one up:
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:17-alpine
const TEST_DATABASE_URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** A past target date of this suite's own, so a repeated run cannot collide. */
const TARGET = "2026-08-20";
/** `gate_at('2026-08-20', 'gate_late')` — D−1 19:00 BRT. */
const GATE_LATE = new Date("2026-08-19T22:00:00.000Z");
/** A later target date, after every go-live in the fixture. */
const AFTER_GO_LIVE = "2026-08-27";

/** The local civil day of `TARGET`, in UTC. Brasília is UTC−3 all year. */
const DAY_FROM = new Date("2026-08-20T03:00:00.000Z");
const HOUR_CURTAILED = new Date("2026-08-20T12:00:00.000Z");
const HOUR_QUIET = new Date("2026-08-20T13:00:00.000Z");

const ENTITY = "CJU_FE01";
const CENTROID_A = "FE01_A";
const CENTROID_B = "FE01_B";

/**
 * The D−1 12Z run: published *before* the late gate, so a feature may see it.
 */
const RUN_BEFORE_GATE = new Date("2026-08-19T12:00:00.000Z");
/**
 * The D 00Z run: published *after* the late gate, and the newest run in the
 * store. Whatever it says must be invisible to a `TARGET` feature — and it is
 * the newest, so an as-of read alone would happily return it.
 */
const RUN_AFTER_GATE = new Date("2026-08-20T00:00:00.000Z");

/**
 * Both runs were ingested at one instant, long before either was published.
 *
 * That is not a mistake in the fixture; it is the backfill window, and it is
 * the whole reason the gate cuts on `published_at`. Over history every row
 * shares one `ingested_at`, so `AsOf(gate)` filters *nothing* and only the
 * publication cut is doing any work. A fixture that gave the two runs honest
 * ingestion instants would let the as-of hide a broken gate.
 */
const WEATHER_INGESTED_AT = new Date("2026-08-01T00:00:00.000Z");

/**
 * The fleet, and the four dates that make the double as-of visible.
 *
 * `InstalledCapacityAsOf` takes two times and they are not interchangeable, so
 * the fixture has to be able to tell a wrong answer on either axis from a right
 * one — which means a unit that moves each axis independently:
 *
 * | unit | MW | commissioned | ONS recorded it | in `TARGET`'s row? |
 * |---|---|---|---|---|
 * | `UG1` | 100 | 2024-01-15 | before the gate | yes, and at D−28 too |
 * | `UG2` | 40 | 2026-08-05 | before the gate | yes — inside the 28 days |
 * | `UG3` | 7 | **2026-08-20** | before the gate | yes at D, **no at D−1** |
 * | `UG4` | 500 | 2024-01-15 | **after the gate** | **no** — unknowable then |
 *
 * `UG4` is the vintage trap and it is deliberately enormous: it is the newest
 * row in the table and would dominate the number, so a read that forgot the
 * vintage axis cannot produce the expected value by accident.
 */
const PLANT_WIND = "EOL.FG.BA.000901-1";
const PLANT_SOLAR = "UFV.FG.BA.000902-9";

/** Before the late gate of every target date this suite asks about. */
const REGISTRY_INGESTED_AT = new Date("2026-08-01T00:00:00.000Z");
/** After `TARGET`'s gate (D−1 19:00 BRT = 22:00Z) and before the next day's. */
const REGISTRY_LATE_INGEST = new Date("2026-08-19T23:00:00.000Z");

/** D−1: the day before `TARGET`, whose fleet must not contain `UG3`. */
const TARGET_MINUS_1 = "2026-08-19";

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
): RegistryGeneratingUnit => ({
  plantCegCore,
  equipmentCode,
  unitNumber: equipmentCode.slice(-1),
  name: `UG ${equipmentCode}`,
  ratedPowerMw,
  testEntryOn: null,
  commissionedOn: new Date(`${commissionedOn}T00:00:00.000Z`),
  // Never set. ONS records zero VRE deactivations across the window and the
  // assumption is asserted at ingest by `findRenewableDeactivations` rather
  // than modelled here — see `0017_capacity_at_the_gate.sql`.
  decommissionedOn: null,
});

/** The labels arrive after the fact, which is what makes them labels. */
const LABEL_PUBLISHED_AT = new Date("2026-08-25T00:00:00.000Z");
const LABEL_INGESTED_AT = new Date("2026-08-26T00:00:00.000Z");

const weatherHour = (
  centroidId: string,
  validTime: Date,
  runInitTime: Date,
  temperature2mC: number,
): WeatherForecastHour => ({
  centroidId,
  validTime,
  gridLatitude: -10,
  gridLongitude: -41,
  gridElevationM: 500,
  runInitTime,
  runCycle: runInitTime.getUTCHours() === 12 ? "12Z" : "00Z",
  runAgeHours: 0,
  windSpeed100mKmh: 30,
  windSpeed120mKmh: 32,
  windDirection120mDeg: 90,
  windGusts10mKmh: 40,
  temperature2mC,
  surfacePressureHpa: 1010,
  relativeHumidity2mPct: 60,
  precipitationMm: 0,
  shortwaveRadiationWm2: 500,
  directNormalIrradianceWm2: 600,
  diffuseRadiationWm2: 100,
  cloudCoverPct: 10,
});

/** Twenty-four hours of the target's local day, at both centroids. */
const runRows = (runInitTime: Date, base: number): WeatherForecastHour[] => {
  const rows: WeatherForecastHour[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const validTime = new Date(DAY_FROM.getTime() + hour * 3_600_000);
    rows.push(weatherHour(CENTROID_A, validTime, runInitTime, base - 2));
    rows.push(weatherHour(CENTROID_B, validTime, runInitTime, base + 2));
  }
  return rows;
};

const report = (
  validTime: Date,
  technology: "WIND" | "SOLAR",
  constrainedOffMwh: number,
): CurtailmentReportHour => ({
  reportingEntityCode: ENTITY,
  technology,
  validTime,
  verifiedGenerationMwh: 100,
  constrainedOffMwh,
  referenceGenerationMwh: 150,
  finalReferenceGenerationMwh: null,
  availableCapacityMw: 200,
  halfHoursObserved: 2,
  cause: null,
  causeMixed: false,
});

/** Column-by-column, `null` and `undefined` included, dates comparable. */
const comparable = (row: FeatureRow): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const column of FEATURE_ROW_COLUMNS) {
    const value = row[column];
    out[column] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
};

const keyOf = (row: FeatureRow): string =>
  `${row.subsystem}|${new Date(row.valid_time).toISOString()}`;

/**
 * The SQLSTATE a statement failed with, from under Drizzle's wrapper.
 *
 * The code and not the message: `22023` is the contract ticket 016 established
 * for "you did not say which vintage", and this ticket raises the same one for
 * "you did not say which gate". A test matching on prose would pass a rewrite
 * that quietly stopped raising.
 */
const sqlStateOf = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^\d{5}$/.test(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

const featuresOnly = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([column]) => isFeatureColumn(column)));

suite("the gate, end to end (real Postgres)", () => {
  const handle = createDatabase(TEST_DATABASE_URL as string, 5);
  const { db } = handle;

  const query = {
    gateProfile: "gate_late",
    featureSet: "dessem_free_v1",
    thresholdMw: 5,
  } as const;

  beforeAll(async () => {
    await db.execute(sql`truncate table weather_forecast_hour`);
    await db.execute(sql`truncate table weather_run_request cascade`);
    await db.execute(sql`truncate table curtailment_report_hour`);
    await db.execute(sql`truncate table reporting_entity cascade`);
    // The units, not the plants: `plant` cascades into three other suites'
    // fixtures, and a plant with no live units contributes no capacity anyway.
    await db.execute(sql`truncate table generating_unit`);
    await db.execute(sql`truncate table ons_resource_version cascade`);

    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "restricao_coff_eolica_conj",
        resourceName: "Restricoes_coff_eolicas-2026-08",
        resourceUrl: "https://example.invalid/FEATURES_2026_08.csv",
        format: "CSV",
        changeKey: `features-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });

    await upsertReportingEntities(db, [
      {
        onsCode: ENTITY,
        kind: "CONJUNTO",
        cegCore: null,
        name: "CONJ. FEATURE GATE",
        subsystem: "NE",
        stateCode: "BA",
      },
    ]);

    await writeCurtailment(db, {
      rows: [
        report(HOUR_CURTAILED, "WIND", 8),
        report(HOUR_CURTAILED, "SOLAR", 4),
        report(HOUR_QUIET, "WIND", 1),
        report(HOUR_QUIET, "SOLAR", 0),
      ],
      publishedAt: LABEL_PUBLISHED_AT,
      publishedAtPrecision: "file",
      sourceVersionId: version?.id ?? "",
      ingestedAt: LABEL_INGESTED_AT,
    });

    const [registryVersion] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "capacidade-geracao",
        resourceName: "Capacidade_Geracao",
        resourceUrl: "https://example.invalid/FEATURES_CAPACIDADE.csv",
        format: "CSV",
        changeKey: `features-capacity-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });

    await upsertPlants(db, [
      registryPlant(PLANT_WIND),
      registryPlant(PLANT_SOLAR, { technology: "SOLAR" }),
    ]);

    const writeUnits = (units: RegistryGeneratingUnit[], ingestedAt: Date) =>
      writeGeneratingUnits(db, {
        units,
        publishedAt: ingestedAt,
        publishedAtPrecision: "file",
        sourceVersionId: registryVersion?.id ?? "",
        ingestedAt,
      });

    // What ONS had recorded before the gate.
    await writeUnits(
      [
        registryUnit(PLANT_WIND, "UG1", 100, "2024-01-15"),
        registryUnit(PLANT_WIND, "UG2", 40, "2026-08-05"),
        registryUnit(PLANT_WIND, "UG3", 7, TARGET),
        registryUnit(PLANT_SOLAR, "UG5", 30, "2024-01-15"),
        registryUnit(PLANT_SOLAR, "UG6", 10, "2026-08-10"),
      ],
      REGISTRY_INGESTED_AT,
    );
    // …and what it recorded after it. Commissioned long before the window, so
    // only the vintage axis can keep it out.
    await writeUnits(
      [registryUnit(PLANT_WIND, "UG4", 500, "2024-01-15")],
      REGISTRY_LATE_INGEST,
    );

    // Order matters: the store keeps the newest run per hour, so the pre-gate
    // run has to land first or it would be discarded as superseded.
    for (const [runInit, base] of [
      [RUN_BEFORE_GATE, 20],
      [RUN_AFTER_GATE, 30],
    ] as const) {
      const requestId = await recordWeatherRunRequest(db, {
        runInit,
        centroidCount: 2,
        forecastDays: 3,
        rowCount: 48,
        response: {
          url: "https://single-runs-api.open-meteo.invalid/v1/forecast",
          httpStatus: 200,
          body: `{"run":"${runInit.toISOString()}"}`,
          rateLimitRetries: 0,
          fetchedAt: WEATHER_INGESTED_AT,
        },
      });
      await writeWeatherForecast(db, {
        rows: runRows(runInit, base),
        sourceVersionId: requestId,
        ingestedAt: WEATHER_INGESTED_AT,
      });
    }
  });

  afterAll(() => handle.close());

  it("returns the calendar's rows, not the data's", async () => {
    // Four subsystems by twenty-four local hours, from the enum and the
    // calendar. A subsystem-hour with no weather and no settled label is still
    // a row — a hole the model can see rather than an absence it cannot.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    expect(rows).toHaveLength(96);
    expect(new Set(rows.map((row) => row.subsystem))).toEqual(
      new Set(["N", "NE", "S", "SE"]),
    );
    expect(new Set(rows.map((row) => keyOf(row))).size).toBe(96);
  });

  it("stamps every row with what it was allowed to see", async () => {
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    for (const row of rows) {
      expect(row.gate_profile).toBe("gate_late");
      expect(new Date(row.gate_at).toISOString()).toBe(GATE_LATE.toISOString());
      expect(row.feature_set).toBe("dessem_free_v1");
      expect(Number(row.threshold_mw)).toBe(5);
      expect(String(row.target_date)).toContain(TARGET);
    }
  });

  it("cuts the weather feature on publication, not on ingestion", async () => {
    // The 00Z run of day D is in the table, is the newest version of every one
    // of these hours, and was ingested at the same instant as the 12Z run — so
    // an as-of read alone returns it. Only `published_at <= gate` does not.
    const [{ post_gate_rows }] = [
      ...(await db.execute<{ post_gate_rows: number }>(sql`
        select count(*)::int as post_gate_rows from weather_forecast_hour
        where published_at > ${GATE_LATE.toISOString()}::timestamptz
      `)),
    ] as [{ post_gate_rows: number }];
    expect(post_gate_rows).toBeGreaterThan(0);

    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const values = new Set(rows.map((row) => row.weather_temperature_2m));
    expect(values).toEqual(new Set([20]));
  });

  it("reads the fleet as of the target date, at the gate's vintage", async () => {
    // The double as-of, both halves at once. 100 + 40 + 7 = 147 MW of wind:
    // `UG3` commissioned on D counts, and `UG4` — 500 MW, commissioned in 2024,
    // recorded by ONS an hour after the gate — does not.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");
    expect(ne).toHaveLength(24);
    for (const row of ne) {
      expect(Number(row.capacity_wind_mw)).toBe(147);
      expect(Number(row.capacity_solar_mw)).toBe(40);
    }

    // Non-vacuous: the post-gate row really is in the table, really is the
    // newest thing there, and really would dominate the answer.
    const [{ post_gate_units }] = [
      ...(await db.execute<{ post_gate_units: number }>(sql`
        select count(*)::int as post_gate_units from generating_unit
        where ingested_at > ${GATE_LATE.toISOString()}::timestamptz
      `)),
    ] as [{ post_gate_units: number }];
    expect(post_gate_units).toBeGreaterThan(0);

    // A subsystem with no units is zero and not null: the registry covers the
    // whole VRE fleet, so "no group" means "nothing commissioned yet".
    const elsewhere = rows.find((row) => row.subsystem === "S");
    expect(Number(elsewhere?.capacity_wind_mw)).toBe(0);
    expect(Number(elsewhere?.capacity_solar_mw)).toBe(0);
  });

  it("leaves a unit commissioned on D out of D−1's row", async () => {
    // The valid-time half. `UG3` enters service on 2026-08-20, so the row for
    // 2026-08-19 is 140 MW and the row for 2026-08-20 is 147 — the seven
    // megawatts appear on the day the unit does, and not a day earlier.
    const dayBefore = await readServingRows(db, {
      targetDate: TARGET_MINUS_1,
      ...query,
    });
    const ne = dayBefore.filter((row) => row.subsystem === "NE");
    expect(ne.length).toBeGreaterThan(0);
    for (const row of ne) {
      expect(Number(row.capacity_wind_mw)).toBe(140);
    }
  });

  it("leaves a unit ONS recorded after the gate out of that row", async () => {
    // The vintage half, on its own. `UG4` is invisible at `TARGET`'s gate and
    // visible at a later date's, and nothing about the unit changed in between
    // — only what WattSteer had been told.
    const later = await readServingRows(db, { targetDate: AFTER_GO_LIVE, ...query });
    const ne = later.find((row) => row.subsystem === "NE");
    // 147 + 500: the same fleet, a week later, with the late snapshot now
    // inside the gate.
    expect(Number(ne?.capacity_wind_mw)).toBe(647);
  });

  it("derives the 28-day addition from the same double as-of", async () => {
    // D−28 is 2026-07-23: `UG1` (100 MW) and `UG5` (30 MW) were live, `UG2`,
    // `UG3` and `UG6` were not. Both reads are at the gate's vintage, so the
    // difference is an addition rather than two vintages subtracted.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");
    for (const row of ne) {
      expect(Number(row.capacity_wind_added_28d_mw)).toBe(47);
      expect(Number(row.capacity_solar_added_28d_mw)).toBe(10);
    }
    const elsewhere = rows.find((row) => row.subsystem === "S");
    expect(Number(elsewhere?.capacity_wind_added_28d_mw)).toBe(0);
  });

  it("broadcasts capacity identically across the 24 hours of the day", async () => {
    // Day grain, and the reason the dictionary marks it: the row is hourly and
    // this column is not, so a modeller who reads it as an hourly signal will
    // find intraday structure in a constant.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    for (const subsystem of ["N", "NE", "S", "SE"]) {
      const values = new Set(
        rows
          .filter((row) => row.subsystem === subsystem)
          .map((row) => Number(row.capacity_wind_mw)),
      );
      expect({ subsystem, distinct: values.size }).toEqual({ subsystem, distinct: 1 });
    }
  });

  it("carries the targets, and derives the positive class from the argument", async () => {
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const at = (validTime: Date): FeatureRow => {
      const found = rows.find(
        (row) =>
          row.subsystem === "NE" &&
          new Date(row.valid_time).getTime() === validTime.getTime(),
      );
      expect(found).toBeDefined();
      return found as FeatureRow;
    };

    const curtailed = at(HOUR_CURTAILED);
    expect(curtailed.y_constrained_off_wind_mwh).toBe(8);
    expect(curtailed.y_constrained_off_solar_mwh).toBe(4);
    expect(curtailed.y_constrained_off_total_mwh).toBe(12);
    expect(curtailed.y_has_curtailment).toBe(true);
    expect(curtailed.y_magnitude_mwh).toBe(12);

    const quiet = at(HOUR_QUIET);
    expect(quiet.y_constrained_off_total_mwh).toBe(1);
    expect(quiet.y_has_curtailment).toBe(false);
    // The magnitude is the label *where* there is curtailment, and null is the
    // honest answer everywhere else.
    expect(quiet.y_magnitude_mwh).toBeNull();

    // A subsystem with nothing settled is null, not zero: "no curtailment was
    // reported" and "this hour has not been settled" are different statements.
    const other = rows.find(
      (row) =>
        row.subsystem === "S" &&
        new Date(row.valid_time).getTime() === HOUR_CURTAILED.getTime(),
    );
    expect(other?.y_constrained_off_total_mwh).toBeNull();
    expect(other?.y_has_curtailment).toBeNull();
  });

  it("moves the positive class with the threshold, without moving anything else", async () => {
    // Derived inside the function and never stored, so two consumers cannot
    // hold disagreeing thresholds — and the >1 / >5 / >10 sweep costs a
    // parameter rather than a rebuild.
    const loose = await readServingRows(db, {
      targetDate: TARGET,
      ...query,
      thresholdMw: 0.5,
    });
    const quiet = loose.find(
      (row) =>
        row.subsystem === "NE" &&
        new Date(row.valid_time).getTime() === HOUR_QUIET.getTime(),
    );
    expect(quiet?.y_has_curtailment).toBe(true);
    expect(quiet?.y_magnitude_mwh).toBe(1);
  });

  it("reports a window predating go-live as revision_optimistic", async () => {
    const before = await readServingRows(db, { targetDate: TARGET, ...query });
    for (const row of before) {
      expect(row.vintage_fidelity).toBe("revision_optimistic");
    }

    // A target date after every source's go-live is honestly point-in-time,
    // even though it has no rows in either source — fidelity is a claim about
    // what WattSteer was watching, not about what it found.
    const after = await readServingRows(db, { targetDate: AFTER_GO_LIVE, ...query });
    for (const row of after) {
      expect(row.vintage_fidelity).toBe("point_in_time");
    }
  });

  it("counts the registry's go-live in the fidelity stamp, not just the hourly sources", async () => {
    // The capacity caveat, made a property. Over the backfill window a registry
    // snapshot is today's record of the past, so a row whose capacity had to be
    // answered from one cannot claim to be point-in-time — and the weakest-link
    // rule is what carries that up to the row.
    //
    // The other two sources are held still and only the registry's go-live is
    // moved, so a stamp that ignored capacity would keep saying point_in_time.
    let stamped: string | undefined;
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await scoped.execute(
          sql`update generating_unit set ingested_at = '2026-09-15T00:00:00.000Z'`,
        );
        const rows = await readServingRows(scoped, {
          targetDate: AFTER_GO_LIVE,
          ...query,
        });
        stamped = rows[0]?.vintage_fidelity;
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    expect(stamped).toBe("revision_optimistic");
  });

  it("agrees with the golden vintage vectors both languages are bound by", async () => {
    // The rule is duplicated in SQL because a feature row must carry its own
    // fidelity and the row is built there. Duplicating two timestamps and an
    // inequality is safe in the way `contract/vintage.ts` argues — provided
    // every copy is bound by the same vectors, which is what this does.
    const directory = join(
      import.meta.dir,
      "../../../packages/core/fixtures/canonical-contract/vintage-fidelity",
    );
    const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const vector = JSON.parse(readFileSync(join(directory, file), "utf8")) as {
        name: string;
        window_start: string;
        go_live_at: string | null;
        expected: string;
      };
      const rows = await db.execute<{ fidelity: string }>(sql`
        select feature_vintage_fidelity(
          ${vector.window_start}::timestamptz,
          ${vector.go_live_at}::timestamptz
        ) as fidelity
      `);
      const [row] = [...rows];
      expect({ case: vector.name, fidelity: row?.fidelity }).toEqual({
        case: vector.name,
        fidelity: vector.expected,
      });
    }
  });

  // ---------------------------------------------------------------- Seam 1
  it("seam 1 — the training row and the serving row are the same row", async () => {
    // The central claim of the spec, and it is cheap because the claim is that
    // they are literally the same query: the serving call is the training call
    // with a range of one day, and the gate is resolved per target date inside
    // the function rather than chosen by either caller.
    const trained = await readFeatureRows(db, {
      targetFrom: "2026-08-18",
      targetTo: TARGET,
      ...query,
    });
    const served = await readServingRows(db, { targetDate: TARGET, ...query });

    const trainedForTarget = trained.filter((row) =>
      String(row.target_date).includes(TARGET),
    );
    expect(trainedForTarget).toHaveLength(served.length);
    expect(served.length).toBeGreaterThan(0);
    // The range really was a range: the other two days came back too.
    expect(trained.length).toBe(served.length * 3);

    const byKey = new Map(trainedForTarget.map((row) => [keyOf(row), comparable(row)]));
    for (const row of served) {
      expect(byKey.get(keyOf(row))).toEqual(comparable(row));
    }
  });

  // ---------------------------------------------------------------- Seam 2
  it("seam 2 — deleting every post-gate source row changes no feature value", async () => {
    // The general leak detector. It is not told which features are suspect: it
    // deletes what will not exist at serve time and asserts that nothing the
    // function calls a feature moved. A lag added by a future session that
    // nobody thought to review fails here.
    //
    // The `y_` labels are deliberately excluded, and that exclusion is the
    // asymmetry rather than a loophole: labels are read `AsOf(now())` on
    // purpose, so their sources are *expected* to post-date the gate. A test
    // that demanded they survive ablation would be testing for a leak the spec
    // asks for.
    const before = await readServingRows(db, { targetDate: TARGET, ...query });
    let after: FeatureRow[] = [];
    let deleted = 0;

    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        // Everything the gate could not have seen, on either axis: a row the
        // source published later, and a row WattSteer learned later. The
        // registry needs the second one — a snapshot is *ingested* after the
        // fact, which is exactly how a unit ONS records late would leak.
        for (const table of [
          "weather_forecast_hour",
          "curtailment_report_hour",
          "generating_unit",
        ]) {
          const removed = await scoped.execute<{ n: number }>(sql`
            with gone as (
              delete from ${sql.raw(table)}
              where published_at > ${GATE_LATE.toISOString()}::timestamptz
                 or ingested_at > ${GATE_LATE.toISOString()}::timestamptz
              returning 1
            ) select count(*)::int as n from gone
          `);
          deleted += Number([...removed][0]?.n ?? 0);
        }
        after = await readServingRows(scoped, { targetDate: TARGET, ...query });
        tx.rollback();
      });
    } catch (error) {
      // `tx.rollback()` throws by design; anything else is a real failure.
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }

    // Non-vacuous in both directions: rows really were removed, and the row set
    // is unchanged because the spine comes from the calendar.
    expect(deleted).toBeGreaterThan(0);
    expect(after).toHaveLength(before.length);

    const byKey = new Map(
      after.map((row) => [keyOf(row), featuresOnly(comparable(row))]),
    );
    for (const row of before) {
      expect(byKey.get(keyOf(row))).toEqual(featuresOnly(comparable(row)));
    }
    // And the ablation was real: the labels, which are read at the settled
    // vintage, did move.
    const curtailedAfter = after.find(
      (row) =>
        row.subsystem === "NE" &&
        new Date(row.valid_time).getTime() === HOUR_CURTAILED.getTime(),
    );
    expect(curtailedAfter?.y_constrained_off_total_mwh).toBeNull();
  });

  // ------------------------------------------------------------ fail closed
  it("refuses an unresolved gate rather than defaulting to one", async () => {
    const refusals: [string, Promise<unknown>][] = [
      [
        "unknown gate profile",
        db.execute(sql`select gate_at(${TARGET}::date, 'gate_middle')`),
      ],
      [
        "unknown feature set",
        db.execute(
          sql`select * from feature_rows(${TARGET}::date, ${TARGET}::date, 'gate_late', 'dessem_v2', 5)`,
        ),
      ],
      [
        "DESSEM at the early gate",
        db.execute(
          sql`select * from feature_rows(${TARGET}::date, ${TARGET}::date, 'gate_early', 'dessem_augmented_v1', 5)`,
        ),
      ],
      [
        "a negative threshold",
        db.execute(
          sql`select * from feature_rows(${TARGET}::date, ${TARGET}::date, 'gate_late', 'dessem_free_v1', -1)`,
        ),
      ],
      [
        "a backwards range",
        db.execute(
          sql`select * from feature_rows('2026-08-21'::date, ${TARGET}::date, 'gate_late', 'dessem_free_v1', 5)`,
        ),
      ],
    ];

    for (const [name, attempt] of refusals) {
      const outcome = await attempt.then(
        () => "resolved",
        (error: unknown) => sqlStateOf(error),
      );
      expect({ name, outcome }).toEqual({ name, outcome: "22023" });
    }
  });

  it("fails on a target date that does not have 24 local hours", async () => {
    // The canary. Brazil has observed no summer time since 2019 and the whole
    // feature window is DST-free, so no DST handling is built — but should the
    // law change, the first affected date fails here instead of silently
    // duplicating or dropping an hour inside every feature built for it.
    for (const dstDay of ["2018-11-04", "2019-02-16"]) {
      const outcome = await db
        .execute(sql`select * from feature_local_day_hours(${dstDay}::date)`)
        .then(
          () => "resolved",
          (error: unknown) => sqlStateOf(error),
        );
      expect({ dstDay, outcome }).toEqual({ dstDay, outcome: "22023" });
    }
    const ordinary = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from feature_local_day_hours(${TARGET}::date)`,
    );
    expect([...ordinary][0]?.n).toBe(24);
  });

  it("hands the read axes back empty, so the next read cannot inherit a gate", async () => {
    // Ticket 016's posture carried forward: after a feature build, a canonical
    // read in the same transaction raises rather than quietly reusing a gate it
    // never asked for.
    let leftover: string | null | undefined;
    let outcome: string | undefined;

    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await readServingRows(scoped, { targetDate: TARGET, ...query });
        const left = await scoped.execute<{ axis: string | null }>(
          sql`select nullif(current_setting('wattsteer.as_of', true), '') as axis`,
        );
        leftover = [...left][0]?.axis;

        // The raise aborts the transaction, which is why this is the last
        // statement in it and why the whole block is rolled back after.
        outcome = await scoped.execute(sql`select canonical_as_of()`).then(
          () => "resolved",
          (error: unknown) => sqlStateOf(error),
        );
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }

    expect(leftover).toBeNull();
    expect(outcome).toBe("22023");
  });

  it("resolves both profiles in Brasília civil time", async () => {
    const rows = await db.execute<{ early: string; late: string }>(sql`
      select gate_at(${TARGET}::date, 'gate_early') as early,
             gate_at(${TARGET}::date, 'gate_late') as late
    `);
    const [row] = [...rows];
    // D−1 09:00 and D−1 19:00 BRT, which is UTC−3 all year since 2019.
    expect(new Date(row?.early ?? 0).toISOString()).toBe("2026-08-19T12:00:00.000Z");
    expect(new Date(row?.late ?? 0).toISOString()).toBe(GATE_LATE.toISOString());
  });
});

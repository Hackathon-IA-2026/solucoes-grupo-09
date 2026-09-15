import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Database } from "../src/database/connection.js";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  assertWeatherCompleteness,
  buildModelInputsArtifact,
  FEATURE_ROW_COLUMNS,
  type FeatureRow,
  featureGrain,
  isFeatureColumn,
  isLabelColumn,
  loadCalendar,
  loadCalendarArtifact,
  MODEL_INPUTS_ARTIFACT_PATH,
  readAbConfigurations,
  readCapacityWeightsAsOf,
  readDroppedFeatures,
  readExpectedRowCount,
  readFeatureDictionary,
  readFeatureRows,
  readFeatureSetModelInputs,
  readServingRows,
  renderModelInputsArtifact,
  ServingCompletenessError,
} from "../src/features/index.js";
import {
  type CurtailmentReportHour,
  type DessemBalanceHalfHour,
  type EnergyBalanceHour,
  type RegistryGeneratingUnit,
  type RegistryPlant,
  recordLoadApiRequest,
  recordWeatherRunRequest,
  upsertPlants,
  upsertReportingEntities,
  type WeatherForecastHour,
  writeCurtailment,
  writeDessemBalance,
  writeEnergyBalance,
  writeGeneratingUnits,
  writeProgrammedLoad,
  writeSubsystemExchange,
  writeWeatherForecast,
} from "../src/ingest/index.js";
import { programmePublishedAt } from "../src/ingest/ons/load.js";

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
/**
 * A target date before every go-live in the fixture.
 *
 * Ticket 05 moved this. Before it, `TARGET` itself predated the label source's
 * go-live, because the only constrained-off rows in the fixture were the
 * settled labels ingested days *after* the target date. The class-`K` block
 * needs a backward view that survives the vintage ablation, so the fixture now
 * also carries a week of *backfilled* observations ingested long before the
 * gate — which is exactly the backfill window the whole cutoff exists for, and
 * which moves every go-live back with it. The fidelity claim is unchanged and
 * is asserted here instead.
 */
const BEFORE_GO_LIVE = "2026-07-15";

/** The local civil day of `TARGET`, in UTC. Brasília is UTC−3 all year. */
const DAY_FROM = new Date("2026-08-20T03:00:00.000Z");
const HOUR_CURTAILED = new Date("2026-08-20T12:00:00.000Z");
const HOUR_QUIET = new Date("2026-08-20T13:00:00.000Z");

/**
 * `actuals_cutoff(gate_at(TARGET, 'gate_late'), 40 h)` — D-2 03:00 BRT.
 *
 * 2026-08-19 19:00 BRT is 22:00Z; forty hours earlier is 2026-08-18 06:00Z,
 * which is 03:00 in Brasilia. So **no hour of 2026-08-19 is available at all**,
 * and of 2026-08-18 only the first four local hours are — which is the spec's
 * "the nearest usable same-hour actual is t-48 h, and even that is
 * conditional", written out as an instant.
 */
const CUTOFF = new Date("2026-08-18T06:00:00.000Z");

/** t-168 h from `HOUR_CURTAILED`: same local hour, seven days back. */
const D_MINUS_7 = new Date("2026-08-13T12:00:00.000Z");
/** Also 12:00Z, also inside the trailing week — the second same-hour sample. */
const D_MINUS_4 = new Date("2026-08-16T12:00:00.000Z");
/** Inside the trailing **24** hours as well as the trailing week. */
const D_MINUS_3 = new Date("2026-08-17T12:00:00.000Z");
/** 00:00 local on D-2 — the last hour that clears the cutoff. */
const D_MINUS_2_EARLY = new Date("2026-08-18T03:00:00.000Z");
/**
 * 09:00 local on D-2 — six hours *past* the cutoff, and the decoy.
 *
 * Published and ingested before the gate, so `AsOf(gate)` and
 * `published_at <= gate` both return it happily. Only the valid-time cut keeps
 * it out, which is the entire point of this ticket: over the backfill window
 * neither vintage axis filters an observation at all.
 */
const D_MINUS_2_NOON = new Date("2026-08-18T12:00:00.000Z");
/** One hour before the trailing week opens — the frame's lower edge. */
const BEFORE_WINDOW = new Date("2026-08-11T05:00:00.000Z");
/** The first local hour of `TARGET`, whose t-48 h is `D_MINUS_2_EARLY`. */
const HOUR_FIRST = new Date("2026-08-20T03:00:00.000Z");
/** The last local hour of `TARGET` — 23:00 BRT, the far edge of the profile. */
const HOUR_LAST = new Date("2026-08-21T02:00:00.000Z");
/** The first local hour of D+1, whose programme is published after the gate. */
const HOUR_NEXT_DAY = new Date("2026-08-21T03:00:00.000Z");

/**
 * When WattSteer learned the backfilled observations: long before the gate.
 *
 * Deliberately *not* an honest ingestion instant per row. That is what a
 * backfill looks like — one bulk load of years of history — and it is why
 * `AsOf(gate)` filters nothing over the window and why the cutoff has to exist.
 */
const OBSERVED_INGESTED_AT = new Date("2026-08-01T00:00:00.000Z");

const ENTITY = "CJU_FE01";
const CENTROID_A = "FE01_A";
const CENTROID_B = "FE01_B";

/**
 * Where this suite's two frozen points are, and where its two plants are.
 *
 * The **same** coordinates for both, deliberately. `canonical_capacity_weight`
 * assigns a plant to the nearest centroid of its own technology, and the real
 * `centroid_set_v1` — nineteen points across the north-east — may already be in
 * this database from the centroid suite. A plant exactly on its own point is
 * nearest to it whatever else is loaded, so the weight vector this fixture
 * asserts against is a property of the fixture rather than of what ran first.
 *
 * `CENTROID_B` is where ticket 03's single solar point stood, so
 * `canonical_solar_centroid` — and every `solar_zenith_cos` computed at it — is
 * unmoved by ticket 08 putting a wind point beside it.
 */
const CENTROID_A_LAT = -10;
const CENTROID_A_LON = -41;
const CENTROID_B_LAT = -9;
const CENTROID_B_LON = -40;

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

/**
 * The target's local day at both centroids, **and the three hours either side**.
 *
 * A weather run is not a day file: the D−1 12Z run that carries 00:00 BRT on D
 * carries 23:00 BRT on D−1 in the same publication, which is why the class-`W`
 * ramps and centred windows are defined at the local day's edges where the
 * class-`P` and class-`D` ones are not. A fixture that stopped at the day
 * boundary would make that difference invisible and the edge rows NULL for a
 * reason that has nothing to do with the gate.
 */
const runRows = (runInitTime: Date, base: number): WeatherForecastHour[] => {
  const rows: WeatherForecastHour[] = [];
  for (let hour = -3; hour < 27; hour += 1) {
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

/**
 * A backfilled observation, with the restriction reason the shares aggregate.
 *
 * The reason travels **upward** only: it is a property of the reporting entity
 * and the share below counts entity-hours of a subsystem. Nothing here
 * attributes a conjunto's reason downward to a member plant, which the domain
 * model forbids as an allocation presented as an observation.
 */
const observed = (
  validTime: Date,
  technology: "WIND" | "SOLAR",
  constrainedOffMwh: number,
  reason: "REL" | "CNF" | "ENE" | null = null,
): CurtailmentReportHour => ({
  ...report(validTime, technology, constrainedOffMwh),
  cause: reason === null ? null : { reason, origin: "SIS", description: null },
});

/** One NE hour of the balance file. The numbers are the assertions' arithmetic. */
const balance = (
  validTime: Date,
  loadMwh: number,
  windGenerationMwh: number,
  solarGenerationMwh: number,
  netExchangeMwh: number,
): EnergyBalanceHour => ({
  subsystem: "NE",
  validTime,
  loadMwh,
  hydroGenerationMwh: 10,
  thermalGenerationMwh: 20,
  windGenerationMwh,
  solarGenerationMwh,
  netExchangeMwh,
});

/**
 * Half an hour of ONS's day-ahead programme.
 *
 * `publishedAt` is not chosen here. It comes from `programmePublishedAt`, which
 * is the decision this ticket had to make and the one place it is made — so the
 * fixture cannot accidentally test a stamp the adapter would never write.
 */
const programmed = (
  areaCode: "NE" | "SECO",
  validTime: Date,
  programmedLoadMwh: number,
) => ({
  areaCode,
  areaKind: "SUBSYSTEM" as const,
  subsystem: (areaCode === "SECO" ? "SE" : "NE") as "SE" | "NE",
  validTime,
  programmedLoadMwh,
  publishedAt: programmePublishedAt(validTime) as Date,
});

/**
 * A whole local day's programme, as the 48 half hours ONS publishes.
 *
 * The hourly value is `atHour(h)` and each half hour carries half of it, so the
 * canonical view's summing back to an hour is exercised rather than assumed.
 */
const programmedDay = (
  areaCode: "NE" | "SECO",
  dayStart: Date,
  atHour: (localHour: number) => number,
) => {
  const rows: ReturnType<typeof programmed>[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const half = atHour(hour) / 2;
    const start = new Date(dayStart.getTime() + hour * 3_600_000);
    rows.push(programmed(areaCode, start, half));
    rows.push(programmed(areaCode, new Date(start.getTime() + 1_800_000), half));
  }
  return rows;
};

/** NE's profile: a clean ramp of +10 MWh an hour, so every shape is arithmetic. */
const NE_PROGRAMMED = (localHour: number): number => 1000 + 10 * localHour;
/** SE's runs the other way, so a rank or a minimum cannot be shared by accident. */
const SE_PROGRAMMED = (localHour: number): number => 2000 - 20 * localHour;

// ------------------------------------------------------ ticket 07's class `D`
//
// DESSEM's file for reference day D is created mid-afternoon on D−1. The spec's
// measured instance is 17:48 **UTC** — 14:48 Brasília — which is four hours
// inside `gate_late` (D−1 22:00Z) and ten hours after `gate_early`.
const DESSEM_PUBLISHED_AT = new Date("2026-08-19T17:48:00.000Z");
/** D−1's own file, published a day earlier and therefore visible at `TARGET`'s gate. */
const DESSEM_PUBLISHED_AT_D_MINUS_1 = new Date("2026-08-18T17:48:00.000Z");
/** After `TARGET`'s gate: a restatement no row of `TARGET` may see. */
const DESSEM_PUBLISHED_AFTER_GATE = new Date("2026-08-19T23:30:00.000Z");

/** One subsystem's day-ahead balance for one local hour, in MW. */
interface DessemHourMw {
  demand: number;
  wind: number;
  solar: number;
  mmgd: number;
  hydro: number;
  smallHydro: number;
  thermal: number;
  smallThermal: number;
  pumping: number;
}

/**
 * The four profiles, chosen so every derived column is arithmetic.
 *
 * NE is the one the assertions look at, and its three ramps are deliberately
 * three *different* numbers — demand +10, residual +9, VRE +1 — so a ramp
 * computed from the wrong quantity cannot come out right by coincidence. SE
 * runs the other way, so a minimum or a rank taken across subsystems rather
 * than within one collapses visibly. N and S exist so the system-wide sum has
 * four terms and so the absorber column has somewhere to be NULL.
 */
const DESSEM_PROFILE: Record<"N" | "NE" | "S" | "SE", (hour: number) => DessemHourMw> = {
  NE: (hour) => ({
    demand: 1000 + 10 * hour,
    // 73.5 against the 147 MW fleet and 10 against the 40 MW fleet: the two
    // capacity factors come to exactly 0.5 and 0.25.
    wind: 73.5,
    solar: 10,
    mmgd: 16.5 + hour,
    hydro: 40,
    smallHydro: 10,
    thermal: 60,
    smallThermal: 15,
    pumping: 5,
  }),
  SE: (hour) => ({
    demand: 2000 - 20 * hour,
    wind: 100,
    solar: 50,
    mmgd: 30,
    hydro: 500,
    smallHydro: 20,
    thermal: 200,
    smallThermal: 10,
    pumping: 25,
  }),
  N: (hour) => ({
    demand: 500 + 5 * hour,
    wind: 50,
    solar: 10,
    mmgd: 5,
    hydro: 300,
    smallHydro: 5,
    thermal: 30,
    smallThermal: 5,
    pumping: 3,
  }),
  S: (hour) => ({
    demand: 800 + 2 * hour,
    wind: 60,
    solar: 20,
    mmgd: 10,
    hydro: 400,
    smallHydro: 10,
    thermal: 50,
    smallThermal: 5,
    pumping: 4,
  }),
};

/** `demand − wind − solar − mmgd`, the quantity five other columns are built on. */
const dessemResidual = (subsystem: keyof typeof DESSEM_PROFILE, hour: number): number => {
  const mw = DESSEM_PROFILE[subsystem](hour);
  return mw.demand - mw.wind - mw.solar - mw.mmgd;
};

/**
 * A whole local day's DESSEM balance, as the 48 half hours ONS publishes.
 *
 * The two half hours of an hour are the hourly value ∓2 MW, so their **mean**
 * is the hourly figure and neither half hour is. A block that summed them, or
 * took the first, or took the last, produces three different wrong answers and
 * none of them is the expected one.
 */
const dessemDay = (
  subsystem: keyof typeof DESSEM_PROFILE,
  dayStart: Date,
  referenceDay: string,
  scale = 1,
): DessemBalanceHalfHour[] => {
  const rows: DessemBalanceHalfHour[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const mw = DESSEM_PROFILE[subsystem](hour);
    const start = new Date(dayStart.getTime() + hour * 3_600_000);
    for (const [offsetMs, delta] of [
      [0, -2],
      [1_800_000, 2],
    ] as const) {
      rows.push({
        subsystem,
        validTime: new Date(start.getTime() + offsetMs),
        referenceDay,
        demandMw: (mw.demand + delta) * scale,
        hydroGenerationMw: (mw.hydro + delta) * scale,
        smallHydroGenerationMw: (mw.smallHydro + delta) * scale,
        thermalGenerationMw: (mw.thermal + delta) * scale,
        smallThermalGenerationMw: (mw.smallThermal + delta) * scale,
        windGenerationMw: (mw.wind + delta) * scale,
        solarGenerationMw: (mw.solar + delta) * scale,
        mmgdGenerationMw: (mw.mmgd + delta) * scale,
        pumpingConsumptionMw: (mw.pumping + delta) * scale,
        // 24 hours × 2 half hours: a whole day, which is the only kind the
        // feature layer reads.
        referenceDayPatamares: 48,
        referenceDayHalfHours: 48,
      });
    }
  }
  return rows;
};

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

  /**
   * One target date, through the **training** call.
   *
   * `readServingRows` is the training call with a range of one day *plus the
   * serve-time completeness contract*, and that contract refuses a day whose
   * weather did not arrive. This fixture carries a run for `TARGET` and for no
   * other date, so the tests below that ask about a different day — the fleet on
   * D−1, the fidelity of a day before go-live — have to ask the way training
   * asks. That they must is the contract working, and it is the reason the
   * distinction between the two entry points is worth having.
   */
  const rowsForDay = (targetDate: string) =>
    readFeatureRows(db, { targetFrom: targetDate, targetTo: targetDate, ...query });

  /**
   * The constrained-off resource version this suite writes under.
   *
   * Captured out of `beforeAll` because ticket 11's frame test writes one more
   * observation of its own, inside a transaction it rolls back — and a row
   * written under a second version would be a second file rather than another
   * hour of the same one.
   */
  let curtailmentVersionId = "";

  beforeAll(async () => {
    await db.execute(sql`truncate table weather_forecast_hour`);
    await db.execute(sql`truncate table weather_run_request cascade`);
    await db.execute(sql`truncate table curtailment_report_hour`);
    await db.execute(sql`truncate table reporting_entity cascade`);
    // The units, not the plants: `plant` cascades into three other suites'
    // fixtures, and a plant with no live units contributes no capacity anyway.
    await db.execute(sql`truncate table generating_unit`);
    await db.execute(sql`truncate table programmed_load_half_hour`);
    await db.execute(sql`truncate table dessem_balance_half_hour`);
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
    curtailmentVersionId = version?.id ?? "";

    // Ticket 03's inputs, seeded here on purpose rather than left empty.
    //
    // The two seams below are generic — they compare every column and every
    // non-label column — but a column that is NULL in every row passes them
    // without being tested. So the calendar, the registry's state assignment
    // and a frozen solar centroid are all present, and the class-`T` features
    // carry real values through both. A suite that truncates `plant` or
    // `centroid_set` may have run before this one, which is why these are
    // written rather than assumed.
    await loadCalendar(db, loadCalendarArtifact());
    await db.execute(sql`
      insert into centroid_set (
        version, source, geometry_digest, centroid_count, represented_mw,
        registry_as_of, fleet_on, freeze_located_mw, freeze_plants, collision_check
      ) values (
        'centroid_set_v1', 'hand_transcribed', 'sha256:features-test', 1, 1000,
        now(), now(), 1000, 1, 'asserted'
      ) on conflict (version) do nothing
    `);
    // The frozen geometry. Two points, one per technology, and they are the two
    // the weather rows below are taken at — because ticket 08 weights the
    // centroids by the capacity nearest them, so a centroid the fleet is not
    // near carries no weight and a weather series at a point the set does not
    // hold is never read.
    //
    // The solar point is where ticket 03's single point was, so
    // `canonical_solar_centroid` — and every `solar_zenith_cos` computed at it —
    // is unmoved by the wind point arriving beside it.
    // `FE01_SOLAR` is this suite's own retired point — ticket 03 needed one
    // solar centroid and named it that; ticket 08 needs one per technology and
    // names them after the two the weather rows are taken at. It is removed
    // rather than left beside them because it sits at the same coordinates as
    // its replacement, and two points at one place make "the nearest centroid"
    // a coin toss.
    await db.execute(sql`delete from centroid_point where centroid_id = 'FE01_SOLAR'`);
    await db.execute(sql`
      insert into centroid_point (
        set_version, centroid_id, label, latitude, longitude, technology,
        represented_mw, origin, municipalities, plants, merged_from
      ) values
        ('centroid_set_v1', ${CENTROID_A}, 'Wind', ${CENTROID_A_LAT},
         ${CENTROID_A_LON}, 'WIND', 1000, 'hand_transcribed', '', 1, ''),
        ('centroid_set_v1', ${CENTROID_B}, 'Solar', ${CENTROID_B_LAT},
         ${CENTROID_B_LON}, 'SOLAR', 1000, 'hand_transcribed', '', 1, '')
      on conflict do nothing
    `);
    await db.execute(sql`
      insert into plant (
        ceg_core, ceg_raw, name, subsystem, state_code, technology,
        operation_modality, owner_name, operator_name
      ) values
        ('FE01_BA', 'FE01_BA', 'Bahia', 'NE', 'BA', 'WIND', 'TIPO_I', 'o', 'o'),
        ('FE01_SP', 'FE01_SP', 'Sao Paulo', 'SE', 'SP', 'SOLAR', 'TIPO_I', 'o', 'o')
      on conflict (ceg_core) do nothing
    `);

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

    // Ticket 08's inputs: where the two plants are.
    //
    // The class-`W` block weights the centroids by the capacity nearest them,
    // so a fixture with no located plant has no weight vector and no weather at
    // all. These two put the wind fleet at `CENTROID_A` and the solar fleet at
    // `CENTROID_B` — one plant each, so the assignment is unambiguous and the
    // weights are the two fleets' own megawatts and nothing else.
    //
    // Written with `plant_geo`'s own vintage columns rather than through the
    // SIGA writer because the location is a constant of this fixture: it is
    // ingested long before every gate this suite asks about, so no as-of can
    // hide it and the weights are a question about capacity alone.
    await db.execute(sql`
      insert into plant_geo (
        plant_ceg_core, ceg_raw, siga_name, latitude, longitude, location_source,
        municipalities_raw, ownership, observed_on, data_version, published_at,
        published_at_precision, ingested_at, value_digest, source_version_id
      ) values
        (${PLANT_WIND}, ${PLANT_WIND}, 'Bahia', ${CENTROID_A_LAT}, ${CENTROID_A_LON},
         'siga_coordinate',
         '', '', ${REGISTRY_INGESTED_AT.toISOString()}::timestamptz, 1,
         ${REGISTRY_INGESTED_AT.toISOString()}::timestamptz, 'file',
         ${REGISTRY_INGESTED_AT.toISOString()}::timestamptz, 'features-geo-wind',
         ${registryVersion?.id ?? ""}::uuid),
        (${PLANT_SOLAR}, ${PLANT_SOLAR}, 'Solar', ${CENTROID_B_LAT}, ${CENTROID_B_LON},
         'siga_coordinate',
         '', '', ${REGISTRY_INGESTED_AT.toISOString()}::timestamptz, 1,
         ${REGISTRY_INGESTED_AT.toISOString()}::timestamptz, 'file',
         ${REGISTRY_INGESTED_AT.toISOString()}::timestamptz, 'features-geo-solar',
         ${registryVersion?.id ?? ""}::uuid)
      on conflict do nothing
    `);

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

    // ------------------------------------------------ ticket 05's backward view
    //
    // A week of NE observations behind the cutoff, and four decoys in front of
    // it or behind the frame's far edge. Every row is published *and* ingested
    // at `OBSERVED_INGESTED_AT`, before the gate — so both vintage axes let all
    // of them through and only `valid_time <= actuals_cutoff` does any work.
    // That is not a quirk of the fixture; it is the backfill window, and a
    // fixture that gave these rows honest per-row ingestion instants would let
    // an as-of read hide a missing cutoff.
    await writeCurtailment(db, {
      rows: [
        // The D-7 hour, and the same-hour mean's first sample: 6 + 3 = 9 MWh.
        observed(D_MINUS_7, "WIND", 6, "ENE"),
        observed(D_MINUS_7, "SOLAR", 3, "ENE"),
        // The same-hour mean's second sample: 2 + 1 = 3 MWh.
        observed(D_MINUS_4, "WIND", 2, "CNF"),
        observed(D_MINUS_4, "SOLAR", 1),
        // The last hour that clears the cutoff, and the only t-48 h any row of
        // TARGET can reach.
        observed(D_MINUS_2_EARLY, "WIND", 2, "REL"),
        observed(D_MINUS_2_EARLY, "SOLAR", 1),
        // Past the cutoff. Enormous on purpose: it is the t-48 h of the hour
        // the assertions look at, so a missing cutoff cannot pass by accident.
        observed(D_MINUS_2_NOON, "WIND", 555, "CNF"),
        // Behind the frame's far edge, and equally enormous: an aggregate that
        // reached back 169 hours instead of 168 would swallow it.
        observed(BEFORE_WINDOW, "WIND", 700, "ENE"),
      ],
      publishedAt: OBSERVED_INGESTED_AT,
      publishedAtPrecision: "file",
      sourceVersionId: version?.id ?? "",
      ingestedAt: OBSERVED_INGESTED_AT,
    });

    const [observationVersion] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "balanco-energia-subsistema",
        resourceName: "BALANCO_ENERGIA_SUBSISTEMA",
        resourceUrl: "https://example.invalid/FEATURES_BALANCO.csv",
        format: "CSV",
        changeKey: `features-observations-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });

    const observationVintage = {
      publishedAt: OBSERVED_INGESTED_AT,
      publishedAtPrecision: "file",
      sourceVersionId: observationVersion?.id ?? "",
      ingestedAt: OBSERVED_INGESTED_AT,
    } as const;

    await writeEnergyBalance(db, {
      rows: [
        // Wind 70 and 42 against a 140 MW fleet, solar 20 and 12 against 40 MW:
        // both capacity factors come to exactly 0.4.
        balance(D_MINUS_7, 1000, 70, 20, 150),
        balance(D_MINUS_3, 900, 42, 12, 50),
        // Past the cutoff, and inside the trailing 24 hours if it were not.
        balance(D_MINUS_2_NOON, 9999, 9999, 9999, 9999),
        // Behind the frame.
        balance(BEFORE_WINDOW, 8888, 8888, 8888, 8888),
      ],
      ...observationVintage,
    });

    await writeSubsystemExchange(db, {
      rows: [
        // Canonical orientation, `from < to` in enum order, positive from to.
        // So NE to SE and N to NE are both stored the way they are named.
        {
          fromSubsystem: "NE",
          toSubsystem: "SE",
          validTime: D_MINUS_7,
          verifiedExchangeMwh: 500,
          programmedExchangeMwh: null,
        },
        {
          fromSubsystem: "N",
          toSubsystem: "NE",
          validTime: D_MINUS_7,
          verifiedExchangeMwh: 200,
          programmedExchangeMwh: null,
        },
        {
          fromSubsystem: "NE",
          toSubsystem: "SE",
          validTime: D_MINUS_2_NOON,
          verifiedExchangeMwh: 9999,
          programmedExchangeMwh: null,
        },
        // ----------------------------------- ticket 10's trailing year
        //
        // A denominator needs a year to be estimated from, and 300 non-null
        // hours before it is allowed to exist at all - so the three rows above
        // are not enough to produce one, which is the point of the ones below.
        //
        // 800 hourly NE->SE rows ending exactly at the cutoff, one of them
        // skipped because the D-7 row above already occupies that hour. The
        // distribution is chosen so every number this suite asserts is one a
        // reader can recompute:
        //
        //   * 774 hours at 400 - the bulk, and the P99.5;
        //   * the last 24 hours at 200 - so the 24-hour mean is 0.5 and cannot
        //     be confused with the bulk;
        //   * one hour at 900, inside the trailing week - so the seven-day
        //     maximum is 2.25 and a *maximum* estimator would have produced 900
        //     rather than 400;
        //   * the D-7 row at 500, already above.
        //
        // Sorted, that is 24 x 200, 774 x 400, one 500 and one 900. P99.5 over
        // 800 values interpolates at index 795.005, which lands inside the 400s:
        // **the two largest observations do not touch the estimate**, which is
        // the whole reason it is a quantile and not a maximum.
        //
        // The reverse direction, SE->NE, is the same series negated, so its
        // P99.5 is -200 - not positive, and therefore no estimate at all. N->NE
        // keeps its single sample and is refused for the other reason. Both
        // refusals are exercised without a second fixture.
        ...Array.from({ length: 800 }, (_, i) => i)
          .filter((i) => i !== 114)
          .map((i) => ({
            fromSubsystem: "NE" as const,
            toSubsystem: "SE" as const,
            validTime: new Date(CUTOFF.getTime() - i * 3_600_000),
            verifiedExchangeMwh: i <= 23 ? 200 : i === 54 ? 900 : 400,
            programmedExchangeMwh: null,
          })),
      ],
      ...observationVintage,
    });

    // --------------------------------------------- ticket 06's class-`P` spine
    //
    // ONS's day-ahead programme, for the target day and for the day after it.
    //
    // Nothing here chooses a `published_at`: every row's comes from
    // `programmePublishedAt`, so the fixture exercises the decision the adapter
    // makes rather than a stamp invented for the test. For `TARGET` that lands
    // at 2026-08-19 15:00 BRT, four hours inside `gate_late`; for D+1 it lands
    // at 2026-08-20 15:00 BRT, which is *after* `TARGET`'s gate — which is what
    // makes the next day's programme a decoy the ablation can remove.
    const programmedRequest = await recordLoadApiRequest(db, {
      series: "PROGRAMMED",
      areaCode: "NE",
      rangeStart: TARGET,
      rangeEnd: "2026-08-21",
      response: {
        rows: [],
        url: "https://apicarga.ons.invalid/prd/cargaprogramada",
        fetchedAt: OBSERVED_INGESTED_AT,
        body: "[]",
        repaired: false,
        httpStatus: 200,
      },
    });
    const programmedVintage = {
      // Ignored by the write — the row carries its own — and passed as the
      // fetch instant it would really have been, so that a regression which
      // went back to using it would produce a visibly wrong stamp.
      publishedAt: OBSERVED_INGESTED_AT,
      publishedAtPrecision: "file",
      sourceVersionId: programmedRequest,
    } as const;

    await writeProgrammedLoad(db, {
      rows: [
        ...programmedDay("NE", DAY_FROM, NE_PROGRAMMED),
        ...programmedDay("SECO", DAY_FROM, SE_PROGRAMMED),
        // D+1's first half hour. Its programme is published after `TARGET`'s
        // gate, so it must be invisible to every row of `TARGET` — including
        // the last hour's centred mean, which is the only feature that would
        // reach for it.
        programmed("NE", HOUR_NEXT_DAY, 9999),
        programmed("NE", new Date(HOUR_NEXT_DAY.getTime() + 1_800_000), 9999),
      ],
      ...programmedVintage,
      ingestedAt: OBSERVED_INGESTED_AT,
    });

    // A restatement of one hour, learned *after* the gate. Its `published_at`
    // is identical to the original's — the stamp is derived from the reference
    // day, so a revision cannot move it — which is precisely why the as-of axis
    // has to be the thing that keeps this out, and why this row is here.
    await writeProgrammedLoad(db, {
      rows: [
        programmed("NE", HOUR_CURTAILED, 4444),
        programmed("NE", new Date(HOUR_CURTAILED.getTime() + 1_800_000), 4444),
      ],
      ...programmedVintage,
      ingestedAt: REGISTRY_LATE_INGEST,
    });

    // ------------------------------------------------ ticket 07's class-`D` block
    //
    // DESSEM's balance for the target day and for the day before it, plus two
    // decoys — one on each vintage axis, because the two keep out different
    // things and only one of them is the publication cut this block relies on.
    const [dessemVersion] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "balanco-dessem-detalhe",
        resourceName: "BALANCO_DESSEM_DETALHE",
        resourceUrl: "https://example.invalid/FEATURES_DESSEM.csv",
        format: "CSV",
        changeKey: `features-dessem-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });

    const dessemVintage = {
      publishedAtPrecision: "file",
      sourceVersionId: dessemVersion?.id ?? "",
    } as const;

    // D−1's own file, published on D−2 and therefore comfortably inside
    // `TARGET`'s gate. It is the near-edge decoy: the 23:00 BRT hour of D−1 is
    // visible at this gate, so a ramp that reached across the day boundary
    // would find it — and would be a difference of two forecasts wearing the
    // name of a shape inside one.
    await writeDessemBalance(db, {
      rows: (["N", "NE", "S", "SE"] as const).flatMap((subsystem) =>
        dessemDay(
          subsystem,
          new Date(DAY_FROM.getTime() - 86_400_000),
          TARGET_MINUS_1,
          // Scaled, so a ramp that crossed the boundary would be visibly wrong
          // rather than accidentally right.
          10,
        ),
      ),
      publishedAt: DESSEM_PUBLISHED_AT_D_MINUS_1,
      ingestedAt: OBSERVED_INGESTED_AT,
      ...dessemVintage,
    });

    // The target day's own file.
    await writeDessemBalance(db, {
      rows: (["N", "NE", "S", "SE"] as const).flatMap((subsystem) =>
        dessemDay(subsystem, DAY_FROM, TARGET),
      ),
      publishedAt: DESSEM_PUBLISHED_AT,
      ingestedAt: OBSERVED_INGESTED_AT,
      ...dessemVintage,
    });

    // The publication decoy: a restatement of the whole day, published after
    // the gate. `published_at <= gate` is the only thing keeping it out, and it
    // is a hundred times the size so it cannot fail to show if it gets in.
    await writeDessemBalance(db, {
      rows: dessemDay("NE", DAY_FROM, TARGET, 100),
      publishedAt: DESSEM_PUBLISHED_AFTER_GATE,
      ingestedAt: OBSERVED_INGESTED_AT,
      ...dessemVintage,
    });

    // The ingestion decoy: the same publication instant as the original — so
    // the publication cut lets it through — learned an hour after the gate.
    // Only `as_of` keeps this one out, and the two axes are here side by side
    // because a block that dropped either would still pass the other's test.
    await writeDessemBalance(db, {
      rows: dessemDay("SE", DAY_FROM, TARGET, 100),
      publishedAt: DESSEM_PUBLISHED_AT,
      ingestedAt: REGISTRY_LATE_INGEST,
      ...dessemVintage,
    });
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
    // The 12Z run's two centroids are 18 °C and 22 °C; the 00Z run's are 28 and
    // 32. Whatever the weighting does, it must do it to the first pair.
    for (const row of rows.filter((r) => r.subsystem === "NE")) {
      expect(Number(row.weather_temperature_2m)).toBeGreaterThan(17);
      expect(Number(row.weather_temperature_2m)).toBeLessThan(23);
    }
  });

  it("weights the twelve variables by capacity, per subsystem, per fleet", async () => {
    // The debt ticket 01 named, paid. Through that ticket
    // `weather_temperature_2m` was the unweighted mean over every centroid that
    // reported the hour — 18 and 22 average to 20, the same number for all four
    // subsystems, and the migration said so at the function.
    //
    // It is now the VRE-capacity-weighted mean over **this** subsystem's fleet:
    // 147 MW of wind at `CENTROID_A` (18 °C) and 40 MW of solar at `CENTROID_B`
    // (22 °C), so 18.86 °C and not 20. Wind variables carry the wind vector
    // alone, so `weather_wind_speed_120m` is `CENTROID_A`'s 32 km/h and not the
    // 32 the two happen to share; solar variables carry the solar vector alone.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");
    expect(ne).toHaveLength(24);

    const vreWeighted = (18 * 147 + 22 * 40) / 187;
    expect(vreWeighted).not.toBe(20);
    for (const row of ne) {
      expect(Number(row.weather_temperature_2m)).toBeCloseTo(vreWeighted, 9);
      // Both centroids report 32 km/h, so the wind mean is 32 whichever way it
      // is weighted — what this pins is that the wind basis produced a number
      // at all, and the direction pair beside it that a numeric mean could not.
      expect(Number(row.weather_wind_speed_120m)).toBeCloseTo(32, 9);
      expect(Number(row.weather_wind_direction_120m_sin)).toBeCloseTo(1, 9);
      expect(Number(row.weather_wind_direction_120m_cos)).toBeCloseTo(0, 9);
      expect(Number(row.weather_shortwave_radiation)).toBeCloseTo(500, 9);
      // Every centroid carrying weight reported, so coverage is exactly 1.
      expect(Number(row.weather_centroid_coverage)).toBeCloseTo(1, 12);
      expect(Number(row.weather_run_age_hours)).toBe(0);
    }

    // A subsystem the registry places no VRE in has no weight vector, so it has
    // no weather — a hole, and one the serve-time contract distinguishes from a
    // fleet whose weather failed to arrive.
    for (const row of rows.filter((r) => r.subsystem !== "NE")) {
      expect(row.weather_temperature_2m).toBeNull();
      expect(row.weather_centroid_coverage).toBeNull();
    }
  });

  it("carries the run's age into the row when a scheduled run was missing", async () => {
    // The fallback, end to end. `weather-repository.ts` writes `run_age_hours`
    // when the scheduled run is absent from the archive and an older cycle
    // stands in — measured at 4.5% of slots — and this is the half that matters
    // to a model: the staleness reaches the feature row instead of the pipeline
    // failing open and saying nothing.
    //
    // Only the **solar** centroid is aged, and the feature still reads 12: the
    // max, not a mean, because a mean would dilute one stale point into
    // invisibility and the column exists to say this row is older than its
    // neighbours.
    let aged: number | null | undefined;
    let cover: number | null | undefined;
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await scoped.execute(sql`
          update weather_forecast_hour set run_age_hours = 12
          where centroid_id = ${CENTROID_B}
        `);
        const rows = await readServingRows(scoped, { targetDate: TARGET, ...query });
        const ne = rows.find((row) => row.subsystem === "NE");
        aged = ne?.weather_run_age_hours;
        cover = ne?.weather_centroid_coverage;
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    expect(Number(aged)).toBe(12);
    // A stale run is a run: it degrades the forecast, and it does not open a
    // hole in the coverage.
    expect(Number(cover)).toBeCloseTo(1, 12);
  });

  it("refuses to serve when a centroid carrying weight reported nothing", async () => {
    // The other half of the same story, against the database rather than a
    // doctored row: delete the solar point's hours and 40 of NE's 187 placed MW
    // stop reporting. The weighted means renormalise over the wind point that
    // remains and look exactly like weather; only the coverage column says
    // otherwise, and the serve path refuses on it rather than imputing.
    let refused: unknown;
    let coverage: number | null | undefined;
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await scoped.execute(
          sql`delete from weather_forecast_hour where centroid_id = ${CENTROID_B}`,
        );
        const training = await readFeatureRows(scoped, {
          targetFrom: TARGET,
          targetTo: TARGET,
          ...query,
        });
        coverage = training.find(
          (row) => row.subsystem === "NE",
        )?.weather_centroid_coverage;
        refused = await readServingRows(scoped, {
          targetDate: TARGET,
          ...query,
        }).catch((error: unknown) => error);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    // 147 of 187 MW reported — the share of weight **mass**, not the two-thirds
    // a count of centroids would have given.
    expect(Number(coverage)).toBeCloseTo(147 / 187, 12);
    expect(refused).toBeInstanceOf(ServingCompletenessError);
    // Training still gets the row, with the hole visible on it. That asymmetry
    // is the design: a training row records what arrived, and a served row is
    // refused rather than imputed.
    expect(coverage).not.toBeNull();
  });

  it("converts wind through a pinned power curve and solar without a derate", async () => {
    // The curve's three numbers, at the feature rather than in a comment: below
    // cut-in and at or above cut-out the machine produces nothing, between rated
    // and cut-out it is at nameplate, and between cut-in and rated the
    // interpolation is cubic because the power in the wind is.
    const [pinned] = [
      ...(await db.execute<Record<string, number | null>>(sql`
        select
          feature_wind_power_curve_cf(2.999) as below_cut_in,
          feature_wind_power_curve_cf(3.0) as at_cut_in,
          feature_wind_power_curve_cf(12.0) as at_rated,
          feature_wind_power_curve_cf(24.999) as below_cut_out,
          feature_wind_power_curve_cf(25.0) as at_cut_out,
          feature_wind_power_curve_cf(7.5) as mid_band,
          feature_wind_power_curve_cf(null) as no_speed
      `)),
    ] as [Record<string, number | null>];
    expect(Number(pinned.below_cut_in)).toBe(0);
    expect(Number(pinned.at_cut_in)).toBe(0);
    expect(Number(pinned.at_rated)).toBe(1);
    expect(Number(pinned.below_cut_out)).toBe(1);
    expect(Number(pinned.at_cut_out)).toBe(0);
    expect(Number(pinned.mid_band)).toBeCloseTo(
      (7.5 ** 3 - 3 ** 3) / (12 ** 3 - 3 ** 3),
      9,
    );
    expect(pinned.no_speed).toBeNull();

    // 32 km/h is 8.888… m/s, inside the band, and the fixture's two centroids
    // agree — so the weighted capacity factor is the curve at that speed and the
    // expected generation is that factor against the 147 MW read at the gate.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");
    const speedMs = 32 / 3.6;
    const cf = (speedMs ** 3 - 3 ** 3) / (12 ** 3 - 3 ** 3);
    for (const row of ne) {
      expect(Number(row.weather_wind_power_curve_cf)).toBeCloseTo(cf, 9);
      expect(Number(row.weather_expected_wind_mwh)).toBeCloseTo(cf * 147, 6);
      // STC-referenced, and carrying no temperature derate: 40 MW x 500/1000.
      expect(Number(row.weather_expected_solar_mwh)).toBeCloseTo(40 * 0.5, 9);
    }
  });

  it("averages wind direction as a vector, across the 350 to 10 degree seam", async () => {
    // 350° and 10° do not average to 180°, and a fixture that only ever averaged
    // 90° with 90° would not know the difference. Asked of the database
    // directly, because the seam is a property of the encoding rather than of
    // this fixture's weather.
    const [seam] = [
      ...(await db.execute<{ sin: number; cos: number }>(sql`
        select
          sum(sin(radians(d))) / sqrt(sum(sin(radians(d))) ^ 2
                                      + sum(cos(radians(d))) ^ 2) as sin,
          sum(cos(radians(d))) / sqrt(sum(sin(radians(d))) ^ 2
                                      + sum(cos(radians(d))) ^ 2) as cos
        from unnest(array[350.0, 10.0]) as d
      `)),
    ] as [{ sin: number; cos: number }];
    // Due north — 0°, which is what 350° and 10° straddle. A numeric mean would
    // have said 180°, which is due south.
    expect(Number(seam.sin)).toBeCloseTo(0, 12);
    expect(Number(seam.cos)).toBeCloseTo(1, 12);
  });

  it("divides shortwave by the extraterrestrial irradiance, guarded at night", async () => {
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");
    for (const row of ne) {
      const ghi = Number(row.solar_extraterrestrial_ghi);
      const expected = Number(row.weather_shortwave_radiation) / Math.max(ghi, 1);
      expect(Number(row.weather_clearness_index)).toBeCloseTo(expected, 9);
      // The guard is what keeps the night finite: the denominator is exactly
      // zero below the horizon, and the fixture's constant 500 W/m² over it is
      // physically impossible and numerically the point.
      expect(Number.isFinite(Number(row.weather_clearness_index))).toBe(true);
    }
    // Non-vacuous: some hours of the day really are below the horizon.
    expect(ne.some((row) => Number(row.solar_extraterrestrial_ghi) === 0)).toBe(true);
  });

  it("derives the shape inside the run profile, across the local day's edges", async () => {
    // The class-`P` and class-`D` ramps are NULL at the first hour of the local
    // day, because the hour before it belongs to D−1's own file. A weather run
    // is not a day file: it carries D−1 23:00 BRT and D 00:00 BRT in the same
    // publication, so the same difference is a shape inside one forecast and is
    // defined at both edges.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows
      .filter((row) => row.subsystem === "NE")
      .toSorted(
        (a, b) => new Date(a.valid_time).getTime() - new Date(b.valid_time).getTime(),
      );
    const first = ne[0];
    const last = ne[23];
    // The fixture's profile is flat across the day, so every ramp is zero — and
    // zero, not NULL, is the claim: a NULL here would mean the difference could
    // not be computed at all.
    for (const column of [
      "weather_wind_speed_120m_ramp_1h",
      "weather_wind_speed_120m_mean_3h",
      "weather_wind_speed_120m_std_6h",
      "weather_shortwave_radiation_ramp_1h",
      "weather_shortwave_radiation_mean_3h",
      "weather_expected_vre_ramp_1h",
    ] as const) {
      // Named rather than compared through `Number(...)`, because `Number(null)`
      // is 0 and 0 is exactly the value these columns take here.
      expect({ column, first: first?.[column], last: last?.[column] }).toEqual({
        column,
        first: expect.any(Number),
        last: expect.any(Number),
      });
    }
    expect(Number(first?.weather_wind_speed_120m_ramp_1h)).toBeCloseTo(0, 9);
    expect(Number(first?.weather_wind_speed_120m_mean_3h)).toBeCloseTo(32, 9);
    expect(Number(first?.weather_wind_speed_120m_std_6h)).toBeCloseTo(0, 9);
    expect(Number(last?.weather_shortwave_radiation_ramp_1h)).toBeCloseTo(0, 9);
    expect(Number(last?.weather_shortwave_radiation_mean_3h)).toBeCloseTo(500, 9);
    expect(Number(last?.weather_expected_vre_ramp_1h)).toBeCloseTo(0, 9);
  });

  it("refuses to serve a day whose fleet lost a centroid, rather than imputing", async () => {
    // The completeness contract, on rows the aggregate really produced. Dropping
    // the solar centroid's hours takes 40 of NE's 187 placed MW out of the
    // sample: the weighted means renormalise over the wind point that remains
    // and look exactly like weather, and only `weather_centroid_coverage` says
    // otherwise. That is what the serve path refuses on.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const holed = rows.map((row) =>
      row.subsystem === "NE" ? { ...row, weather_centroid_coverage: 147 / 187 } : row,
    );
    expect(() => assertWeatherCompleteness(holed, TARGET)).toThrow(
      ServingCompletenessError,
    );
    // A missing pinned variable refuses on the same terms, and a derived one
    // does not: a centred window is NULL wherever a neighbour is, and refusing
    // on that would refuse on the machinery working.
    const blanked = rows.map((row) =>
      row.subsystem === "NE" ? { ...row, weather_shortwave_radiation: null } : row,
    );
    expect(() => assertWeatherCompleteness(blanked, TARGET)).toThrow(
      ServingCompletenessError,
    );
    const windowed = rows.map((row) => ({
      ...row,
      weather_wind_speed_120m_std_6h: null,
    }));
    expect(() => assertWeatherCompleteness(windowed, TARGET)).not.toThrow();
    // And a day with no weighted subsystem at all is refused rather than passing
    // vacuously.
    const unweighted = rows.map((row) => ({
      ...row,
      weather_centroid_coverage: null,
    }));
    expect(() => assertWeatherCompleteness(unweighted, TARGET)).toThrow(
      ServingCompletenessError,
    );
  });

  it("agrees with the capacity weights TypeScript computes for the same fleet", async () => {
    // The weighting has two implementations — `canonical_capacity_weight` here
    // and `computeCapacityWeights` in `features/capacity-weights.ts` — because a
    // plpgsql feature function cannot call TypeScript. This is what makes the
    // second one safe: the same fleet through both, compared, exactly as
    // `feature_vintage_fidelity` is bound to the golden vintage vectors it
    // restates rather than trusted beside them.
    // The geometry is handed in rather than defaulted, because `centroids.ts`
    // holds the real nineteen points and this fixture's fleet lives at two of
    // its own. Both sides therefore answer the same question about the same
    // geometry, which is the only comparison worth making.
    const weights = await readCapacityWeightsAsOf(db, {
      asOf: GATE_LATE,
      on: new Date(`${TARGET}T00:00:00.000Z`),
      centroids: [
        {
          id: CENTROID_A,
          label: "Wind",
          latitude: CENTROID_A_LAT,
          longitude: CENTROID_A_LON,
          technology: "WIND",
          representedMw: 1000,
          provisional: false,
        },
        {
          id: CENTROID_B,
          label: "Solar",
          latitude: CENTROID_B_LAT,
          longitude: CENTROID_B_LON,
          technology: "SOLAR",
          representedMw: 1000,
          provisional: false,
        },
      ],
    });
    // The view is read under the axes the gate writes, and through the function
    // that writes them: there is no second opinion here about what "at the gate"
    // means either.
    const fromSql = await db.transaction(async (tx) => {
      await tx.execute(sql`select feature_apply_gate(${TARGET}::date, 'gate_late')`);
      return [
        ...(await tx.execute<{
          subsystem: string;
          technology: string;
          centroid_id: string;
          weight: number;
          capacity_mw: number;
        }>(sql`
          select subsystem, technology::text as technology, centroid_id,
                 weight, capacity_mw
          from canonical_capacity_weight
        `)),
      ];
    });

    const fromTs = weights.vectors
      .flatMap((vector) =>
        vector.cells.map((cell) => ({
          subsystem: vector.subsystem,
          technology: vector.technology,
          centroid_id: cell.centroidId,
          weight: cell.weight,
          capacity_mw: cell.capacityMw,
        })),
      )
      .toSorted((a, b) =>
        `${a.subsystem}|${a.technology}|${a.centroid_id}`.localeCompare(
          `${b.subsystem}|${b.technology}|${b.centroid_id}`,
        ),
      );

    const sorted = fromSql.toSorted((a, b) =>
      `${a.subsystem}|${a.technology}|${a.centroid_id}`.localeCompare(
        `${b.subsystem}|${b.technology}|${b.centroid_id}`,
      ),
    );

    expect(sorted.length).toBeGreaterThan(0);
    expect(sorted.length).toBe(fromTs.length);
    sorted.forEach((row, index) => {
      const mirror = fromTs[index];
      expect({
        subsystem: row.subsystem,
        technology: row.technology,
        centroid_id: row.centroid_id,
      }).toEqual({
        subsystem: mirror?.subsystem as string,
        technology: mirror?.technology as string,
        centroid_id: mirror?.centroid_id as string,
      });
      expect(Number(row.weight)).toBeCloseTo(mirror?.weight ?? Number.NaN, 12);
      expect(Number(row.capacity_mw)).toBeCloseTo(mirror?.capacity_mw ?? Number.NaN, 9);
    });
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
    const dayBefore = await rowsForDay(TARGET_MINUS_1);
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
    const later = await rowsForDay(AFTER_GO_LIVE);
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
    const before = await rowsForDay(BEFORE_GO_LIVE);
    for (const row of before) {
      expect(row.vintage_fidelity).toBe("revision_optimistic");
    }

    // A target date after every source's go-live is honestly point-in-time,
    // even though it has no rows in either source — fidelity is a claim about
    // what WattSteer was watching, not about what it found.
    const after = await rowsForDay(AFTER_GO_LIVE);
    for (const row of after) {
      expect(row.vintage_fidelity).toBe("point_in_time");
    }
  });

  it("never stamps point_in_time on a row built under a relaxed ingestion cut", async () => {
    // Ticket 15's invariant, and the thing that keeps its repair honest.
    //
    // Over the backfill window `feature_as_of` suspends the ingestion cut
    // entirely — `ingested_at` there is the loader's clock, and cutting on it
    // returned zero rows rather than fewer ones. The relaxation is bounded by
    // `feature_ingestion_history_from()`, the latest go-live across the
    // canonical reads, and it is deliberately loose in one band: a gate between
    // the first source's go-live and the last one's relaxes the cut for sources
    // that were already live.
    //
    // So the stamp carries it. `point_in_time` means, exactly, that this row
    // was built under `as_of = gate` with nothing relaxed — which is asserted
    // here as the equality it is, against the two functions themselves, rather
    // than trusted to stay true as more sources are onboarded.
    for (const targetDate of [TARGET, BEFORE_GO_LIVE, AFTER_GO_LIVE]) {
      const [axes] = [
        ...(await db.execute<{ as_of: string; gate: string }>(sql`
          select feature_as_of(${targetDate}::date, 'gate_late')::text as as_of,
                 gate_at(${targetDate}::date, 'gate_late')::text as gate
        `)),
      ];
      const unrelaxed = axes?.as_of === axes?.gate;
      const rows = await rowsForDay(targetDate);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        if (row.vintage_fidelity === "point_in_time") {
          expect({ targetDate, unrelaxed }).toEqual({ targetDate, unrelaxed: true });
        }
      }
    }

    // Non-vacuous in both directions: the fixture really does straddle the
    // horizon, so this is not three passes of the same regime.
    const [regimes] = [
      ...(await db.execute<{ relaxed: boolean; strict: boolean }>(sql`
        select feature_as_of(${BEFORE_GO_LIVE}::date, 'gate_late')
                 <> gate_at(${BEFORE_GO_LIVE}::date, 'gate_late') as relaxed,
               feature_as_of(${AFTER_GO_LIVE}::date, 'gate_late')
                 = gate_at(${AFTER_GO_LIVE}::date, 'gate_late') as strict
      `)),
    ];
    expect(regimes).toEqual({ relaxed: true, strict: true });
  });

  /**
   * The vintaged sources a feature row reads — **asked, not listed.**
   *
   * `feature_rows` named seven canonical reads one at a time until
   * data-platform 20, and the list was one short: `canonical_plant_registry`
   * reads `plant_geo` under `canonical_as_of()` and stands behind every weather
   * feature through `canonical_capacity_weight`, and `plant_geo` was in no row
   * of `canonical_read_go_live` at all. So the stamp is now the weakest link
   * over `feature_source_go_live()`, and this suite reads the same function
   * rather than restating the list it replaced.
   *
   * Two reads are still absent from it, and that absence is the narrowing:
   * `curtailment-by-plant` feeds `canonical_curtailment_by_plant`, which no
   * feature composes — the labels come from the reporting-entity read — and
   * `conjunto-membership` feeds `canonical_conjunto_membership`, which no
   * feature composes either. The last test in this group measures that, out of
   * a real build's scan counters, rather than trusting it.
   */
  const featureSources = async (
    scope: Database = db,
  ): Promise<Map<string, string | null>> =>
    new Map(
      [
        ...(await scope.execute<{ source_table: string; go_live_at: string | null }>(
          sql`select source_table, go_live_at::text from feature_source_go_live()`,
        )),
      ].map((row) => [row.source_table, row.go_live_at]),
    );

  /**
   * The vintaged tables a piece of SQL actually scans, from Postgres' own
   * per-transaction scan counters.
   *
   * The derivation `feature_source_go_live()` performs is a scan of the feature
   * functions' source text, because a plpgsql body records no catalogue
   * dependency on the views it reads. A missed source would be the unsafe
   * direction — a row claiming `point_in_time` against a source that was not
   * live — so it is measured here instead of reasoned about: whatever the build
   * touches, the counters know.
   */
  const vintagedTablesScannedBy = async (
    scope: Database,
    statement: ReturnType<typeof sql>,
  ): Promise<string[]> => {
    // A **delta**, because the counters are pending session statistics and a
    // rolled-back transaction on the same pooled connection leaves its own
    // scans in them. Measured as a difference, the only scans left are the
    // statement's own.
    const counters = async (): Promise<Map<string, number>> =>
      new Map(
        [
          ...(await scope.execute<{ relname: string; scans: number }>(sql`
            select c.relname, pg_stat_get_xact_numscans(c.oid)::int as scans
            from pg_class c
            where c.relkind = 'r'
              and c.relnamespace = 'public'::regnamespace
              and exists (
                select 1 from pg_attribute a
                where a.attrelid = c.oid and a.attname = 'ingested_at'
                  and a.attnum > 0 and not a.attisdropped
              )
          `)),
        ].map((row) => [row.relname, row.scans]),
      );
    const before = await counters();
    await scope.execute(statement);
    const after = await counters();
    return [...after.entries()]
      .filter(([table, scans]) => scans > (before.get(table) ?? 0))
      .map(([table]) => table)
      .sort();
  };

  it("gates every hour of the day it gates from before it, at both profiles", async () => {
    // Ticket 16's load-bearing lemma, and the only thing about it that could
    // ever stop being true.
    //
    // Both gate profiles are D−1 wall-clock hours — 09:00 and 19:00 BRT — and
    // the earliest hour they gate is 00:00 BRT on D. So the gate precedes every
    // `valid_time` in the row spine it decides, by five hours at the closest.
    // That is why `gate >= X` implies `valid_time >= X` for any X, which is
    // what collapses the per-source floor into the horizon the tree already
    // has; the test below measures the collapse and this one measures its
    // premise.
    //
    // Sixteen DST-free years of it, because if Brazil reinstates summer time or
    // a profile is ever moved past midnight the premise is what breaks first.
    const [gaps] = [
      ...(await db.execute<{
        rows_checked: number;
        min_gap: string;
        violations: number;
      }>(sql`
        select count(*)::int as rows_checked,
               min(h.valid_time - gate_at(d.target_date, p.gate_profile))::text as min_gap,
               count(*) filter (
                 where h.valid_time <= gate_at(d.target_date, p.gate_profile)
               )::int as violations
        from (
          select generate_series('2020-01-01'::date, '2035-12-31'::date, interval '1 day')::date
                 as target_date
        ) d
        cross join (select unnest(array['gate_early', 'gate_late']) as gate_profile) p
        cross join lateral feature_local_day_hours(d.target_date) as h(valid_time)
      `)),
    ];
    expect(gaps?.rows_checked).toBe(280_512);
    expect(gaps?.violations).toBe(0);
    expect(gaps?.min_gap).toBe("05:00:00");
  });

  it("stamps every row exactly as a per-source ingestion floor would", async () => {
    // **Ticket 16's measurement, as a property.** The ticket asks how many rows
    // now read `revision_optimistic` that a floor per source rather than per
    // deployment would make `point_in_time`. The answer is none, and this is
    // why rather than a count that happened to come out zero.
    //
    // `feature_as_of` relaxes the ingestion cut for a gate before
    // `feature_ingestion_history_from()`, the **latest** go-live across the
    // canonical reads, and `0039` recorded the cost: in the band between the
    // first go-live and the last, a source that was already ingesting gets its
    // cut relaxed when it need not be. True — and it moves no stamp. A
    // per-source floor would stamp `point_in_time` exactly when every read the
    // row uses was live at the gate, `gate >= go_live(s)` for all s, which is
    // `gate >= max(go_live)`; and by the lemma above that already implies the
    // seven `valid_time >= go_live(s)` conjuncts the stamp is made of. The two
    // rules are the same predicate written twice.
    //
    // So this asserts the *shipped* stamp against the per-source predicate,
    // computed from `feature_source_go_live()` rather than restated, over the
    // fixture's three target dates — which straddle the horizon, so both
    // answers occur.
    const goLive = await featureSources();
    // Non-vacuous, and the one source data-platform 20 added: the predicate
    // below is over eight tables, not the seven `feature_rows` used to name.
    expect([...goLive.keys()].sort()).toContain("plant_geo");

    const seen = new Set<boolean>();
    for (const targetDate of [BEFORE_GO_LIVE, TARGET, AFTER_GO_LIVE]) {
      const [gate] = [
        ...(await db.execute<{ gate: string }>(
          sql`select gate_at(${targetDate}::date, 'gate_late')::text as gate`,
        )),
      ];
      const gateAt = new Date(gate?.gate as string).getTime();
      // The floor a source can honestly carry: it was live at the gate, and it
      // has a go-live at all. A source that has ingested nothing keeps the
      // `revision_optimistic` answer `feature_vintage_fidelity` already gives.
      const perSourceFloor = [...goLive.values()].every(
        (at) => at !== null && at !== undefined && new Date(at).getTime() <= gateAt,
      );
      seen.add(perSourceFloor);

      const rows = await rowsForDay(targetDate);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect({ targetDate, stamp: row.vintage_fidelity }).toEqual({
          targetDate,
          stamp: perSourceFloor ? "point_in_time" : "revision_optimistic",
        });
      }
    }
    // Non-vacuous: the fixture really does straddle the floor.
    expect([...seen].sort()).toEqual([false, true]);
  });

  it("no longer carries the horizon over reads no feature block reads", async () => {
    // The band where the two rules parted company, closed by data-platform 20.
    //
    // `feature_ingestion_history_from()` was the latest go-live across all
    // **nine** rows of `canonical_read_go_live`, two of which —
    // `curtailment-by-plant` and `conjunto-membership` — are read by no feature
    // block. Onboarding one of *those* last stamped `revision_optimistic` on
    // every target date in between although every source the row reads was live
    // at its gate: feature-engineering 16 measured 11,904 rows over 62 target
    // dates in its scenario C, and left the wide horizon standing anyway,
    // because it was the only cover for `plant_geo` — which had no go-live row
    // at all.
    //
    // With the go-live set derived, the horizon is over the sources a feature
    // row reads. This is the same fixture with the same late
    // `conjunto-membership` go-live, asserting the opposite answer: the row is
    // point-in-time, because nothing it reads was ingested after its gate.
    let stamped: string | undefined;
    let horizonMoved: boolean | undefined;
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await scoped.execute(sql`
          insert into conjunto
            (ons_conjunto_code, name, subsystem, state_code, source_type_code)
          values ('FE16_CONJ', 'fe16', 'NE', 'BA', 'EOL')
        `);
        await scoped.execute(sql`
          insert into conjunto_membership
            (plant_ons_code, conjunto_code, member_from, data_version, published_at,
             published_at_precision, ingested_at, value_digest, source_version_id)
          values ('FE16_PLANT', 'FE16_CONJ', '2026-01-01T00:00:00.000Z', 1,
                  '2026-01-01T00:00:00.000Z', 'row', '2027-01-01T00:00:00.000Z', 'd',
                  ${curtailmentVersionId}::uuid)
        `);
        // Non-vacuous in the way that matters: that row really is a later
        // go-live than the horizon, so the nine-read rule would have moved.
        const [reach] = [
          ...(await scoped.execute<{ moved: boolean }>(sql`
            select (select max(go_live_at) from canonical_read_go_live)
                     > feature_ingestion_history_from() as moved
          `)),
        ];
        horizonMoved = reach?.moved;
        const rows = await readFeatureRows(scoped, {
          targetFrom: AFTER_GO_LIVE,
          targetTo: AFTER_GO_LIVE,
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
    expect(horizonMoved).toBe(true);
    // `revision_optimistic` before `0040`, on this same fixture.
    expect(stamped).toBe("point_in_time");
  });

  it("counts plant_geo's go-live in the fidelity stamp, the source that had no row", async () => {
    // The ticket's own finding, as the property it should always have been.
    //
    // `canonical_plant_registry` reads `plant_geo` under `canonical_as_of()`
    // and `canonical_capacity_weight` reads the registry, so the location cut
    // stands behind **every weather feature** — the weights are read from it.
    // Before `0040` it was in no row of `canonical_read_go_live`, so moving it
    // past the gate changed the weather and left the stamp saying
    // `point_in_time`. Everything else is held still, exactly as the
    // `generating_unit` test above holds everything but the registry still.
    let stamped: string | undefined;
    let derived: string | null | undefined;
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await scoped.execute(
          sql`update plant_geo set ingested_at = '2026-09-15T00:00:00.000Z'`,
        );
        derived = (await featureSources(scoped)).get("plant_geo");
        const rows = await readFeatureRows(scoped, {
          targetFrom: AFTER_GO_LIVE,
          targetTo: AFTER_GO_LIVE,
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
    expect(new Date(derived as string).toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(stamped).toBe("revision_optimistic");
  });

  it("reads no vintaged table it has no go-live for, measured on the scan counters", async () => {
    // The guard on the one derivation the catalogue cannot perform, and the
    // acceptance criterion as a measurement: **whatever the build reads, it has
    // a go-live for.**
    //
    // `feature_source_go_live()` finds the feature layer's sources by matching
    // canonical view names against the `feature_%` functions' own source,
    // because a plpgsql body records no dependency on the views it reads. A
    // false positive there is safe — a wider set is a later horizon and an
    // earlier weakest link. A miss is not, so it is not argued: Postgres'
    // per-transaction scan counters say which tables were actually touched.
    //
    // The whole build is measured, and the two reads the narrowed horizon
    // dropped are asserted *absent* from the scan — which is what makes
    // dropping them sound rather than convenient.
    let touched: string[] = [];
    let derived: string[] = [];
    let blockTouched: string[] = [];
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        derived = [...(await featureSources(scoped)).keys()].sort();
        blockTouched = await vintagedTablesScannedBy(
          scoped,
          sql`select count(*) from feature_weather_block(${TARGET}::date, 'gate_late')`,
        );
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        touched = await vintagedTablesScannedBy(
          scoped,
          sql`select count(*) from feature_rows(${TARGET}::date, ${TARGET}::date,
                'gate_late', 'dessem_augmented_v1', 1.0)`,
        );
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    // Every vintaged table the build scanned has a go-live in the derived set.
    expect(touched.filter((table) => !derived.includes(table))).toEqual([]);
    expect(touched.length).toBeGreaterThan(0);
    // The class-`W` block on its own reaches the registry's location cut
    // through the capacity weights, and that is the path that had no go-live
    // row. Measured, rather than read off the SQL.
    expect(blockTouched).toContain("plant_geo");
    expect(blockTouched.filter((table) => !derived.includes(table))).toEqual([]);
    // And the two reads the horizon stopped carrying really are unread: a build
    // that scanned either of them would make the narrowing unsound.
    expect(touched).not.toContain("plant_detail_hour");
    expect(touched).not.toContain("conjunto_membership");
  });

  it("leaves nothing behind, memo included, when it hands the axes back", async () => {
    // `feature_ingestion_history_from()` memoises its answer in a
    // transaction-local setting, because the set behind it is a catalogue walk
    // and an unindexed `min()` per source, and it is asked once per block per
    // target date. The memo is
    // not a read axis and no view consults it — but "a feature build leaves
    // nothing behind" is a better sentence without an exception in it, so
    // `feature_release_axes` clears it too.
    let leftover: string | null | undefined;
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await readServingRows(scoped, { targetDate: TARGET, ...query });
        const left = await scoped.execute<{ memo: string | null }>(
          sql`select nullif(
                current_setting('wattsteer.feature_ingestion_history_from', true), ''
              ) as memo`,
        );
        leftover = [...left][0]?.memo;
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    expect(leftover).toBeNull();
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
        // The training call, because hiding the registry hides the capacity
        // weights with it and the serve-time contract would refuse the day
        // before the stamp could be read. That refusal is the right answer to a
        // fleet nobody can see; it is not the question this test asks.
        const rows = await readFeatureRows(scoped, {
          targetFrom: AFTER_GO_LIVE,
          targetTo: AFTER_GO_LIVE,
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

  // ------------------------------------------------------- lagged actuals (K)
  it("resolves the cutoff from the gate and the configured lag, and refuses an unknown dataset", async () => {
    // `actuals_cutoff(gate, dataset) = gate - publication_lag_hours[dataset]`,
    // with the gate derived from the target date rather than handed in. Forty
    // hours from 2026-08-19 19:00 BRT lands at 2026-08-18 03:00 BRT: no hour of
    // D-1 is assumed available at all.
    const rows = await db.execute<{ cutoff: string; early: string }>(sql`
      select actuals_cutoff(${TARGET}::date, 'gate_late', 'restricao-coff') as cutoff,
             actuals_cutoff(${TARGET}::date, 'gate_early', 'restricao-coff') as early
    `);
    const [row] = [...rows];
    expect(new Date(row?.cutoff ?? 0).toISOString()).toBe(CUTOFF.toISOString());
    // The early gate is ten hours earlier, so its cutoff is too.
    expect(new Date(row?.early ?? 0).toISOString()).toBe("2026-08-17T20:00:00.000Z");

    // An unmeasured latency must not become an unmeasured leak: an unknown
    // dataset raises rather than defaulting to a zero-hour lag, which would be
    // an unfiltered observation read that looks exactly like a correct answer.
    const outcome = await db
      .execute(
        sql`select actuals_cutoff(${TARGET}::date, 'gate_late', 'carga-inventada')`,
      )
      .then(
        () => "resolved",
        (error: unknown) => sqlStateOf(error),
      );
    expect(outcome).toBe("22023");
  });

  it("cuts the lagged actuals on valid_time, where neither vintage axis would", async () => {
    // The claim the whole ticket rests on. The decoy hour is six hours past the
    // cutoff, carries 555 MWh, and was both published and ingested before the
    // gate - so `AsOf(gate)` returns it and `published_at <= gate` returns it.
    // It is the t-48 h of the hour asserted below, and it appears nowhere.
    const [{ visible }] = [
      ...(await db.execute<{ visible: number }>(sql`
        select count(*)::int as visible from curtailment_report_hour
        where valid_time = ${D_MINUS_2_NOON.toISOString()}::timestamptz
          and published_at <= ${GATE_LATE.toISOString()}::timestamptz
          and ingested_at <= ${GATE_LATE.toISOString()}::timestamptz
      `)),
    ] as [{ visible: number }];
    expect(visible).toBeGreaterThan(0);

    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const values = rows.flatMap((row) => [
      row.observed_constrained_off_lag_48h,
      row.observed_constrained_off_lag_168h,
      row.observed_constrained_off_same_hour_mean_7d,
      row.observed_constrained_off_total_7d_mwh,
      row.observed_load_lag_168h,
      row.observed_net_exchange_mean_24h_to_cutoff,
      row.observed_corridor_flow_ne_se_lag_168h,
    ]);
    for (const forbidden of [555, 700, 8888, 9999]) {
      expect({ forbidden, present: values.some((v) => Number(v) === forbidden) }).toEqual(
        {
          forbidden,
          present: false,
        },
      );
    }
  });

  it("carries the D-7 levels, and the windows that end at the cutoff", async () => {
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const at = (subsystem: string, validTime: Date): FeatureRow => {
      const found = rows.find(
        (row) =>
          row.subsystem === subsystem &&
          new Date(row.valid_time).getTime() === validTime.getTime(),
      );
      expect(found).toBeDefined();
      return found as FeatureRow;
    };

    const noon = at("NE", HOUR_CURTAILED);
    // t-168 h: 6 MWh of wind and 3 of solar on 2026-08-13 at the same local hour.
    expect(Number(noon.observed_constrained_off_lag_168h)).toBe(9);
    expect(Number(noon.observed_constrained_off_wind_lag_168h)).toBe(6);
    expect(Number(noon.observed_constrained_off_solar_lag_168h)).toBe(3);
    // The same local hour over the seven days ending at the cutoff: 9 and 3.
    // The 555 MWh hour past the cutoff is the third occurrence and is absent,
    // which is the `168 PRECEDING AND 1 PRECEDING` frame doing its one job.
    expect(Number(noon.observed_constrained_off_same_hour_mean_7d)).toBe(6);
    // Every hour of the trailing week: 9 + 3 + 3. Neither decoy is in it.
    expect(Number(noon.observed_constrained_off_total_7d_mwh)).toBe(15);
    // One of those three hours is above the 5 MW threshold.
    expect(Number(noon.observed_constrained_off_hours_above_threshold_7d)).toBe(1);
    // The occurrence twin of the same-hour mean, over the *same two* same-local-
    // hour observations rather than over all the hours of the week: 9 is above
    // the 5 MW threshold and 3 is not. It is a different number from the hours
    // count beside it, and that difference is the whole reason forecaster.md's
    // rung 1 needs its own column - the hours count is day grain over 168 hours,
    // and this is hourly over seven observations of one local hour.
    expect(Number(noon.observed_constrained_off_same_hour_exceedance_7d)).toBeCloseTo(
      0.5,
      10,
    );
    // The balance series, same hour, seven days back.
    expect(Number(noon.observed_load_lag_168h)).toBe(1000);
    expect(Number(noon.observed_wind_generation_lag_168h)).toBe(70);
    expect(Number(noon.observed_solar_generation_lag_168h)).toBe(20);
    expect(Number(noon.observed_net_exchange_lag_168h)).toBe(150);
    // The last 24 available hours hold one balance row, at 50 MWh.
    expect(Number(noon.observed_net_exchange_mean_24h_to_cutoff)).toBe(50);
    // Realised fleet CF: (70 + 42) / 2 over 140 MW, (20 + 12) / 2 over 40 MW.
    // The denominator is the fleet of the *last available day*, so UG3 - which
    // enters service on the target date - is not in it.
    expect(Number(noon.observed_wind_capacity_factor_mean_7d)).toBeCloseTo(0.4, 10);
    expect(Number(noon.observed_solar_capacity_factor_mean_7d)).toBeCloseTo(0.4, 10);
    // Directed corridor flow, in the canonical orientation, seven days back.
    expect(Number(noon.observed_corridor_flow_ne_se_lag_168h)).toBe(500);
    expect(Number(noon.observed_corridor_flow_n_ne_lag_168h)).toBe(200);
    // Four reason-carrying entity-hours in the week: two ENE, one CNF, one REL.
    expect(Number(noon.observed_reason_share_ene_7d)).toBeCloseTo(0.5, 10);
    expect(Number(noon.observed_reason_share_cnf_7d)).toBeCloseTo(0.25, 10);
    expect(Number(noon.observed_reason_share_rel_7d)).toBeCloseTo(0.25, 10);
    // The three shares sum to one because `PAR` has never been observed. The day
    // it is, they will not - which is the monitoring signal, not a class.
    expect(
      Number(noon.observed_reason_share_ene_7d) +
        Number(noon.observed_reason_share_cnf_7d) +
        Number(noon.observed_reason_share_rel_7d),
    ).toBeCloseTo(1, 10);

    // A subsystem with no observations is null, not zero - and the corridors,
    // which are system facts rather than properties of one end, are not.
    const elsewhere = at("S", HOUR_CURTAILED);
    expect(elsewhere.observed_constrained_off_lag_168h).toBeNull();
    expect(elsewhere.observed_constrained_off_total_7d_mwh).toBeNull();
    expect(elsewhere.observed_wind_capacity_factor_mean_7d).toBeNull();
    expect(elsewhere.observed_reason_share_ene_7d).toBeNull();
    expect(Number(elsewhere.observed_corridor_flow_ne_se_lag_168h)).toBe(500);
  });

  it("counts the same-hour exceedance strictly, as the label does", async () => {
    // The spec's class-`K` table wrote "at or above `threshold_mw`", and this
    // column is deliberately not that. `y_has_curtailment` is
    // `total > threshold_mw`, and so is
    // `observed_constrained_off_hours_above_threshold_7d` - `drizzle/0021`
    // argued for the strict comparison explicitly, so the >1 / >5 / >10 sweep
    // cannot make a feature and the label disagree about what curtailment is.
    // This column is the occurrence *baseline for that label*, so a boundary
    // hour it counted and the label did not would be exactly the disagreement
    // forecaster.md computes rung 1 from the feature function to avoid.
    //
    // The two same-local-hour observations behind NE's noon are 9 and 3 MWh, so
    // a threshold of exactly 3 separates the two readings completely: `> 3` is
    // one of two, `>= 3` would be two of two. There is no rounding here to hide
    // behind.
    const rows = await readServingRows(db, {
      targetDate: TARGET,
      ...query,
      thresholdMw: 3,
    });
    const noon = rows.find(
      (row) =>
        row.subsystem === "NE" &&
        new Date(row.valid_time).getTime() === HOUR_CURTAILED.getTime(),
    );
    expect(Number(noon?.observed_constrained_off_same_hour_exceedance_7d)).toBeCloseTo(
      0.5,
      10,
    );
    // And it moves with the threshold rather than being fixed at build time -
    // the argument reaches this column exactly as it reaches the hours count.
    const strict = await readServingRows(db, {
      targetDate: TARGET,
      ...query,
      thresholdMw: 10,
    });
    expect(
      Number(
        strict.find(
          (row) =>
            row.subsystem === "NE" &&
            new Date(row.valid_time).getTime() === HOUR_CURTAILED.getTime(),
        )?.observed_constrained_off_same_hour_exceedance_7d,
      ),
    ).toBe(0);
  });

  it("yields NULL for a lag that does not clear the cutoff, and never slides", async () => {
    // The fixture test the spec asks for by name. At `gate_late` the cutoff is
    // 2026-08-18 03:00 BRT, so t-48 h clears it only for the first local hour
    // of the day and is NULL for the other twenty-three - and the NULL is a
    // NULL, not the nearest available hour wearing a 48-hour label.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");

    const first = ne.find(
      (row) => new Date(row.valid_time).getTime() === HOUR_FIRST.getTime(),
    );
    expect(Number(first?.observed_constrained_off_lag_48h)).toBe(3);

    const noon = ne.find(
      (row) => new Date(row.valid_time).getTime() === HOUR_CURTAILED.getTime(),
    );
    expect(noon?.observed_constrained_off_lag_48h).toBeNull();

    const cleared = ne.filter((row) => row.observed_constrained_off_lag_48h !== null);
    expect(cleared).toHaveLength(1);

    // At the early gate the cutoff is ten hours earlier still, so no hour of the
    // day can reach a t-48 h at all.
    const early = await readServingRows(db, {
      targetDate: TARGET,
      ...query,
      gateProfile: "gate_early",
    });
    for (const row of early) {
      expect(row.observed_constrained_off_lag_48h).toBeNull();
    }
  });

  it("tells the model how stale its own backward view is", async () => {
    // `valid_time - actuals_cutoff`, in hours. The model is given the distance
    // to the last actual it was allowed to see rather than left to assume the
    // lag is constant - it is not, and it moves by ten hours between profiles.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const noon = rows.find(
      (row) =>
        row.subsystem === "NE" &&
        new Date(row.valid_time).getTime() === HOUR_CURTAILED.getTime(),
    );
    expect(Number(noon?.observed_actual_lag_hours)).toBeCloseTo(54, 10);

    const first = rows.find(
      (row) =>
        row.subsystem === "NE" &&
        new Date(row.valid_time).getTime() === HOUR_FIRST.getTime(),
    );
    expect(Number(first?.observed_actual_lag_hours)).toBeCloseTo(45, 10);
    // Never negative: the backward view is behind the row by construction.
    for (const row of rows) {
      expect(Number(row.observed_actual_lag_hours)).toBeGreaterThan(0);
    }
  });

  it("broadcasts the cutoff-anchored windows identically across the 24 hours", async () => {
    // Day grain, and the reason the dictionary marks it: these windows are
    // anchored to the cutoff rather than to the target hour, so they carry one
    // value for the whole day. Read as an hourly signal they are a constant a
    // model will find intraday structure in.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");
    for (const column of [
      "observed_constrained_off_total_7d_mwh",
      "observed_constrained_off_hours_above_threshold_7d",
      "observed_net_exchange_mean_24h_to_cutoff",
      "observed_reason_share_ene_7d",
    ] as const) {
      const distinct = new Set(ne.map((row) => Number(row[column])));
      expect({ column, distinct: distinct.size }).toEqual({ column, distinct: 1 });
    }
    // The same-hour mean is *not* day grain, and this fixture proves it can
    // vary: 12:00Z has samples and the rest of the day does not.
    expect(
      new Set(ne.map((row) => row.observed_constrained_off_same_hour_mean_7d)).size,
    ).toBeGreaterThan(1);
  });

  // ------------------------------------------------------- class `P`, the spine
  it("carries the programmed profile, summed back to the hour", async () => {
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");
    const se = rows.filter((row) => row.subsystem === "SE");

    // Every hour of the day, for both subsystems that have a programme. This is
    // the acceptance claim: the spine is non-null across the window it covers.
    expect(ne).toHaveLength(24);
    expect(ne.every((row) => row.programmed_load_mwh !== null)).toBe(true);
    expect(se.every((row) => row.programmed_load_mwh !== null)).toBe(true);
    // …and it is the *sum* of the two half hours ONS publishes, not one of
    // them and not their mean. Each half carries half the hourly value, so a
    // mean would come back at half the size and look entirely plausible.
    const byHour = new Map(
      ne.map((row) => [new Date(row.valid_time).toISOString(), row]),
    );
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date(DAY_FROM.getTime() + hour * 3_600_000).toISOString();
      expect({ at, mwh: byHour.get(at)?.programmed_load_mwh }).toEqual({
        at,
        mwh: NE_PROGRAMMED(hour),
      });
    }

    // A subsystem with no programme is a hole, not a zero — and the two that
    // have one do not share a profile.
    expect(
      rows.filter((row) => row.subsystem === "S" || row.subsystem === "N"),
    ).toHaveLength(48);
    for (const row of rows.filter((r) => r.subsystem === "S")) {
      expect(row.programmed_load_mwh).toBeNull();
      expect(row.programmed_load_rank_in_day).toBeNull();
    }
  });

  it("derives the shape inside the profile, and stops at the day's edges", async () => {
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = new Map(
      rows
        .filter((row) => row.subsystem === "NE")
        .map((row) => [new Date(row.valid_time).toISOString(), row]),
    );
    const at = (instant: Date) => ne.get(instant.toISOString());

    // A ramp inside a profile whose whole day is published at once. NE rises by
    // a flat 10 MWh an hour, so any window that had slipped by one would show.
    const noon = at(HOUR_CURTAILED);
    expect(noon?.programmed_load_ramp_1h).toBeCloseTo(10, 6);
    expect(noon?.programmed_load_mean_3h).toBeCloseTo(NE_PROGRAMMED(9), 6);

    // The near edge: the first hour of the local day has no predecessor inside
    // its own publication, so it has no ramp and no centred mean.
    expect(at(HOUR_FIRST)?.programmed_load_mwh).toBeCloseTo(NE_PROGRAMMED(0), 6);
    expect(at(HOUR_FIRST)?.programmed_load_ramp_1h).toBeNull();
    expect(at(HOUR_FIRST)?.programmed_load_mean_3h).toBeNull();

    // The far edge, and the one that would be a leak rather than a wrong
    // number: the hour after 23:00 belongs to D+1's programme, published at
    // D 15:00 BRT — four hours *after* this row's gate. It is in the fixture,
    // it is enormous, and the centred mean must not have found it.
    expect(at(HOUR_LAST)?.programmed_load_ramp_1h).toBeCloseTo(10, 6);
    expect(at(HOUR_LAST)?.programmed_load_mean_3h).toBeNull();
  });

  it("summarises the day, and says which hour of it this is", async () => {
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");
    const se = rows.filter((row) => row.subsystem === "SE");

    // Day grain: one number for the whole date, broadcast identically.
    expect(new Set(ne.map((row) => row.programmed_load_daily_min_mwh))).toEqual(
      new Set([NE_PROGRAMMED(0)]),
    );
    // The two subsystems' profiles run in opposite directions, so a minimum
    // computed across subsystems rather than within one would collapse here.
    expect(new Set(se.map((row) => row.programmed_load_daily_min_mwh))).toEqual(
      new Set([SE_PROGRAMMED(23)]),
    );

    // Rank is hourly, ascending, and partitioned by subsystem: NE's trough is
    // its first local hour and SE's is its last.
    const rank = (rowsOf: typeof ne, instant: Date) =>
      rowsOf.find((row) => new Date(row.valid_time).getTime() === instant.getTime())
        ?.programmed_load_rank_in_day;
    expect(rank(ne, HOUR_FIRST)).toBe(1);
    expect(rank(ne, HOUR_LAST)).toBe(24);
    expect(rank(se, HOUR_FIRST)).toBe(24);
    expect(rank(se, HOUR_LAST)).toBe(1);
  });

  it("holds a programme back until its own gate, and never past it", async () => {
    // The whole publication decision, as a property of two rows rather than a
    // paragraph. `gate_late` is D−1 19:00 BRT and the programme is stamped
    // D−1 15:00 BRT, so `TARGET` sees its own programme and D−1 sees the one
    // published the day before that — but no target date ever sees the
    // programme of the day after it, because that one is published at D 15:00.
    const late = await readServingRows(db, { targetDate: TARGET, ...query });
    const noon = late.find(
      (row) =>
        row.subsystem === "NE" &&
        new Date(row.valid_time).getTime() === HOUR_CURTAILED.getTime(),
    );
    // And the restatement ingested after the gate did not win, even though its
    // `published_at` is identical to the original's: the as-of axis is what
    // keeps a later revision out, which is exactly the division of labour the
    // derived stamp makes necessary.
    expect(noon?.programmed_load_mwh).toBeCloseTo(NE_PROGRAMMED(9), 6);

    // `gate_early` is D−1 09:00 BRT, four hours *before* the programme is taken
    // to be published, so every class-`P` column is NULL there. That is the
    // visible hole this ticket reports rather than papers over: assuming an
    // earlier hour with no measurement behind it would be a leak into a model
    // that cannot be served at 09:00.
    const early = await readServingRows(db, {
      targetDate: TARGET,
      ...query,
      gateProfile: "gate_early",
    });
    expect(early.length).toBe(late.length);
    for (const row of early) {
      expect(row.programmed_load_mwh).toBeNull();
      expect(row.programmed_load_ramp_1h).toBeNull();
      expect(row.programmed_load_mean_3h).toBeNull();
      expect(row.programmed_load_daily_min_mwh).toBeNull();
      expect(row.programmed_load_rank_in_day).toBeNull();
    }
  });

  it("refuses to store a programme published after the half hour it programmes", async () => {
    // `docs/domain-model.md` §4's discriminator, enforced by the database
    // rather than by the adapter's good manners. This is the shape the fetch
    // instant produced for every backfilled row, and it is now unrepresentable.
    let sqlstate: string | undefined;
    try {
      await db.execute(sql`
        insert into programmed_load_half_hour (
          area_code, area_kind, subsystem, valid_time, programmed_load_mwh,
          data_version, published_at, published_at_precision, value_digest,
          source_request_id
        )
        select 'NE', 'SUBSYSTEM', 'NE', ${HOUR_QUIET.toISOString()}::timestamptz, 1,
               99, ${HOUR_QUIET.toISOString()}::timestamptz + interval '1 day',
               'file', 'not-a-real-digest', id
        from load_api_request limit 1
      `);
    } catch (error) {
      sqlstate = sqlStateOf(error);
    }
    // 23514 — check_violation.
    expect(sqlstate).toBe("23514");
  });

  // ----------------------------------------------------- class `D`, the A/B arm
  //
  // Every test below asks for `dessem_augmented_v1`, because that is the only
  // set in which these columns exist and the only gate at which they can.
  const augmented = { ...query, featureSet: "dessem_augmented_v1" } as const;

  const dessemRows = async (targetDate: string) =>
    readServingRows(db, { targetDate, ...augmented });

  const neAt = (rows: FeatureRow[], hour: number): FeatureRow | undefined => {
    const at = new Date(DAY_FROM.getTime() + hour * 3_600_000).getTime();
    return rows.find(
      (row) => row.subsystem === "NE" && new Date(row.valid_time).getTime() === at,
    );
  };

  it("carries the balance, averaged from MW back to the hour's MWh", async () => {
    const rows = await dessemRows(TARGET);
    // Every subsystem has a profile, and every hour of it is present.
    for (const subsystem of ["N", "NE", "S", "SE"] as const) {
      const of = rows.filter((row) => row.subsystem === subsystem);
      expect(of).toHaveLength(24);
      expect({
        subsystem,
        complete: of.every((row) => row.dessem_demand_mwh !== null),
      }).toEqual({ subsystem, complete: true });
    }

    // The seven levels, at one hour, against the profile's own arithmetic. The
    // two half hours are the hourly value ∓2 MW, so a sum would be double, the
    // first half two low and the last two high — three wrong answers, none of
    // them this one.
    const mw = DESSEM_PROFILE.NE(9);
    const noon = neAt(rows, 9);
    expect(noon?.dessem_demand_mwh).toBeCloseTo(mw.demand, 6);
    expect(noon?.dessem_wind_mwh).toBeCloseTo(mw.wind, 6);
    expect(noon?.dessem_solar_mwh).toBeCloseTo(mw.solar, 6);
    expect(noon?.dessem_mmgd_mwh).toBeCloseTo(mw.mmgd, 6);
    // Hydro and thermal are each the pair the spec's feature table defines:
    // `val_ger_hidraulica` + `val_ger_pch`, `val_ger_termica` + `val_ger_pct`.
    expect(noon?.dessem_hydro_mwh).toBeCloseTo(mw.hydro + mw.smallHydro, 6);
    expect(noon?.dessem_thermal_mwh).toBeCloseTo(mw.thermal + mw.smallThermal, 6);
    expect(noon?.dessem_pumping_mwh).toBeCloseTo(mw.pumping, 6);

    // And the decoys did not win. The restatement published after the gate is a
    // hundred times NE's size; the one learned after the gate is a hundred
    // times SE's. Neither axis alone would have kept both out.
    const se = rows.find((row) => row.subsystem === "SE");
    expect(Number(se?.dessem_demand_mwh)).toBeCloseTo(DESSEM_PROFILE.SE(0).demand, 6);

    // Non-vacuous: both decoys really are in the table, really are the newest
    // rows for their keys, and really would dominate the answer.
    const [counts] = [
      ...(await db.execute<{ published_late: number; ingested_late: number }>(sql`
        select
          count(*) filter (
            where published_at > ${GATE_LATE.toISOString()}::timestamptz
          )::int as published_late,
          count(*) filter (
            where published_at <= ${GATE_LATE.toISOString()}::timestamptz
              and ingested_at > ${GATE_LATE.toISOString()}::timestamptz
          )::int as ingested_late
        from dessem_balance_half_hour
      `)),
    ] as [{ published_late: number; ingested_late: number }];
    expect(counts.published_late).toBeGreaterThan(0);
    expect(counts.ingested_late).toBeGreaterThan(0);
  });

  it("derives the identities from the balance's own quantities", async () => {
    const rows = await dessemRows(TARGET);
    const mw = DESSEM_PROFILE.NE(9);
    const vre = mw.wind + mw.solar + mw.mmgd;
    const noon = neAt(rows, 9);

    expect(noon?.dessem_residual_load_mwh).toBeCloseTo(mw.demand - vre, 6);
    expect(noon?.dessem_renewable_load_ratio).toBeCloseTo(vre / mw.demand, 9);
    expect(noon?.dessem_vre_surplus_mwh).toBeCloseTo(vre - mw.demand, 6);
    expect(noon?.dessem_inflexible_share).toBeCloseTo(
      (mw.hydro + mw.smallHydro + mw.thermal + mw.smallThermal) / mw.demand,
      9,
    );
    // The energy identity DESSEM's missing exchange column is worked around by:
    // generation minus demand minus pumping is net export, up to the losses the
    // column's name says are not modelled.
    expect(noon?.dessem_implied_net_export_mwh).toBeCloseTo(
      mw.hydro +
        mw.smallHydro +
        mw.thermal +
        mw.smallThermal +
        vre -
        mw.demand -
        mw.pumping,
      6,
    );
  });

  it("derives the shape inside the profile, and stops at the day's near edge", async () => {
    const rows = await dessemRows(TARGET);
    // Three different ramps, so one computed from the wrong quantity cannot
    // come out right by coincidence: demand +10, residual +9, VRE +1.
    const noon = neAt(rows, 9);
    expect(noon?.dessem_demand_ramp_1h).toBeCloseTo(10, 6);
    expect(noon?.dessem_residual_load_ramp_1h).toBeCloseTo(9, 6);
    expect(noon?.dessem_vre_ramp_1h).toBeCloseTo(1, 6);

    // The near edge, and the reason it is an edge: D−1's own DESSEM file is in
    // the table, is published a day earlier, and is therefore *visible* at this
    // gate — so nothing but the day bound stops a ramp reaching into it. It is
    // ten times the size, so a ramp that did would be unmissable.
    const first = neAt(rows, 0);
    expect(first?.dessem_demand_mwh).toBeCloseTo(DESSEM_PROFILE.NE(0).demand, 6);
    expect(first?.dessem_demand_ramp_1h).toBeNull();
    expect(first?.dessem_residual_load_ramp_1h).toBeNull();
    expect(first?.dessem_vre_ramp_1h).toBeNull();
    // The far edge has no such hole: DESSEM carries no centred window, only
    // backward differences, so the last hour of the day is a complete row.
    expect(neAt(rows, 23)?.dessem_demand_ramp_1h).toBeCloseTo(10, 6);
  });

  it("summarises the day's residual load, and says which hour of it this is", async () => {
    const rows = await dessemRows(TARGET);
    const ne = rows.filter((row) => row.subsystem === "NE");
    const se = rows.filter((row) => row.subsystem === "SE");

    // Day grain: one number for the whole date, broadcast identically. NE's
    // residual load rises and SE's falls, so a minimum taken across subsystems
    // rather than within one collapses here.
    expect(new Set(ne.map((row) => row.dessem_residual_load_min_of_day))).toEqual(
      new Set([dessemResidual("NE", 0)]),
    );
    expect(new Set(se.map((row) => row.dessem_residual_load_min_of_day))).toEqual(
      new Set([dessemResidual("SE", 23)]),
    );

    // Rank is hourly, ascending, partitioned by subsystem: 1 is the trough.
    expect(neAt(rows, 0)?.dessem_residual_load_rank_in_day).toBe(1);
    expect(neAt(rows, 23)?.dessem_residual_load_rank_in_day).toBe(24);
    const seRank = (hour: number) =>
      se.find(
        (row) =>
          new Date(row.valid_time).getTime() === DAY_FROM.getTime() + hour * 3_600_000,
      )?.dessem_residual_load_rank_in_day;
    expect(seRank(0)).toBe(24);
    expect(seRank(23)).toBe(1);
  });

  it("takes the capacity-factor denominator from the fleet at the gate", async () => {
    const rows = await dessemRows(TARGET);
    // NE's fleet at this gate is 147 MW of wind and 40 of solar — `UG3`
    // commissioned on D counts, `UG4` recorded after the gate does not — so a
    // denominator read at any other vintage gives a different number. 73.5/147
    // and 10/40.
    for (const row of rows.filter((r) => r.subsystem === "NE")) {
      expect(row.dessem_wind_capacity_factor).toBeCloseTo(0.5, 9);
      expect(row.dessem_solar_capacity_factor).toBeCloseTo(0.25, 9);
      // The same fleet the row's own capacity columns report: one definition of
      // "the fleet at the gate", so the ratio and its denominator cannot
      // disagree.
      expect(Number(row.capacity_wind_mw)).toBe(147);
    }

    // S has generation and no registered fleet, so its capacity factors are
    // NULL and never zero: "the fleet is unknown at this gate" and "the fleet
    // generated nothing" are different statements, and only one is a number.
    for (const row of rows.filter((r) => r.subsystem === "S")) {
      expect(Number(row.capacity_wind_mw)).toBe(0);
      expect(row.dessem_wind_capacity_factor).toBeNull();
      expect(row.dessem_solar_capacity_factor).toBeNull();
    }
  });

  it("carries the system total and the absorbing subsystem's residual load", async () => {
    const rows = await dessemRows(TARGET);
    const hour = 9;
    const sin = (["N", "NE", "S", "SE"] as const).reduce(
      (total, subsystem) => total + dessemResidual(subsystem, hour),
      0,
    );

    // A derived sum over the four, which is the only form a national total may
    // take: `SIN` is not a Subsystem. Broadcast identically to all four rows of
    // the hour.
    const atHour = rows.filter(
      (row) =>
        new Date(row.valid_time).getTime() === DAY_FROM.getTime() + hour * 3_600_000,
    );
    expect(atHour).toHaveLength(4);
    for (const row of atHour) {
      expect(row.dessem_sin_residual_load_mwh).toBeCloseTo(sin, 5);
    }

    // The physical asymmetry: SE's residual load on the northern rows, because
    // N and NE curtail when SE has no headroom to absorb them.
    const absorbing = dessemResidual("SE", hour);
    for (const subsystem of ["N", "NE"] as const) {
      const row = atHour.find((r) => r.subsystem === subsystem);
      expect({ subsystem, carried: row?.dessem_absorber_residual_load_mwh }).toEqual({
        subsystem,
        carried: absorbing,
      });
    }
    // NULL where the mechanism does not apply. On SE it would otherwise be a
    // duplicate of the column beside it under a name promising something else.
    for (const subsystem of ["S", "SE"] as const) {
      const row = atHour.find((r) => r.subsystem === subsystem);
      expect({ subsystem, carried: row?.dessem_absorber_residual_load_mwh }).toEqual({
        subsystem,
        carried: null,
      });
    }
  });

  it("refuses the augmented set at the early gate rather than returning NULLs", async () => {
    // The acceptance claim, and the difference between this and the class-`P`
    // hole beside it. The programme *could* be published earlier and is not, so
    // its early-gate columns are NULL and the hole is the report. DESSEM's file
    // for day D does not exist at 09:00 on D−1 at all, so the augmented set is
    // not a thinner answer at `gate_early` — it is not an answer, and the
    // function says so instead of handing back a row a model could train on.
    let sqlstate: string | undefined;
    try {
      await readServingRows(db, {
        targetDate: TARGET,
        ...augmented,
        gateProfile: "gate_early",
      });
    } catch (error) {
      sqlstate = sqlStateOf(error);
    }
    expect(sqlstate).toBe("22023");

    // And the block refuses on its own, for a caller that reaches it without
    // going through `feature_rows`.
    let blockState: string | undefined;
    try {
      await db.execute(
        sql`select * from feature_dessem_block(${TARGET}::date, 'gate_early', 'dessem_augmented_v1')`,
      );
    } catch (error) {
      blockState = sqlStateOf(error);
    }
    expect(blockState).toBe("22023");
  });

  it("leaves the DESSEM-free set free of DESSEM, at either gate", async () => {
    // The other half of the feature-set argument. Set A is not "set B with the
    // columns blanked": the block produces no rows for it, so the columns are
    // NULL because the join found nothing — and the same is true at both gates,
    // including the one where the file genuinely exists.
    const dessemColumns = FEATURE_ROW_COLUMNS.filter((column) =>
      column.startsWith("dessem_"),
    );
    // Twenty-two since ticket 10: `dessem_export_utilisation` is the
    // twenty-second name, and it is NULL for set A by the same mechanism as the
    // other twenty-one - the utilisation block composes `feature_dessem_block`,
    // which returns no rows here, so its numerator is missing rather than
    // blanked.
    expect(dessemColumns).toHaveLength(22);

    for (const gateProfile of ["gate_early", "gate_late"] as const) {
      const rows = await readServingRows(db, {
        targetDate: TARGET,
        ...query,
        gateProfile,
      });
      expect(rows).toHaveLength(96);
      for (const row of rows) {
        for (const column of dessemColumns) {
          expect({ gateProfile, column, value: row[column] }).toEqual({
            gateProfile,
            column,
            value: null,
          });
        }
      }
    }

    // Non-vacuous: the same rows at the same late gate carry real values once
    // the augmented set is asked for, so the NULLs above are the set's doing.
    const setB = await dessemRows(TARGET);
    expect(setB.every((row) => row.dessem_demand_mwh !== null)).toBe(true);
  });

  // ------------------------------------------ class `P`+`W`+`T`, the proxy
  //
  // Residual load rebuilt from the day-ahead programme and the pinned run. The
  // fixture makes the arithmetic checkable end to end: NE's programme is
  // `1000 + 10h`, its weather is flat, its fleet at `TARGET`'s gate is 147 MW of
  // wind and 40 MW of solar, and `feature_wind_power_curve_cf` is pinned — so
  // every column below is a number this test can compute rather than read back.
  const PROXY_EXPECTED_SOLAR = 40 * (500 / 1000);
  const PROXY_EXPECTED_WIND = (((32 / 3.6) ** 3 - 3 ** 3) / (12 ** 3 - 3 ** 3)) * 147;
  const PROXY_EXPECTED_VRE = PROXY_EXPECTED_WIND + PROXY_EXPECTED_SOLAR;
  const proxyResidual = (localHour: number): number =>
    NE_PROGRAMMED(localHour) - PROXY_EXPECTED_VRE;

  it("rebuilds the residual load from terms that exist at D−1", async () => {
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");
    expect(ne).toHaveLength(24);

    // The acceptance claim: non-null across the window, for a subsystem that
    // has both a programme and a fleet.
    expect(ne.every((row) => row.proxy_residual_load_mwh !== null)).toBe(true);

    for (let hour = 0; hour < 24; hour += 1) {
      const row = neAt(ne, hour);
      expect(Number(row?.proxy_residual_load_mwh)).toBeCloseTo(proxyResidual(hour), 6);
      // …and it is the *row's own* three terms, not a second reading of them.
      // The block composes `feature_programmed_load_block` and
      // `feature_weather_block` rather than re-deriving what they derive, so
      // this identity holds inside every row by construction. A third
      // definition of either term would show up here first.
      expect(Number(row?.proxy_residual_load_mwh)).toBeCloseTo(
        Number(row?.programmed_load_mwh) -
          Number(row?.weather_expected_wind_mwh) -
          Number(row?.weather_expected_solar_mwh),
        9,
      );
    }
  });

  it("derives the ratios and the surplus from the same three terms", async () => {
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");

    for (let hour = 0; hour < 24; hour += 1) {
      const row = neAt(ne, hour);
      const programmedMwh = NE_PROGRAMMED(hour);
      expect(Number(row?.proxy_residual_load_ratio)).toBeCloseTo(
        proxyResidual(hour) / programmedMwh,
        9,
      );
      expect(Number(row?.proxy_renewable_load_ratio)).toBeCloseTo(
        PROXY_EXPECTED_VRE / programmedMwh,
        9,
      );
      expect(Number(row?.proxy_vre_surplus_mwh)).toBeCloseTo(
        PROXY_EXPECTED_VRE - programmedMwh,
        6,
      );
      // The three are one quantity seen three ways, and the identities that say
      // so are worth asserting: the two ratios sum to one, and the surplus is
      // the residual load's negative.
      expect(
        Number(row?.proxy_residual_load_ratio) + Number(row?.proxy_renewable_load_ratio),
      ).toBeCloseTo(1, 9);
      expect(Number(row?.proxy_vre_surplus_mwh)).toBeCloseTo(
        -Number(row?.proxy_residual_load_mwh),
        6,
      );
    }
  });

  it("derives the shape inside the proxy profile, and stops at the day's near edge", async () => {
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");

    // NE's programme rises by a flat 10 MWh an hour and its weather is flat, so
    // the reconstructed profile ramps by exactly 10 — a window that had slipped
    // by one, or a conversion that had leaked an hour, would show.
    for (let hour = 1; hour < 24; hour += 1) {
      expect(Number(neAt(ne, hour)?.proxy_residual_load_ramp_1h)).toBeCloseTo(10, 6);
    }
    // The near edge. The weather run carries 23:00 BRT on D−1 in the same
    // publication as 00:00 on D, but the programme does not — its predecessor
    // hour belongs to D−1's own file — so the narrower parent decides and the
    // first hour has no ramp.
    expect(neAt(ne, 0)?.proxy_residual_load_mwh).not.toBeNull();
    expect(neAt(ne, 0)?.proxy_residual_load_ramp_1h).toBeNull();

    // Day grain: one minimum for the whole date, broadcast identically, and it
    // is the trough of the *reconstruction* rather than of the programme.
    expect(new Set(ne.map((row) => Number(row.proxy_residual_load_min_of_day)))).toEqual(
      new Set([Number(neAt(ne, 0)?.proxy_residual_load_mwh)]),
    );
    expect(Number(neAt(ne, 0)?.proxy_residual_load_min_of_day)).toBeCloseTo(
      proxyResidual(0),
      6,
    );
    // Rank is hourly, ascending and partitioned by subsystem: 1 is the trough.
    expect(neAt(ne, 0)?.proxy_residual_load_rank_in_day).toBe(1);
    expect(neAt(ne, 23)?.proxy_residual_load_rank_in_day).toBe(24);
  });

  it("is a hole where a term is missing, and never a load with two zeroes taken off it", async () => {
    // SE has a programme and no fleet: the registry places no VRE there at this
    // gate, so there is no expected generation to subtract. `programmed_load`
    // with two zeroes taken off it would be a load forecast wearing a residual
    // load's name — plausible, and wrong in exactly the rows where the fleet
    // read had failed.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const se = rows.filter((row) => row.subsystem === "SE");
    expect(se).toHaveLength(24);
    expect(se.every((row) => row.programmed_load_mwh !== null)).toBe(true);
    expect(se.every((row) => row.weather_expected_wind_mwh === null)).toBe(true);

    for (const row of se) {
      for (const column of FEATURE_ROW_COLUMNS.filter((name) =>
        name.startsWith("proxy_"),
      )) {
        expect({ column, value: row[column] }).toEqual({ column, value: null });
      }
    }
  });

  it("is NULL at the early gate, because the programme it subtracts from is", async () => {
    // The finding this ticket inherits and does not paper over. `gate_early` is
    // D−1 09:00 BRT and the programme for day D is stamped D−1 15:00 BRT, so
    // there is no load term at 09:00 and every column here is NULL — while the
    // *weather* half of the reconstruction is present at the same gate, which is
    // what makes the hole unambiguously the programme's.
    //
    // Filling it would mean assuming an earlier publication nothing has
    // measured, and a model trained on a value it will not have at 09:00 cannot
    // be served. Issue 12's measurement is what settles this, not a fallback.
    const proxyColumns = FEATURE_ROW_COLUMNS.filter((name) => name.startsWith("proxy_"));
    expect(proxyColumns).toHaveLength(7);

    const early = await readServingRows(db, {
      targetDate: TARGET,
      ...query,
      gateProfile: "gate_early",
    });
    expect(early).toHaveLength(96);
    expect(early.some((row) => row.weather_expected_wind_mwh !== null)).toBe(true);
    for (const row of early) {
      expect(row.programmed_load_mwh).toBeNull();
      for (const column of proxyColumns) {
        expect({ column, value: row[column] }).toEqual({ column, value: null });
      }
    }

    // Non-vacuous: the same rows at the late gate carry the whole family.
    const late = await readServingRows(db, { targetDate: TARGET, ...query });
    expect(late.some((row) => row.proxy_residual_load_mwh !== null)).toBe(true);
  });

  it("keeps both views of residual load where the augmented set has both", async () => {
    // The A/B compares two *views* of one quantity, so set B carries the
    // rebuilt residual load beside DESSEM's own rather than replacing it. A
    // model that can see both is what makes the comparison answerable at all.
    const setB = await dessemRows(TARGET);
    const ne = setB.filter((row) => row.subsystem === "NE");
    expect(ne).toHaveLength(24);
    expect(ne.every((row) => row.proxy_residual_load_mwh !== null)).toBe(true);
    expect(ne.every((row) => row.dessem_residual_load_mwh !== null)).toBe(true);

    // And they are genuinely two views: the proxy is a forecast built from the
    // programme and the run, DESSEM's is the balance's own statement, and the
    // fixture's two disagree — as the real ones will.
    const setA = await readServingRows(db, { targetDate: TARGET, ...query });
    for (let hour = 0; hour < 24; hour += 1) {
      // The proxy is the same number in both sets: nothing about it is
      // conditioned on the feature set.
      expect(Number(neAt(ne, hour)?.proxy_residual_load_mwh)).toBeCloseTo(
        Number(neAt(setA, hour)?.proxy_residual_load_mwh),
        9,
      );
    }
    expect(Number(neAt(ne, 12)?.proxy_residual_load_mwh)).not.toBeCloseTo(
      Number(neAt(ne, 12)?.dessem_residual_load_mwh),
      3,
    );
  });

  // ---------------------------- the interchange utilisation proxy, ticket 10
  //
  // The fixture's NE->SE series is 774 hours at 400 MWh, the last 24 at 200,
  // one hour at 900 inside the trailing week and the D-7 row at 500 - 800 hours
  // in the year ending at the cutoff, and a 9999 MWh hour past it. Every number
  // below is a consequence of that series and of nothing else.
  const ESTIMATE_NE_SE = 400;

  const capability = async (gateProfile: "gate_early" | "gate_late") => [
    ...(await db.execute<{
      from_subsystem: string;
      to_subsystem: string;
      export_capability_mwh: number | null;
      sample_hours: number;
    }>(sql`
      select * from feature_export_capability_estimate(
        ${TARGET}::date, ${gateProfile}
      )
    `)),
  ];

  it("publishes the estimate per directed corridor, with its sample size", async () => {
    // The ticket's third claim, and the shape it asks for: per *directed*
    // corridor, and with the sample it was computed from - because that is what
    // distinguishes an estimate from a measurement to whoever reads it. A
    // corridor that never binds is visibly not a constraint here rather than
    // silently a scaled flow downstream.
    const corridors = await capability("gate_late");
    const of = (from: string, to: string) =>
      corridors.find((row) => row.from_subsystem === from && row.to_subsystem === to);

    // The one direction with a year behind it. P99.5 over the 800 hours is 400:
    // neither the 900 nor the 500 reaches it, which is the quantile refusing to
    // be a maximum.
    expect(Number(of("NE", "SE")?.export_capability_mwh)).toBeCloseTo(ESTIMATE_NE_SE, 9);
    expect(Number(of("NE", "SE")?.sample_hours)).toBe(800);

    // The same series reversed. Its P99.5 is -200 - the direction never carried
    // energy - so there is no estimate, and the sample size beside it says the
    // refusal was not for want of data.
    expect(of("SE", "NE")?.export_capability_mwh).toBeNull();
    expect(Number(of("SE", "NE")?.sample_hours)).toBe(800);

    // The other refusal: one observation is not a year. A P99.5 over a single
    // hour is that hour, and a denominator computed from noise is worse than no
    // denominator at all.
    expect(of("N", "NE")?.export_capability_mwh).toBeNull();
    expect(Number(of("N", "NE")?.sample_hours)).toBe(1);
    expect(of("NE", "N")?.export_capability_mwh).toBeNull();
  });

  it("differs from a whole-history maximum, and from a trailing one", async () => {
    // The ticket asks for this demonstration by name, and it is the reason the
    // estimator is trailing *and* gate-bounded rather than either alone.
    //
    // Three numbers over the same corridor: the whole-history maximum is 9999,
    // an hour the gate could not have seen at all; the maximum inside the
    // trailing gate-bounded year is 900; and the estimate is 400. A naive
    // `max(flow)` would have leaked the first into every historical row, and a
    // gate-bounded maximum would still have let one outlier hour define a year
    // of denominators.
    const [extremes] = [
      ...(await db.execute<{ whole_history: number; trailing: number }>(sql`
        select
          max(verified_exchange_mwh) as whole_history,
          max(verified_exchange_mwh) filter (
            where valid_time <= ${CUTOFF.toISOString()}::timestamptz
          ) as trailing
        from subsystem_exchange_hour
        where from_subsystem = 'NE' and to_subsystem = 'SE'
      `)),
    ] as [{ whole_history: number; trailing: number }];

    expect(Number(extremes.whole_history)).toBe(9999);
    expect(Number(extremes.trailing)).toBe(900);
    const corridors = await capability("gate_late");
    const estimate = Number(
      corridors.find((row) => row.from_subsystem === "NE" && row.to_subsystem === "SE")
        ?.export_capability_mwh,
    );
    expect(estimate).toBe(ESTIMATE_NE_SE);
    expect(estimate).toBeLessThan(Number(extremes.trailing));
    expect(estimate).toBeLessThan(Number(extremes.whole_history));
  });

  it("carries the two observed ratios, at day grain and against that estimate", async () => {
    // Ticket 05 built the directed flows and left these two out, because the
    // denominator they divide did not exist. It does now, and it is the one in
    // the test above rather than a second one.
    const rows = await readServingRows(db, { targetDate: TARGET, ...query });
    const ne = rows.filter((row) => row.subsystem === "NE");
    expect(ne).toHaveLength(24);

    // The last 24 available hours are 200 MWh against a 400 MWh estimate.
    for (const row of ne) {
      expect(Number(row.observed_export_utilisation_mean_24h_to_cutoff)).toBeCloseTo(
        200 / ESTIMATE_NE_SE,
        9,
      );
    }
    // Day grain: one number for the whole target date, not an hourly signal.
    expect(
      new Set(ne.map((row) => Number(row.observed_export_utilisation_mean_24h_to_cutoff)))
        .size,
    ).toBe(1);

    // The trailing seven days hold the 900 MWh hour, so the corridor maximum is
    // 2.25 - above one, which is what a capability *estimate* looks like when
    // the corridor exceeds it. It is a system fact, so all four subsystems
    // carry it, exactly as they carry the corridor flows.
    for (const row of rows) {
      expect({
        subsystem: row.subsystem,
        max: Number(row.observed_corridor_utilisation_ne_se_max_7d),
      }).toEqual({ subsystem: row.subsystem, max: 900 / ESTIMATE_NE_SE });
    }

    // A subsystem whose outgoing corridors have no estimate has no ratio -
    // never a zero, and never a fallback to somebody else's denominator.
    for (const subsystem of ["N", "S", "SE"] as const) {
      for (const row of rows.filter((each) => each.subsystem === subsystem)) {
        expect(row.observed_export_utilisation_mean_24h_to_cutoff).toBeNull();
      }
    }
  });

  it("moves the observed ratio with the gate, because the window does", async () => {
    // Unlike ticket 09's family, nothing here is NULL at `gate_early`: these are
    // class-`K` columns and the early gate simply sees a cutoff ten hours
    // earlier. The window that ends there holds fourteen 200 MWh hours and ten
    // 400 MWh ones, so the mean ratio is 17/24 rather than 1/2 - the same
    // definition answering a different question, which is what a gate is for.
    const early = await readFeatureRows(db, {
      targetFrom: TARGET,
      targetTo: TARGET,
      ...query,
      gateProfile: "gate_early",
    });
    const ne = early.filter((row) => row.subsystem === "NE");
    expect(ne).toHaveLength(24);
    for (const row of ne) {
      expect(Number(row.observed_export_utilisation_mean_24h_to_cutoff)).toBeCloseTo(
        17 / 24,
        9,
      );
    }
    // And the estimate itself is unchanged, because the bulk of the year is.
    const corridors = await capability("gate_early");
    expect(
      Number(
        corridors.find((row) => row.from_subsystem === "NE" && row.to_subsystem === "SE")
          ?.export_capability_mwh,
      ),
    ).toBeCloseTo(ESTIMATE_NE_SE, 9);
  });

  it("closes the augmented set's twenty-second name with the same denominator", async () => {
    // `dessem_export_utilisation`, which ticket 07 left out of its twenty-one
    // rather than invent a denominator for. The numerator is the class-`D`
    // block's own implied net export - read out of the same row, so the two
    // cannot disagree - and the denominator is the class-`K` estimate above.
    // There is no second estimate for this column to have grown.
    const rows = await dessemRows(TARGET);
    const ne = rows.filter((row) => row.subsystem === "NE");
    expect(ne).toHaveLength(24);
    expect(ne.every((row) => row.dessem_implied_net_export_mwh !== null)).toBe(true);
    for (const row of ne) {
      expect(Number(row.dessem_export_utilisation)).toBeCloseTo(
        Number(row.dessem_implied_net_export_mwh) / ESTIMATE_NE_SE,
        9,
      );
    }
    // Hourly, not day grain: the numerator is DESSEM's own hourly profile even
    // though the denominator is constant across the day.
    expect(
      new Set(ne.map((row) => Number(row.dessem_export_utilisation))).size,
    ).toBeGreaterThan(1);

    // The other three subsystems have an implied net export and no capability
    // estimate, so the ratio is NULL rather than a number divided by somebody
    // else's corridor.
    for (const row of rows.filter((each) => each.subsystem !== "NE")) {
      expect(row.dessem_export_utilisation).toBeNull();
    }

    // And it is absent from set A for the reason every other `dessem_*` column
    // is: the block behind it returned no rows.
    const setA = await readServingRows(db, { targetDate: TARGET, ...query });
    expect(setA.every((row) => row.dessem_export_utilisation === null)).toBe(true);
    // Non-vacuous: the two class-`K` ratios beside it are present in set A.
    expect(
      setA.some((row) => row.observed_corridor_utilisation_ne_se_max_7d !== null),
    ).toBe(true);
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

  it("seam 1 — and the same is true of the augmented set", async () => {
    // The claim has to hold for both arms of the A/B, not only the one the rest
    // of this suite queries. The augmented set is the harder case: it carries
    // twenty-one more columns, three of which are derived across subsystems and
    // two of which read a second block, so a range query that let a day's
    // profile bleed into its neighbour's would show here and nowhere else.
    const trained = await readFeatureRows(db, {
      targetFrom: TARGET_MINUS_1,
      targetTo: TARGET,
      ...augmented,
    });
    const served = await readServingRows(db, { targetDate: TARGET, ...augmented });

    const trainedForTarget = trained.filter((row) =>
      String(row.target_date).includes(TARGET),
    );
    expect(trainedForTarget).toHaveLength(served.length);
    expect(served.length).toBeGreaterThan(0);
    expect(trained.length).toBe(served.length * 2);
    // Non-vacuous: the DESSEM columns really are populated in what is compared.
    expect(served.some((row) => row.dessem_residual_load_mwh !== null)).toBe(true);

    const byKey = new Map(trainedForTarget.map((row) => [keyOf(row), comparable(row)]));
    for (const row of served) {
      expect(byKey.get(keyOf(row))).toEqual(comparable(row));
    }
  });

  // ---------------------------------------------------------------- Seam 2
  //
  // Run for both feature sets, because the augmented set is the only one in
  // which twenty-one of the columns exist at all — and an ablation that never
  // asked for them would pass on a DESSEM leak without noticing.
  //
  // Ticket 11 gave it a gate: set A exists at *both* profiles, and an ablation
  // run only at the late one says nothing about the early one — where the gate
  // is ten hours earlier, the cutoff ten hours further back, and a different
  // set of source rows is invisible. The two instants travel together because
  // the cutoff is derived from the gate.
  const ablate = async (
    featureSet: "dessem_free_v1" | "dessem_augmented_v1",
    gateProfile: "gate_early" | "gate_late" = "gate_late",
    gateAt: Date = GATE_LATE,
    cutoffAt: Date = CUTOFF,
  ): Promise<{
    before: FeatureRow[];
    after: FeatureRow[];
    deleted: number;
    deletedFromDessem: number;
    deletedPastCutoff: number;
  }> => {
    const asked = { ...query, featureSet, gateProfile } as const;
    const before = await readServingRows(db, { targetDate: TARGET, ...asked });
    let after: FeatureRow[] = [];
    let deleted = 0;
    let deletedFromDessem = 0;
    let deletedPastCutoff = 0;

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
          // Ticket 06's spine. It is a forecast, so the publication axis is the
          // one that bites: D+1's programme and the post-gate restatement of one
          // of `TARGET`'s hours both go, and nothing the row calls a feature may
          // move when they do.
          "programmed_load_half_hour",
          // Ticket 07's class-`D` block, and the one table with a decoy on each
          // axis: a restatement published after the gate, and a restatement
          // learned after it under the original's publication instant. Both are
          // a hundred times the size of the real profile.
          "dessem_balance_half_hour",
        ]) {
          const removed = await scoped.execute<{ n: number }>(sql`
            with gone as (
              delete from ${sql.raw(table)}
              where published_at > ${gateAt.toISOString()}::timestamptz
                 or ingested_at > ${gateAt.toISOString()}::timestamptz
              returning 1
            ) select count(*)::int as n from gone
          `);
          const n = Number([...removed][0]?.n ?? 0);
          deleted += n;
          if (table === "dessem_balance_half_hour") {
            deletedFromDessem = n;
          }
        }

        // The second axis, and the one ticket 05 added. Over the backfill window
        // the two vintage deletes above remove *nothing* from an observation
        // table - every row was learned at go-live and published from an S3
        // `Last-Modified` that may post-date the hour by two years - so a
        // class-`K` feature that depended on the future would sail through the
        // ablation as it stood. Cutting on `valid_time > actuals_cutoff` is what
        // makes the seam able to see it.
        for (const table of [
          "curtailment_report_hour",
          "subsystem_energy_balance_hour",
          "subsystem_exchange_hour",
        ]) {
          const removed = await scoped.execute<{ n: number }>(sql`
            with gone as (
              delete from ${sql.raw(table)}
              where valid_time > ${cutoffAt.toISOString()}::timestamptz
              returning 1
            ) select count(*)::int as n from gone
          `);
          deletedPastCutoff += Number([...removed][0]?.n ?? 0);
        }

        after = await readServingRows(scoped, { targetDate: TARGET, ...asked });
        tx.rollback();
      });
    } catch (error) {
      // `tx.rollback()` throws by design; anything else is a real failure.
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    return { before, after, deleted, deletedFromDessem, deletedPastCutoff };
  };

  it("seam 2 — and the augmented set survives the same ablation", async () => {
    // The DESSEM arm of the leak detector. Twenty-one columns exist only here,
    // two of them are derived across subsystems and two read the registry
    // through a second block — so this is where a DESSEM-shaped leak would
    // show, and set A's pass says nothing about it.
    const { before, after, deleted, deletedFromDessem } =
      await ablate("dessem_augmented_v1");
    expect(deleted).toBeGreaterThan(0);
    // Non-vacuous on this ticket's own table: DESSEM rows the gate could not
    // have seen — on either axis — really were there to be removed.
    expect(deletedFromDessem).toBeGreaterThan(0);
    expect(after).toHaveLength(before.length);

    // Non-vacuous: the columns under test carry values on both sides.
    expect(before.some((row) => row.dessem_residual_load_mwh !== null)).toBe(true);
    expect(after.some((row) => row.dessem_residual_load_mwh !== null)).toBe(true);

    const byKey = new Map(
      after.map((row) => [keyOf(row), featuresOnly(comparable(row))]),
    );
    for (const row of before) {
      expect(byKey.get(keyOf(row))).toEqual(featuresOnly(comparable(row)));
    }
  });

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
    const { before, after, deleted, deletedPastCutoff } = await ablate("dessem_free_v1");

    // Non-vacuous in both directions: rows really were removed, and the row set
    // is unchanged because the spine comes from the calendar.
    expect(deleted).toBeGreaterThan(0);
    // Non-vacuous on the new axis too: rows the gate could see on both vintage
    // axes, and could not see on valid time, really were there to be removed.
    expect(deletedPastCutoff).toBeGreaterThan(0);
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

  it("seam 1 — and at the early gate, where set A is the only set there is", async () => {
    // Set A exists at both profiles and the augmented set at neither but the
    // late one, so "both sets at both applicable gates" is three calls and not
    // four. This is the third: ten hours earlier, a cutoff ten hours further
    // back, and twelve columns that are NULL here and not at `gate_late`.
    const early = { ...query, gateProfile: "gate_early" } as const;
    const trained = await readFeatureRows(db, {
      targetFrom: TARGET_MINUS_1,
      targetTo: TARGET,
      ...early,
    });
    const served = await readServingRows(db, { targetDate: TARGET, ...early });

    const trainedForTarget = trained.filter((row) =>
      String(row.target_date).includes(TARGET),
    );
    expect(served.length).toBe(96);
    expect(trainedForTarget).toHaveLength(served.length);
    expect(trained.length).toBe(served.length * 2);
    // Non-vacuous, and it is the whole difference between the two gates: the
    // early rows really are the early rows.
    expect(served.every((row) => row.gate_profile === "gate_early")).toBe(true);
    expect(served.every((row) => row.programmed_load_mwh === null)).toBe(true);

    const byKey = new Map(trainedForTarget.map((row) => [keyOf(row), comparable(row)]));
    for (const row of served) {
      expect(byKey.get(keyOf(row))).toEqual(comparable(row));
    }
  });

  it("seam 2 — and the early gate's own ablation, at its own cutoff", async () => {
    // `gate_at(TARGET, 'gate_early')` is D−1 09:00 BRT = 12:00Z, and the
    // cutoff forty hours behind it is 2026-08-17 20:00Z. Both move together
    // because one is derived from the other, which is exactly the property the
    // ablation is testing: delete what *this* gate could not have seen, and
    // nothing the row calls a feature may move.
    const gate = new Date("2026-08-19T12:00:00.000Z");
    const cutoff = new Date("2026-08-17T20:00:00.000Z");
    const { before, after, deleted, deletedPastCutoff } = await ablate(
      "dessem_free_v1",
      "gate_early",
      gate,
      cutoff,
    );

    expect(deleted).toBeGreaterThan(0);
    // Non-vacuous on the axis the early gate moves furthest: the cutoff is ten
    // hours further back than `gate_late`'s, so it excludes strictly more.
    expect(deletedPastCutoff).toBeGreaterThan(0);
    expect(after).toHaveLength(before.length);

    const byKey = new Map(
      after.map((row) => [keyOf(row), featuresOnly(comparable(row))]),
    );
    for (const row of before) {
      expect(byKey.get(keyOf(row))).toEqual(featuresOnly(comparable(row)));
    }
  });

  // ------------------------------------------- seam 3, the frame's own edge
  it("ends the trailing frame AT the cutoff, and not one hour past it", async () => {
    // The off-by-one the spec names first: `168 PRECEDING AND 1 PRECEDING`
    // versus `... AND CURRENT ROW` is one token, and it decides whether a
    // feature is honest. The fixture's decoys straddle the cutoff by three
    // hours and six; this one straddles it by nothing at all, which is where a
    // `<` written as `<=` — or the reverse — is invisible.
    //
    // The rule is `valid_time <= actuals_cutoff`, so the hour *at* the cutoff
    // is in and the hour after it is out.
    const before = await readServingRows(db, { targetDate: TARGET, ...query });
    const totalBefore = Number(
      before.find(
        (row) =>
          row.subsystem === "NE" &&
          new Date(row.valid_time).getTime() === HOUR_CURTAILED.getTime(),
      )?.observed_constrained_off_total_7d_mwh,
    );
    expect(totalBefore).toBe(15);

    /** One hand-built observation at `at`, then the window it lands in. */
    const withAnHourAt = async (at: Date): Promise<number> => {
      let total = Number.NaN;
      try {
        await db.transaction(async (tx) => {
          const scoped = tx as unknown as Database;
          await writeCurtailment(scoped, {
            rows: [observed(at, "WIND", 100)],
            publishedAt: OBSERVED_INGESTED_AT,
            publishedAtPrecision: "file",
            sourceVersionId: curtailmentVersionId,
            ingestedAt: OBSERVED_INGESTED_AT,
          });
          const rows = await readServingRows(scoped, { targetDate: TARGET, ...query });
          total = Number(
            rows.find(
              (row) =>
                row.subsystem === "NE" &&
                new Date(row.valid_time).getTime() === HOUR_CURTAILED.getTime(),
            )?.observed_constrained_off_total_7d_mwh,
          );
          tx.rollback();
        });
      } catch (error) {
        if (!(error instanceof Error && /rollback/i.test(error.message))) {
          throw error;
        }
      }
      return total;
    };

    // The hour *at* the cutoff is inside the frame; the hour after it is not.
    // One hour apart, and the whole difference is which side of `<=` it falls.
    expect(await withAnHourAt(CUTOFF)).toBe(totalBefore + 100);
    expect(await withAnHourAt(new Date(CUTOFF.getTime() + 3_600_000))).toBe(totalBefore);
  });

  // --------------------------------------------------- the dictionary, live
  it("describes every column of the row, from the type rather than from a list", async () => {
    const dictionary = await readFeatureDictionary(db);

    // Names, order and types all come from `pg_attribute`, so this is the
    // catalogue's own list compared against TypeScript's copy of it.
    expect(dictionary).toHaveLength(112);
    expect(dictionary.map((entry) => entry.column_name)).toEqual([
      ...FEATURE_ROW_COLUMNS,
    ]);
    expect(dictionary.map((entry) => entry.ordinal)).toEqual(
      dictionary.map((_, index) => index + 1),
    );

    // Nothing is unclassified, and nothing is undescribed.
    for (const entry of dictionary) {
      expect({
        column: entry.column_name,
        classified: entry.role === "feature" ? entry.classes.length > 0 : true,
        described: entry.description.length > 0,
        sourced: entry.source.length > 0,
      }).toEqual({
        column: entry.column_name,
        classified: true,
        described: true,
        sourced: true,
      });
    }

    // The spec's own notation, reproduced: a column can be made of a forecast
    // and a deterministic quantity, and one letter would hide which half can go
    // missing.
    const labelOf = (column: string) =>
      dictionary.find((entry) => entry.column_name === column)?.class_label;
    expect(labelOf("weather_clearness_index")).toBe("W+T");
    expect(labelOf("proxy_residual_load_mwh")).toBe("P+W+T");
    expect(labelOf("dessem_export_utilisation")).toBe("D+K");
    expect(labelOf("observed_constrained_off_lag_168h")).toBe("K");
    expect(labelOf("y_has_curtailment")).toBe("label");
  });

  it("refuses the whole dictionary rather than answering with a gap in it", async () => {
    // The enforcement, exercised. A ticket that appends an attribute and forgets
    // the entry does not get a dictionary with a hole; it gets a refusal — and
    // a dictionary with one unclassified column in it is exactly the shape a
    // reader would trust.
    const failures: string[] = [];
    /**
     * One edit to the dictionary, rolled back — each in its own transaction.
     *
     * Separate transactions because the first raise aborts the one it happened
     * in, and Postgres will not take a second statement after that. The refusal
     * is the point, so the shape of the test has to survive it.
     */
    const refusedAfter = async (edit: string, what: string): Promise<void> => {
      try {
        await db.transaction(async (tx) => {
          const scoped = tx as unknown as Database;
          await scoped.execute(sql.raw(edit));
          try {
            await readFeatureDictionary(scoped);
            failures.push(what);
          } catch (error) {
            expect(sqlStateOf(error)).toBe("22023");
            throw new Error("rollback: the refusal happened, so the edit goes back");
          }
          tx.rollback();
        });
      } catch (error) {
        if (!(error instanceof Error && /rollback/i.test(error.message))) {
          throw error;
        }
      }
    };

    await refusedAfter(
      `delete from feature_dictionary_entry where column_name = 'dessem_residual_load_mwh'`,
      "an unclassified attribute was tolerated",
    );
    await refusedAfter(
      `insert into feature_dictionary_entry (
         column_name, role, classes, source, grain,
         in_dessem_free_v1, in_dessem_augmented_v1, available_at_gate_early,
         is_proxy, justifies_dessem_trade, model_input
       ) values (
         'a_column_that_is_not_an_attribute', 'feature', array['T']::text[], 'derived',
         'hour', true, true, true, false, false, true
       )`,
      "an entry naming no attribute was tolerated",
    );
    expect(failures).toEqual([]);
    // And outside the transaction it answers again, so the refusals were about
    // the edits and not about the dictionary.
    expect(await readFeatureDictionary(db)).toHaveLength(112);
  });

  it("binds the TypeScript grain marking to the dictionary's, rather than trusting it", async () => {
    // The same arrangement `canonical_capacity_weight` has with
    // `capacity-weights.ts`: two implementations of one marking, compared. The
    // TypeScript copy exists because the serve path and the ablation seam need
    // it without a database; it is a copy, and this is what says so.
    const dictionary = await readFeatureDictionary(db);
    for (const entry of dictionary) {
      // The dictionary marks grain only where the question is asked - identity
      // and stamp columns say which row this is, not what was measured - while
      // `featureGrain` answers "hour" for anything it was not told about.
      if (entry.grain !== null) {
        expect({
          column: entry.column_name,
          grain: featureGrain(entry.column_name),
        }).toEqual({ column: entry.column_name, grain: entry.grain });
      }
      expect({
        column: entry.column_name,
        feature: isFeatureColumn(entry.column_name),
        label: isLabelColumn(entry.column_name),
      }).toEqual({
        column: entry.column_name,
        feature: entry.role === "feature",
        label: entry.role === "label",
      });
    }
    // Non-vacuous in both directions.
    expect(dictionary.filter((entry) => entry.grain === "day")).toHaveLength(17);
    expect(dictionary.filter((entry) => entry.role === "feature")).toHaveLength(99);
  });

  it("enumerates the augmented set's twenty-two names, and the four that would justify the trade", async () => {
    const dictionary = await readFeatureDictionary(db);
    const only = dictionary.filter((entry) => entry.augmented_only);

    // 22 feature names across 21 rows of the spec's table: the
    // `dessem_residual_load_min_of_day` / `_rank_in_day` row carries two, and
    // `dessem_export_utilisation` came from ticket 10 rather than ticket 07.
    expect(only.map((entry) => entry.column_name)).toHaveLength(22);
    expect(only.every((entry) => entry.column_name.startsWith("dessem_"))).toBe(true);
    expect(only.every((entry) => !entry.available_at_gate_early)).toBe(true);

    // Everything else DESSEM contributes has a weather- or programming-derived
    // analogue in set A. These four do not.
    expect(
      dictionary
        .filter((entry) => entry.justifies_dessem_trade)
        .map((entry) => entry.column_name),
    ).toEqual([
      "dessem_residual_load_mwh",
      "dessem_implied_net_export_mwh",
      "dessem_absorber_residual_load_mwh",
      "dessem_export_utilisation",
    ]);

    // And the ordered model inputs of the two sets differ by exactly those 22.
    const inputsA = await readFeatureSetModelInputs(db, "dessem_free_v1");
    const inputsB = await readFeatureSetModelInputs(db, "dessem_augmented_v1");
    expect(inputsA).toHaveLength(78);
    expect(inputsB).toHaveLength(100);
    expect(inputsB.map((input) => input.column_name)).toEqual(
      expect.arrayContaining(inputsA.map((input) => input.column_name)),
    );
    expect(
      inputsB
        .map((input) => input.column_name)
        .filter((column) => !inputsA.some((input) => input.column_name === column)),
    ).toEqual(only.map((entry) => entry.column_name));
    // `subsystem` is an input and the rest of the identity and the stamp is not.
    expect(inputsA[0]?.column_name).toBe("subsystem");
    expect(inputsA.some((input) => input.column_name === "gate_at")).toBe(false);
    expect(inputsA.some((input) => input.column_name.startsWith("y_"))).toBe(false);
  });

  it("keeps the generated model-input artifact in step with the type", async () => {
    // The staleness check, and the only assertion in this repository that can
    // say whether `apps/ml` is reading the right feature names.
    //
    // `apps/ml`'s driver-group totality check needs the model inputs and the
    // Python side has no database, so the names travel as a *generated*
    // artifact — `feature_set_model_inputs(set)` serialised. Generated is the
    // whole claim: `ordered_features.yaml`, which this replaced, was a hand
    // transcription that matched `feature_set_model_inputs()` exactly, 77 names
    // and 99, while both were one name short of the spec's class-`K` table.
    // Nobody noticed, because a second list is silent while it agrees.
    //
    // So this compares **bytes**, against a freshly migrated database. A
    // regeneration run against a database behind the tree produces a
    // well-formed artifact for the wrong tree, and that is exactly the failure
    // a diff of the rendered file catches and a count does not.
    const expected = renderModelInputsArtifact(
      buildModelInputsArtifact(
        {
          dessem_free_v1: await readFeatureSetModelInputs(db, "dessem_free_v1"),
          dessem_augmented_v1: await readFeatureSetModelInputs(db, "dessem_augmented_v1"),
        },
        (await readFeatureDictionary(db)).length,
      ),
    );
    const onDisk = readFileSync(
      join(import.meta.dir, "../../..", MODEL_INPUTS_ARTIFACT_PATH),
      "utf8",
    );
    expect({
      path: MODEL_INPUTS_ARTIFACT_PATH,
      stale: onDisk !== expected,
      regenerate: "bun run --cwd apps/api features:snapshot",
    }).toEqual({
      path: MODEL_INPUTS_ARTIFACT_PATH,
      stale: false,
      regenerate: "bun run --cwd apps/api features:snapshot",
    });

    // Non-vacuous on the name the second list could not see: it is in the type,
    // so it is in the artifact, so `apps/ml` must have placed it in a driver
    // group. The composite type is the authority now, and this is the sentence
    // that says the chain reaches all the way to Python.
    expect(onDisk).toContain("observed_constrained_off_same_hour_exceedance_7d");
  });

  it("marks the proxies, and the columns the early gate does not have", async () => {
    // Two claims the dictionary makes that the *data* can be asked about, so
    // this is a binding rather than a restatement.
    const dictionary = await readFeatureDictionary(db);

    const early = await readServingRows(db, {
      targetDate: TARGET,
      ...query,
      gateProfile: "gate_early",
    });
    const late = await readServingRows(db, { targetDate: TARGET, ...query });

    const absent = dictionary.filter(
      (entry) => !entry.available_at_gate_early && entry.in_dessem_free_v1,
    );
    expect(absent.map((entry) => entry.column_name)).toHaveLength(12);
    for (const entry of absent) {
      const column = entry.column_name as keyof FeatureRow;
      // NULL everywhere at the early gate, and present at the late one. Both
      // halves matter: the first is the finding, the second is what makes it a
      // publication-time hole rather than a missing feature.
      expect({
        column: entry.column_name,
        early: early.every((row) => row[column] === null),
        late: late.some((row) => row[column] !== null),
      }).toEqual({ column: entry.column_name, early: true, late: true });
    }

    // Twelve columns are estimates of quantities WattSteer cannot observe, and
    // every one of them says the word in the catalogue that its reader needs.
    // The three `weather_expected_*` conversions are deliberately not among
    // them: the proxy stands one step behind, in `weather_wind_power_curve_cf`,
    // and flagging everything downstream of a proxy dilutes the flag.
    const proxies = dictionary.filter((entry) => entry.is_proxy);
    expect(proxies).toHaveLength(12);
    expect(
      proxies.some((entry) => entry.column_name.startsWith("weather_expected_")),
    ).toBe(false);
    for (const entry of proxies) {
      // Named in the column's own name or in its prose — the `proxy_` family
      // wears it as a prefix, and the rest say "estimate" or "generic" where a
      // reader will meet the caveat.
      expect({
        column: entry.column_name,
        named:
          entry.column_name.startsWith("proxy_") ||
          /proxy|estimate|upper bound|generic/i.test(entry.description),
      }).toEqual({ column: entry.column_name, named: true });
    }
    // The utilisation denominators are conservative in a *known* direction, and
    // the direction is in the column comment.
    const utilisation = dictionary.find(
      (entry) => entry.column_name === "observed_export_utilisation_mean_24h_to_cutoff",
    );
    expect(utilisation?.description).toContain("upper bound");
  });

  it("names a replacement for every dropped feature, and every replacement is a column", async () => {
    const dropped = await readDroppedFeatures(db);
    expect(dropped).toHaveLength(11);

    for (const entry of dropped) {
      expect({ feature: entry.idea_feature, reason: entry.reason.length > 0 }).toEqual({
        feature: entry.idea_feature,
        reason: true,
      });
      for (const column of entry.replacement_columns) {
        expect({
          feature: entry.idea_feature,
          column,
          exists: FEATURE_ROW_COLUMNS.includes(column as keyof FeatureRow),
        }).toEqual({ feature: entry.idea_feature, column, exists: true });
      }
    }

    // Exactly one is excluded rather than replaced, and it is the one whose
    // inclusion would be the mirror-image skew.
    const empty = dropped.filter((entry) => entry.replacement_columns.length === 0);
    expect(empty).toHaveLength(1);
    expect(empty[0]?.idea_feature).toContain("val_intercambioprogmwmed");

    // And a replacement pointing at a column that does not exist is refused
    // rather than published, so a rename cannot leave a stale sentence behind.
    let tolerated = false;
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await scoped.execute(sql`
          insert into feature_dropped_feature (idea_feature, reason, replacement, replacement_columns)
          values ('a_feature_nobody_proposed', 'because', 'a column that is not there',
                  array['residual_load_at_t']::text[])
        `);
        try {
          await readDroppedFeatures(scoped);
          tolerated = true;
        } catch (error) {
          expect(sqlStateOf(error)).toBe("22023");
        }
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    expect(tolerated).toBe(false);
  });

  it("expresses all three A/B configurations as arguments to the one function", async () => {
    // The acceptance claim, run rather than asserted: each configuration is a
    // call to `feature_rows` with different arguments, and none of them reaches
    // a second code path. The window each names is its own; what is exercised
    // here is one target date through each, because the fixture carries one.
    const configurations = await readAbConfigurations(db);
    expect(configurations.map((entry) => entry.run)).toEqual([
      "A-common",
      "A-full",
      "B-common",
    ]);

    for (const configuration of configurations) {
      const rows = await readFeatureRows(db, {
        targetFrom: TARGET,
        targetTo: TARGET,
        gateProfile: configuration.gate_profile,
        featureSet: configuration.feature_set,
        thresholdMw: 5,
      });
      expect({ run: configuration.run, rows: rows.length }).toEqual({
        run: configuration.run,
        rows: 96,
      });
      expect(rows.every((row) => row.feature_set === configuration.feature_set)).toBe(
        true,
      );
      expect(rows.every((row) => row.gate_profile === configuration.gate_profile)).toBe(
        true,
      );
    }

    // A-full and A-common differ in the window alone; B-common is the one that
    // changes the feature content. That is the whole reason there are three.
    const byRun = new Map(configurations.map((entry) => [entry.run, entry]));
    expect(byRun.get("A-full")?.feature_set).toBe(byRun.get("A-common")?.feature_set);
    expect(byRun.get("A-full")?.window_from).not.toBe(byRun.get("A-common")?.window_from);
    expect(byRun.get("B-common")?.window_from).toBe(byRun.get("A-common")?.window_from);
    expect(byRun.get("B-common")?.feature_set).toBe("dessem_augmented_v1");
    // All three at the same gate, so the comparison is not confounded by it.
    expect(new Set(configurations.map((entry) => entry.gate_profile))).toEqual(
      new Set(["gate_late"]),
    );

    // A configuration asking for a gate or a window its set does not have is
    // refused, rather than building eleven months of NULL DESSEM columns.
    let tolerated = false;
    try {
      await db.transaction(async (tx) => {
        const scoped = tx as unknown as Database;
        await scoped.execute(sql`
          insert into feature_ab_configuration (run, feature_set, window_from, gate_profile, isolates)
          values ('B-early', 'dessem_augmented_v1', '2024-04-01', 'gate_early', 'nothing it can have')
        `);
        try {
          await readAbConfigurations(scoped);
          tolerated = true;
        } catch (error) {
          expect(sqlStateOf(error)).toBe("22023");
        }
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof Error && /rollback/i.test(error.message))) {
        throw error;
      }
    }
    expect(tolerated).toBe(false);
  });

  it("builds both sets over their full windows, and the row counts are the arithmetic", async () => {
    // Four subsystems by twenty-four local hours by the days of the window. The
    // hours are counted through `feature_local_day_hours` rather than
    // multiplied by 24, so this cannot agree with a calendar that lost one.
    //
    // Fixed far end so the numbers are checkable: 2026-08-28.
    const setA = await readExpectedRowCount(db, "dessem_free_v1", "2026-08-28");
    const setB = await readExpectedRowCount(db, "dessem_augmented_v1", "2026-08-28");

    // 880 days x 96, and 463 x 96 — the spec's "≈ 84,500" and "≈ 44,200".
    expect(setA).toBe(880 * 96);
    expect(setB).toBe(463 * 96);
    expect(setA % 96).toBe(0);
    expect(setB % 96).toBe(0);

    // And a build really does produce 96 rows for a day, in both sets, so the
    // arithmetic is over the same row the function returns.
    for (const featureSet of ["dessem_free_v1", "dessem_augmented_v1"] as const) {
      const rows = await readFeatureRows(db, {
        targetFrom: TARGET,
        targetTo: TARGET,
        gateProfile: "gate_late",
        featureSet,
        thresholdMw: 5,
      });
      expect({ featureSet, rows: rows.length }).toEqual({ featureSet, rows: 96 });
      // The row grain, restated where it can be seen: one row per
      // (Subsystem, valid_time), carrying BOTH technologies' labels as columns
      // rather than duplicating sixty-odd shared context columns per technology.
      expect(new Set(rows.map(keyOf)).size).toBe(96);
      const curtailed = rows.find(
        (row) =>
          row.subsystem === "NE" &&
          new Date(row.valid_time).getTime() === HOUR_CURTAILED.getTime(),
      );
      expect(curtailed?.y_constrained_off_wind_mwh).not.toBeNull();
      expect(curtailed?.y_constrained_off_solar_mwh).not.toBeNull();
    }

    // The window is the part the function cannot hold, so it is refused here.
    expect(await readExpectedRowCount(db, "dessem_augmented_v1", "2024-04-01")).toBe(0);
  });

  it("builds a day in one call, and a week in seven days' worth of work", async () => {
    // The time and call budget, measured rather than promised. Two properties,
    // and the second is the one that matters for an 880-day build: the cost is
    // linear in the range, so a full window is days x the per-day cost and not
    // something worse. A range query that re-read a source per day would show
    // as a per-day cost that grows with the range.
    //
    // One call, always: `readFeatureRows` binds five arguments and issues a
    // single statement whatever the range, because the loop is inside the
    // function. That is what makes the serving call the training call.
    const ask = (from: string, to: string) =>
      readFeatureRows(db, { targetFrom: from, targetTo: to, ...query });

    await ask(TARGET, TARGET); // warm the plan, so the first call is not the sample
    const oneStart = performance.now();
    const one = await ask(TARGET, TARGET);
    const onePerDay = performance.now() - oneStart;

    const sevenStart = performance.now();
    const seven = await ask("2026-08-14", TARGET);
    const sevenPerDay = (performance.now() - sevenStart) / 7;

    expect(one).toHaveLength(96);
    expect(seven).toHaveLength(96 * 7);
    // A generous absolute ceiling, so this is a budget rather than a benchmark.
    expect(onePerDay).toBeLessThan(5000);
    // And the shape: per-day cost does not grow with the range. Three times is
    // slack for a cold cache on one of the seven days, not for an algorithm.
    expect(sevenPerDay).toBeLessThan(Math.max(onePerDay * 3, 1000));
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

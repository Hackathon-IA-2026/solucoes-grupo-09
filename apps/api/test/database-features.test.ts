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
  loadCalendar,
  loadCalendarArtifact,
  readFeatureRows,
  readServingRows,
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
    await db.execute(sql`
      insert into centroid_point (
        set_version, centroid_id, label, latitude, longitude, technology,
        represented_mw, origin, municipalities, plants, merged_from
      ) values (
        'centroid_set_v1', 'FE01_SOLAR', 'Solar', -9, -40, 'SOLAR', 1000,
        'hand_transcribed', '', 1, ''
      ) on conflict do nothing
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
    const before = await readServingRows(db, { targetDate: BEFORE_GO_LIVE, ...query });
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
    expect(dessemColumns).toHaveLength(21);

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
  const ablate = async (
    featureSet: "dessem_free_v1" | "dessem_augmented_v1",
  ): Promise<{
    before: FeatureRow[];
    after: FeatureRow[];
    deleted: number;
    deletedFromDessem: number;
    deletedPastCutoff: number;
  }> => {
    const asked = { ...query, featureSet } as const;
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
              where published_at > ${GATE_LATE.toISOString()}::timestamptz
                 or ingested_at > ${GATE_LATE.toISOString()}::timestamptz
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
              where valid_time > ${CUTOFF.toISOString()}::timestamptz
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

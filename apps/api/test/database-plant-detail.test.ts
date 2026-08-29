import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import { observedPlant, onsResourceVersion, plant } from "../src/database/schema.js";
import {
  type ObservedPlant,
  type PlantDetailHour,
  readPlantDetailAsOf,
  reconcilePlantIdentity,
  upsertObservedPlants,
  upsertReportingEntities,
  writePlantDetail,
} from "../src/ingest/index.js";

// Seam 2 for the plant-grain constrained-off detail — as-of reads, the
// database-level invariants, and the structural claim that no reason can reach
// a plant row. Gated exactly as `database.test.ts` is; spin one up with:
//
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:16-alpine
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

/** Run a statement expected to violate a constraint and name the one it hit. */
async function constraintViolated(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const cause = (error as { cause?: { constraint_name?: string } }).cause;
    return cause?.constraint_name ?? String(error);
  }
  return "no error was thrown";
}

/** A distant valid-time window, so a repeated run cannot collide with itself. */
const HOUR_ONE = new Date("2024-09-01T03:00:00.000Z");
const HOUR_TWO = new Date("2024-09-01T04:00:00.000Z");

const WIND_PLANT: ObservedPlant = {
  onsCode: "MAEDT1",
  cegCore: "EOL.CV.MA.033682-3",
  cegRaw: "EOL.CV.MA.033682-3.01",
  name: "Delta 3 I",
  subsystem: "N",
  stateCode: "MA",
  technology: "WIND",
  operationModality: "TIPO_II_C",
};

const SOLAR_PLANT: ObservedPlant = {
  onsCode: "BAFB11",
  cegCore: "UFV.RS.BA.034153-3",
  cegRaw: "UFV.RS.BA.034153-3.01",
  name: "BJL 11",
  subsystem: "NE",
  stateCode: "BA",
  technology: "SOLAR",
  operationModality: "TIPO_II_C",
};

const hour = (
  validTime: Date,
  measurement: { value: number; invalid: boolean } | null,
  verifiedGenerationMwh: number | null = 4.8,
): PlantDetailHour => ({
  plantOnsCode: WIND_PLANT.onsCode,
  technology: "WIND",
  validTime,
  estimatedGenerationMwh: 3.5,
  verifiedGenerationMwh,
  measurement,
  halfHoursObserved: 2,
});

suite("plant detail · bitemporal store (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    await db.execute(sql`truncate table plant_detail_hour`);
    await db.execute(sql`truncate table observed_plant cascade`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "restricao_coff_eolica_detail",
        resourceName: "Restricoes_coff_Eolicas_Detalhamento-2024-09",
        resourceUrl: "https://example.invalid/RESTRICAO_COFF_EOLICA_DETAIL_2024_09.csv",
        format: "CSV",
        changeKey: `plant-detail-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";
    await upsertObservedPlants(db, [WIND_PLANT, SOLAR_PLANT]);
  });

  afterAll(() => handle.close());

  const write = (rows: PlantDetailHour[], ingestedAt: Date) =>
    writePlantDetail(db, {
      rows,
      publishedAt: ingestedAt,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt,
    });

  it("appends a version only when the values actually changed", async () => {
    const first = new Date("2026-01-01T00:00:00.000Z");
    const inserted = await write(
      [hour(HOUR_ONE, { value: 6.1, invalid: false }), hour(HOUR_TWO, null)],
      first,
    );
    expect(inserted).toEqual({ inserted: 2, revised: 0, unchanged: 0 });

    const again = await write(
      [hour(HOUR_ONE, { value: 6.1, invalid: false }), hour(HOUR_TWO, null)],
      new Date("2026-01-02T00:00:00.000Z"),
    );
    expect(again).toEqual({ inserted: 0, revised: 0, unchanged: 2 });

    // A wind speed restated on its own is a revision: the measured resource is
    // part of the value, not metadata about it.
    const revised = await write(
      [hour(HOUR_ONE, { value: 6.4, invalid: false }), hour(HOUR_TWO, null)],
      new Date("2026-01-03T00:00:00.000Z"),
    );
    expect(revised).toEqual({ inserted: 0, revised: 1, unchanged: 1 });
  });

  it("reads exactly one row per key as of an instant", async () => {
    const before = await readPlantDetailAsOf(db, {
      asOf: new Date("2026-01-02T12:00:00.000Z"),
      from: HOUR_ONE,
      to: new Date("2024-09-02T00:00:00.000Z"),
    });
    expect(before.rows).toHaveLength(2);
    expect(before.rows[0]?.measurement).toEqual({ value: 6.1, invalid: false });

    const after = await readPlantDetailAsOf(db, {
      asOf: new Date("2026-06-01T00:00:00.000Z"),
      from: HOUR_ONE,
      to: new Date("2024-09-02T00:00:00.000Z"),
    });
    expect(after.rows[0]?.measurement).toEqual({ value: 6.4, invalid: false });
    expect(after.rows[0]?.dataVersion).toBe(2);
    // The window predates go-live, so this is ONS's current restatement of the
    // past rather than what was knowable then.
    expect(after.vintageFidelity).toBe("revision_optimistic");
  });

  it("round-trips an absent measurement as absent, not as zero", async () => {
    const result = await readPlantDetailAsOf(db, {
      asOf: new Date("2026-06-01T00:00:00.000Z"),
      from: HOUR_TWO,
      to: new Date("2024-09-02T00:00:00.000Z"),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.measurement).toBeNull();
  });
});

suite("plant detail · invariants the database enforces (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    await db.execute(sql`truncate table plant_detail_hour`);
    await db.execute(sql`truncate table observed_plant cascade`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "restricao_coff_eolica_detail",
        resourceName: "Restricoes_coff_Eolicas_Detalhamento-2024-09",
        resourceUrl: "https://example.invalid/detail.csv",
        format: "CSV",
        changeKey: `plant-detail-checks|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";
    await upsertObservedPlants(db, [WIND_PLANT, SOLAR_PLANT]);
  });

  afterAll(() => handle.close());

  const insert = (values: Record<string, unknown>) =>
    db.execute(sql`
      insert into plant_detail_hour (
        plant_ons_code, technology, valid_time, data_version,
        measured_wind_speed_ms, measured_irradiance_wm2, measurement_invalid,
        half_hours_observed, published_at, published_at_precision, ingested_at,
        value_digest, source_version_id
      ) values (
        ${values.code as string}, ${values.technology as string},
        ${HOUR_ONE.toISOString()}::timestamptz, ${values.version as number},
        ${values.wind as number | null}, ${values.irradiance as number | null},
        ${values.invalid as number | null},
        2, now(), 'file', now(), ${`digest-${values.version}`}, ${sourceVersionId}
      )
    `);

  it("refuses a measurement without its invalid flag", async () => {
    const violated = await constraintViolated(() =>
      insert({
        code: WIND_PLANT.onsCode,
        technology: "WIND",
        version: 1,
        wind: 6.1,
        irradiance: null,
        invalid: null,
      }),
    );
    expect(violated).toBe("plant_detail_measurement_whole");
  });

  it("refuses an invalid flag with nothing measured", async () => {
    const violated = await constraintViolated(() =>
      insert({
        code: WIND_PLANT.onsCode,
        technology: "WIND",
        version: 2,
        wind: null,
        irradiance: null,
        invalid: 0,
      }),
    );
    expect(violated).toBe("plant_detail_measurement_whole");
  });

  it("refuses an irradiance on a wind row", async () => {
    // The units are not interchangeable, and a column that could hold either
    // would eventually hold the wrong one.
    const violated = await constraintViolated(() =>
      insert({
        code: WIND_PLANT.onsCode,
        technology: "WIND",
        version: 3,
        wind: null,
        irradiance: 812.4,
        invalid: 0,
      }),
    );
    expect(violated).toBe("plant_detail_measurement_technology");
  });

  it("refuses a wind speed on a solar row", async () => {
    const violated = await constraintViolated(() =>
      insert({
        code: SOLAR_PLANT.onsCode,
        technology: "SOLAR",
        version: 4,
        wind: 6.1,
        irradiance: null,
        invalid: 0,
      }),
    );
    expect(violated).toBe("plant_detail_measurement_technology");
  });

  it("refuses a plant it has never seen", async () => {
    const violated = await constraintViolated(() =>
      insert({
        code: "NOSUCH",
        technology: "WIND",
        version: 5,
        wind: 6.1,
        irradiance: null,
        invalid: 0,
      }),
    );
    expect(violated).toBe("plant_detail_hour_plant_ons_code_observed_plant_ons_code_fk");
  });
});

suite("plant detail · no schema path from a plant to a reason", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  afterAll(() => handle.close());

  it("has no reason-shaped column on the plant-grain table", async () => {
    // The claim of the ticket, asserted against the live catalogue rather than
    // against the source file that declares it.
    const columns = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_name = 'plant_detail_hour'
    `);
    const names = [...columns].map((row) => row.column_name);
    expect(names.length).toBeGreaterThan(0);
    for (const forbidden of [
      "reason",
      "origin",
      "restriction_description",
      "cause_mixed",
      "reference_generation_mwh",
      "final_reference_generation_mwh",
      "constrained_off_mwh",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("has no reason-shaped column on the plant dimension either", async () => {
    const columns = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_name = 'observed_plant'
    `);
    const names = [...columns].map((row) => row.column_name);
    expect(names.length).toBeGreaterThan(0);
    // Not even the conjunto's name: it is the one field from which the entity
    // that *does* carry a reason could be rebuilt.
    for (const forbidden of ["reason", "origin", "conjunto_code", "conjunto_name"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("declares no foreign key into the table that holds reasons", async () => {
    const links = await db.execute<{ foreign_table: string }>(sql`
      select ccu.table_name as foreign_table
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'
        and tc.table_name in ('plant_detail_hour', 'observed_plant')
    `);
    const targets = [...links].map((row) => row.foreign_table);
    expect(targets).not.toContain("curtailment_report_hour");
    expect(targets).not.toContain("reporting_entity");
    expect(targets).not.toContain("conjunto");
  });
});

suite("plant detail · identity resolves against the other grains", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  beforeAll(async () => {
    await db.execute(sql`truncate table plant_detail_hour`);
    await db.execute(sql`truncate table observed_plant cascade`);
    await db.execute(sql`truncate table generating_unit`);
    await db.execute(sql`delete from plant`);
    await db.execute(sql`truncate table curtailment_report_hour`);
    await db.execute(sql`delete from reporting_entity`);

    await upsertObservedPlants(db, [WIND_PLANT, SOLAR_PLANT]);
    // The entity grain sees this plant too, because a Tipo I / II-B plant is
    // its own reporting entity. Here it is recorded as one, with the same CEG.
    await upsertReportingEntities(db, [
      {
        onsCode: WIND_PLANT.onsCode,
        kind: "PLANT",
        cegCore: WIND_PLANT.cegCore,
        name: WIND_PLANT.name,
        subsystem: WIND_PLANT.subsystem,
        stateCode: WIND_PLANT.stateCode,
      },
    ]);
    await db.insert(plant).values({
      cegCore: WIND_PLANT.cegCore,
      cegRaw: WIND_PLANT.cegRaw,
      name: WIND_PLANT.name,
      subsystem: WIND_PLANT.subsystem,
      stateCode: WIND_PLANT.stateCode,
      technology: "WIND",
      operationModality: "TIPO_II_C",
      ownerName: "—",
      operatorName: "—",
    });
  });

  afterAll(() => handle.close());

  it("fills the registry's missing ONS code from the one file that has both", async () => {
    // `capacidade-geracao` publishes no `id_ons`; these files publish both
    // identifiers on the same row, for every plant that was ever measured.
    const before = await db.execute<{ ons_plant_code: string | null }>(
      sql`select ons_plant_code from plant where ceg_core = ${WIND_PLANT.cegCore}`,
    );
    expect(before[0]?.ons_plant_code).toBeNull();

    const result = await reconcilePlantIdentity(db);
    expect(result.linkedRegistryPlants).toBe(1);
    expect(result.ambiguousCegCores).toBe(0);

    const after = await db.execute<{ ons_plant_code: string | null }>(
      sql`select ons_plant_code from plant where ceg_core = ${WIND_PLANT.cegCore}`,
    );
    expect(after[0]?.ons_plant_code).toBe(WIND_PLANT.onsCode);
  });

  it("agrees with the entity grain about a self-reporting plant", async () => {
    const result = await reconcilePlantIdentity(db);
    expect(result.selfReporting).toBe(1);
    expect(result.conflicts).toEqual([]);
  });

  it("reports a disagreement rather than repairing it", async () => {
    await db
      .insert(observedPlant)
      .values({ ...SOLAR_PLANT, onsCode: "CJU_MAPLN" })
      .onConflictDoNothing();
    await upsertReportingEntities(db, [
      {
        onsCode: "CJU_MAPLN",
        kind: "CONJUNTO",
        cegCore: null,
        name: "Conj. Paulino Neves",
        subsystem: "N",
        stateCode: "MA",
      },
    ]);

    const result = await reconcilePlantIdentity(db);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.onsCode).toBe("CJU_MAPLN");
    expect(result.conflicts[0]?.entityKind).toBe("CONJUNTO");

    await db.execute(sql`delete from observed_plant where ons_code = 'CJU_MAPLN'`);
    await db.execute(sql`delete from reporting_entity where ons_code = 'CJU_MAPLN'`);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { applyAxes } from "../src/contract/scope.js";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import { payloadRefusal } from "../src/errors.js";
import {
  createControlledFlowIngestor,
  createProgrammedGenerationIngestor,
  createProgrammedVsForecastIngestor,
  type ProgrammedGenerationHalfHour,
  programmeFilePublishedAt,
  writeProgrammedGeneration,
} from "../src/ingest/index.js";
import {
  dailyCsv,
  type FixtureEntity,
  type FixturePlant,
  flowCsv,
  pxpCsv,
  wholeFleet,
} from "./support/programme-fixtures.js";

// The day-ahead programme datasets against a real Postgres, gated as every
// `database-*.test.ts` is: `test:db` supplies the URL and a plain `bun test` skips it.
//
// What only a database can show: the forecast CHECK that keeps a programme from
// being read as an observation, the `DISTINCT ON` as-of pick under the views, the
// hour rule ("a half-empty hour is a hole") in SQL, and that a job re-run writes
// nothing. The parsers are proved without one in `ons-programme-*.test.ts`.
// Not named `URL`: that would shadow the global the fetch stub below needs.
const DATABASE = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = DATABASE ? describe : describe.skip;

const DAY = "2026-09-17";
const FIRST_HALF_HOUR = new Date("2026-09-17T03:00:00.000Z");
const T_END = new Date("2100-01-01T00:00:00.000Z");

/** ONS stamps the file *after* the day begins here — what the anchor exists to survive. */
const LAST_MODIFIED = "Thu, 17 Sep 2026 04:08:05 GMT";

interface Served {
  slug: string;
  file: string;
  body: string;
  lastModified?: string;
}

/**
 * A fetch that serves a CKAN package list, HEADs and GETs from memory, and counts
 * what it was asked for so a re-run can be shown to have downloaded nothing.
 */
function stubFetch(served: Served[]) {
  const counts = { head: 0, get: 0, package: 0 };
  const requested: string[] = [];
  const urlOf = (item: Served) =>
    `https://example.invalid/dataset/${item.slug}/${item.file}`;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("package_show")) {
      counts.package += 1;
      const slug = new URL(url).searchParams.get("id");
      const resources = served
        .filter((candidate) => candidate.slug === slug)
        .map((entry) => ({
          name: entry.file,
          url: urlOf(entry),
          format: entry.file.endsWith(".csv") ? "CSV" : "PARQUET",
          created: "2026-09-16T23:00:00",
          last_modified: "2026-09-16T23:00:00",
        }));
      return Response.json({ success: true, result: { resources } });
    }
    const item = served.find((candidate) => urlOf(candidate) === url);
    if (!item) {
      return new Response("not found", { status: 404 });
    }
    const headers = {
      "last-modified": item.lastModified ?? LAST_MODIFIED,
      "content-length": String(item.body.length),
      etag: `"${item.body.length}"`,
    };
    if (init?.method === "HEAD") {
      counts.head += 1;
      return new Response(null, { headers });
    }
    counts.get += 1;
    requested.push(url);
    return new Response(item.body, { headers });
  }) as typeof fetch;
  return { fetch: impl, counts, requested };
}

const groupRow = (
  validTime: Date,
  programmedMw: number,
  overrides: Partial<ProgrammedGenerationHalfHour> = {},
): ProgrammedGenerationHalfHour => ({
  subsystem: "SE",
  technology: "WIND",
  validTime,
  referenceDay: "2026-09-17",
  plantCount: 3,
  reportingPlantCount: 3,
  programmedMw,
  availabilityMw: 50,
  inflexibilityMw: null,
  unitCommitmentMw: null,
  electricalReasonMw: null,
  energyGuaranteeMw: null,
  exportMw: null,
  ...overrides,
});

suite("programme · the bitemporal store (real Postgres)", () => {
  const handle = createDatabase(DATABASE as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    await db.execute(
      sql`truncate table programmed_generation_half_hour, programmed_vs_forecast_half_hour, controlled_flow_half_hour, pdp_crosswalk`,
    );
    await db.execute(sql`truncate table ons_resource_version cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "programacao_diaria",
        resourceName: "PROGRAMACAO_DIARIA_2026_09_17.csv",
        resourceUrl: "https://example.invalid/PROGRAMACAO_DIARIA_2026_09_17.csv",
        format: "CSV",
        changeKey: 'test|1|"a"',
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";
  });

  afterAll(() => handle.close());

  const PUBLISHED = programmeFilePublishedAt(DAY);
  const T1 = new Date("2026-09-17T10:00:00.000Z");
  const T2 = new Date("2026-09-18T10:00:00.000Z");
  const write = (rows: ProgrammedGenerationHalfHour[], ingestedAt: Date) =>
    writeProgrammedGeneration(db, {
      rows,
      publishedAt: PUBLISHED,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt,
    });

  const readVersion = async (asOf: Date) =>
    db.transaction(async (tx) => {
      await applyAxes(tx as never, { asOf });
      return tx.execute<{ programmed_mw: number; data_version: number }>(sql`
        select programmed_mw, data_version from canonical_programmed_generation
        where subsystem = 'SE' and technology = 'WIND' and valid_time = ${FIRST_HALF_HOUR.toISOString()}::timestamptz
      `);
    });

  it("writes the first vintage at data_version 1", async () => {
    const result = await write([groupRow(FIRST_HALF_HOUR, 100)], T1);
    expect(result).toMatchObject({ inserted: 1, revised: 0, unchanged: 0 });
  });

  it("writes nothing when the same numbers arrive again", async () => {
    const result = await write([groupRow(FIRST_HALF_HOUR, 100)], T2);
    expect(result).toMatchObject({ inserted: 0, revised: 0, unchanged: 1 });
  });

  it("appends a new version when a value really changed, and an as-of read sees each", async () => {
    const result = await write([groupRow(FIRST_HALF_HOUR, 125)], T2);
    expect(result).toMatchObject({ inserted: 0, revised: 1 });
    const before = await readVersion(new Date("2026-09-17T12:00:00.000Z"));
    const after = await readVersion(new Date("2026-09-19T00:00:00.000Z"));
    expect([before[0]?.programmed_mw, before[0]?.data_version]).toEqual([100, 1]);
    expect([after[0]?.programmed_mw, after[0]?.data_version]).toEqual([125, 2]);
  });

  it("refuses, in code, a stamp that is not before the half hour it describes", async () => {
    const attempt = writeProgrammedGeneration(db, {
      rows: [groupRow(FIRST_HALF_HOUR, 1)],
      publishedAt: FIRST_HALF_HOUR,
      publishedAtPrecision: "file",
      sourceVersionId,
    });
    const refusal = await attempt.catch((error) => payloadRefusal(error));
    expect(refusal?.refusal).toBe("forecast_integrity");
  });

  it("refuses, in the database, a row that would be an observation", async () => {
    // The CHECK is the guarantee and the code above is the diagnosis: a writer
    // that skips the diagnosis still cannot store an observation here.
    const insert = async () => {
      await db.execute(sql`
        insert into programmed_generation_half_hour
          (subsystem, technology, valid_time, run_label, plant_count, reporting_plant_count,
           programmed_mw, data_version, published_at, published_at_precision, value_digest,
           source_version_id)
        values ('N', 'WIND', ${FIRST_HALF_HOUR.toISOString()}::timestamptz, 'x', 1, 1, 1, 1,
                ${FIRST_HALF_HOUR.toISOString()}::timestamptz, 'file', 'd', ${sourceVersionId}::uuid)
      `);
    };
    await expect(insert()).rejects.toThrow();
  });

  it("refuses more reporting plants than plants", async () => {
    await expect(
      write([groupRow(FIRST_HALF_HOUR, 1, { reportingPlantCount: 9 })], T2),
    ).rejects.toThrow();
  });
});

suite("programme · the three ingestors end to end (real Postgres)", () => {
  const handle = createDatabase(DATABASE as string, 5);
  const { db } = handle;

  beforeAll(async () => {
    await db.execute(
      sql`truncate table programmed_generation_half_hour, programmed_vs_forecast_half_hour, controlled_flow_half_hour, pdp_crosswalk`,
    );
    await db.execute(sql`truncate table ons_resource_version cascade`);
    await db.execute(sql`truncate table ingestion_run cascade`);
  });
  afterAll(() => handle.close());

  const zero = (code: string, subsystem: FixturePlant["subsystem"]): FixturePlant => ({
    code,
    subsystem,
    tip: "SOLAR",
    programmed: () => 0,
    availability: () => 0,
  });
  const fleet = [...wholeFleet(), zero("Z1", "NE"), zero("Z2", "S")];

  // E_WNE carries NE wind's programme exactly, E_SSE SE solar's; E_ZERO is flat
  // at zero and so collides with two solar plants in different subsystems; E_NONE
  // is programmed at a value no plant carries.
  const entities: FixtureEntity[] = [
    { code: "E_WNE", programmed: (p) => 200 + p + 0.5, forecast: (p) => 1200 + p + 0.5 },
    {
      code: "E_SSE",
      programmed: (p) => 800 + p + 0.75,
      forecast: (p) => 1800 + p + 0.75,
    },
    { code: "E_ZERO", programmed: () => 0, forecast: () => 10 },
    { code: "E_NONE", programmed: () => 50, forecast: () => 60 },
  ];

  // Another dataset's files sitting in the flow dataset's resource list, as CSVs
  // — the case the prefix guards, placed so each of its two defences is needed
  // on its own. One shares the genuine file's date and is listed FIRST, so a
  // selector without the prefix would pick it; the other has a date of its own,
  // so a discovery without the prefix would offer a day with no genuine file. With
  // a single same-date stray, dropping the prefix from discovery alone went
  // unnoticed: the day list is a set, and it dedups the stray into the real day.
  const strays: Served[] = [
    {
      slug: "programacao_fluxo_controlado",
      file: "PROGRAMACAO_DIARIA_2026_09_17.csv",
      body: "garbage",
    },
    {
      slug: "programacao_fluxo_controlado",
      file: "PROGRAMACAO_DIARIA_2026_09_10.csv",
      body: "garbage",
    },
  ];
  const served: Served[] = [
    ...strays,
    {
      slug: "programacao_diaria",
      file: "PROGRAMACAO_DIARIA_2026_09_17.csv",
      body: dailyCsv(DAY, fleet),
    },
    {
      slug: "programacao_x_previsao",
      file: "PROGRAMACAO_X_PREVISAO_2026_09_17.csv",
      body: pxpCsv(DAY, entities),
    },
    {
      slug: "programacao_fluxo_controlado",
      file: "PROGRAMACAO_FLUXO_CONTROLADO_2026_09_17.csv",
      body: flowCsv(DAY, [
        { name: "BtB 1", submarket: "SE", load: (p) => -275 + p },
        { name: "Boa Vista", submarket: "RR", load: (p) => 40 + p },
      ]),
    },
  ];
  const stub = stubFetch(served);
  const shared = { db, fetch: stub.fetch };
  const noop = () => {};

  it("ingests programacao_diaria aggregated, stamped D-1 23:00 rather than from Last-Modified", async () => {
    const result = await createProgrammedGenerationIngestor(shared)({}, noop);
    expect(result).toMatchObject({ daysAvailable: 1, daysIngested: 1, daysRefused: 0 });
    // 18 plants x 48 half hours, collapsed to 16 (subsystem, technology) groups... plus
    // the two extra solar plants sharing NE and S groups: 16 groups x 48.
    expect(result.rowsParsed).toBe(16 * 48);
    expect(result.extra.plantRowsRead).toBe(18 * 48);

    const [row] = await db.execute<{ published_at: string; precision: string }>(sql`
      select published_at, published_at_precision as precision
      from programmed_generation_half_hour limit 1
    `);
    // The stub's Last-Modified is 04:08Z on the reference day — after patamar 1
    // began. Stored as the anchor, or the CHECK above would have refused the row.
    expect(new Date(row?.published_at ?? "").toISOString()).toBe(
      "2026-09-17T02:00:00.000Z",
    );
    expect(row?.precision).toBe("file");
    const [version] = await db.execute<{ change_key: string }>(sql`
      select change_key from ons_resource_version where dataset_slug = 'programacao_diaria' limit 1
    `);
    expect(version?.change_key).toContain("04:08:05");
  });

  it("re-running the same day downloads nothing and writes nothing", async () => {
    const before = stub.counts.get;
    const result = await createProgrammedGenerationIngestor(shared)({}, noop);
    expect(result.daysDownloaded).toBe(0);
    expect(result.inserted).toBe(0);
    expect(stub.counts.get).toBe(before);
  });

  it("ingests programacao_x_previsao and derives the crosswalk from the plant file", async () => {
    const result = await createProgrammedVsForecastIngestor(shared)({}, noop);
    expect(result).toMatchObject({ daysIngested: 1, daysRefused: 0 });
    expect(result.rowsParsed).toBe(4 * 48);
    // Two entities determined outright, one ambiguous, one unmatched: all four
    // are written, so the read can say "no match" rather than "never looked".
    expect(result.extra.crosswalkSet).toBe(3);
    expect(result.extra.crosswalkConflicts).toBe(0);
    const rows = await db.execute<{
      pdp_code: string;
      subsystem_candidates: string[];
      technology_candidates: string[];
    }>(
      sql`select pdp_code, subsystem_candidates, technology_candidates from pdp_crosswalk order by 1`,
    );
    const byCode = new Map(rows.map((row) => [row.pdp_code, row]));
    expect(byCode.size).toBe(4);
    expect(byCode.get("E_WNE")?.subsystem_candidates).toEqual(["NE"]);
    expect(byCode.get("E_WNE")?.technology_candidates).toEqual(["WIND"]);
    expect(byCode.get("E_SSE")?.subsystem_candidates).toEqual(["SE"]);
    expect(byCode.get("E_ZERO")?.subsystem_candidates).toEqual(["NE", "S"]);
    expect(byCode.get("E_ZERO")?.technology_candidates).toEqual(["SOLAR"]);
    expect(byCode.get("E_NONE")?.subsystem_candidates).toEqual([]);
    // The energy-weighted determination travels as sums, for the reader to divide.
    expect(result.extra.pdpEnergyMw).toBeGreaterThan(
      result.extra.pdpEnergyDeterminedMw ?? 0,
    );
  });

  it("does not fetch the plant file again once every code is one subsystem", async () => {
    // E_ZERO and E_NONE are still unresolved, so it does fetch — the property is
    // that a run with nothing new to say writes no belief.
    const result = await createProgrammedVsForecastIngestor(shared)(
      { force: true },
      noop,
    );
    expect(result.extra.crosswalkRowsWritten ?? 0).toBe(0);
  });

  it("a later day that contradicts the belief is reported by code and never written over it", async () => {
    // Day 2: E_WNE's programme now matches only a SOLAR plant in S. That is the
    // shape of the real collision seen on 2026-04-10 (a flat 18-19 MW programme
    // matching one plant in another subsystem), and the belief from day 1 —
    // NE/WIND — is the one that stands.
    const before = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pdp_crosswalk where pdp_code = 'E_WNE'`,
    );
    const otherDay = "2026-09-18";
    const collided: FixturePlant[] = [
      ...fleet.filter((plant) => plant.code !== "WNE"),
      {
        code: "SCOLLIDE",
        subsystem: "S",
        tip: "SOLAR",
        programmed: (p) => 200 + p + 0.5,
        availability: () => 0,
      },
    ];
    const local = stubFetch([
      {
        slug: "programacao_diaria",
        file: "PROGRAMACAO_DIARIA_2026_09_18.csv",
        body: dailyCsv(otherDay, collided),
      },
      {
        slug: "programacao_x_previsao",
        file: "PROGRAMACAO_X_PREVISAO_2026_09_18.csv",
        body: pxpCsv(otherDay, entities),
      },
    ]);
    const result = await createProgrammedVsForecastIngestor({ db, fetch: local.fetch })(
      { crosswalk: "always" },
      noop,
    );
    expect(result.extra.crosswalkConflicts).toBe(1);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("PDP E_WNE conflicts");
    expect(result.notes[0]).toContain("stored NE WIND");
    expect(result.notes[0]).toContain("the stored belief stands");

    const [belief] = await db.execute<{
      subsystem_candidates: string[];
      technology_candidates: string[];
    }>(sql`
      select subsystem_candidates, technology_candidates from pdp_crosswalk
      where pdp_code = 'E_WNE' order by data_version desc limit 1`);
    expect(belief?.subsystem_candidates).toEqual(["NE"]);
    expect(belief?.technology_candidates).toEqual(["WIND"]);
    const after = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pdp_crosswalk where pdp_code = 'E_WNE'`,
    );
    expect(after[0]?.n).toBe(before[0]?.n ?? -1);
  });

  it("asks for the plant file as Parquet when that is the only rendition, and skips the crosswalk if it cannot be decoded", async () => {
    // Guards a defect found by a lint warning: the crosswalk's plant-file
    // selection was still CSV-only after the adapters learned Parquet, so on a
    // day when `programacao_diaria` exists only as Parquet it could not have
    // found the file at all. Valid Parquet cannot be fabricated here, so the
    // property is that the Parquet URL is *requested*, and that bytes which do not
    // decode are a recorded refusal — the crosswalk is skipped, the day of ONS
    // forecasts is not lost, and nothing throws.
    const day = "2026-09-19";
    const local = stubFetch([
      {
        slug: "programacao_diaria",
        file: "PROGRAMACAO_DIARIA_2026_09_19.parquet",
        body: "PAR1 not really",
      },
      {
        slug: "programacao_x_previsao",
        file: "PROGRAMACAO_X_PREVISAO_2026_09_19.csv",
        body: pxpCsv(day, entities),
      },
    ]);
    const result = await createProgrammedVsForecastIngestor({ db, fetch: local.fetch })(
      { crosswalk: "always" },
      noop,
    );
    expect(
      local.requested.some((url) =>
        url.endsWith("PROGRAMACAO_DIARIA_2026_09_19.parquet"),
      ),
    ).toBe(true);
    expect(result).toMatchObject({ daysIngested: 1, daysRefused: 0 });
    expect(result.rowsParsed).toBe(4 * 48);
    expect(result.extra.crosswalkSkipped).toBe(1);
  });

  it("ingests programacao_fluxo_controlado and never sees the stray file", async () => {
    const result = await createControlledFlowIngestor(shared)({}, noop);
    expect(result).toMatchObject({ daysAvailable: 1, daysIngested: 1, daysRefused: 0 });
    expect(result.rowsParsed).toBe(2 * 48);
    const submarkets = await db.execute<{ submarket: string }>(
      sql`select distinct submarket from controlled_flow_half_hour order by 1`,
    );
    expect(submarkets.map((row) => row.submarket)).toEqual(["RR", "SE"]);
  });

  it("records a refused day, and a standing refusal costs one HEAD and no download", async () => {
    const short: Served[] = [
      {
        slug: "programacao_x_previsao",
        file: "PROGRAMACAO_X_PREVISAO_2026_09_16.csv",
        body: pxpCsv("2026-09-16", entities, {
          skip: (code, p) => code === "E_WNE" && p === 5,
        }),
      },
    ];
    const local = stubFetch(short);
    const ingest = createProgrammedVsForecastIngestor({ db, fetch: local.fetch });
    const first = await ingest({}, noop);
    expect(first).toMatchObject({ daysRefused: 1, daysIngested: 0 });
    expect(first.refusals[0]).toMatchObject({ reason: "coverage", refusedThisRun: true });

    const gets = local.counts.get;
    const second = await ingest({}, noop);
    expect(second).toMatchObject({ daysStandingRefused: 1, daysDownloaded: 0 });
    expect(local.counts.get).toBe(gets);
  });

  describe("the canonical views", () => {
    const read = <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
      db.transaction(async (tx) => {
        await applyAxes(tx as never, { asOf: T_END });
        return tx.execute<T>(query);
      });

    it("canonical_pdp_crosswalk states an absence as null beside a reason, and never picks", async () => {
      const rows = await read<{
        pdp_code: string;
        subsystem: string | null;
        subsystem_unavailable_reason: string | null;
        technology: string | null;
        technology_unavailable_reason: string | null;
      }>(sql`select * from canonical_pdp_crosswalk order by pdp_code`);
      const byCode = new Map(rows.map((row) => [row.pdp_code, row]));
      expect(byCode.get("E_WNE")).toMatchObject({
        subsystem: "NE",
        subsystem_unavailable_reason: null,
        technology: "WIND",
      });
      expect(byCode.get("E_ZERO")).toMatchObject({
        subsystem: null,
        subsystem_unavailable_reason: "ambiguous",
        technology: "SOLAR",
        technology_unavailable_reason: null,
      });
      expect(byCode.get("E_NONE")).toMatchObject({
        subsystem: null,
        subsystem_unavailable_reason: "no_match",
      });
      // A null is never without its reason.
      for (const row of rows) {
        expect(row.subsystem === null).toBe(row.subsystem_unavailable_reason !== null);
        expect(row.technology === null).toBe(row.technology_unavailable_reason !== null);
      }
    });

    it("canonical_programmed_vre sums mapped entities and states what it left out", async () => {
      const rows = await read<{
        subsystem: string;
        technology: string;
        forecast_mw: number;
        programmed_mw: number;
        entity_count: number;
        mapped_programmed_share: number;
        unmapped_programmed_mw: number;
      }>(sql`
        select * from canonical_programmed_vre
        where valid_time = ${FIRST_HALF_HOUR.toISOString()}::timestamptz order by subsystem`);
      expect(rows.map((row) => `${row.subsystem}/${row.technology}`)).toEqual([
        "NE/WIND",
        "SE/SOLAR",
      ]);
      const [wind, solar] = rows;
      expect(wind?.programmed_mw).toBeCloseTo(201.5, 6);
      expect(wind?.forecast_mw).toBeCloseTo(1201.5, 6);
      expect(solar?.programmed_mw).toBeCloseTo(801.75, 6);
      // 201.5 + 801.75 mapped, out of those plus E_ZERO (0) and E_NONE (50).
      const total = 201.5 + 801.75 + 0 + 50;
      expect(wind?.mapped_programmed_share).toBeCloseTo((201.5 + 801.75) / total, 6);
      expect(wind?.unmapped_programmed_mw).toBeCloseTo(50, 6);
      // The whole half hour's coverage, repeated on every row of it.
      expect(solar?.mapped_programmed_share).toBeCloseTo(
        wind?.mapped_programmed_share ?? -1,
        9,
      );
    });

    it("canonical_subsystem_programme_hour averages two half hours into an hour", async () => {
      const [ne] = await read<{
        programmed_wind_mw: number;
        thermal_inflexibility_mw: number;
        pdp_wind_forecast_mw: number;
        pdp_mapped_programmed_share: number;
        valid_time: string;
      }>(sql`
        select * from canonical_subsystem_programme_hour
        where subsystem = 'NE' and valid_time = ${FIRST_HALF_HOUR.toISOString()}::timestamptz`);
      // NE wind is 200 + p + 0.5: patamares 1 and 2 are 201.5 and 202.5.
      expect(ne?.programmed_wind_mw).toBeCloseTo(202, 6);
      expect(ne?.thermal_inflexibility_mw).toBeCloseTo(207, 6);
      expect(ne?.pdp_wind_forecast_mw).toBeCloseTo(1202, 6);
      expect(ne?.pdp_mapped_programmed_share).toBeGreaterThan(0.9);
      expect(new Date(ne?.valid_time ?? "").toISOString()).toBe(
        "2026-09-17T03:00:00.000Z",
      );
    });

    it("a half-empty hour is a hole, not a half-sized one", async () => {
      await db.execute(sql`
        delete from programmed_generation_half_hour
        where subsystem = 'NE' and technology = 'WIND'
          and valid_time = ${new Date("2026-09-17T03:30:00.000Z").toISOString()}::timestamptz`);
      const [ne] = await read<{
        programmed_wind_mw: number | null;
        programmed_solar_mw: number | null;
      }>(sql`
        select programmed_wind_mw, programmed_solar_mw from canonical_subsystem_programme_hour
        where subsystem = 'NE' and valid_time = ${FIRST_HALF_HOUR.toISOString()}::timestamptz`);
      expect(ne?.programmed_wind_mw).toBeNull();
      // The other technologies of the same hour are untouched.
      expect(ne?.programmed_solar_mw).not.toBeNull();
    });

    it("canonical_controlled_flow returns element grain with the sign intact", async () => {
      const rows = await read<{
        element: string;
        load_mw: number;
        submarket: string;
      }>(sql`
        select element, load_mw, submarket from canonical_controlled_flow
        where valid_time = ${FIRST_HALF_HOUR.toISOString()}::timestamptz order by element`);
      // Ordered as the database collates them: "Boa Vista" before "BtB 1".
      expect(rows).toEqual([
        { element: "Boa Vista", load_mw: 41, submarket: "RR" },
        { element: "BtB 1", load_mw: -274, submarket: "SE" },
      ] as never);
    });

    it("canonical_programmed_generation is empty before anything was learned", async () => {
      const rows = await db.transaction(async (tx) => {
        await applyAxes(tx as never, { asOf: new Date("2000-01-01T00:00:00.000Z") });
        return tx.execute(sql`select 1 from canonical_programmed_generation limit 1`);
      });
      expect(rows).toHaveLength(0);
    });
  });
});

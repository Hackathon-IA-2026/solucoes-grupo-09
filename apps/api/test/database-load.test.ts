import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import {
  createLoadIngestor,
  readProgrammedLoadAsOf,
  readVerifiedLoadAsOf,
  recordLoadApiRequest,
  writeProgrammedLoad,
  writeVerifiedLoad,
} from "../src/ingest/index.js";
import { EmptyLoadResponseError } from "../src/ingest/ons/carga-api.js";
import { parseProgrammedLoad, parseVerifiedLoad } from "../src/ingest/ons/load.js";
import type { VerifiedLoadHalfHour } from "../src/ingest/types.js";
import { createInProcessRunner } from "../src/jobs/inprocess.js";

// Seam 2 for the carga API, gated exactly like `database.test.ts` — the
// `test:db` script supplies the URL, and the default `bun test` skips this file
// entirely. The thing under test is a SQL property (one row per key from a
// DISTINCT ON) plus a CHECK constraint, neither of which a mock can prove.
//
// Spin one up:
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:16-alpine
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const VERIFIED = read("carga-verificada-SECO-2026-08-01.json");
const VERIFIED_EMPTY = read("carga-verificada-SE-2026-08-01.empty.json");
const PROGRAMMED = read("carga-programada-SECO-2026-08-01.json");

/** A distant half-hour, so a repeated run cannot collide with itself. */
const HALF_HOUR = new Date("2024-04-02T03:00:00.000Z");

const verified = (
  loadMwh: number,
  publishedAt: Date | null = new Date("2024-04-03T00:00:00.000Z"),
): VerifiedLoadHalfHour => ({
  areaCode: "SECO",
  areaKind: "SUBSYSTEM",
  subsystem: "SE",
  validTime: HALF_HOUR,
  loadMwh,
  consistedLoadMwh: loadMwh,
  loadNetOfMmgdMwh: null,
  supervisedLoadMwh: 1,
  unsupervisedLoadMwh: 2,
  mmgdLoadMwh: null,
  consistencyAdjustmentMwh: 0,
  publishedAt,
});

suite("carga · bitemporal store (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    await db.execute(sql`truncate table verified_load_half_hour`);
    await db.execute(sql`truncate table programmed_load_half_hour`);
    await db.execute(sql`truncate table load_api_request cascade`);

    sourceVersionId = await recordLoadApiRequest(db, {
      series: "VERIFIED",
      areaCode: "SECO",
      rangeStart: "2024-04-01",
      rangeEnd: "2024-04-30",
      response: {
        rows: [],
        url: "https://apicarga.ons.org.br/prd/cargaverificada?cod_areacarga=SECO",
        fetchedAt: new Date("2024-05-01T00:00:00.000Z"),
        body: "[]",
        repaired: false,
        httpStatus: 200,
      },
    });
  });

  afterAll(() => handle.close());

  const write = (rows: VerifiedLoadHalfHour[], ingestedAt: Date) =>
    writeVerifiedLoad(db, {
      rows,
      publishedAt: new Date("2024-05-01T00:00:00.000Z"),
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt,
    });

  const T1 = new Date("2026-05-01T00:00:00.000Z");
  const T2 = new Date("2026-06-01T00:00:00.000Z");
  const T3 = new Date("2026-07-01T00:00:00.000Z");

  it("stamps the row's own din_atualizacao, at row precision", async () => {
    expect(await write([verified(100)], T1)).toEqual({
      inserted: 1,
      revised: 0,
      unchanged: 0,
    });
    const [row] = await db.execute<{
      published_at: string;
      published_at_precision: string;
    }>(sql`
      select published_at, published_at_precision from verified_load_half_hour
      where valid_time = ${HALF_HOUR.toISOString()}::timestamptz
    `);
    // The only source in the platform that can say `row` rather than `file`.
    expect(row?.published_at_precision).toBe("row");
    expect(new Date(row?.published_at ?? 0).toISOString()).toBe(
      "2024-04-03T00:00:00.000Z",
    );
  });

  it("writes no new version when ONS re-stamps a row it did not change", async () => {
    // `din_atualizacao` moves on every ONS batch. The digest excludes it on
    // purpose: a new stamp over identical numbers is not a restatement.
    const result = await write([verified(100, new Date("2024-09-01T00:00:00.000Z"))], T2);
    expect(result).toEqual({ inserted: 0, revised: 0, unchanged: 1 });
  });

  it("appends a version when a value actually changes", async () => {
    expect(await write([verified(111)], T3)).toEqual({
      inserted: 0,
      revised: 1,
      unchanged: 0,
    });
    const [{ versions }] = await db.execute<{ versions: number }>(sql`
      select count(*)::int as versions from verified_load_half_hour
      where area_code = 'SECO' and valid_time = ${HALF_HOUR.toISOString()}::timestamptz
    `);
    expect(versions).toBe(2);
  });

  it("returns exactly one row per key, and what was believed then", async () => {
    const to = new Date(HALF_HOUR.getTime() + 1_800_000);
    const now = await readVerifiedLoadAsOf(db, {
      asOf: new Date("2026-08-01T00:00:00.000Z"),
      from: HALF_HOUR,
      to,
    });
    expect(now.rows).toHaveLength(1);
    expect(now.rows[0]).toMatchObject({ loadMwh: 111, dataVersion: 2 });

    const before = await readVerifiedLoadAsOf(db, {
      asOf: new Date("2026-06-15T00:00:00.000Z"),
      from: HALF_HOUR,
      to,
    });
    expect(before.rows[0]).toMatchObject({ loadMwh: 100, dataVersion: 1 });
    // The valid-time window predates go-live and can never be point-in-time.
    expect(before.vintageFidelity).toBe("revision_optimistic");
  });

  it("filters by the canonical subsystem, never by SECO", async () => {
    const result = await readVerifiedLoadAsOf(db, {
      asOf: new Date("2026-08-01T00:00:00.000Z"),
      from: HALF_HOUR,
      to: new Date(HALF_HOUR.getTime() + 1_800_000),
      subsystem: "SE",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.areaCode).toBe("SECO");
  });

  it("keeps a geoelectric area's subsystem null at the database, not just in TypeScript", async () => {
    // ONS publishes no area → subsystem assignment. TypeScript keeps this
    // codebase honest; the CHECK is what makes it true for any other writer.
    let caught: unknown;
    try {
      await db.execute(sql`
        insert into verified_load_half_hour (
          area_code, area_kind, subsystem, valid_time, data_version, load_mwh,
          published_at, published_at_precision, value_digest, source_request_id
        ) values (
          'RJ', 'GEOELECTRIC', 'SE',
          ${new Date("2024-04-02T04:00:00.000Z").toISOString()}::timestamptz, 1, 1,
          now(), 'row', 'geoelectric-probe', ${sourceVersionId}::uuid
        )
      `);
    } catch (error) {
      caught = error;
    }
    const cause = (caught as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe(
      "verified_load_subsystem_only_for_subsystem_area",
    );
  });

  it("keeps the programmed forecast in its own table", async () => {
    const rows = parseProgrammedLoad(
      JSON.parse(PROGRAMMED) as Record<string, unknown>[],
    ).rows;
    const written = await writeProgrammedLoad(db, {
      rows,
      publishedAt: new Date("2026-07-31T12:00:00.000Z"),
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt: T1,
    });
    expect(written.inserted).toBe(48);

    const result = await readProgrammedLoadAsOf(db, {
      asOf: new Date("2026-08-01T00:00:00.000Z"),
      from: new Date("2026-08-01T03:00:00.000Z"),
      to: new Date("2026-08-02T03:00:00.000Z"),
    });
    expect(result.rows).toHaveLength(48);

    // A forecast cannot be read as an actual: it is not in the verified table.
    const [{ verified_rows }] = await db.execute<{ verified_rows: number }>(sql`
      select count(*)::int as verified_rows from verified_load_half_hour
      where valid_time >= '2026-08-01T03:00:00Z'::timestamptz
    `);
    expect(verified_rows).toBe(0);
  });
});

/**
 * The ingestion job end to end, on the existing job runner, with the network
 * answered by the captured fixtures. Needs Postgres because what the job writes
 * is the whole point, so it is gated with the suite above.
 */
suite("carga ingestion job (real Postgres, stub network)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  /** What the job actually asked the network for. */
  let requests: string[] = [];

  const stubFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    // The real API's behaviour, reproduced from the captured payloads: `SECO`
    // returns data and `SE` returns HTTP 200 with an empty array.
    if (url.includes("cod_areacarga=SECO")) {
      return new Response(VERIFIED);
    }
    return new Response(VERIFIED_EMPTY);
  }) as typeof fetch;

  beforeAll(async () => {
    await db.execute(sql`truncate table verified_load_half_hour`);
    await db.execute(sql`truncate table programmed_load_half_hour`);
    await db.execute(sql`truncate table load_api_request cascade`);
  });
  afterAll(() => handle.close());

  it("ingests a day through the job runner and writes canonical rows", async () => {
    requests = [];
    const runner = createInProcessRunner(createLoadIngestor({ db, fetch: stubFetch }));
    const id = await runner.submit({
      series: "VERIFIED",
      from: "2026-08-01",
      to: "2026-08-01",
      areaCodes: ["SECO"],
      now: "2026-08-03",
    });

    let record = await runner.status(id);
    for (let i = 0; i < 400 && record?.status !== "completed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = await runner.status(id);
    }
    await runner.close();

    expect(record?.status).toBe("completed");
    expect(record?.result).toMatchObject({
      requests: 1,
      requestsRepaired: 0,
      rowsFetched: 48,
      rowsParsed: 48,
      rowsRejected: 0,
      rowsWithoutVintage: 0,
      inserted: 48,
      revised: 0,
      unchanged: 0,
    });
    // The URL the job actually sent. This is the trap, spelled out.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("cod_areacarga=SECO");
  }, 60_000);

  it("is idempotent — the same day fetched twice writes nothing new", async () => {
    const ingest = createLoadIngestor({ db, fetch: stubFetch });
    const result = await ingest(
      {
        series: "VERIFIED",
        from: "2026-08-01",
        to: "2026-08-01",
        areaCodes: ["SECO"],
        now: "2026-08-03",
      },
      () => {},
    );
    expect(result.unchanged).toBe(48);
    expect(result.inserted + result.revised).toBe(0);
  }, 60_000);

  it("records the request as provenance, with the SECO dialect visible", async () => {
    const [row] = await db.execute<{
      request_url: string;
      row_count: number;
      json_repaired: number;
    }>(sql`
      select request_url, row_count, json_repaired from load_api_request
      order by fetched_at desc limit 1
    `);
    expect(row?.request_url).toContain("cod_areacarga=SECO");
    expect(row?.row_count).toBe(48);
    expect(row?.json_repaired).toBe(0);
  });

  it("fails the run rather than reporting that a subsystem has no load", async () => {
    // The single most dangerous silent failure in any ONS source: the code
    // every other dataset uses returns HTTP 200 and nothing.
    const ingest = createLoadIngestor({ db, fetch: stubFetch });
    expect(
      ingest(
        {
          series: "VERIFIED",
          from: "2026-08-01",
          to: "2026-08-01",
          // Bypasses `resolveAreaCode`'s guard by naming a real but wrong area,
          // so what is under test is the empty-response rule and not the map.
          areaCodes: ["PEN"],
          now: "2026-08-03",
        },
        () => {},
      ),
    ).rejects.toThrow(EmptyLoadResponseError);
  }, 60_000);

  it("counts the parsed rows the fixtures actually contain", () => {
    // Belt to the job's braces: 48 half-hours is one local day.
    expect(parseVerifiedLoad(JSON.parse(VERIFIED)).rows).toHaveLength(48);
  });
});

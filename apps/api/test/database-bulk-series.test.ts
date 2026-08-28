import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  createDailyLoadIngestor,
  createInterchangeIngestor,
  readSubsystemExchangeAsOf,
  readSubsystemLoadDaysAsOf,
  type SubsystemExchangeHour,
  type SubsystemLoadDay,
  writeSubsystemExchange,
  writeSubsystemLoadDays,
} from "../src/ingest/index.js";

// Seam 2 for the two remaining subsystem bulk series — as-of reads and the two
// database-level invariants, against real Postgres. Gated exactly as
// `database.test.ts` is; spin one up with:
//
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:16-alpine
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

const FIXTURES = join(import.meta.dir, "fixtures", "ons");

/**
 * Run a statement expected to violate a constraint and name the one it hit.
 *
 * Drizzle wraps the driver error, so the constraint name lives on `cause`
 * rather than in the thrown message — asserting on the name is what makes these
 * tests about the invariant instead of about the SQL text.
 */
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
const HOUR_ONE = new Date("2024-07-01T03:00:00.000Z");
const HOUR_TWO = new Date("2024-07-01T04:00:00.000Z");

const exchange = (
  validTime: Date,
  verifiedExchangeMwh: number,
  programmedExchangeMwh: number | null = null,
): SubsystemExchangeHour => ({
  fromSubsystem: "N",
  toSubsystem: "NE",
  validTime,
  verifiedExchangeMwh,
  programmedExchangeMwh,
});

suite("subsystem exchange · bitemporal store (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    await db.execute(sql`truncate table subsystem_exchange_hour`);
    await db.execute(sql`truncate table subsystem_load_day`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "intercambio-nacional",
        resourceName: "Intercambio_Nacional-2024",
        resourceUrl: "https://example.invalid/INTERCAMBIO_NACIONAL_2024.csv",
        format: "CSV",
        changeKey: `exchange-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";
  });

  afterAll(() => handle.close());

  const write = (rows: SubsystemExchangeHour[], ingestedAt: Date) =>
    writeSubsystemExchange(db, {
      rows,
      publishedAt: ingestedAt,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt,
    });

  const T1 = new Date("2026-05-01T00:00:00.000Z");
  const T2 = new Date("2026-06-01T00:00:00.000Z");

  it("writes the first vintage, then treats an identical re-ingest as unchanged", async () => {
    expect(await write([exchange(HOUR_ONE, -100), exchange(HOUR_TWO, 200)], T1)).toEqual({
      inserted: 2,
      revised: 0,
      unchanged: 0,
    });
    expect(await write([exchange(HOUR_ONE, -100)], T2)).toEqual({
      inserted: 0,
      revised: 0,
      unchanged: 1,
    });
  });

  it("treats the arrival of the programmed column as a real revision", async () => {
    // The hazard this dataset exists to prove: ONS added
    // `val_intercambioprogmwmed` in 2026 and did *not* backfill it. When a year
    // is re-ingested after ONS ever does backfill it, null → value must appear
    // as a restatement — which it only can if null and 0 digest differently.
    const result = await write([exchange(HOUR_ONE, -100, 0)], T2);
    expect(result).toEqual({ inserted: 0, revised: 1, unchanged: 0 });

    const read = await readSubsystemExchangeAsOf(db, {
      asOf: new Date("2026-08-01T00:00:00.000Z"),
      from: HOUR_ONE,
      to: new Date("2024-07-01T05:00:00.000Z"),
    });
    expect(read.rows).toHaveLength(2);
    const revised = read.rows.find(
      (row) => row.validTime.getTime() === HOUR_ONE.getTime(),
    );
    expect(revised).toMatchObject({ dataVersion: 2, programmedExchangeMwh: 0 });
    // The prior belief — that ONS had said nothing — survives.
    const before = await readSubsystemExchangeAsOf(db, {
      asOf: new Date("2026-05-15T00:00:00.000Z"),
      from: HOUR_ONE,
      to: new Date("2024-07-01T05:00:00.000Z"),
    });
    expect(
      before.rows.find((row) => row.validTime.getTime() === HOUR_ONE.getTime()),
    ).toMatchObject({ dataVersion: 1, programmedExchangeMwh: null });
  });

  it("returns exactly one row per link and hour", async () => {
    const read = await readSubsystemExchangeAsOf(db, {
      asOf: new Date("2026-08-01T00:00:00.000Z"),
      from: HOUR_ONE,
      to: new Date("2024-07-01T05:00:00.000Z"),
      subsystem: "NE",
    });
    expect(read.rows).toHaveLength(2);
    expect(read.vintageFidelity).toBe("revision_optimistic");
  });

  it("makes the wrong orientation unrepresentable, not merely avoided", async () => {
    // The adapter normalises `NE→N` into `N→NE` with the sign flipped. The
    // check constraint is what stops any other writer storing the raw pair and
    // putting two opposite conventions in one column.
    const insert = async () =>
      db.execute(sql`
        insert into subsystem_exchange_hour
          (from_subsystem, to_subsystem, valid_time, verified_exchange_mwh,
           data_version, published_at, published_at_precision, value_digest,
           source_version_id)
        values ('NE', 'N', ${HOUR_ONE.toISOString()}::timestamptz, 1,
                1, now(), 'file', 'x', ${sourceVersionId}::uuid)
      `);
    expect(await constraintViolated(insert)).toBe(
      "subsystem_exchange_canonical_orientation",
    );
  });
});

const DAY_ONE = new Date("2024-07-01T03:00:00.000Z");

const loadDay = (
  validTime: Date,
  loadMwh: number,
  methodologyRegime: SubsystemLoadDay["methodologyRegime"] = "WITH_MMGD",
): SubsystemLoadDay => ({
  subsystem: "SE",
  validTime,
  loadMwh,
  dayMinutes: 1440,
  methodologyRegime,
});

suite("subsystem daily load · bitemporal store (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "carga-energia",
        resourceName: "Carga_Energia-2024",
        resourceUrl: "https://example.invalid/CARGA_ENERGIA_2024.csv",
        format: "CSV",
        changeKey: `daily-load-test|${Date.now()}`,
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";
  });

  afterAll(() => handle.close());

  const write = (rows: SubsystemLoadDay[], ingestedAt: Date) =>
    writeSubsystemLoadDays(db, {
      rows,
      publishedAt: ingestedAt,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt,
    });

  it("writes a day and reports the regime it was measured under", async () => {
    const T1 = new Date("2026-05-01T00:00:00.000Z");
    expect(await write([loadDay(DAY_ONE, 1000)], T1)).toEqual({
      inserted: 1,
      revised: 0,
      unchanged: 0,
    });

    const read = await readSubsystemLoadDaysAsOf(db, {
      asOf: new Date("2026-08-01T00:00:00.000Z"),
      from: DAY_ONE,
      to: new Date("2024-07-05T03:00:00.000Z"),
    });
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]).toMatchObject({
      loadMwh: 1000,
      dayMinutes: 1440,
      methodologyRegime: "WITH_MMGD",
    });
    expect(read.regimesSpanned).toEqual(["WITH_MMGD"]);
  });

  it("names every regime a window spans, so a break cannot be read as the grid", async () => {
    await write(
      [loadDay(new Date("2024-07-02T03:00:00.000Z"), 900, "WITH_NON_DISPATCHED")],
      new Date("2026-05-01T00:00:00.000Z"),
    );
    const read = await readSubsystemLoadDaysAsOf(db, {
      asOf: new Date("2026-08-01T00:00:00.000Z"),
      from: DAY_ONE,
      to: new Date("2024-07-05T03:00:00.000Z"),
      subsystem: "SE",
    });
    expect(new Set(read.regimesSpanned)).toEqual(
      new Set(["WITH_MMGD", "WITH_NON_DISPATCHED"]),
    );
  });

  it("refuses a day length that is not 23, 24 or 25 hours", async () => {
    // A wrong divisor is a quietly wrong energy, so the database refuses one.
    const insert = async () =>
      db.execute(sql`
        insert into subsystem_load_day
          (subsystem, valid_time, load_mwh, day_minutes, methodology_regime,
           data_version, published_at, published_at_precision, value_digest,
           source_version_id)
        values ('N', ${DAY_ONE.toISOString()}::timestamptz, 1, 1441, 'WITH_MMGD',
                1, now(), 'file', 'x', ${sourceVersionId}::uuid)
      `);
    expect(await constraintViolated(insert)).toBe("subsystem_load_day_length");
  });
});

/**
 * Both jobs end to end on the shared bulk-acquisition path, with the network
 * stubbed by the captured fixtures.
 */
suite("ingestion jobs · interchange and daily load (real Postgres, stub network)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  /** The real S3 HEAD of `INTERCAMBIO_NACIONAL_2000.csv` — see FIXTURES.md. */
  const HEAD_2000 = {
    "last-modified": "Fri, 13 Oct 2023 13:45:52 GMT",
    "content-length": "1367327",
    etag: '"b81b0e64e99bde0abb7c2da0937560c5"',
  };

  let requests: string[] = [];

  const stub = (packageShow: string, body: string) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("package_show")) {
        return new Response(await Bun.file(join(FIXTURES, packageShow)).text(), {
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "HEAD") {
        return new Response(null, { headers: HEAD_2000 });
      }
      return new Response(await Bun.file(join(FIXTURES, body)).arrayBuffer(), {
        headers: HEAD_2000,
      });
    }) as typeof fetch;

  beforeAll(async () => {
    await db.execute(sql`truncate table subsystem_exchange_hour`);
    await db.execute(sql`truncate table subsystem_load_day`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
  });
  afterAll(() => handle.close());

  it("ingests an interchange year CKAN reports no last_modified for", async () => {
    // 15 of the 27 CSVs carry `last_modified: null`. Change detection is the S3
    // HEAD, not the catalogue, so the year still ingests and still gets an
    // honest `published_at` — the file's own Last-Modified.
    requests = [];
    const ingest = createInterchangeIngestor({
      db,
      fetch: stub(
        "package-show-intercambio-nacional.json",
        "INTERCAMBIO_NACIONAL_2000.head.csv",
      ),
    });
    const result = await ingest({ year: 2000 }, () => {});

    expect(result).toMatchObject({
      format: "CSV",
      changed: true,
      downloaded: true,
      hasProgrammedColumn: false,
      rowsRejected: 0,
      inserted: 12,
    });
    const [row] = await db.execute<{ published_at: string }>(
      sql`select published_at from subsystem_exchange_hour limit 1`,
    );
    expect(new Date(row?.published_at ?? 0).toISOString()).toBe(
      "2023-10-13T13:45:52.000Z",
    );
  });

  it("stops at the HEAD when the fingerprint has not moved", async () => {
    requests = [];
    const ingest = createInterchangeIngestor({
      db,
      fetch: stub(
        "package-show-intercambio-nacional.json",
        "INTERCAMBIO_NACIONAL_2000.head.csv",
      ),
    });
    const result = await ingest({ year: 2000 }, () => {});

    expect(result).toMatchObject({ changed: false, downloaded: false });
    expect(requests).toEqual([
      expect.stringContaining("package_show"),
      expect.stringContaining("HEAD https://ons-aws-prod-opendata.s3.amazonaws.com"),
    ]);
  });

  it("re-parsing the same interchange bytes writes no new version", async () => {
    const ingest = createInterchangeIngestor({
      db,
      fetch: stub(
        "package-show-intercambio-nacional.json",
        "INTERCAMBIO_NACIONAL_2000.head.csv",
      ),
    });
    const result = await ingest({ year: 2000, force: true }, () => {});
    expect(result.downloaded).toBe(true);
    expect(result.inserted + result.revised).toBe(0);
    expect(result.unchanged).toBe(12);
  });

  it("ingests a daily-load year and reports the regimes it spanned", async () => {
    const ingest = createDailyLoadIngestor({
      db,
      fetch: stub("package-show-carga-energia.json", "CARGA_ENERGIA_2021.regime.csv"),
    });
    const result = await ingest({ year: 2021 }, () => {});

    expect(result).toMatchObject({
      format: "CSV",
      downloaded: true,
      rowsRejected: 0,
      irregularDays: 0,
      inserted: 16,
    });
    // The fixture straddles 2021-03-01, so the run reports both regimes — the
    // level shift is announced by the job, not left to be discovered.
    expect(new Set(result.regimes)).toEqual(
      new Set(["DISPATCHED_ONLY", "WITH_NON_DISPATCHED"]),
    );
  });
});

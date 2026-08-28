import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import { onsResourceVersion } from "../src/database/schema.js";
import {
  createEnergyBalanceIngestor,
  type EnergyBalanceHour,
  readEnergyBalanceAsOf,
  writeEnergyBalance,
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

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import { dessemBalanceHalfHour, onsResourceVersion } from "../src/database/schema.js";
import {
  createDessemIngestor,
  type DessemBalanceHalfHour,
  readDessemBalanceAsOf,
  writeDessemBalance,
} from "../src/ingest/index.js";
import { createInProcessRunner } from "../src/jobs/inprocess.js";

// Seam 2 for DESSEM, gated exactly like `database.test.ts` — the `test:db`
// script supplies the URL and the default `bun test` skips this file.
//
// Two of the things under test cannot be proved anywhere else: the CHECK
// constraint that makes a forecast unable to masquerade as an observation, and
// the `DISTINCT ON` that makes `AsOf` return one row per key.
//
// Spin one up:
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:16-alpine
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const DAY_CSV = read("BALANCO_DESSEM_DETALHE_2026_08_29.csv");
const PACKAGE = read("package-show-balanco-dessem-detalhe.trimmed.json");
const HEAD = JSON.parse(read("head-BALANCO_DESSEM_DETALHE_2026_08_29.csv.json")) as {
  headers: Record<string, string>;
};

/** A distant reference day, so a repeated run cannot collide with itself. */
const REFERENCE_DAY = "2024-04-03";
const HALF_HOUR = new Date("2024-04-03T03:00:00.000Z");
const NEXT_HALF_HOUR = new Date("2024-04-03T03:30:00.000Z");
/** The file for it would have been created the evening before. */
const PUBLISHED = new Date("2024-04-02T20:00:00.000Z");

const forecast = (
  validTime: Date,
  demandMw: number,
  subsystem: DessemBalanceHalfHour["subsystem"] = "SE",
): DessemBalanceHalfHour => ({
  subsystem,
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

suite("DESSEM · bitemporal store (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;
  let sourceVersionId = "";

  beforeAll(async () => {
    await db.execute(sql`truncate table dessem_balance_half_hour`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
    const [version] = await db
      .insert(onsResourceVersion)
      .values({
        datasetSlug: "balanco_dessem_detalhe",
        resourceName: "Balanco_Dessem_Detalhe-2024-04-03",
        resourceUrl: "https://example.invalid/BALANCO_DESSEM_DETALHE_2024_04_03.csv",
        format: "CSV",
        changeKey: 'test|1|"a"',
      })
      .returning({ id: onsResourceVersion.id });
    sourceVersionId = version?.id ?? "";
  });

  afterAll(() => handle.close());

  const write = (
    rows: DessemBalanceHalfHour[],
    ingestedAt: Date,
    publishedAt = PUBLISHED,
  ) =>
    writeDessemBalance(db, {
      rows,
      publishedAt,
      publishedAtPrecision: "file",
      sourceVersionId,
      ingestedAt,
    });

  const T1 = new Date("2026-05-01T00:00:00.000Z");
  const T2 = new Date("2026-06-01T00:00:00.000Z");

  const readAll = (asOf: Date, publishedAtOrBefore?: Date) =>
    readDessemBalanceAsOf(db, {
      asOf,
      from: new Date("2024-04-03T00:00:00.000Z"),
      to: new Date("2024-04-04T00:00:00.000Z"),
      publishedAtOrBefore,
    });

  it("writes the first vintage at data_version 1", async () => {
    const result = await write(
      [forecast(HALF_HOUR, 100), forecast(NEXT_HALF_HOUR, 200)],
      T1,
    );
    expect(result).toEqual({ inserted: 2, revised: 0, unchanged: 0 });
  });

  it("derives lead time from the two axes rather than storing it", async () => {
    const { rows } = await readAll(T1);
    expect(rows).toHaveLength(2);
    const first = rows[0];
    // 2024-04-02T20:00Z → 2024-04-03T03:00Z is seven hours.
    expect(first?.leadTimeMinutes).toBe(420);
    expect(first?.publishedAt.getTime()).toBeLessThan(
      first?.validTime.getTime() as number,
    );
    // The row names its origin: producer, run label, publication.
    expect(first?.forecastProducer).toBe("ons_dessem");
    expect(first?.referenceDay).toBe(REFERENCE_DAY);
  });

  it("writes nothing when ONS republishes identical numbers", async () => {
    const result = await write(
      [forecast(HALF_HOUR, 100), forecast(NEXT_HALF_HOUR, 200)],
      T2,
    );
    expect(result).toEqual({ inserted: 0, revised: 0, unchanged: 2 });
  });

  it("appends a new version when a value actually changes", async () => {
    const result = await write([forecast(HALF_HOUR, 111)], T2);
    expect(result).toEqual({ inserted: 0, revised: 1, unchanged: 0 });

    const before = await readAll(T1);
    const after = await readAll(T2);
    // The earlier as-of still sees the earlier belief. Nothing was destroyed.
    expect(
      before.rows.find((row) => row.validTime.getTime() === HALF_HOUR.getTime())
        ?.demandMw,
    ).toBe(100);
    expect(
      after.rows.find((row) => row.validTime.getTime() === HALF_HOUR.getTime())?.demandMw,
    ).toBe(111);
    expect(after.rows).toHaveLength(2);
  });

  it("cuts on published_at, which is the filter a gate actually needs", async () => {
    // A forecast for the same half hour, published later — a `gate_early` cut
    // must not see it, and `AsOf` alone would not exclude it, because in
    // backfill everything was ingested at the same instant.
    const later = new Date("2024-04-02T22:30:00.000Z");
    await write([forecast(HALF_HOUR, 222, "S")], T2, later);

    const gated = await readAll(T2, new Date("2024-04-02T21:00:00.000Z"));
    expect(gated.rows.map((row) => row.subsystem).sort()).toEqual(["SE", "SE"]);

    const ungated = await readAll(T2);
    expect(ungated.rows).toHaveLength(3);
  });

  it("refuses a row that is shaped like an observation, in code and in the database", async () => {
    // The adapter's guard: a diagnosis, naming the reference day and both times.
    await expect(
      write([forecast(HALF_HOUR, 1)], T2, new Date("2024-04-03T04:00:00.000Z")),
    ).rejects.toThrow(/published at .* at or after/);

    // And the guarantee, which does not depend on that adapter existing.
    const insertDirectly = async (): Promise<void> => {
      await db.insert(dessemBalanceHalfHour).values({
        subsystem: "N",
        validTime: HALF_HOUR,
        forecastProducer: "ons_dessem",
        runLabel: REFERENCE_DAY,
        demandMw: 1,
        hydroGenerationMw: 1,
        smallHydroGenerationMw: 1,
        thermalGenerationMw: 1,
        smallThermalGenerationMw: 1,
        windGenerationMw: 1,
        solarGenerationMw: 1,
        mmgdGenerationMw: 1,
        pumpingConsumptionMw: 1,
        dataVersion: 1,
        // After the half hour it describes: an observation, which this table
        // cannot hold.
        publishedAt: new Date("2024-04-03T09:00:00.000Z"),
        publishedAtPrecision: "file",
        ingestedAt: T2,
        valueDigest: "not-a-real-digest",
        sourceVersionId,
      });
    };
    // Drizzle wraps the driver error, so the constraint name — the thing that
    // proves *which* rule refused the row — is on the cause, not the message.
    const refusal = await insertDirectly().then(
      () => null,
      (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause,
    );
    expect(refusal?.constraint_name).toBe("dessem_balance_is_a_forecast");
  });
});

suite("DESSEM · the daily-split sweep, end to end (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  const CSV_URL =
    "https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/balanco_dessem_detalhe/BALANCO_DESSEM_DETALHE_2026_08_29.csv";

  let heads = 0;
  let gets = 0;
  let packages = 0;

  /** Serves the captured package, HEAD and bytes. Nothing hand-written. */
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("package_show")) {
      packages += 1;
      return new Response(PACKAGE, { status: 200 });
    }
    expect(url).toBe(CSV_URL);
    if (init?.method === "HEAD") {
      heads += 1;
      return new Response(null, { status: 200, headers: HEAD.headers });
    }
    gets += 1;
    return new Response(DAY_CSV, { status: 200 });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    await db.execute(sql`truncate table dessem_balance_half_hour`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
  });

  afterAll(() => handle.close());

  /** Run the sweep for one reference day and wait for it, as `job.test.ts` does. */
  const sweep = async (): Promise<Record<string, number>> => {
    const runner = createInProcessRunner(createDessemIngestor({ db, fetch: fetchImpl }));
    const id = await runner.submit({ from: "2026-08-29", to: "2026-08-29" });
    let record = await runner.status(id);
    for (let i = 0; i < 600 && record?.status !== "completed"; i += 1) {
      if (record?.status === "failed") {
        throw new Error(record.error);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = await runner.status(id);
    }
    await runner.close();
    expect(record?.status).toBe("completed");
    return record?.result as unknown as Record<string, number>;
  };

  it("discovers the day, downloads it once and stores the whole day", async () => {
    const result = await sweep();
    expect(result.daysAvailable).toBe(1);
    expect(result.rowsParsed).toBe(192);
    expect(result.inserted).toBe(192);
    // The notice the forecast gave on its earliest half hour: 19:42:43Z on
    // D−1 against 03:00Z on D — comfortably inside `gate_late`.
    expect(result.minLeadTimeMinutes).toBe(437);
    expect(packages).toBe(1);
    expect(gets).toBe(1);
  });

  it("re-runs on one HEAD and no download", async () => {
    const result = await sweep();
    expect(result.daysDownloaded).toBe(0);
    expect(result.inserted).toBe(0);
    expect(gets).toBe(1);
    expect(heads).toBe(2);
  });

  it("reads the stored day back as a forecast, at the half-hour grain", async () => {
    const { rows } = await readDessemBalanceAsOf(db, {
      asOf: new Date(),
      from: new Date("2026-08-29T00:00:00.000Z"),
      to: new Date("2026-08-31T00:00:00.000Z"),
      subsystem: "SE",
    });
    expect(rows).toHaveLength(48);
    expect(rows[0]?.validTime.toISOString()).toBe("2026-08-29T03:00:00.000Z");
    expect(rows[0]?.publishedAt.toISOString()).toBe("2026-08-28T19:42:43.000Z");
    expect(rows.every((row) => row.leadTimeMinutes > 0)).toBe(true);
    expect(rows.every((row) => row.referenceDay === "2026-08-29")).toBe(true);
    // MW, verbatim from the file — no MWmed conversion anywhere in the path.
    expect(rows[0]?.demandMw).toBe(44_370.76);
  });
});

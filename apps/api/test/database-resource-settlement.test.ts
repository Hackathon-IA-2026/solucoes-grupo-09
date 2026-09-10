import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import { dessemBalanceHalfHour, onsResourceVersion } from "../src/database/schema.js";
import { PayloadRefusedError } from "../src/errors.js";
import {
  acquireBulkResource,
  type CatalogueResource,
  createDessemIngestor,
  createDirectoryArchive,
  type PayloadArchive,
  readRetainedPayload,
} from "../src/ingest/index.js";
import { createInProcessRunner } from "../src/jobs/inprocess.js";

/**
 * Seam — the settlement of a resource version, against real Postgres.
 *
 * What is under test is the distinction data-platform 22 exists to draw:
 * **holding the bytes and having ingested them are two facts**, and the second
 * one was inferred from the first. A parse that threw left `fetched_at`
 * stamped, so the next sweep read the resource as done, returned
 * `{ downloaded: false }`, reported `inserted: 0` and exited 0 — forever.
 * Measured on the DESSEM reference day 2025-07-19 in issue 21: zero rows,
 * clean success, permanently.
 *
 * A mock proves nothing here. The whole defect lives in what one run leaves
 * behind in `ons_resource_version` for the next run to read, so the test needs
 * a real row in a real table across four sequential acquisitions.
 *
 * Gated exactly like the other database suites — `WATTSTEER_TEST_DATABASE_URL`
 * — and it truncates the ingestion tables it touches, so point it at a
 * throwaway instance and never at a database holding a backfill:
 *   docker run -d -p 5455:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const SLUG = "balanco_dessem_detalhe";
const BASE = `https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/${SLUG}`;
const GOOD_DAY_URL = `${BASE}/BALANCO_DESSEM_DETALHE_2026_08_29.csv`;
const SHORT_DAY_URL = `${BASE}/BALANCO_DESSEM_DETALHE_2026_08_28.csv`;

/** The captured day, verbatim. Non-empty is asserted, never assumed. */
const DAY_CSV = readFileSync(
  join(FIXTURES, "BALANCO_DESSEM_DETALHE_2026_08_29.csv"),
  "utf8",
);

/** `package_show` for the dataset, trimmed — the two adjacent days it offers. */
const PACKAGE = readFileSync(
  join(FIXTURES, "package-show-balanco-dessem-detalhe.trimmed.json"),
  "utf8",
);

/**
 * The captured day with subsystem N truncated to 26 patamares — the exact
 * shape of ONS's file for 2025-07-19, the day that killed the whole-history
 * task in issue 21. Derived from the fixture rather than captured, because the
 * defect it reproduces is a *count*, and deriving it makes the count visible
 * in the test that asserts it.
 */
function shortenSubsystemN(csv: string, referenceDay: string, keep: number): string {
  const [header, ...rows] = csv.trimEnd().split("\n");
  const kept = rows.filter((row) => {
    const [, patamar, subsystem] = row.split(";");
    return subsystem !== "N" || Number(patamar) <= keep;
  });
  return [header, ...kept].join("\n").replaceAll("2026-08-29;", `${referenceDay};`);
}

const SHORT_DAY_CSV = shortenSubsystemN(DAY_CSV, "2026-08-28", 26);

/** Count the rows one subsystem carries, so "26 against 48" is measured here too. */
function rowsFor(csv: string, subsystem: string): number {
  return csv
    .trimEnd()
    .split("\n")
    .slice(1)
    .filter((row) => row.split(";")[2] === subsystem).length;
}

suite("resource settlement · custody, completion and refusal (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  let root = "";
  let archive: PayloadArchive;
  let gets = 0;
  let heads = 0;

  /** Two resources, so a refusal and a completion cannot be read off each other. */
  const resource = (url: string): CatalogueResource => ({
    name: url.split("/").pop() as string,
    url,
    format: "CSV",
    lastModified: new Date("2026-08-28T19:42:43.000Z"),
    size: DAY_CSV.length,
  });
  const LANDS = resource(GOOD_DAY_URL);
  const REFUSES = resource(SHORT_DAY_URL);

  /** Mutable so the test can restate a file the way ONS restates one. */
  const etags = new Map<string, string>([
    [GOOD_DAY_URL, '"lands-v1"'],
    [SHORT_DAY_URL, '"refuses-v1"'],
  ]);

  const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = url === SHORT_DAY_URL ? SHORT_DAY_CSV : DAY_CSV;
    const headers = {
      "last-modified": "Fri, 28 Aug 2026 19:42:43 GMT",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      etag: etags.get(url) as string,
    };
    if (init?.method === "HEAD") {
      heads += 1;
      return new Response(null, { headers });
    }
    gets += 1;
    return new Response(body, { headers });
  }) as typeof fetch;

  const acquire = (target: CatalogueResource, force = false) =>
    acquireBulkResource({
      db,
      fetch: stubFetch,
      slug: SLUG,
      resources: [target],
      select: (candidates) => candidates[0] as CatalogueResource,
      archive,
      force,
    });

  const versionRow = async (id: string) => {
    const [row] = await db
      .select()
      .from(onsResourceVersion)
      .where(eq(onsResourceVersion.id, id))
      .limit(1);
    return row;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "wattsteer-settlement-"));
    archive = createDirectoryArchive(root);
    await db.execute(sql`truncate table payload_custody`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
  });

  afterAll(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

  it("has non-empty payloads to acquire, and a short day that is actually short", () => {
    // The guard on the guard. This repo has been bitten four times by an
    // assertion that passed because its input was empty.
    expect(DAY_CSV.length).toBeGreaterThan(10_000);
    expect(rowsFor(DAY_CSV, "N")).toBe(48);
    expect(rowsFor(DAY_CSV, "SE")).toBe(48);
    expect(SHORT_DAY_CSV.length).toBeGreaterThan(5000);
    expect(rowsFor(SHORT_DAY_CSV, "N")).toBe(26);
    expect(rowsFor(SHORT_DAY_CSV, "SE")).toBe(48);
    expect(SHORT_DAY_CSV).toContain("2026-08-28;1;N;");
    expect(SHORT_DAY_CSV).not.toContain("2026-08-29;");
  });

  let landsVersionId = "";

  it("stamps custody before the parse, and nothing else", async () => {
    const first = await acquire(LANDS);
    landsVersionId = first.versionId;

    expect(first.downloaded).toBe(true);
    expect(first.settled).toBe(false);
    expect(first.bytes?.byteLength).toBe(DAY_CSV.length);
    expect(gets).toBe(1);

    // Custody before parsing, preserved: the bytes are archived and digested
    // before anything has tried to understand them.
    const row = await versionRow(first.versionId);
    expect(row?.fetchedAt).not.toBeNull();
    expect(row?.contentSha256).not.toBeNull();
    expect(row?.byteSize).toBe(DAY_CSV.length);
    expect(row?.archiveUri).not.toBeNull();
    const held = await readRetainedPayload(db, archive, "bulk_resource", first.versionId);
    expect(held?.bytes.byteLength).toBe(DAY_CSV.length);

    // And that is *all* it says. The parse has not run, so nothing claims the
    // payload was ingested. This is the assertion the defect failed.
    expect(row?.ingestedAt).toBeNull();
    expect(row?.refusedAt).toBeNull();
  });

  it("re-downloads and re-parses a payload whose parse threw", async () => {
    // The defect, directly. Before the fix this acquisition returned
    // `{ downloaded: false, bytes: null }` — because the run above had already
    // stamped the resource as fetched, and "fetched" was the skip gate — so
    // the day's rows never landed and no run ever said so again.
    const retry = await acquire(LANDS);

    expect(retry.settled).toBe(false);
    expect(retry.downloaded).toBe(true);
    expect(retry.bytes?.byteLength).toBe(DAY_CSV.length);
    expect(gets).toBe(2);
    // The fingerprint never moved, and the retry must not pretend it did: a
    // re-parse is not a re-publication.
    expect(retry.changed).toBe(false);
    expect(retry.republication).toBeNull();
    expect(retry.versionId).toBe(landsVersionId);
  });

  it("settles on the completion mark, and then costs one HEAD", async () => {
    const landed = await acquire(LANDS);
    expect(landed.downloaded).toBe(true);
    expect(gets).toBe(3);

    // What the ingestor calls once its write has actually landed.
    await landed.markIngested();
    const row = await versionRow(landed.versionId);
    expect(row?.ingestedAt).not.toBeNull();

    const next = await acquire(LANDS);
    expect(next.settled).toBe(true);
    expect(next.downloaded).toBe(false);
    expect(next.bytes).toBeNull();
    expect(gets).toBe(3);
    expect(heads).toBe(4);
  });

  let refusesVersionId = "";

  it("records a refusal against the bytes, and stops re-fetching them", async () => {
    const refused = await acquire(REFUSES);
    refusesVersionId = refused.versionId;
    expect(refused.downloaded).toBe(true);
    const getsAfterDownload = gets;

    await refused.markRefused(
      new PayloadRefusedError(
        "coverage",
        "Reference day 2026-08-28 has 26 patamares for subsystem N; " +
          "the local civil day is 48 half hours long",
      ),
    );

    const row = await versionRow(refused.versionId);
    // Refused is not ingested. A census of what loaded cannot mistake this row
    // for a day that landed — which `fetched_at` alone could not express.
    expect(row?.ingestedAt).toBeNull();
    expect(row?.refusedAt).not.toBeNull();
    expect(row?.refusalReason).toBe("coverage");
    expect(row?.refusalDetail).toContain("26 patamares");
    // Custody is unaffected: the bytes that were refused are the evidence for
    // the refusal, and they are still held.
    expect(row?.fetchedAt).not.toBeNull();
    expect(row?.archiveUri).not.toBeNull();

    // And this is the other half of the fix: a refused payload is settled, so
    // the next pass spends one HEAD and no download. Not a hot loop.
    const next = await acquire(REFUSES);
    expect(next.settled).toBe(true);
    expect(next.downloaded).toBe(false);
    expect(next.refusal?.reason).toBe("coverage");
    expect(next.refusal?.detail).toContain("26 patamares");
    expect(gets).toBe(getsAfterDownload);
  });

  it("re-parses a refused payload under force, and supersedes the refusal", async () => {
    // The operator's repair path for a refusal that was the adapter's fault
    // rather than ONS's: fix the adapter, re-run with force.
    const forced = await acquire(REFUSES, true);
    expect(forced.downloaded).toBe(true);
    expect(forced.versionId).toBe(refusesVersionId);

    await forced.markIngested();
    const row = await versionRow(forced.versionId);
    expect(row?.ingestedAt).not.toBeNull();
    expect(row?.refusedAt).toBeNull();
    expect(row?.refusalReason).toBeNull();
  });
});

suite("DESSEM · one refused day does not take the sweep with it", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  let gets = 0;
  /** Mutable: ONS re-publishing a day is a new fingerprint, and that matters. */
  let shortDayBody = SHORT_DAY_CSV;
  let shortDayEtag = '"short-v1"';

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("package_show")) {
      return new Response(PACKAGE, { status: 200 });
    }
    const short = url === SHORT_DAY_URL;
    const body = short ? shortDayBody : DAY_CSV;
    const headers = {
      // D−1 for each day, so neither is refused for being published after the
      // half hours it forecasts. The refusal under test is the short day.
      "last-modified": short
        ? "Thu, 27 Aug 2026 19:42:43 GMT"
        : "Fri, 28 Aug 2026 19:42:43 GMT",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      etag: short ? shortDayEtag : '"good-v1"',
    };
    if (init?.method === "HEAD") {
      return new Response(null, { headers });
    }
    gets += 1;
    return new Response(body, { headers });
  }) as unknown as typeof fetch;

  /** Run the sweep over both days and wait for it, as `database-dessem` does. */
  const sweep = async (): Promise<unknown> => {
    const runner = createInProcessRunner(createDessemIngestor({ db, fetch: fetchImpl }));
    const id = await runner.submit({ from: "2026-08-28", to: "2026-08-29" });
    let record = await runner.status(id);
    for (let i = 0; i < 600 && record?.status !== "completed"; i += 1) {
      if (record?.status === "failed") {
        throw new Error(record.error);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = await runner.status(id);
    }
    await runner.close();
    // The blast radius, asserted: a day this adapter refuses is not a failed
    // task. Before the per-day isolation the refusal on 2026-08-28 threw out
    // of the whole sweep and 2026-08-29 was never probed.
    expect(record?.status).toBe("completed");
    return record?.result;
  };

  const versionFor = async (url: string) => {
    const [row] = await db
      .select()
      .from(onsResourceVersion)
      .where(eq(onsResourceVersion.resourceUrl, url))
      .orderBy(onsResourceVersion.firstSeenAt)
      .limit(1);
    return row;
  };

  beforeAll(async () => {
    await db.execute(sql`truncate table dessem_balance_half_hour`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
  });

  afterAll(() => handle.close());

  it("refuses the short day, reports it, and still loads the day after it", async () => {
    const result = (await sweep()) as unknown as {
      daysAvailable: number;
      daysDownloaded: number;
      daysIngested: number;
      daysRefused: number;
      daysStandingRefused: number;
      inserted: number;
      refusals: {
        referenceDay: string;
        reason: string;
        detail: string;
        refusedThisRun: boolean;
      }[];
    };

    expect(result.daysAvailable).toBe(2);
    expect(result.daysDownloaded).toBe(2);
    expect(result.daysIngested).toBe(1);
    expect(result.daysRefused).toBe(1);
    // The good day is the *second* of the two, so a non-zero insert count is
    // what says the sweep survived the first day's refusal.
    expect(result.inserted).toBe(192);

    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.referenceDay).toBe("2026-08-28");
    expect(result.refusals[0]?.reason).toBe("coverage");
    expect(result.refusals[0]?.detail).toContain("26 patamares");
    expect(result.refusals[0]?.refusedThisRun).toBe(true);

    // The refused day stored nothing, and says so in its provenance row rather
    // than looking like a day that loaded.
    const refused = await versionFor(SHORT_DAY_URL);
    expect(refused?.fetchedAt).not.toBeNull();
    expect(refused?.ingestedAt).toBeNull();
    expect(refused?.refusalReason).toBe("coverage");
    const landed = await versionFor(GOOD_DAY_URL);
    expect(landed?.ingestedAt).not.toBeNull();
    expect(landed?.refusedAt).toBeNull();

    // The reference day is stored as the forecast's `run_label`.
    const stored = await db
      .selectDistinct({ referenceDay: dessemBalanceHalfHour.runLabel })
      .from(dessemBalanceHalfHour);
    expect(stored.map((row) => row.referenceDay)).toEqual(["2026-08-29"]);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(dessemBalanceHalfHour);
    expect(count).toBe(192);
  });

  it("re-runs on two HEADs, downloading neither day", async () => {
    const before = gets;
    const result = (await sweep()) as unknown as {
      daysDownloaded: number;
      daysRefused: number;
      daysStandingRefused: number;
      inserted: number;
      refusals: { refusedThisRun: boolean; reason: string }[];
    };

    // The refused day is not retried into a hot loop, and the loaded day is
    // not re-downloaded either. Both are settled, for different reasons.
    expect(gets).toBe(before);
    expect(result.daysDownloaded).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.daysRefused).toBe(0);
    expect(result.daysStandingRefused).toBe(1);
    // Settled is not silent: the standing refusal is still in the report.
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.refusedThisRun).toBe(false);
    expect(result.refusals[0]?.reason).toBe("coverage");
  });

  it("retries the day ONS re-publishes complete, because that is new bytes", async () => {
    // A refusal is permanent about *bytes*, never about a reference day. ONS
    // rewriting the file is a new `change_key`, so it arrives unsettled and is
    // parsed again — no force, no operator.
    shortDayBody = DAY_CSV.replaceAll("2026-08-29;", "2026-08-28;");
    shortDayEtag = '"short-v2-complete"';
    expect(rowsFor(shortDayBody, "N")).toBe(48);

    const result = (await sweep()) as unknown as {
      daysDownloaded: number;
      daysIngested: number;
      daysRefused: number;
      daysStandingRefused: number;
      inserted: number;
      refusals: unknown[];
    };

    expect(result.daysDownloaded).toBe(1);
    expect(result.daysIngested).toBe(1);
    expect(result.daysRefused).toBe(0);
    expect(result.daysStandingRefused).toBe(0);
    expect(result.refusals).toHaveLength(0);
    expect(result.inserted).toBe(192);

    const stored = await db
      .selectDistinct({ referenceDay: dessemBalanceHalfHour.runLabel })
      .from(dessemBalanceHalfHour)
      .orderBy(dessemBalanceHalfHour.runLabel);
    expect(stored.map((row) => row.referenceDay)).toEqual(["2026-08-28", "2026-08-29"]);
  });
});

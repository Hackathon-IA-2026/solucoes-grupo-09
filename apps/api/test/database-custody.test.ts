import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/database/connection.js";
import {
  onsResourceVersion,
  payloadCustody,
  resourceRepublication,
} from "../src/database/schema.js";
import {
  createArchiveFetch,
  createConstrainedOffIngestor,
  createDirectoryArchive,
  createRefreshSweep,
  enforceRetention,
  type IngestTask,
  type IngestTaskResult,
  type PayloadArchive,
  readIngestionHealth,
  readRetainedPayload,
} from "../src/ingest/index.js";

// Seam — custody, re-publication detection and the health view against real
// Postgres. Runs only with a test database (the `test:db` script sets it), the
// same gating as the other database suites.
//
// Spin one up:
//   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
//     -e POSTGRES_DB=wattsteer postgres:17-alpine
//
// A mock proves nothing here: what is under test is that the archive, the
// ledger and the fact tables agree about what WattSteer holds — three stores
// that can only disagree in a real database.
const URL = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const RESOURCE_URL =
  "https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_eolica_usi/RESTRICAO_COFF_EOLICA_2026_08.csv";

/** `package_show` as CKAN would answer it for the one month under test. */
const packageShow = JSON.stringify({
  result: {
    resources: [
      {
        name: "RESTRICAO_COFF_EOLICA_2026_08",
        url: RESOURCE_URL,
        format: "CSV",
        last_modified: "2026-08-28T15:09:24",
        size: 4096,
      },
    ],
  },
});

suite("raw-payload custody · archive, republication, retention (real Postgres)", () => {
  const handle = createDatabase(URL as string, 5);
  const { db } = handle;

  let root = "";
  let archive: PayloadArchive;
  let original = "";
  /** Mutable so the test can restate the file the way ONS restates one. */
  let body = "";
  let etag = '"first-vintage"';
  let networkCalls = 0;

  const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    networkCalls += 1;
    const url = String(input);
    if (url.includes("package_show")) {
      return new Response(packageShow, {
        headers: { "content-type": "application/json" },
      });
    }
    const headers = {
      "last-modified": "Fri, 28 Aug 2026 15:08:30 GMT",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      etag,
    };
    if (init?.method === "HEAD") {
      return new Response(null, { headers });
    }
    return new Response(body, { headers });
  }) as typeof fetch;

  /** A fetch that fails loudly — proof that a reprocess touched no network. */
  const forbiddenFetch = (async () => {
    throw new Error("the network was used during a reprocess");
  }) as typeof fetch;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "wattsteer-custody-"));
    archive = createDirectoryArchive(root);
    original = await Bun.file(
      join(FIXTURES, "RESTRICAO_COFF_EOLICA_2026_08.restricted.csv"),
    ).text();
    body = original;

    await db.execute(sql`truncate table curtailment_report_hour`);
    await db.execute(sql`truncate table reporting_entity cascade`);
    await db.execute(sql`truncate table payload_custody`);
    await db.execute(sql`truncate table resource_republication`);
    await db.execute(sql`truncate table ingestion_run`);
    await db.execute(sql`truncate table ons_resource_version cascade`);
  });

  afterAll(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

  it("archives the payload byte-for-byte with its fetch time", async () => {
    const ingest = createConstrainedOffIngestor({ db, fetch: stubFetch, archive });
    const result = await ingest({ technology: "WIND", year: 2026, month: 8 }, () => {});
    expect(result).toMatchObject({ downloaded: true, changed: true });
    expect(result.inserted).toBeGreaterThan(0);

    const [custody] = await db.select().from(payloadCustody);
    expect(custody?.provenance).toBe("bulk_resource");
    expect(custody?.datasetSlug).toBe("restricao_coff_eolica_usi");
    expect(custody?.fetchedAt).toBeInstanceOf(Date);

    // Byte-for-byte: the archived object is the file, not a re-encoding of it.
    const held = await archive.get(custody?.archiveUri as string);
    expect(new TextDecoder().decode(held as Uint8Array)).toBe(original);

    // The provenance row carries the locator too, so provenance alone answers
    // "where are the bytes?".
    const [version] = await db.execute<{ archive_uri: string | null }>(
      sql`select archive_uri from ons_resource_version limit 1`,
    );
    expect(version?.archive_uri).toBe(custody?.archiveUri as string);
  });

  it("costs one HEAD when nothing moved", async () => {
    networkCalls = 0;
    const ingest = createConstrainedOffIngestor({ db, fetch: stubFetch, archive });
    const result = await ingest({ technology: "WIND", year: 2026, month: 8 }, () => {});
    expect(result).toMatchObject({ changed: false, downloaded: false });
    // package_show + HEAD, and no GET of the file.
    expect(networkCalls).toBe(2);
  });

  it("surfaces a re-publication of a closed period instead of absorbing it", async () => {
    // ONS rewrites the month under the same filename, with no version marker —
    // the behaviour the whole refresh regime exists for.
    /*
      The **reference** generation, not `val_geracaolimitada`.

      This mutated `163.261` — the ceiling — while that field was what the
      adapter stored as curtailed energy. It is not: ONS's dictionary calls it
      "o limite para a geração estabelecido pelo ONS em Tempo Real", and the
      curtailed energy is `val_geracaonaorealizadaapurada`, derived here from
      reference minus verified because this fixture predates that column. So a
      change to the ceiling now revises nothing, and a test that asserted a
      revision was asserting the defect.
    */
    body = original.replace("355.262", "370.500");
    etag = '"second-vintage"';

    const ingest = createConstrainedOffIngestor({ db, fetch: stubFetch, archive });
    const result = await ingest(
      {
        technology: "WIND",
        year: 2026,
        month: 8,
        context: { tier: "history" },
      },
      () => {},
    );
    expect(result.downloaded).toBe(true);
    expect(result.revised).toBeGreaterThan(0);

    const events = await db.select().from(resourceRepublication);
    expect(events).toHaveLength(1);
    // Attributed to the sweep that found it: a change found by the history
    // sweep *is* the evidence that a settled period was rewritten.
    expect(events[0]?.tier).toBe("history");
    expect(events[0]?.resourceUrl).toBe(RESOURCE_URL);
    expect(events[0]?.priorFetchedAt).toBeInstanceOf(Date);

    // Both vintages are now held — the prior one is unrecoverable upstream.
    const custody = await db.select().from(payloadCustody);
    expect(custody).toHaveLength(2);
  });

  it("reprocesses from the archive without re-fetching", async () => {
    const ingest = createConstrainedOffIngestor({
      db,
      // The forbidden fetch is the assertion: if anything reached for the
      // network, the reprocess was not from custody.
      fetch: createArchiveFetch({ db, archive }),
      archive,
    });
    const result = await ingest(
      { technology: "WIND", year: 2026, month: 8, force: true },
      () => {},
    );

    // Same bytes, same parse, same digests: a reprocess of the current vintage
    // writes nothing at all.
    expect(result.downloaded).toBe(true);
    expect(result.inserted).toBe(0);
    expect(result.revised).toBe(0);
    expect(result.unchanged).toBeGreaterThan(0);

    // And nothing new was recorded as a re-publication: reprocessing our own
    // archive is not ONS restating anything.
    expect(await db.select().from(resourceRepublication)).toHaveLength(1);

    const control = createConstrainedOffIngestor({ db, fetch: forbiddenFetch, archive });
    expect(
      control({ technology: "WIND", year: 2026, month: 8, force: true }, () => {}),
    ).rejects.toThrow(/network/);
  });

  it("replays a prior vintage as of a past instant", async () => {
    const [first] = await db.execute<{ id: string; fetched_at: string }>(sql`
      select id, fetched_at from ons_resource_version order by fetched_at asc limit 1
    `);
    const asOf = new Date(first?.fetched_at as string);

    const replay = createArchiveFetch({ db, archive, asOf });
    const response = await replay(RESOURCE_URL);
    // What ONS said then, which ONS can no longer be asked for.
    expect(await response.text()).toBe(original);

    // The catalogue is replayed too, so a reprocess cannot pick a resource that
    // did not exist at the vintage it claims to be replaying.
    const catalogue = await replay(
      "https://dados.ons.org.br/api/3/action/package_show?id=restricao_coff_eolica_usi",
    );
    const payload = (await catalogue.json()) as {
      result: { resources: { url: string }[] };
    };
    expect(payload.result.resources).toHaveLength(1);
    expect(payload.result.resources[0]?.url).toBe(RESOURCE_URL);
  });

  it("keeps what produced a revision and drops what did not", async () => {
    /*
      A third state whose **facts** reproduce the second: a new fingerprint, no
      new rows. This is the overwhelming majority of what a sweep finds.

      It is built on top of the second vintage and moves `val_geracaolimitada`,
      which is a better fixture than the byte-identical one it replaces: that
      field is ONS's *ceiling* and this adapter stores no quantity from it, so
      a file differing only there is genuinely a new publication of the same
      facts. The retention pass is then deciding on the property it exists for
      rather than on two identical files.
    */
    body = original.replace("355.262", "370.500").replace("163.261", "170.500");
    etag = '"third-fingerprint"';
    const ingest = createConstrainedOffIngestor({ db, fetch: stubFetch, archive });
    const unproductive = await ingest(
      { technology: "WIND", year: 2026, month: 8 },
      () => {},
    );
    expect(unproductive.inserted + unproductive.revised).toBe(0);

    // Age every payload past the window so the whole ledger is examined.
    await db.execute(
      sql`update payload_custody set fetched_at = now() - interval '200 days'`,
    );

    const before = await db.select().from(payloadCustody);
    const result = await enforceRetention(db, archive, {
      policy: { unproductiveDays: 90, batchSize: 100 },
    });

    expect(result.examined).toBe(before.length);
    expect(result.retainedProductive).toBe(2); // the two vintages that changed facts
    expect(result.purged).toBe(1);

    const [purged] = await db.execute<{ purge_reason: string }>(sql`
      select purge_reason from payload_custody where purged_at is not null
    `);
    expect(purged?.purge_reason).toContain("no revision written");

    // The payloads that produced a revision are still readable — they are the
    // only surviving copy of what ONS used to say.
    const [productive] = await db.execute<{ provenance_id: string }>(sql`
      select provenance_id from payload_custody where purged_at is null limit 1
    `);
    const held = await readRetainedPayload(
      db,
      archive,
      "bulk_resource",
      productive?.provenance_id as string,
    );
    expect(held?.bytes.byteLength).toBeGreaterThan(0);

    // Re-running is safe: nothing left to examine is nothing purged.
    const again = await enforceRetention(db, archive, {
      policy: { unproductiveDays: 90, batchSize: 100 },
    });
    expect(again.purged).toBe(0);
  });

  it("records a run per task and calls a bulk campaign what it is", async () => {
    // The sweep is driven with a stub runner: what is under test is the run
    // log and the campaign detector, not the seventh copy of an ingestor.
    const [seed] = await db.execute<{ id: string; fetched_at: string }>(sql`
      select id, fetched_at from ons_resource_version order by fetched_at asc limit 1
    `);
    // Four distinct superseding versions: the republication pair is unique, so
    // a campaign is four resources rewritten, not one row written four times.
    const planted = await db
      .insert(onsResourceVersion)
      .values(
        [0, 1, 2, 3].map((index) => ({
          datasetSlug: "restricao_coff_eolica_usi",
          resourceName: `PLANTED_${index}`,
          resourceUrl: `${RESOURCE_URL}#${index}`,
          format: "CSV" as const,
          changeKey: `planted-${index}`,
        })),
      )
      .returning({ id: onsResourceVersion.id });
    let republicationsToPlant = planted.length;

    const sweep = createRefreshSweep({
      db,
      run: async (task: IngestTask): Promise<IngestTaskResult> => {
        const runId =
          task.kind === "load" ? undefined : (task.payload.context?.runId ?? undefined);
        if (runId && republicationsToPlant > 0) {
          republicationsToPlant -= 1;
          await db.insert(resourceRepublication).values({
            datasetSlug: "restricao_coff_eolica_usi",
            resourceName: `planted-${republicationsToPlant}`,
            resourceUrl: `${RESOURCE_URL}#${republicationsToPlant}`,
            priorVersionId: seed?.id as string,
            versionId: planted[republicationsToPlant]?.id as string,
            priorFetchedAt: new Date(seed?.fetched_at as string),
            // Rewritten after standing settled for well over a year — the
            // 2021→2024 pattern the research measured.
            settledDays: 900,
            tier: "history",
            runId,
          });
        }
        return {
          kind: "energy_balance",
          result: {
            resourceName: "stub",
            format: "CSV",
            changed: true,
            downloaded: true,
            rowsParsed: 10,
            rowsRejected: 0,
            aggregateRowsFiltered: 0,
            inserted: 0,
            revised: 10,
            unchanged: 0,
          },
        };
      },
    });

    const outcome = await sweep(
      { tier: "history", now: "2026-08-28T12:00:00.000Z" },
      () => {},
    );

    expect(outcome.planned).toBeGreaterThan(50); // 27 years plus every closed month
    expect(outcome.succeeded).toBe(outcome.planned);
    expect(outcome.republications).toBe(4);
    expect(outcome.campaign).not.toBeNull();
    expect(outcome.campaign?.resources).toBe(4);
    expect(outcome.campaign?.maxSettledDays).toBe(900);

    const [runs] = await db.execute<{ total: number; ok: number }>(sql`
      select count(*)::int as total, count(*) filter (where status = 'ok')::int as ok
      from ingestion_run
    `);
    expect(Number(runs?.total)).toBe(outcome.planned);
    expect(Number(runs?.ok)).toBe(outcome.planned);
  }, 120_000);

  it("shows freshness, custody and join match rates per source", async () => {
    const health = await readIngestionHealth(db, archive, {
      now: new Date("2026-08-13T00:00:00.000Z"),
    });

    const wind = health.sources.find(
      (source) => source.source === "constrained_off_wind",
    );
    expect(wind?.rows).toBeGreaterThan(0);
    expect(wind?.lastRunStatus).toBe("ok");
    expect(wind?.lastSuccessAt).toBeInstanceOf(Date);
    // The fixture's newest hour is 2026-08-12 09:00Z, inside the 72h tolerance.
    expect(wind?.stale).toBe(false);

    // A source that has never produced a row is stale, not unknown: it is
    // exactly as useless as one that stopped. (Which sources are empty depends
    // on what else has run against this database, so the rule is asserted
    // rather than one source's emptiness.)
    for (const source of health.sources.filter((candidate) => candidate.rows === 0)) {
      expect(source.lagHours).toBeNull();
      expect(source.stale).toBe(true);
    }

    // The same view, one week later and with nothing new ingested: silence
    // becomes visible rather than staying green.
    const later = await readIngestionHealth(db, archive, {
      now: new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(later.sources.find((s) => s.source === "constrained_off_wind")?.stale).toBe(
      true,
    );

    expect(health.archive.archiveKind).toBe("directory");
    expect(health.archive.retained).toBeGreaterThan(0);
    expect(health.archive.purged).toBe(1);

    expect(health.republications.last30d).toBeGreaterThanOrEqual(5);
    expect(health.republications.campaignSuspected).toBe(true);

    // Registry joins: a rate is a real proportion, or null where there is
    // nothing to join yet — never a fabricated 100%.
    const { plantOnsCode, reportingEntity } = health.registryJoins;
    expect(plantOnsCode.rate === null || plantOnsCode.rate <= 1).toBe(true);
    expect(plantOnsCode.rate === null).toBe(plantOnsCode.total === 0);
    expect(reportingEntity.total).toBeGreaterThan(0);
    expect(reportingEntity.rate).not.toBeNull();
  });
});

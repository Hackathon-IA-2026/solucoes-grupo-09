import { and, eq, isNull, lt, ne, sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import {
  loadApiRequest,
  onsResourceVersion,
  payloadCustody,
} from "../database/schema.js";
import { archiveKey, type PayloadArchive, payloadSha256 } from "./archive.js";

/**
 * Custody: the ledger over the archive, and the retention policy that bounds it.
 *
 * The archive holds bytes and knows nothing about them. This module is where a
 * payload becomes *evidence* — filed against the provenance row that explains
 * which resource it was and when it was fetched, readable back for
 * reprocessing, and enumerable by a retention pass that can say why it dropped
 * anything it dropped.
 *
 * **Retention, decided here and recorded in `docs/specs/data-platform.md`:**
 * a payload that produced a written revision is kept indefinitely, and one that
 * produced none is kept 90 days. The asymmetry is the whole policy, and it
 * follows from what the archive is for. A payload whose rows all digested
 * identical is not a vintage — WattSteer's belief did not change when it
 * arrived, so nothing point-in-time depends on still holding it, and it is the
 * overwhelming majority of what a nightly sweep downloads. A payload that did
 * change something is the *only* surviving copy of what ONS used to say, since
 * the bucket exposes no versioning and the file is already overwritten
 * upstream. The 90 days on the first class is not a hedge about its value; it
 * is a window for a parsing bug to be found and reprocessed before the bytes
 * that would have proved it go away.
 *
 * The fingerprint rows are never deleted. `ons_resource_version` and
 * `load_api_request` are small, and they are the only record that a file
 * existed in a given state at all.
 */

/** Which provenance table a payload hangs off. */
export type CustodyProvenance = "bulk_resource" | "load_api_request";

/** One payload to retain, with everything needed to file it. */
export interface RetainPayloadRequest {
  provenance: CustodyProvenance;
  /** `ons_resource_version.id` or `load_api_request.id`. */
  provenanceId: string;
  /** CKAN package id, or the carga series — the archive's first path segment. */
  datasetSlug: string;
  resourceName: string;
  /** Extension the payload is filed under: `csv`, `parquet`, `json`. */
  extension: string;
  bytes: Uint8Array;
  fetchedAt: Date;
}

/** Where a retained payload ended up, and whether it was already held. */
export interface RetainedPayload {
  archiveUri: string;
  contentSha256: string;
  byteSize: number;
}

/**
 * Archive one payload byte-for-byte and record custody of it.
 *
 * Order matters: bytes first, ledger second. A crash between them leaves an
 * orphan object that the next identical fetch re-uses and that retention will
 * never have promised anyone — whereas a ledger row pointing at bytes that were
 * never written would be a lie about what WattSteer holds.
 *
 * Returns `null` when no archive is configured, so a caller can tell "not
 * retained" from "retained here" instead of assuming custody it does not have.
 */
export async function retainPayload(
  db: Database,
  archive: PayloadArchive | undefined,
  request: RetainPayloadRequest,
): Promise<RetainedPayload | null> {
  if (!archive) {
    return null;
  }

  const contentSha256 = payloadSha256(request.bytes);
  const uri = archiveKey({
    family: request.provenance === "bulk_resource" ? "bulk" : "carga",
    datasetSlug: request.datasetSlug,
    contentSha256,
    extension: request.extension,
  });

  await archive.put(uri, request.bytes);

  await db
    .insert(payloadCustody)
    .values({
      provenance: request.provenance,
      provenanceId: request.provenanceId,
      datasetSlug: request.datasetSlug,
      resourceName: request.resourceName,
      archiveUri: uri,
      contentSha256,
      byteSize: request.bytes.byteLength,
      fetchedAt: request.fetchedAt,
    })
    // Re-archiving the same provenance row is a no-op, not a second claim.
    .onConflictDoNothing();

  // The provenance row carries the locator too, so provenance answers "where
  // are the bytes?" without a join. Nullable there since the tracer landed it
  // before this writer existed.
  if (request.provenance === "bulk_resource") {
    await db
      .update(onsResourceVersion)
      .set({ archiveUri: uri })
      .where(eq(onsResourceVersion.id, request.provenanceId));
  } else {
    await db
      .update(loadApiRequest)
      .set({ archiveUri: uri })
      .where(eq(loadApiRequest.id, request.provenanceId));
  }

  return { archiveUri: uri, contentSha256, byteSize: request.bytes.byteLength };
}

/** A retained payload, verified against the digest it was filed under. */
export interface ReadPayloadResult {
  bytes: Uint8Array;
  archiveUri: string;
  contentSha256: string;
  fetchedAt: Date;
}

/**
 * Read a retained payload back, verifying it is the payload it claims to be.
 *
 * The digest check is not ceremony. The archive is the only surviving copy of a
 * prior vintage, so a silently corrupted object would be reprocessed into fact
 * rows that look exactly like history and are not it. Failing loudly leaves a
 * hole that is visible; succeeding quietly does not.
 */
export async function readRetainedPayload(
  db: Database,
  archive: PayloadArchive | undefined,
  provenance: CustodyProvenance,
  provenanceId: string,
): Promise<ReadPayloadResult | null> {
  if (!archive) {
    return null;
  }
  const [row] = await db
    .select()
    .from(payloadCustody)
    .where(
      and(
        eq(payloadCustody.provenance, provenance),
        eq(payloadCustody.provenanceId, provenanceId),
        isNull(payloadCustody.purgedAt),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }

  const bytes = await archive.get(row.archiveUri);
  if (!bytes) {
    return null;
  }
  const actual = payloadSha256(bytes);
  if (actual !== row.contentSha256) {
    throw new Error(
      `Archived payload ${row.archiveUri} digests ${actual}, expected ${row.contentSha256}`,
    );
  }
  return {
    bytes,
    archiveUri: row.archiveUri,
    contentSha256: row.contentSha256,
    fetchedAt: row.fetchedAt,
  };
}

/** The one tunable in the policy — how long an unproductive payload is held. */
export interface RetentionPolicy {
  /** Days a payload that produced no revision is kept. */
  unproductiveDays: number;
  /** Most payloads purged per pass, so one run cannot stall on a huge backlog. */
  batchSize: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  unproductiveDays: 90,
  batchSize: 500,
};

/** What one retention pass did. */
export interface RetentionResult {
  /** Custody rows older than the window that were examined. */
  examined: number;
  /** Payloads dropped, because they never produced a revision. */
  purged: number;
  /** Bytes reclaimed. */
  bytesReclaimed: number;
  /** Payloads kept because a fact row points at them. Held indefinitely. */
  retainedProductive: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Every provenance id some fact row was actually written from.
 *
 * Discovered from `information_schema` rather than from a list of table names,
 * and that is deliberate: fact tables are added by whoever adds a source, and a
 * hardcoded list would fail *silently and destructively* the first time one was
 * forgotten — retention would classify a productive payload as unproductive and
 * delete the only copy of a vintage. The convention it keys off is the one the
 * schema already enforces everywhere: a fact row's provenance column is named
 * `source_version_id` or `source_request_id`.
 *
 * One pass per table, not one query per candidate: the answer is bounded by the
 * number of provenance rows (thousands), while the fact tables are millions.
 */
async function productiveProvenanceIds(db: Database): Promise<Set<string>> {
  const columns = await db.execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name
    from information_schema.columns
    where table_schema = current_schema()
      and column_name in ('source_version_id', 'source_request_id')
    order by table_name
  `);

  const productive = new Set<string>();
  for (const column of columns) {
    const rows = await db.execute<{ id: string }>(sql`
      select distinct ${sql.identifier(column.column_name)} as id
      from ${sql.identifier(column.table_name)}
    `);
    for (const row of rows) {
      if (row.id) {
        productive.add(String(row.id));
      }
    }
  }
  return productive;
}

/**
 * Apply the retention policy — the half of custody that keeps it affordable.
 *
 * Re-runnable by construction: purging bytes that are already gone is not an
 * error, and a row already marked purged is never examined again.
 */
export async function enforceRetention(
  db: Database,
  archive: PayloadArchive | undefined,
  options: { now?: Date; policy?: RetentionPolicy } = {},
): Promise<RetentionResult> {
  const policy = options.policy ?? DEFAULT_RETENTION;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - policy.unproductiveDays * MS_PER_DAY);
  const result: RetentionResult = {
    examined: 0,
    purged: 0,
    bytesReclaimed: 0,
    retainedProductive: 0,
  };

  const candidates = await db
    .select()
    .from(payloadCustody)
    .where(and(isNull(payloadCustody.purgedAt), lt(payloadCustody.fetchedAt, cutoff)))
    .orderBy(payloadCustody.fetchedAt)
    .limit(policy.batchSize);

  if (candidates.length === 0) {
    return result;
  }
  result.examined = candidates.length;

  const productive = await productiveProvenanceIds(db);

  for (const candidate of candidates) {
    if (productive.has(candidate.provenanceId)) {
      result.retainedProductive += 1;
      continue;
    }
    // The archive is content-addressed, so two provenance rows that fetched
    // byte-identical payloads share one object — which is the point, and also a
    // way to delete a vintage something else is still holding. The object goes
    // only when this is the last live claim on it; the claim itself is released
    // either way.
    const [shared] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(payloadCustody)
      .where(
        and(
          eq(payloadCustody.archiveUri, candidate.archiveUri),
          isNull(payloadCustody.purgedAt),
          ne(payloadCustody.id, candidate.id),
        ),
      );
    const stillClaimed = Number(shared?.count ?? 0) > 0;

    // Bytes first, then the ledger: a crash between them leaves a row claiming
    // custody of bytes that are gone, which the next pass fixes. The reverse
    // would leave bytes nothing will ever reclaim.
    if (!stillClaimed) {
      await archive?.remove(candidate.archiveUri);
    }
    await db
      .update(payloadCustody)
      .set({
        purgedAt: now,
        purgeReason: stillClaimed
          ? `no revision written; older than ${policy.unproductiveDays}d (bytes kept for another provenance)`
          : `no revision written; older than ${policy.unproductiveDays}d`,
      })
      .where(eq(payloadCustody.id, candidate.id));
    result.purged += 1;
    if (!stillClaimed) {
      result.bytesReclaimed += candidate.byteSize;
    }
  }

  return result;
}

/** What the archive currently holds — the operator's line in the health view. */
export interface CustodySummary {
  archiveKind: "bucket" | "directory" | "off";
  retained: number;
  retainedBytes: number;
  purged: number;
  oldestRetainedAt: Date | null;
  newestRetainedAt: Date | null;
}

/** Read the custody summary. Cheap: one aggregate over a small table. */
export async function readCustodySummary(
  db: Database,
  archive: PayloadArchive | undefined,
): Promise<CustodySummary> {
  const [row] = await db.execute<{
    retained: number;
    retained_bytes: string | null;
    purged: number;
    oldest: string | null;
    newest: string | null;
  }>(sql`
    select
      count(*) filter (where purged_at is null)::int as retained,
      coalesce(sum(byte_size) filter (where purged_at is null), 0) as retained_bytes,
      count(*) filter (where purged_at is not null)::int as purged,
      min(fetched_at) filter (where purged_at is null) as oldest,
      max(fetched_at) filter (where purged_at is null) as newest
    from payload_custody
  `);

  return {
    archiveKind: archive?.kind ?? "off",
    retained: Number(row?.retained ?? 0),
    retainedBytes: Number(row?.retained_bytes ?? 0),
    purged: Number(row?.purged ?? 0),
    oldestRetainedAt: row?.oldest ? new Date(row.oldest) : null,
    newestRetainedAt: row?.newest ? new Date(row.newest) : null,
  };
}

import type { Database } from "../database/connection.js";
import { type PayloadRefusedError, UpstreamError } from "../errors.js";
import type { ReportProgress } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { retainPayload } from "./custody.js";
import {
  type CatalogueResource,
  fetchPackage,
  headResource,
  type ResourceFormat,
} from "./ons/catalogue.js";
import {
  markResourceFetched,
  markResourceIngested,
  markResourceRefused,
  type ObservationContext,
  type RecordedRefusal,
  type Republication,
  recordResourceVersion,
} from "./resource-version.js";

/**
 * The bulk-file acquisition step, once.
 *
 * Every ONS dataset that ships as downloadable files is acquired identically:
 * discover the resource from the catalogue, fingerprint it with a `HEAD`, stop
 * there if nothing moved, and only then spend a download. The order is the
 * point — it is what makes a nightly sweep over years of closed history cost
 * one request per file instead of gigabytes.
 *
 * **Deliberately scoped to bulk files, and named for it.** Not every ONS source
 * is one: the carga API publishes no files at all, is paged rather than
 * downloaded, and carries a genuine per-row vintage stamp instead of a file's
 * `Last-Modified`. That source shares the *versioned write* (see
 * `versioned-write.ts`) but not this acquisition path, and forcing it through
 * here would mean inventing a fingerprint for something that has none.
 *
 * **Two marks, not one.** Acquiring bytes and ingesting them are separate facts
 * and are recorded separately: this helper stamps custody (`fetched_at`, the
 * archive) and hands the caller `markIngested` / `markRefused` to stamp the
 * outcome of the parse it performs. They were one fact once, and the cost of
 * that is written up in `.scratch/data-platform/issues/22-*.md`: a parse that
 * threw left the resource marked done, so the next sweep skipped it and the
 * task reported `changed: false, inserted: 0` and exited 0 forever.
 */

/** What acquiring one bulk resource produced. */
export interface BulkResource {
  resource: CatalogueResource;
  format: ResourceFormat;
  /** The `ons_resource_version` row these bytes belong to. */
  versionId: string;
  /** False when the `HEAD` matched a fingerprint already on record. */
  changed: boolean;
  /** False when the run stopped at the `HEAD`. */
  downloaded: boolean;
  /**
   * True when these exact bytes had already been parsed to a conclusion —
   * ingested, or refused. The skip gate, and *not* the same question as
   * "have we downloaded this before?".
   */
  settled: boolean;
  /**
   * Why these bytes stand refused, when a previous pass refused them. Set on a
   * skipped acquisition so a caller can report a standing refusal rather than
   * present it as an unremarkable no-op.
   */
  refusal: RecordedRefusal | null;
  /** Null when the run stopped at the `HEAD`. */
  bytes: ArrayBuffer | null;
  /**
   * Set when these bytes replaced bytes WattSteer had already downloaded — ONS
   * rewrote the file under the same name. The prior vintage is unrecoverable
   * upstream, which is exactly why the event is surfaced rather than absorbed.
   */
  republication: Republication | null;
  /** Archive locator of the retained payload; null when custody is off. */
  archiveUri: string | null;
  /**
   * When the source asserted these values. Bulk files carry no row-level
   * stamp, so the file's `Last-Modified` is the coarsest honest answer — and
   * the row records that coarseness rather than implying precision.
   */
  publishedAt: Date;
  publishedAtPrecision: "file";
  /**
   * When this resource **first entered the catalogue**, which is not the same
   * question as `publishedAt` and is deliberately not used as it.
   *
   * `publishedAt` is the vintage of the bytes in hand; when ONS overwrites a
   * file, the bytes in hand were asserted at the rewrite, and stamping them
   * with the earlier first-publication instant would place values nobody could
   * have read before the gate that admits them. So this is carried *beside*
   * the vintage rather than in place of it — it is what lets an adapter say
   * whether a period that failed a vintage check was published late for the
   * first time or published on time and rewritten. Null when CKAN has no
   * `created`.
   */
  firstPublishedAt: Date | null;
  /**
   * Stamp the parse as landed. **Every caller that parses must call this after
   * its write succeeds**, and no caller may call it before.
   *
   * It is the caller's job because the caller is the only party that knows the
   * rows are in. Forgetting it costs a re-download next sweep — loud in the
   * byte count, harmless to the data — which is the direction this mark is
   * deliberately biased in. Marking too early costs a day of history that
   * never arrives and never complains, which is the failure this replaced.
   *
   * A no-op when the run stopped at the `HEAD`: there is nothing to conclude
   * about bytes this run did not read, and re-stamping a settled row would
   * erase a standing refusal without having parsed anything.
   */
  markIngested: () => Promise<void>;
  /**
   * Record that these exact bytes cannot be ingested, so the next sweep neither
   * re-downloads them nor mistakes them for a period that loaded.
   *
   * For a `PayloadRefusedError` only — a defect in the payload, deterministic
   * in the bytes. Anything else must be left unmarked and rethrown, so it is
   * retried. Also a no-op when nothing was downloaded.
   */
  markRefused: (refusal: PayloadRefusedError) => Promise<void>;
}

export interface BulkResourceRequest {
  db: Database;
  fetch: typeof fetch;
  /** CKAN package id. */
  slug: string;
  /** Pick the resource for the period being ingested. */
  select: (resources: CatalogueResource[]) => CatalogueResource;
  /**
   * An already-discovered resource list, so the catalogue call is skipped.
   *
   * For the year- and month-split datasets one acquisition is one file and
   * reading `package_show` per call costs nothing worth naming. The daily-split
   * DESSEM balances are ~460 files behind a 900 kB `package_show`, so a
   * backfill that re-read it per day would spend 400 MB re-answering a question
   * it asked in its first request. The package stays the *job's* to fetch;
   * this is only the door for handing the answer back.
   */
  resources?: CatalogueResource[];
  /** Re-download and re-diff even when the fingerprint is unchanged. */
  force?: boolean;
  /** Progress across the four acquisition steps. */
  report?: ReportProgress;
  /**
   * Where the downloaded bytes are retained. Optional because a development
   * process may have no archive configured; when it is absent the payload is
   * ingested and not kept, and `archiveUri` says so.
   */
  archive?: PayloadArchive;
  /** The sweep this acquisition belongs to, so a discovery can be attributed. */
  context?: ObservationContext;
}

/** Steps this helper reports against, so callers share one progress scale. */
export const BULK_STEPS = 4;

/**
 * Discover, fingerprint and (only if needed) download one bulk resource.
 *
 * Returns without bytes when the fingerprint is unchanged, which is the common
 * case and the whole reason the `HEAD` happens first.
 */
export async function acquireBulkResource(
  request: BulkResourceRequest,
): Promise<BulkResource> {
  const { db, fetch: fetchImpl, slug, select, report } = request;

  const resources = request.resources ?? (await fetchPackage(slug, fetchImpl));
  const resource = select(resources);
  report?.({ done: 1, total: BULK_STEPS });

  const fingerprint = await headResource(resource.url, fetchImpl);
  const version = await recordResourceVersion(
    db,
    slug,
    resource,
    fingerprint,
    request.context,
  );
  report?.({ done: 2, total: BULK_STEPS });

  const base = {
    resource,
    format: resource.format,
    versionId: version.id,
    changed: !version.alreadySeen,
    settled: version.settled,
    refusal: version.refusal,
    publishedAt: fingerprint.lastModified ?? resource.lastModified ?? new Date(),
    publishedAtPrecision: "file" as const,
    firstPublishedAt: resource.firstPublishedAt,
    republication: version.republication,
  };

  /**
   * The two outcome marks, for the branch that actually read bytes. Bound to
   * the version row rather than passed as an id, so a caller cannot stamp a
   * conclusion against a resource it did not acquire.
   */
  const marks = {
    markIngested: () => markResourceIngested(db, version.id),
    markRefused: (refusal: PayloadRefusedError) =>
      markResourceRefused(db, version.id, refusal.refusal, refusal.message),
  };
  /** Nothing was read, so there is nothing to conclude. */
  const noMarks = {
    markIngested: async (): Promise<void> => {},
    markRefused: async (): Promise<void> => {},
  };

  // **Settled**, not merely seen. A version whose bytes we hold but whose parse
  // threw is deliberately *not* settled, so it is fetched and parsed again here
  // rather than reported as a period that loaded. A version that was ingested,
  // or refused for a reason that is a property of its bytes, is settled and
  // costs this one `HEAD` — which is what keeps a refused day out of a hot loop.
  if (version.settled && !request.force) {
    return { ...base, ...noMarks, downloaded: false, bytes: null, archiveUri: null };
  }

  const response = await fetchImpl(resource.url);
  if (!response.ok) {
    throw new UpstreamError(`GET ${resource.url} failed: HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  await markResourceFetched(db, version.id, bytes);

  // Custody before parsing, deliberately. The payload is retained for what it
  // is — the only surviving copy of what ONS said today — and a parser that
  // throws on an unexpected column must not be what decides whether the bytes
  // were kept.
  //
  // `markResourceFetched` belongs to that argument and stays inside it: the
  // digest and the byte size are facts about the bytes in hand, established
  // before anything tries to understand them. What is *not* established here is
  // that the payload was ingested — that is `markIngested`, stamped by the
  // caller after its write. The one ordering used to carry both claims, and the
  // second one was false whenever a parse threw.
  const fetchedAt = new Date();
  const retained = await retainPayload(db, request.archive, {
    provenance: "bulk_resource",
    provenanceId: version.id,
    datasetSlug: slug,
    resourceName: resource.name,
    extension: resource.format.toLowerCase(),
    bytes: new Uint8Array(bytes),
    fetchedAt,
  });
  report?.({ done: 3, total: BULK_STEPS });

  return {
    ...base,
    ...marks,
    downloaded: true,
    bytes,
    archiveUri: retained?.archiveUri ?? null,
  };
}

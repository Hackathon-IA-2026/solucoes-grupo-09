import type { Database } from "../database/connection.js";
import { UpstreamError } from "../errors.js";
import type { ReportProgress } from "../jobs/index.js";
import {
  type CatalogueResource,
  fetchPackage,
  headResource,
  type ResourceFormat,
} from "./ons/catalogue.js";
import { markResourceFetched, recordResourceVersion } from "./resource-version.js";

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
  /** Null when the run stopped at the `HEAD`. */
  bytes: ArrayBuffer | null;
  /**
   * When the source asserted these values. Bulk files carry no row-level
   * stamp, so the file's `Last-Modified` is the coarsest honest answer — and
   * the row records that coarseness rather than implying precision.
   */
  publishedAt: Date;
  publishedAtPrecision: "file";
}

export interface BulkResourceRequest {
  db: Database;
  fetch: typeof fetch;
  /** CKAN package id. */
  slug: string;
  /** Pick the resource for the period being ingested. */
  select: (resources: CatalogueResource[]) => CatalogueResource;
  /** Re-download and re-diff even when the fingerprint is unchanged. */
  force?: boolean;
  /** Progress across the four acquisition steps. */
  report?: ReportProgress;
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

  const resources = await fetchPackage(slug, fetchImpl);
  const resource = select(resources);
  report?.({ done: 1, total: BULK_STEPS });

  const fingerprint = await headResource(resource.url, fetchImpl);
  const version = await recordResourceVersion(db, slug, resource, fingerprint);
  report?.({ done: 2, total: BULK_STEPS });

  const base = {
    resource,
    format: resource.format,
    versionId: version.id,
    changed: !version.alreadySeen,
    publishedAt: fingerprint.lastModified ?? resource.lastModified ?? new Date(),
    publishedAtPrecision: "file" as const,
  };

  if (version.alreadySeen && !request.force) {
    return { ...base, downloaded: false, bytes: null };
  }

  const response = await fetchImpl(resource.url);
  if (!response.ok) {
    throw new UpstreamError(`GET ${resource.url} failed: HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  await markResourceFetched(db, version.id, bytes);
  report?.({ done: 3, total: BULK_STEPS });

  return { ...base, downloaded: true, bytes };
}

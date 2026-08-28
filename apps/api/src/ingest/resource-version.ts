import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { onsResourceVersion } from "../database/schema.js";
import { UpstreamError } from "../errors.js";
import type { CatalogueResource, ResourceFingerprint } from "./ons/catalogue.js";

/**
 * Provenance for a downloaded ONS resource, shared by every bulk adapter.
 *
 * Extracted from the energy-balance job when the second adapter arrived: the
 * "have we already seen this exact file?" question is identical for every
 * dataset, and two copies of it would be two chances to answer it differently.
 */

/**
 * Record this observation of the resource, or return the existing row.
 *
 * The `(resource_url, change_key)` unique index is what makes "have we already
 * seen this exact file?" one query rather than a heuristic.
 */
export async function recordResourceVersion(
  db: Database,
  datasetSlug: string,
  resource: CatalogueResource,
  fingerprint: ResourceFingerprint,
): Promise<{ id: string; alreadySeen: boolean }> {
  const [existing] = await db
    .select({ id: onsResourceVersion.id, fetchedAt: onsResourceVersion.fetchedAt })
    .from(onsResourceVersion)
    .where(
      and(
        eq(onsResourceVersion.resourceUrl, resource.url),
        eq(onsResourceVersion.changeKey, fingerprint.changeKey),
      ),
    )
    .limit(1);

  if (existing) {
    // Only a completed download counts as "seen": a row from a HEAD-only probe
    // must not stop the next run from fetching the bytes.
    return { id: existing.id, alreadySeen: existing.fetchedAt !== null };
  }

  const [inserted] = await db
    .insert(onsResourceVersion)
    .values({
      datasetSlug,
      resourceName: resource.name,
      resourceUrl: resource.url,
      format: resource.format,
      changeKey: fingerprint.changeKey,
      lastModified: fingerprint.lastModified,
      contentLength: fingerprint.contentLength,
      etag: fingerprint.etag,
    })
    .returning({ id: onsResourceVersion.id });

  if (!inserted) {
    throw new UpstreamError("Failed to record the ONS resource version");
  }
  return { id: inserted.id, alreadySeen: false };
}

/** Record the bytes actually fetched, so a HEAD-only probe stays distinguishable. */
export async function markResourceFetched(
  db: Database,
  versionId: string,
  bytes: ArrayBuffer,
): Promise<void> {
  await db
    .update(onsResourceVersion)
    .set({
      contentSha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
      byteSize: bytes.byteLength,
      fetchedAt: new Date(),
    })
    .where(eq(onsResourceVersion.id, versionId));
}

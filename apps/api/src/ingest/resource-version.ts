import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import {
  onsResourceVersion,
  type refreshTier,
  resourceRepublication,
} from "../database/schema.js";
import { UpstreamError } from "../errors.js";
import type { CatalogueResource, ResourceFingerprint } from "./ons/catalogue.js";

/**
 * Provenance for a downloaded ONS resource, shared by every bulk adapter.
 *
 * Extracted from the energy-balance job when the second adapter arrived: the
 * "have we already seen this exact file?" question is identical for every
 * dataset, and two copies of it would be two chances to answer it differently.
 */

/** Which sweep observed a resource state, when a sweep did. */
export type RefreshTier = (typeof refreshTier.enumValues)[number];

/** The run an observation belongs to, so a discovery can be attributed. */
export interface ObservationContext {
  tier?: RefreshTier;
  runId?: string;
}

/** A resource that changed after WattSteer had already downloaded it. */
export interface Republication {
  priorVersionId: string;
  priorFetchedAt: Date;
  /** Whole days the prior version stood before ONS overwrote it. */
  settledDays: number;
}

/** What recording an observation of a resource established. */
export interface RecordedResourceVersion {
  id: string;
  alreadySeen: boolean;
  /**
   * Set when this state supersedes bytes WattSteer had already downloaded —
   * i.e. ONS rewrote a file under the same name. Null on a first sighting.
   */
  republication: Republication | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Record this observation of the resource, or return the existing row.
 *
 * The `(resource_url, change_key)` unique index is what makes "have we already
 * seen this exact file?" one query rather than a heuristic.
 *
 * **A new state for a URL we have already downloaded is a re-publication**, and
 * it is recorded as an event here rather than inferred later. This is the only
 * place in the platform that sees both the prior fetched version and the new
 * fingerprint in the same breath, so it is the only place that can say a file
 * was overwritten — and ONS overwrites closed months years later with no
 * version marker, so an overwrite that is merely absorbed into a new
 * `data_version` is a bulk campaign nobody ever sees.
 */
export async function recordResourceVersion(
  db: Database,
  datasetSlug: string,
  resource: CatalogueResource,
  fingerprint: ResourceFingerprint,
  context: ObservationContext = {},
): Promise<RecordedResourceVersion> {
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
    return {
      id: existing.id,
      alreadySeen: existing.fetchedAt !== null,
      republication: null,
    };
  }

  // The newest state of this URL whose bytes we actually hold. If there is one,
  // those bytes are what this new state replaces — and upstream they are gone.
  const [superseded] = await db
    .select({ id: onsResourceVersion.id, fetchedAt: onsResourceVersion.fetchedAt })
    .from(onsResourceVersion)
    .where(
      and(
        eq(onsResourceVersion.resourceUrl, resource.url),
        isNotNull(onsResourceVersion.fetchedAt),
      ),
    )
    .orderBy(desc(onsResourceVersion.fetchedAt))
    .limit(1);

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

  if (!superseded?.fetchedAt) {
    return { id: inserted.id, alreadySeen: false, republication: null };
  }

  const settledDays = Math.max(
    0,
    Math.floor((Date.now() - superseded.fetchedAt.getTime()) / MS_PER_DAY),
  );
  await db
    .insert(resourceRepublication)
    .values({
      datasetSlug,
      resourceName: resource.name,
      resourceUrl: resource.url,
      priorVersionId: superseded.id,
      versionId: inserted.id,
      priorFetchedAt: superseded.fetchedAt,
      settledDays,
      tier: context.tier,
      runId: context.runId,
    })
    // The pair is unique, so a concurrent probe of the same overwrite records
    // the event once rather than inflating a campaign.
    .onConflictDoNothing();

  return {
    id: inserted.id,
    alreadySeen: false,
    republication: {
      priorVersionId: superseded.id,
      priorFetchedAt: superseded.fetchedAt,
      settledDays,
    },
  };
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

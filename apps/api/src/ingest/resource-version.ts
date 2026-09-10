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

/** A recorded refusal of one resource version's bytes. */
export interface RecordedRefusal {
  /** A `PayloadRefusal` — read as text, because the set is the adapters'. */
  reason: string;
  detail: string | null;
  at: Date;
}

/** What recording an observation of a resource established. */
export interface RecordedResourceVersion {
  id: string;
  /**
   * True when the bytes behind *this exact fingerprint* have already been
   * downloaded. It is the answer to "did the file move?", and nothing more.
   */
  alreadySeen: boolean;
  /**
   * True when those bytes have also been **parsed to a conclusion** — ingested,
   * or refused for a reason that is a property of the bytes.
   *
   * This is the skip gate, and it is a different question from `alreadySeen`.
   * Conflating them is what made data-platform 21's silent hole: bytes in hand
   * read as work done, so a parse that threw was never retried and never
   * reported. A downloaded-but-unsettled version is retried; a settled one is
   * not touched again without `force`.
   */
  settled: boolean;
  /** Why these bytes stand refused, when a previous pass refused them. */
  refusal: RecordedRefusal | null;
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
    .select({
      id: onsResourceVersion.id,
      fetchedAt: onsResourceVersion.fetchedAt,
      ingestedAt: onsResourceVersion.ingestedAt,
      refusedAt: onsResourceVersion.refusedAt,
      refusalReason: onsResourceVersion.refusalReason,
      refusalDetail: onsResourceVersion.refusalDetail,
    })
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
    //
    // And only a *landed* parse — or a refusal of these bytes — counts as
    // settled. A row that was fetched and whose parse then threw is neither,
    // so the next pass fetches it again instead of reporting it done.
    return {
      id: existing.id,
      alreadySeen: existing.fetchedAt !== null,
      settled: existing.ingestedAt !== null || existing.refusedAt !== null,
      refusal:
        existing.refusedAt === null
          ? null
          : {
              reason: existing.refusalReason ?? "unspecified",
              detail: existing.refusalDetail,
              at: existing.refusedAt,
            },
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
    return {
      id: inserted.id,
      alreadySeen: false,
      settled: false,
      refusal: null,
      republication: null,
    };
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
    settled: false,
    refusal: null,
    republication: {
      priorVersionId: superseded.id,
      priorFetchedAt: superseded.fetchedAt,
      settledDays,
    },
  };
}

/**
 * Record the bytes actually fetched, so a HEAD-only probe stays distinguishable.
 *
 * **Custody, and only custody.** This is stamped before the parse, on purpose
 * — see `bulk-resource.ts`. It records that WattSteer holds these bytes and
 * what their digest is. It says nothing about whether they were understood,
 * which is `markResourceIngested`'s job.
 */
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

/**
 * Record that these bytes were parsed and written — the completion mark.
 *
 * Called **after** the write, by the ingestor that did it, because it is the
 * only party that knows the rows landed. Until it is called the version is
 * unsettled and the next pass will fetch and parse it again, which is the
 * behaviour a thrown parse needs and the behaviour it did not have.
 *
 * A standing refusal is cleared here: a fixed adapter re-run under `force`
 * that now succeeds supersedes the refusal rather than sitting beside it.
 */
export async function markResourceIngested(
  db: Database,
  versionId: string,
): Promise<void> {
  await db
    .update(onsResourceVersion)
    .set({
      ingestedAt: new Date(),
      refusedAt: null,
      refusalReason: null,
      refusalDetail: null,
    })
    .where(eq(onsResourceVersion.id, versionId));
}

/**
 * Record that these exact bytes cannot be ingested, and why.
 *
 * The counterpart to `markResourceIngested`, and the reason a refused day is
 * not the same thing as a thrown parse. The refusal is a property of the bytes,
 * so it settles this fingerprint — no re-download next sweep — while leaving
 * `ingested_at` null, so nothing can mistake the day for one that loaded. ONS
 * re-publishing the file produces a different `change_key` and therefore a
 * fresh, unsettled row: the refusal never outlives the bytes it is about.
 */
export async function markResourceRefused(
  db: Database,
  versionId: string,
  reason: string,
  detail: string,
): Promise<void> {
  await db
    .update(onsResourceVersion)
    .set({ refusedAt: new Date(), refusalReason: reason, refusalDetail: detail })
    .where(eq(onsResourceVersion.id, versionId));
}

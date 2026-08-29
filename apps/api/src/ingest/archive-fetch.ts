import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { loadApiRequest, onsResourceVersion } from "../database/schema.js";
import { UpstreamError } from "../errors.js";
import type { PayloadArchive } from "./archive.js";
import { readRetainedPayload } from "./custody.js";
import { CKAN_BASE } from "./ons/catalogue.js";

/**
 * Reprocessing, without re-fetching anything.
 *
 * A parsing bug found in six months is not fixable by re-downloading: the files
 * ONS serves then are not the files that produced the wrong rows, and for a
 * closed period they may have been rewritten twice since. What is fixable is
 * re-running the *same ingestor* over the *same bytes* — which is what this is.
 *
 * **It is a `fetch`, and that is the whole design.** Every ingestor already
 * takes `fetch` as a dependency so it can be tested without the network, so a
 * `fetch` that answers out of custody makes reprocessing a wiring choice rather
 * than a second code path per source. Nothing in an adapter knows or needs to
 * know that its bytes came from the archive:
 *
 * ```ts
 * const ingest = createConstrainedOffIngestor({
 *   db,
 *   fetch: createArchiveFetch({ db, archive }),
 * });
 * await ingest({ technology: "WIND", year: 2025, month: 1, force: true }, report);
 * ```
 *
 * `force` is required, and for the right reason: the fingerprint is by
 * definition one already on record, so without it the acquisition would stop at
 * the `HEAD` exactly as it should during a normal sweep.
 *
 * **`asOf` replays a past vintage.** With it, the catalogue, the fingerprints
 * and the bytes all come from the newest state fetched at or before that
 * instant — so "reprocess the platform as it stood last March" is one
 * parameter, and the answer is built from what WattSteer actually held then
 * rather than from what ONS is willing to serve today.
 */

export interface ArchiveFetchOptions {
  db: Database;
  archive: PayloadArchive;
  /** Replay the newest vintage fetched at or before this instant. */
  asOf?: Date;
}

/** A CKAN resource as `package_show` renders it, rebuilt from what we hold. */
interface SynthesisedResource {
  name: string;
  url: string;
  format: string;
  last_modified: string | null;
  size: number | null;
}

/** Split a stored change key back into the header strings it was folded from. */
function headersFromChangeKey(changeKey: string, byteSize: number | null): Headers {
  const [lastModified = "", contentLength = "", etag = ""] = changeKey.split("|");
  const headers = new Headers();
  if (lastModified) {
    headers.set("last-modified", lastModified);
  }
  // Prefer the length the fingerprint was taken with, so the reconstructed
  // change key is byte-identical to the one on record; fall back to what we
  // actually hold rather than emitting nothing.
  const length = contentLength || (byteSize === null ? "" : String(byteSize));
  if (length) {
    headers.set("content-length", length);
  }
  if (etag) {
    headers.set("etag", etag);
  }
  return headers;
}

export function createArchiveFetch(options: ArchiveFetchOptions): typeof fetch {
  const { db, archive } = options;
  const asOf = options.asOf;

  /** The newest state of a URL whose bytes we hold, at or before `asOf`. */
  async function versionFor(url: string) {
    const [row] = await db
      .select()
      .from(onsResourceVersion)
      .where(
        and(
          eq(onsResourceVersion.resourceUrl, url),
          isNotNull(onsResourceVersion.fetchedAt),
          ...(asOf ? [lte(onsResourceVersion.fetchedAt, asOf)] : []),
        ),
      )
      .orderBy(desc(onsResourceVersion.fetchedAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Rebuild `package_show` from the resource versions on record.
   *
   * The catalogue is answered from custody too, not passed through to CKAN.
   * A reprocess that read today's catalogue would be free to pick a resource
   * that did not exist at the vintage it claims to be replaying — which is the
   * one mistake this whole path exists to prevent.
   */
  async function packageShow(slug: string): Promise<Response> {
    const rows = await db
      .select()
      .from(onsResourceVersion)
      .where(
        and(
          eq(onsResourceVersion.datasetSlug, slug),
          isNotNull(onsResourceVersion.fetchedAt),
          ...(asOf ? [lte(onsResourceVersion.fetchedAt, asOf)] : []),
        ),
      )
      .orderBy(desc(onsResourceVersion.fetchedAt));

    const newest = new Map<string, SynthesisedResource>();
    for (const row of rows) {
      if (newest.has(row.resourceUrl)) {
        continue; // rows arrive newest-first, so the first sighting wins
      }
      newest.set(row.resourceUrl, {
        name: row.resourceName,
        url: row.resourceUrl,
        format: row.format,
        // CKAN writes this without a timezone suffix and the reader appends
        // one; rendering it the same way keeps the round trip lossless.
        last_modified: row.lastModified
          ? row.lastModified.toISOString().replace(/\.\d+Z$/, "")
          : null,
        size: row.contentLength,
      });
    }

    return Response.json({ result: { resources: [...newest.values()] } });
  }

  return async function archiveFetch(input, init) {
    const url = typeof input === "string" ? input : new URL(String(input)).toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.startsWith(`${CKAN_BASE}/package_show`)) {
      const slug = new URL(url).searchParams.get("id") ?? "";
      return packageShow(slug);
    }

    const version = await versionFor(url);
    if (version) {
      const headers = headersFromChangeKey(version.changeKey, version.byteSize);
      if (method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }
      const payload = await readRetainedPayload(db, archive, "bulk_resource", version.id);
      if (!payload) {
        throw new UpstreamError(
          `No archived payload for ${url} — the vintage was never retained or has been purged`,
        );
      }
      // Copied into a plain ArrayBuffer: a Uint8Array view is not a BodyInit.
      return new Response(payload.bytes.slice().buffer, { status: 200, headers });
    }

    // The carga API: no file, no fingerprint, and the request URL is the only
    // identity the response ever had.
    const [request] = await db
      .select()
      .from(loadApiRequest)
      .where(
        and(
          eq(loadApiRequest.requestUrl, url),
          ...(asOf ? [lte(loadApiRequest.fetchedAt, asOf)] : []),
        ),
      )
      .orderBy(desc(loadApiRequest.fetchedAt))
      .limit(1);

    if (!request) {
      throw new UpstreamError(`Nothing in custody for ${url}`);
    }
    const payload = await readRetainedPayload(
      db,
      archive,
      "load_api_request",
      request.id,
    );
    if (!payload) {
      throw new UpstreamError(
        `No archived response for ${url} — it was never retained or has been purged`,
      );
    }
    return new Response(payload.bytes.slice().buffer, {
      status: request.httpStatus,
      headers: { "content-type": "application/json" },
    });
  } as typeof fetch;
}

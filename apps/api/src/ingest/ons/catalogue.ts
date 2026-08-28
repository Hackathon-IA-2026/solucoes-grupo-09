import { UpstreamError } from "../../errors.js";

/**
 * The ONS CKAN catalogue, and the S3 change detector that sits behind it.
 *
 * Resource URLs are **read from `package_show`, never constructed**. The S3
 * path segment is frequently not the CKAN slug, filenames are irregular
 * (`CMO_SEMIHORARIO` and not `CMO_SEMI_HORARIO`), and a minority of older
 * resources are served from a regional host — so a constructed URL fails as a
 * 404 or, worse, as a wrong file.
 */

/** Base of the ONS CKAN action API. */
export const CKAN_BASE = "https://dados.ons.org.br/api/3/action";

/** Formats WattSteer will ingest, in order of preference. */
export const PREFERRED_FORMATS = ["PARQUET", "CSV"] as const;
export type ResourceFormat = (typeof PREFERRED_FORMATS)[number];

/** The fields of a CKAN resource this layer uses. */
export interface CatalogueResource {
  name: string;
  url: string;
  format: ResourceFormat;
  /** CKAN's own stamp. Trails S3 by up to a minute and is sometimes null. */
  lastModified: Date | null;
  size: number | null;
}

interface RawResource {
  name?: unknown;
  url?: unknown;
  format?: unknown;
  last_modified?: unknown;
  created?: unknown;
  size?: unknown;
}

/** Read the resource list out of a `package_show` payload. */
export function readResources(payload: unknown): CatalogueResource[] {
  const result = (payload as { result?: { resources?: RawResource[] } } | null)?.result;
  if (!result?.resources) {
    throw new UpstreamError("CKAN package_show returned no resources");
  }

  const resources: CatalogueResource[] = [];
  for (const raw of result.resources) {
    const format = String(raw.format ?? "").toUpperCase();
    if (!PREFERRED_FORMATS.includes(format as ResourceFormat)) {
      continue;
    }
    // `last_modified` is not populated on every resource; `created` still is.
    // CKAN writes both without a timezone suffix and they are effectively UTC.
    const stamp = raw.last_modified ?? raw.created;
    resources.push({
      name: String(raw.name ?? ""),
      url: String(raw.url ?? ""),
      format: format as ResourceFormat,
      lastModified: typeof stamp === "string" ? new Date(`${stamp}Z`) : null,
      size: typeof raw.size === "number" ? raw.size : null,
    });
  }
  return resources;
}

/** Filename a resource URL points at, lower-cased. */
function basename(url: string): string {
  return (url.split("/").pop() ?? "").toLowerCase();
}

/**
 * Pick the resource covering `year`, preferring Parquet.
 *
 * The year is matched against the filename CKAN gave us rather than used to
 * build one, so the irregular-filename hazard stays confined to matching — a
 * miss is a thrown error, not a silent 404 on a fabricated URL.
 */
export function selectResourceForYear(
  resources: CatalogueResource[],
  year: number,
): CatalogueResource {
  for (const format of PREFERRED_FORMATS) {
    const match = resources.find(
      (resource) =>
        resource.format === format &&
        basename(resource.url).endsWith(`_${year}.${format.toLowerCase()}`),
    );
    if (match) {
      return match;
    }
  }
  throw new UpstreamError(`No PARQUET or CSV resource found for year ${year}`);
}

/**
 * Pick the resource for one month, for the datasets ONS splits monthly.
 *
 * `formats` is a parameter rather than the module default because the
 * preference is per dataset, not global: Parquet is smaller everywhere, but it
 * does not cover the full wind constrained-off history (it starts 2023-10
 * against the CSV's 2021-10), so that adapter asks for CSV first. Choosing the
 * format that always exists beats choosing the one that is usually smaller.
 */
export function selectResourceForMonth(
  resources: CatalogueResource[],
  year: number,
  month: number,
  formats: readonly ResourceFormat[] = PREFERRED_FORMATS,
): CatalogueResource {
  const suffix = `_${year}_${String(month).padStart(2, "0")}`;
  for (const format of formats) {
    const match = resources.find(
      (resource) =>
        resource.format === format &&
        basename(resource.url).endsWith(`${suffix}.${format.toLowerCase()}`),
    );
    if (match) {
      return match;
    }
  }
  throw new UpstreamError(
    `No ${formats.join(" or ")} resource found for ${year}-${String(month).padStart(2, "0")}`,
  );
}

/** Fetch and decode `package_show` for a dataset. */
export async function fetchPackage(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogueResource[]> {
  const response = await fetchImpl(
    `${CKAN_BASE}/package_show?id=${encodeURIComponent(slug)}`,
  );
  if (!response.ok) {
    throw new UpstreamError(`CKAN package_show ${slug} failed: HTTP ${response.status}`);
  }
  return readResources(await response.json());
}

/**
 * The S3 fingerprint of a resource, as observed by a `HEAD`.
 *
 * ONS exposes no object versioning and republishes revisions under the same
 * filename, so this triple is the only revision signal that exists. `ETag`
 * equality is reliable for "unchanged"; inequality is treated as "changed" even
 * though a multipart re-upload could in principle differ without new content.
 */
export interface ResourceFingerprint {
  lastModified: Date | null;
  contentLength: number | null;
  etag: string | null;
  /** The three above folded into one comparable value. */
  changeKey: string;
}

/** Fold response headers into a fingerprint. Exported for the fixture test. */
export function fingerprintFromHeaders(headers: Headers): ResourceFingerprint {
  const lastModifiedHeader = headers.get("last-modified");
  const contentLengthHeader = headers.get("content-length");
  const etag = headers.get("etag");
  const lastModified = lastModifiedHeader ? new Date(lastModifiedHeader) : null;
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
  return {
    lastModified,
    contentLength,
    etag,
    changeKey: [lastModifiedHeader ?? "", contentLengthHeader ?? "", etag ?? ""].join(
      "|",
    ),
  };
}

/** `HEAD` a resource — the change check that costs no download. */
export async function headResource(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResourceFingerprint> {
  const response = await fetchImpl(url, { method: "HEAD" });
  if (!response.ok) {
    throw new UpstreamError(`HEAD ${url} failed: HTTP ${response.status}`);
  }
  return fingerprintFromHeaders(response.headers);
}

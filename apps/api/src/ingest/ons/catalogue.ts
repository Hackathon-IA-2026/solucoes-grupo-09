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
  /**
   * CKAN's `created` — when this resource **first entered the catalogue**, and
   * therefore the earliest instant anything downstream could have read it.
   *
   * Read separately from `lastModified` because they answer different
   * questions and only one of them survives a rewrite. A file ONS overwrites
   * keeps its `created` and moves its `last_modified`; a file ONS publishes
   * late for the first time has no `last_modified` at all and a `created`
   * after the period it covers. Folded into one field — which is what
   * `last_modified ?? created` used to do, under the name of the first — those
   * two cases are indistinguishable, and data-platform 21 misdiagnosed 59 days
   * of *never published in time* as *re-published later* because of it
   * (data-platform 25).
   *
   * **Not** a substitute for `published_at`. See `lastModified`'s use in
   * `bulk-resource.ts`: the vintage of the bytes in hand is when those bytes
   * were written, not when some earlier bytes under the same name were.
   */
  firstPublishedAt: Date | null;
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
      firstPublishedAt:
        typeof raw.created === "string" ? new Date(`${raw.created}Z`) : null,
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
 *
 * `formats` is a parameter for the same reason it is one on
 * `selectResourceForMonth`: the preference is per dataset. `intercambio-nacional`
 * publishes Parquet for 2023 → 2026 only, against CSV for all 27 years, so a
 * Parquet-preferring select would silently ingest a different rendition for the
 * recent years than for the history.
 */
export function selectResourceForYear(
  resources: CatalogueResource[],
  year: number,
  formats: readonly ResourceFormat[] = PREFERRED_FORMATS,
): CatalogueResource {
  for (const format of formats) {
    const match = resources.find(
      (resource) =>
        resource.format === format &&
        basename(resource.url).endsWith(`_${year}.${format.toLowerCase()}`),
    );
    if (match) {
      return match;
    }
  }
  throw new UpstreamError(`No ${formats.join(" or ")} resource found for year ${year}`);
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

/** `_YYYY_MM_DD` before an accepted extension — the daily-split filename shape. */
const DAY_SUFFIX = /_(\d{4})_(\d{2})_(\d{2})\.(csv|parquet)$/;

/**
 * Whether a resource's file name begins with `prefix`, case-insensitively; true
 * when no prefix is asked for.
 *
 * A package's resource list is not guaranteed to hold only its own files.
 * `programacao_fluxo_controlado` lists `PROGRAMACAO_DIARIA_2026_07_21.parquet`,
 * pointing into the `programacao_diaria` folder, among its own 700-odd days —
 * and a selector that matches on the date suffix alone would offer that file as
 * the flow dataset's 2026-07-21, or count the day as available on the strength
 * of it. The prefix is the file's own name for what it is, so it is asked for by
 * the datasets that have been seen to need it rather than defended everywhere.
 */
function hasPrefix(url: string, prefix: string | undefined): boolean {
  return prefix === undefined || basename(url).startsWith(prefix.toLowerCase());
}

/**
 * Pick the resource for one reference day, for the datasets ONS splits daily.
 *
 * The DESSEM balances are the only daily split in scope — ~460 resources per
 * package and one more every evening — so this is a third selector rather than
 * a generalisation of the other two: the month and year selectors match a
 * suffix that a daily file would also match on the first of a month, and
 * folding them together would make `2026_08` silently select `2026_08_01`.
 */
export function selectResourceForDay(
  resources: CatalogueResource[],
  year: number,
  month: number,
  day: number,
  formats: readonly ResourceFormat[] = PREFERRED_FORMATS,
  filePrefix?: string,
): CatalogueResource {
  const suffix = `_${year}_${String(month).padStart(2, "0")}_${String(day).padStart(2, "0")}`;
  for (const format of formats) {
    const match = resources.find(
      (resource) =>
        resource.format === format &&
        hasPrefix(resource.url, filePrefix) &&
        basename(resource.url).endsWith(`${suffix}.${format.toLowerCase()}`),
    );
    if (match) {
      return match;
    }
  }
  throw new UpstreamError(
    `No ${formats.join(" or ")} resource found for ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  );
}

/**
 * Every reference day the catalogue actually offers, as `YYYY-MM-DD`, ascending.
 *
 * Discovery, not construction: a backfill over a daily-split dataset has to know
 * which days exist, and iterating a date range instead would spend a request per
 * day ONS never published. Days are read from the filenames CKAN gave us, in the
 * formats the caller will actually ingest — a day present only as XLSX is not a
 * day this platform can read.
 */
export function availableResourceDays(
  resources: CatalogueResource[],
  formats: readonly ResourceFormat[] = PREFERRED_FORMATS,
  filePrefix?: string,
): string[] {
  const days = new Set<string>();
  for (const resource of resources) {
    if (!(formats.includes(resource.format) && hasPrefix(resource.url, filePrefix))) {
      continue;
    }
    const match = DAY_SUFFIX.exec(basename(resource.url));
    if (match) {
      days.add(`${match[1]}-${match[2]}-${match[3]}`);
    }
  }
  return [...days].sort();
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

/**
 * Pick the one resource of a dataset ONS publishes as a single file.
 *
 * The registry datasets — `capacidade-geracao`, `usina_conjunto`,
 * `modalidade-usina` — are not split by year or month: there is exactly one
 * file per format, overwritten in place. So there is nothing to match a period
 * against, and the only choice is the format preference.
 *
 * Still routed through the catalogue rather than a constant URL, and for a
 * reason this dataset family demonstrates better than any other:
 * `modalidade-usina`'s CKAN slug is hyphenated while its S3 path segment is
 * `modalidade_usina`. A constructed URL is a 404 waiting to happen.
 */
export function selectSingleResource(
  resources: CatalogueResource[],
  formats: readonly ResourceFormat[] = PREFERRED_FORMATS,
): CatalogueResource {
  for (const format of formats) {
    const match = resources.find((resource) => resource.format === format);
    if (match) {
      return match;
    }
  }
  throw new UpstreamError(`No ${formats.join(" or ")} resource found`);
}

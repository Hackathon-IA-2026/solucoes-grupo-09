import type { Database } from "../database/connection.js";
import { UpstreamError } from "../errors.js";
import type { Execute } from "../jobs/index.js";
import { upsertReportingEntities, writeCurtailment } from "./curtailment-repository.js";
import { fetchPackage, headResource, selectResourceForMonth } from "./ons/catalogue.js";
import {
  parseConstrainedOffCsv,
  SOLAR_DATASET_SLUG,
  WIND_DATASET_SLUG,
} from "./ons/constrained-off.js";
import { markResourceFetched, recordResourceVersion } from "./resource-version.js";
import type { Technology } from "./types.js";

/**
 * Ingestion for the entity-grain constrained-off datasets, one month at a time
 * — the unit ONS publishes.
 *
 * Same order of operations as the energy-balance job, for the same reason:
 * discover from the catalogue, fingerprint with a `HEAD`, stop there if nothing
 * moved, and only then spend a download. The refresh policy this enables
 * matters more here than anywhere else, because ONS rewrites closed months of
 * this dataset years after the fact — the whole of 2025 was restated in 2026.
 */

/** One month of one technology. */
export interface IngestConstrainedOffPayload {
  technology: Technology;
  year: number;
  /** 1–12. */
  month: number;
  /** Re-download and re-diff even when the fingerprint is unchanged. */
  force?: boolean;
}

export interface IngestConstrainedOffResult {
  resourceName: string;
  changed: boolean;
  downloaded: boolean;
  rowsParsed: number;
  rowsRejected: number;
  entitiesSeen: number;
  /** Whether this file carried `dsc_restricao` at all. */
  hasDescriptionColumn: boolean;
  inserted: number;
  revised: number;
  unchanged: number;
}

export interface ConstrainedOffIngestorDeps {
  db: Database;
  /** Injected so the job is testable without the network. */
  fetch?: typeof fetch;
}

/**
 * CSV first, deliberately.
 *
 * Parquet is roughly a tenth the bytes, but it does not cover the full wind
 * history — the adapter is written against the rendition that always exists,
 * and the size win is not worth a silent hole in 2021–2023.
 */
const FORMATS = ["CSV"] as const;

const slugFor = (technology: Technology): string =>
  technology === "WIND" ? WIND_DATASET_SLUG : SOLAR_DATASET_SLUG;

export function createConstrainedOffIngestor(
  deps: ConstrainedOffIngestorDeps,
): Execute<IngestConstrainedOffPayload, IngestConstrainedOffResult> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (payload, report) => {
    const slug = slugFor(payload.technology);
    const resources = await fetchPackage(slug, fetchImpl);
    const resource = selectResourceForMonth(
      resources,
      payload.year,
      payload.month,
      FORMATS,
    );
    report({ done: 1, total: 4 });

    const fingerprint = await headResource(resource.url, fetchImpl);
    const version = await recordResourceVersion(deps.db, slug, resource, fingerprint);
    report({ done: 2, total: 4 });

    const base = {
      resourceName: resource.name,
      changed: !version.alreadySeen,
      rowsParsed: 0,
      rowsRejected: 0,
      entitiesSeen: 0,
      hasDescriptionColumn: false,
      inserted: 0,
      revised: 0,
      unchanged: 0,
    };

    if (version.alreadySeen && !payload.force) {
      return { ...base, downloaded: false };
    }

    const response = await fetchImpl(resource.url);
    if (!response.ok) {
      throw new UpstreamError(`GET ${resource.url} failed: HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    report({ done: 3, total: 4 });

    const parsed = parseConstrainedOffCsv(
      new TextDecoder("utf-8").decode(bytes),
      payload.technology,
    );
    await markResourceFetched(deps.db, version.id, bytes);

    // Entities first: the fact table has a foreign key to them, and a month can
    // introduce a conjunto that has never been settled against before.
    await upsertReportingEntities(deps.db, parsed.entities);

    const written = await writeCurtailment(deps.db, {
      rows: parsed.rows,
      // No row-level vintage on these files, so the file's `Last-Modified` is
      // the coarsest honest stamp, and the row says so.
      publishedAt: fingerprint.lastModified ?? resource.lastModified ?? new Date(),
      publishedAtPrecision: "file",
      sourceVersionId: version.id,
    });
    report({ done: 4, total: 4 });

    return {
      ...base,
      downloaded: true,
      rowsParsed: parsed.rows.length,
      rowsRejected: parsed.rejected.length,
      entitiesSeen: parsed.entities.length,
      hasDescriptionColumn: parsed.hasDescriptionColumn,
      ...written,
    };
  };
}

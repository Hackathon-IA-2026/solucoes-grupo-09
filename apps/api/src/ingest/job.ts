import type { Database } from "../database/connection.js";
import { UpstreamError } from "../errors.js";
import type { Execute } from "../jobs/index.js";
import {
  type CatalogueResource,
  fetchPackage,
  headResource,
  type ResourceFingerprint,
  selectResourceForYear,
} from "./ons/catalogue.js";
import { DATASET_SLUG, parseEnergyBalance } from "./ons/energy-balance.js";
import { writeEnergyBalance } from "./repository.js";
import { markResourceFetched, recordResourceVersion } from "./resource-version.js";

/**
 * The ingestion job for `balanco-energia-subsistema`, running on the job layer
 * the template already provides. No second scheduler.
 *
 * The order of operations is the point: discover the resource from the
 * catalogue, fingerprint it with a `HEAD`, stop there if nothing moved, and
 * only then spend a download. Every step is idempotent, so a retry after a
 * partial failure re-does work rather than corrupting it.
 */

/** One year of one dataset — the unit ONS actually publishes. */
export interface IngestEnergyBalancePayload {
  year: number;
  /** Re-download and re-diff even when the fingerprint is unchanged. */
  force?: boolean;
}

export interface IngestEnergyBalanceResult {
  resourceName: string;
  format: "PARQUET" | "CSV";
  /** False when the `HEAD` matched a fingerprint already on record. */
  changed: boolean;
  /** False when the job stopped at the `HEAD`. */
  downloaded: boolean;
  rowsParsed: number;
  rowsRejected: number;
  aggregateRowsFiltered: number;
  inserted: number;
  revised: number;
  unchanged: number;
}

export interface EnergyBalanceIngestorDeps {
  db: Database;
  /** Injected so the job is testable without the network. */
  fetch?: typeof fetch;
}

/**
 * Build the job handler. `Execute` is generic over payload and result, so this
 * plugs into either job backend without the job layer knowing anything about
 * ONS.
 */
export function createEnergyBalanceIngestor(
  deps: EnergyBalanceIngestorDeps,
): Execute<IngestEnergyBalancePayload, IngestEnergyBalanceResult> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (payload, report) => {
    const resources = await fetchPackage(DATASET_SLUG, fetchImpl);
    const resource = selectResourceForYear(resources, payload.year);
    report({ done: 1, total: 4 });

    const fingerprint = await headResource(resource.url, fetchImpl);
    const version = await recordResourceVersion(
      deps.db,
      DATASET_SLUG,
      resource,
      fingerprint,
    );
    report({ done: 2, total: 4 });

    const base = {
      resourceName: resource.name,
      format: resource.format,
      changed: !version.alreadySeen,
      rowsParsed: 0,
      rowsRejected: 0,
      aggregateRowsFiltered: 0,
      inserted: 0,
      revised: 0,
      unchanged: 0,
    };

    if (version.alreadySeen && !payload.force) {
      // The whole point of the HEAD: an unchanged file costs one request.
      return { ...base, downloaded: false };
    }

    const response = await fetchImpl(resource.url);
    if (!response.ok) {
      throw new UpstreamError(`GET ${resource.url} failed: HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    report({ done: 3, total: 4 });

    const parsed = await parseEnergyBalance(resource.format, bytes);

    await markResourceFetched(deps.db, version.id, bytes);

    const written = await writeEnergyBalance(deps.db, {
      rows: parsed.rows,
      // ONS stamps no row-level vintage on bulk files, so the file's
      // `Last-Modified` is the coarsest honest stamp available — and the row
      // says so rather than pretending to a precision it does not have.
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
      aggregateRowsFiltered: parsed.aggregateRowsFiltered,
      ...written,
    };
  };
}

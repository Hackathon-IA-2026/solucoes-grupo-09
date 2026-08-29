import type { Database } from "../database/connection.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { acquireBulkResource, BULK_STEPS } from "./bulk-resource.js";
import { selectResourceForYear } from "./ons/catalogue.js";
import { DATASET_SLUG, parseEnergyBalance } from "./ons/energy-balance.js";
import { writeEnergyBalance } from "./repository.js";
import type { ObservationContext } from "./resource-version.js";

/**
 * The ingestion job for `balanco-energia-subsistema`, running on the job layer
 * the template already provides. No second scheduler.
 *
 * Acquisition — catalogue, fingerprint, conditional download — is shared with
 * every other bulk dataset in `bulk-resource.ts`. What is left here is the two
 * things only this dataset knows: how to pick its resource, and how to parse
 * and persist it.
 */

/** One year of one dataset — the unit ONS actually publishes. */
export interface IngestEnergyBalancePayload {
  year: number;
  /** Re-download and re-diff even when the fingerprint is unchanged. */
  force?: boolean;
  /**
   * The sweep this run belongs to. Stamped on any re-publication the run
   * discovers, which is what makes "the history sweep found this" — the
   * evidence that a settled period was rewritten — a queryable fact.
   */
  context?: ObservationContext;
}

export interface IngestEnergyBalanceResult {
  resourceName: string;
  format: "PARQUET" | "CSV";
  changed: boolean;
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
  /**
   * Where raw payloads are retained. Absent means the payload is ingested and
   * not kept — correct for a test, and visible in the health view otherwise.
   */
  archive?: PayloadArchive;
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
    const acquired = await acquireBulkResource({
      db: deps.db,
      fetch: fetchImpl,
      slug: DATASET_SLUG,
      select: (resources) => selectResourceForYear(resources, payload.year),
      force: payload.force,
      archive: deps.archive,
      context: payload.context,
      report,
    });

    const base = {
      resourceName: acquired.resource.name,
      format: acquired.format,
      changed: acquired.changed,
      rowsParsed: 0,
      rowsRejected: 0,
      aggregateRowsFiltered: 0,
      inserted: 0,
      revised: 0,
      unchanged: 0,
    };

    if (!acquired.bytes) {
      // The whole point of the HEAD: an unchanged file costs one request.
      return { ...base, downloaded: false };
    }

    const parsed = await parseEnergyBalance(acquired.format, acquired.bytes);
    const written = await writeEnergyBalance(deps.db, {
      rows: parsed.rows,
      publishedAt: acquired.publishedAt,
      publishedAtPrecision: acquired.publishedAtPrecision,
      sourceVersionId: acquired.versionId,
    });
    report({ done: BULK_STEPS, total: BULK_STEPS });

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

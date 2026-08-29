import type { Database } from "../database/connection.js";
import { UpstreamError } from "../errors.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { acquireBulkResource, BULK_STEPS } from "./bulk-resource.js";
import { writeSubsystemExchange } from "./interchange-repository.js";
import { selectResourceForYear } from "./ons/catalogue.js";
import {
  INTERCHANGE_DATASET_SLUG,
  INTERCHANGE_FORMATS,
  parseInterchangeCsv,
} from "./ons/interchange.js";
import type { ObservationContext } from "./resource-version.js";

/**
 * The ingestion job for `intercambio-nacional`, on the job layer the template
 * already provides. No second scheduler.
 *
 * Acquisition — catalogue, fingerprint, conditional download — is shared with
 * every other bulk dataset in `bulk-resource.ts`, which matters more here than
 * elsewhere: **CKAN reports no `last_modified` for 15 of this dataset's 27 CSV
 * resources** (every year before 2012). Change detection still works, because
 * the authoritative detector was never CKAN's stamp — it is the S3 `HEAD`
 * triple, which every one of those files answers. What CKAN's null costs is only
 * the `published_at` fallback, and the `HEAD`'s own `Last-Modified` supplies
 * that too.
 */

/** One year of the dataset — the unit ONS actually publishes. */
export interface IngestInterchangePayload {
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

export interface IngestInterchangeResult {
  resourceName: string;
  format: "PARQUET" | "CSV";
  changed: boolean;
  downloaded: boolean;
  rowsParsed: number;
  rowsRejected: number;
  /** Whether this file carried `val_intercambioprogmwmed` at all. */
  hasProgrammedColumn: boolean;
  /** Rows ONS published in the reverse of the canonical orientation. */
  reorientedRows: number;
  inserted: number;
  revised: number;
  unchanged: number;
}

export interface InterchangeIngestorDeps {
  db: Database;
  /** Injected so the job is testable without the network. */
  fetch?: typeof fetch;
  /**
   * Where raw payloads are retained. Absent means the payload is ingested and
   * not kept — correct for a test, and visible in the health view otherwise.
   */
  archive?: PayloadArchive;
}

/** Build the job handler. */
export function createInterchangeIngestor(
  deps: InterchangeIngestorDeps,
): Execute<IngestInterchangePayload, IngestInterchangeResult> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (payload, report) => {
    const acquired = await acquireBulkResource({
      db: deps.db,
      fetch: fetchImpl,
      slug: INTERCHANGE_DATASET_SLUG,
      select: (resources) =>
        selectResourceForYear(resources, payload.year, INTERCHANGE_FORMATS),
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
      hasProgrammedColumn: false,
      reorientedRows: 0,
      inserted: 0,
      revised: 0,
      unchanged: 0,
    };

    if (!acquired.bytes) {
      // The whole point of the HEAD: an unchanged file costs one request.
      return { ...base, downloaded: false };
    }
    if (acquired.format !== "CSV") {
      // `INTERCHANGE_FORMATS` asks for CSV only, so this is unreachable unless
      // the catalogue starts answering something else — in which case failing
      // beats parsing Parquet bytes as text.
      throw new UpstreamError(
        `intercambio-nacional returned ${acquired.format}; only CSV is ingested`,
      );
    }

    const parsed = parseInterchangeCsv(new TextDecoder("utf-8").decode(acquired.bytes));
    const written = await writeSubsystemExchange(deps.db, {
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
      hasProgrammedColumn: parsed.hasProgrammedColumn,
      reorientedRows: parsed.reorientedRows,
      ...written,
    };
  };
}

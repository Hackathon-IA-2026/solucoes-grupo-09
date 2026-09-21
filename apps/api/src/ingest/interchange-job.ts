import type { Database } from "../database/connection.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { createBulkCsvIngestor } from "./bulk-csv-ingestor.js";
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

/**
 * Build the job handler.
 *
 * A spec, not a body — see `bulk-csv-ingestor.ts`. What is here is what makes
 * this one the interchange: the year's resource, the CSV, the exchange rows,
 * and the two facts it reports that no other source has.
 */
export function createInterchangeIngestor(
  deps: InterchangeIngestorDeps,
): Execute<IngestInterchangePayload, IngestInterchangeResult> {
  return createBulkCsvIngestor<
    IngestInterchangePayload,
    ReturnType<typeof parseInterchangeCsv>,
    { hasProgrammedColumn: boolean; reorientedRows: number }
  >(
    {
      slug: INTERCHANGE_DATASET_SLUG,
      source: "intercambio-nacional",
      select: (resources, payload) =>
        selectResourceForYear(resources, payload.year, INTERCHANGE_FORMATS),
      parse: parseInterchangeCsv,
      write: (db, parsed, version) =>
        writeSubsystemExchange(db, { rows: parsed.rows, ...version }),
      counted: (parsed) => ({
        parsed: parsed.rows.length,
        rejected: parsed.rejected.length,
      }),
      empty: { hasProgrammedColumn: false, reorientedRows: 0 },
      extra: (parsed) => ({
        hasProgrammedColumn: parsed.hasProgrammedColumn,
        reorientedRows: parsed.reorientedRows,
      }),
    },
    deps,
  );
}

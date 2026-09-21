import type { Database } from "../database/connection.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { createBulkCsvIngestor } from "./bulk-csv-ingestor.js";
import { writeSubsystemLoadDays } from "./daily-load-repository.js";
import { selectResourceForYear } from "./ons/catalogue.js";
import {
  DAILY_LOAD_DATASET_SLUG,
  DAILY_LOAD_FORMATS,
  parseDailyLoadCsv,
} from "./ons/daily-load.js";
import type { ObservationContext } from "./resource-version.js";
import type { LoadMethodologyRegime } from "./types.js";

/**
 * The ingestion job for `carga-energia` — daily load per subsystem.
 *
 * Acquisition is the shared bulk path; what this job adds to a run summary is
 * the two things an operator of *this* dataset needs to see: which methodology
 * regimes the year spanned, and how many of its days were not 24 hours long.
 */

/** One year of the dataset. */
export interface IngestDailyLoadPayload {
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

export interface IngestDailyLoadResult {
  resourceName: string;
  format: "PARQUET" | "CSV";
  changed: boolean;
  downloaded: boolean;
  rowsParsed: number;
  rowsRejected: number;
  /** Rows whose local day was 23 or 25 hours long. */
  irregularDays: number;
  /** The definitional regimes this year's rows were measured under. */
  regimes: LoadMethodologyRegime[];
  inserted: number;
  revised: number;
  unchanged: number;
}

export interface DailyLoadIngestorDeps {
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
 * A spec, not a body: the acquisition, the non-CSV refusal, the decode and the
 * `markIngested()`-after-write ordering are `bulk-csv-ingestor.ts`'s, shared
 * with every other bulk source. What is here is what makes this one the daily
 * load: which resource answers for a year, how its CSV parses, where its rows
 * go, and the two counters it reports beyond the shared four.
 */
export function createDailyLoadIngestor(
  deps: DailyLoadIngestorDeps,
): Execute<IngestDailyLoadPayload, IngestDailyLoadResult> {
  return createBulkCsvIngestor<
    IngestDailyLoadPayload,
    ReturnType<typeof parseDailyLoadCsv>,
    { irregularDays: number; regimes: LoadMethodologyRegime[] }
  >(
    {
      slug: DAILY_LOAD_DATASET_SLUG,
      source: "carga-energia",
      select: (resources, payload) =>
        selectResourceForYear(resources, payload.year, DAILY_LOAD_FORMATS),
      parse: parseDailyLoadCsv,
      write: (db, parsed, version) =>
        writeSubsystemLoadDays(db, { rows: parsed.rows, ...version }),
      counted: (parsed) => ({
        parsed: parsed.rows.length,
        rejected: parsed.rejected.length,
      }),
      empty: { irregularDays: 0, regimes: [] },
      extra: (parsed) => ({
        irregularDays: parsed.irregularDays,
        regimes: [...new Set(parsed.rows.map((row) => row.methodologyRegime))],
      }),
    },
    deps,
  );
}

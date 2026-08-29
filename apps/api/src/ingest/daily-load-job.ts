import type { Database } from "../database/connection.js";
import { UpstreamError } from "../errors.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { acquireBulkResource, BULK_STEPS } from "./bulk-resource.js";
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

/** Build the job handler. */
export function createDailyLoadIngestor(
  deps: DailyLoadIngestorDeps,
): Execute<IngestDailyLoadPayload, IngestDailyLoadResult> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (payload, report) => {
    const acquired = await acquireBulkResource({
      db: deps.db,
      fetch: fetchImpl,
      slug: DAILY_LOAD_DATASET_SLUG,
      select: (resources) =>
        selectResourceForYear(resources, payload.year, DAILY_LOAD_FORMATS),
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
      irregularDays: 0,
      regimes: [] as LoadMethodologyRegime[],
      inserted: 0,
      revised: 0,
      unchanged: 0,
    };

    if (!acquired.bytes) {
      return { ...base, downloaded: false };
    }
    if (acquired.format !== "CSV") {
      throw new UpstreamError(
        `carga-energia returned ${acquired.format}; only CSV is ingested`,
      );
    }

    const parsed = parseDailyLoadCsv(new TextDecoder("utf-8").decode(acquired.bytes));
    const written = await writeSubsystemLoadDays(deps.db, {
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
      irregularDays: parsed.irregularDays,
      regimes: [...new Set(parsed.rows.map((row) => row.methodologyRegime))],
      ...written,
    };
  };
}

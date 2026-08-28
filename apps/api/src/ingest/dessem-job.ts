import type { Database } from "../database/connection.js";
import type { Execute } from "../jobs/index.js";
import { acquireBulkResource } from "./bulk-resource.js";
import { writeDessemBalance } from "./dessem-repository.js";
import {
  availableResourceDays,
  type CatalogueResource,
  fetchPackage,
  selectResourceForDay,
} from "./ons/catalogue.js";
import {
  DESSEM_COVERAGE_START,
  DESSEM_DETAIL_DATASET_SLUG,
  parseDessemBalanceCsv,
} from "./ons/dessem-balance.js";

/**
 * Ingestion for the DESSEM day-ahead balance — the only **daily-split** source
 * in scope, and the first job whose unit of work is a *sweep* rather than a file.
 *
 * Every other bulk dataset publishes a file per year or per month, so "ingest
 * this period" and "fetch this resource" are the same sentence. Here one
 * reference day is one 17 kB file, there are ~460 of them and one more every
 * evening, and `package_show` for the dataset is 900 kB. So the shape inverts:
 * the catalogue is read **once** per run and handed to each acquisition, and
 * the payload is a date *range* whose default is the whole available history.
 *
 * What is not different is the per-file path: `HEAD` first, download only on a
 * changed fingerprint, append only what actually changed. A daily backfill
 * therefore costs ~460 `HEAD`s and no downloads once history is in.
 */

/** A range of reference days, defaulting to everything ONS has published. */
export interface IngestDessemPayload {
  /** `YYYY-MM-DD`, inclusive. Defaults to the coverage start, 2025-05-23. */
  from?: string;
  /** `YYYY-MM-DD`, inclusive. Defaults to the newest day in the catalogue. */
  to?: string;
  /** Re-download and re-diff even where the fingerprint is unchanged. */
  force?: boolean;
}

/** What one reference day did. */
export interface DessemDayResult {
  referenceDay: string;
  resourceName: string;
  changed: boolean;
  downloaded: boolean;
  rowsParsed: number;
  rowsRejected: number;
  inserted: number;
  revised: number;
  unchanged: number;
  /**
   * `valid_time − published_at` for the *earliest* half hour of the day — the
   * notice this forecast actually gave, and the number that decides whether
   * `gate_late` (D−1 19:00 BRT) can see it. Null when nothing was downloaded.
   */
  minLeadTimeMinutes: number | null;
}

export interface IngestDessemResult {
  /** Reference days the catalogue offers within the requested range. */
  daysAvailable: number;
  /** Days actually acquired — one `HEAD` each, at least. */
  daysProcessed: number;
  /** Days whose bytes were downloaded because the fingerprint moved. */
  daysDownloaded: number;
  rowsParsed: number;
  rowsRejected: number;
  inserted: number;
  revised: number;
  unchanged: number;
  /** The smallest lead time seen this run, across every day downloaded. */
  minLeadTimeMinutes: number | null;
  days: DessemDayResult[];
}

export interface DessemIngestorDeps {
  db: Database;
  /** Injected so the job is testable without the network. */
  fetch?: typeof fetch;
}

/**
 * CSV only, measured. The Parquet rendition of 2026-08-29 is 16 634 bytes
 * against the CSV's 17 236 — a 3.5% saving that does not pay for a second parse
 * path, let alone for re-importing the INT96 timestamp hazard.
 */
const FORMATS = ["CSV"] as const;

const MS_PER_MINUTE = 60_000;

export function createDessemIngestor(
  deps: DessemIngestorDeps,
): Execute<IngestDessemPayload, IngestDessemResult> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (payload, report) => {
    // One catalogue read for the whole sweep. `acquireBulkResource` would
    // otherwise fetch it per day: 460 × 900 kB to answer a question already
    // answered.
    const resources: CatalogueResource[] = await fetchPackage(
      DESSEM_DETAIL_DATASET_SLUG,
      fetchImpl,
    );
    const from = payload.from ?? DESSEM_COVERAGE_START;
    const to = payload.to;
    const days = availableResourceDays(resources, FORMATS).filter(
      (day) => day >= from && (to === undefined || day <= to),
    );

    const result: IngestDessemResult = {
      daysAvailable: days.length,
      daysProcessed: 0,
      daysDownloaded: 0,
      rowsParsed: 0,
      rowsRejected: 0,
      inserted: 0,
      revised: 0,
      unchanged: 0,
      minLeadTimeMinutes: null,
      days: [],
    };

    for (const [index, day] of days.entries()) {
      const [year, month, dayOfMonth] = day.split("-").map(Number) as [
        number,
        number,
        number,
      ];
      const acquired = await acquireBulkResource({
        db: deps.db,
        fetch: fetchImpl,
        slug: DESSEM_DETAIL_DATASET_SLUG,
        resources,
        select: (candidates) =>
          selectResourceForDay(candidates, year, month, dayOfMonth, FORMATS),
        force: payload.force,
      });

      result.daysProcessed += 1;
      const dayResult: DessemDayResult = {
        referenceDay: day,
        resourceName: acquired.resource.name,
        changed: acquired.changed,
        downloaded: acquired.bytes !== null,
        rowsParsed: 0,
        rowsRejected: 0,
        inserted: 0,
        revised: 0,
        unchanged: 0,
        minLeadTimeMinutes: null,
      };

      if (acquired.bytes) {
        result.daysDownloaded += 1;
        const parsed = parseDessemBalanceCsv(
          new TextDecoder("utf-8").decode(acquired.bytes),
        );
        const written = await writeDessemBalance(deps.db, {
          rows: parsed.rows,
          publishedAt: acquired.publishedAt,
          publishedAtPrecision: acquired.publishedAtPrecision,
          sourceVersionId: acquired.versionId,
        });

        const earliest = Math.min(...parsed.rows.map((row) => row.validTime.getTime()));
        dayResult.minLeadTimeMinutes = Math.round(
          (earliest - acquired.publishedAt.getTime()) / MS_PER_MINUTE,
        );
        dayResult.rowsParsed = parsed.rows.length;
        dayResult.rowsRejected = parsed.rejected.length;
        dayResult.inserted = written.inserted;
        dayResult.revised = written.revised;
        dayResult.unchanged = written.unchanged;

        result.rowsParsed += parsed.rows.length;
        result.rowsRejected += parsed.rejected.length;
        result.inserted += written.inserted;
        result.revised += written.revised;
        result.unchanged += written.unchanged;
        result.minLeadTimeMinutes =
          result.minLeadTimeMinutes === null
            ? dayResult.minLeadTimeMinutes
            : Math.min(result.minLeadTimeMinutes, dayResult.minLeadTimeMinutes);
      }

      result.days.push(dayResult);
      // Progress is per reference day, not per acquisition step: a sweep's unit
      // of work is the day, and 460 × 4 steps would say nothing more.
      report({ done: index + 1, total: days.length });
    }

    return result;
  };
}

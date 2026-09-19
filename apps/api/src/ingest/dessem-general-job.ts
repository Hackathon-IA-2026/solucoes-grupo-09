import type { Database } from "../database/connection.js";
import { payloadRefusal } from "../errors.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { acquireBulkResource } from "./bulk-resource.js";
import { writeDessemGeneral } from "./dessem-general-repository.js";
import type { DessemRefusal } from "./dessem-job.js";
import {
  availableResourceDays,
  type CatalogueResource,
  fetchPackage,
  selectResourceForDay,
} from "./ons/catalogue.js";
import {
  DESSEM_GENERAL_COVERAGE_START,
  DESSEM_GENERAL_DATASET_SLUG,
  parseDessemGeneralCsv,
} from "./ons/dessem-general.js";
import type { ObservationContext } from "./resource-version.js";

/**
 * Ingestion for `balanco_dessem_geral` — a daily-split sweep, shaped like
 * `dessem-job.ts` and for the same reasons: one reference day is one small file,
 * the catalogue is read **once** per run and handed to each acquisition, and a
 * refused day is isolated to that day rather than taking the sweep with it.
 *
 * **What is not there is the partial-day branch.** The detalhe job counts days
 * ONS published short and stores them with their shortfall stated. This adapter
 * refuses a short day (`coverage`), because the file has nothing that pins its
 * period index, so a short day here is simply a refusal and the sweep reports it
 * as one — `daysPartial` would always be zero and is not carried.
 *
 * Everything else a run can say is the same: `daysStandingRefused` distinguishes
 * bytes refused today from bytes an earlier pass already refused, so a
 * legitimately-refused day costs one `HEAD` and is still reported.
 */

/** A range of reference days, defaulting to everything ONS has published. */
export interface IngestDessemGeneralPayload {
  /** `YYYY-MM-DD`, inclusive. Defaults to the coverage start, 2025-05-23. */
  from?: string;
  /** `YYYY-MM-DD`, inclusive. Defaults to the newest day in the catalogue. */
  to?: string;
  /** Re-download and re-diff even where the fingerprint is unchanged. */
  force?: boolean;
  /** The sweep this run belongs to, stamped on any re-publication it finds. */
  context?: ObservationContext;
}

/** What one reference day did. */
export interface DessemGeneralDayResult {
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
   * notice this forecast gave. Null when nothing was downloaded.
   */
  minLeadTimeMinutes: number | null;
  /** Set when this day's payload was refused. Null when it loaded or was skipped. */
  refusal: { reason: string; detail: string } | null;
}

export interface IngestDessemGeneralResult {
  /** Reference days the catalogue offers within the requested range. */
  daysAvailable: number;
  /** Days actually acquired — one `HEAD` each, at least. */
  daysProcessed: number;
  /** Days whose bytes were downloaded because the fingerprint moved. */
  daysDownloaded: number;
  /** Days this run parsed and wrote. */
  daysIngested: number;
  /** Days this run downloaded and refused. */
  daysRefused: number;
  /** Days skipped because a previous pass had already refused these bytes. */
  daysStandingRefused: number;
  rowsParsed: number;
  rowsRejected: number;
  inserted: number;
  revised: number;
  unchanged: number;
  /** The smallest lead time seen this run, across every day downloaded. */
  minLeadTimeMinutes: number | null;
  days: DessemGeneralDayResult[];
  /** Every day this sweep could not load, with its reason. */
  refusals: DessemRefusal[];
}

export interface DessemGeneralIngestorDeps {
  db: Database;
  /** Injected so the job is testable without the network. */
  fetch?: typeof fetch;
  /** Where raw payloads are retained. Absent means ingested and not kept. */
  archive?: PayloadArchive;
}

/** CSV only — the detalhe job measured what a second parse path costs. */
const FORMATS = ["CSV"] as const;

const MS_PER_MINUTE = 60_000;

export function createDessemGeneralIngestor(
  deps: DessemGeneralIngestorDeps,
): Execute<IngestDessemGeneralPayload, IngestDessemGeneralResult> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (payload, report) => {
    const resources: CatalogueResource[] = await fetchPackage(
      DESSEM_GENERAL_DATASET_SLUG,
      fetchImpl,
    );
    const from = payload.from ?? DESSEM_GENERAL_COVERAGE_START;
    const to = payload.to;
    const days = availableResourceDays(resources, FORMATS).filter(
      (day) => day >= from && (to === undefined || day <= to),
    );

    const result: IngestDessemGeneralResult = {
      daysAvailable: days.length,
      daysProcessed: 0,
      daysDownloaded: 0,
      daysIngested: 0,
      daysRefused: 0,
      daysStandingRefused: 0,
      rowsParsed: 0,
      rowsRejected: 0,
      inserted: 0,
      revised: 0,
      unchanged: 0,
      minLeadTimeMinutes: null,
      days: [],
      refusals: [],
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
        slug: DESSEM_GENERAL_DATASET_SLUG,
        resources,
        select: (candidates) =>
          selectResourceForDay(candidates, year, month, dayOfMonth, FORMATS),
        force: payload.force,
        archive: deps.archive,
        context: payload.context,
      });

      result.daysProcessed += 1;
      const dayResult: DessemGeneralDayResult = {
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
        refusal: null,
      };

      if (acquired.bytes) {
        result.daysDownloaded += 1;
        try {
          const parsed = parseDessemGeneralCsv(
            new TextDecoder("utf-8").decode(acquired.bytes),
          );
          const written = await writeDessemGeneral(deps.db, {
            rows: parsed.rows,
            publishedAt: acquired.publishedAt,
            publishedAtPrecision: acquired.publishedAtPrecision,
            firstPublishedAt: acquired.firstPublishedAt,
            sourceVersionId: acquired.versionId,
          });
          // Only now is the resource version a day that loaded: before this
          // call it is bytes in custody and nothing more, which is what makes a
          // throw above retryable rather than permanent.
          await acquired.markIngested();
          result.daysIngested += 1;

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
        } catch (error) {
          const refused = payloadRefusal(error);
          if (!refused) {
            // Not a fact about these bytes — a socket, a migration, a bug.
            // Nothing is marked, so the day is retried, and it takes the task
            // with it: a run that hit this is not a healthy run.
            throw error;
          }
          await acquired.markRefused(refused);
          result.daysRefused += 1;
          dayResult.refusal = { reason: refused.refusal, detail: refused.message };
          result.refusals.push({
            referenceDay: day,
            resourceName: acquired.resource.name,
            reason: refused.refusal,
            detail: refused.message,
            refusedThisRun: true,
          });
        }
      } else if (acquired.refusal) {
        // Settled as refused by an earlier pass: one `HEAD`, no download, and
        // still reported, so a legitimately-refused day stays out of a hot loop
        // without being hidden.
        result.daysStandingRefused += 1;
        dayResult.refusal = {
          reason: acquired.refusal.reason,
          detail: acquired.refusal.detail ?? "",
        };
        result.refusals.push({
          referenceDay: day,
          resourceName: acquired.resource.name,
          reason: acquired.refusal.reason,
          detail: acquired.refusal.detail ?? "",
          refusedThisRun: false,
        });
      }

      result.days.push(dayResult);
      report({ done: index + 1, total: days.length });
    }

    return result;
  };
}

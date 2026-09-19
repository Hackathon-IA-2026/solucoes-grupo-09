import type { Database } from "../database/connection.js";
import { payloadRefusal } from "../errors.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { acquireBulkResource, type BulkResource } from "./bulk-resource.js";
import { type DelimitedTable, parseDelimited } from "./csv.js";
import type { DessemRefusal } from "./dessem-job.js";
import {
  availableResourceDays,
  type CatalogueResource,
  fetchPackage,
  selectResourceForDay,
} from "./ons/catalogue.js";
import { PROGRAMME_COVERAGE_START } from "./ons/programme-daily.js";
import { readProgrammeParquet } from "./ons/programme-parquet.js";
import type { ObservationContext } from "./resource-version.js";
import type { VersionedWriteResult } from "./versioned-write.js";

/**
 * The daily-split sweep the three programme ingestors share.
 *
 * It is `dessem-general-job.ts`'s loop, written once: the catalogue is read
 * **once** per run and handed to each acquisition, a refused day is isolated to
 * that day, and `markIngested` is called only after the write so that a throw is
 * a retry and never a day that silently never arrived. What differs between the
 * three datasets is one step — parse these bytes and write these rows — and that
 * is the `process` callback.
 *
 * Kept out of the three job files because the alternative is three copies of the
 * refusal bookkeeping, and the refusal bookkeeping is exactly the part that must
 * not disagree between sources: `daysStandingRefused` distinguishes bytes
 * refused today from bytes an earlier pass already refused, so a
 * legitimately-refused day costs one `HEAD` and is still reported.
 */

export interface ProgrammeSweepPayload {
  /** `YYYY-MM-DD`, inclusive. Defaults to the coverage start, 2024-10-01. */
  from?: string;
  /** `YYYY-MM-DD`, inclusive. Defaults to the newest day in the catalogue. */
  to?: string;
  /** Re-download and re-diff even where the fingerprint is unchanged. */
  force?: boolean;
  /** The sweep this run belongs to, stamped on any re-publication it finds. */
  context?: ObservationContext;
}

export interface ProgrammeDayResult {
  referenceDay: string;
  resourceName: string;
  changed: boolean;
  downloaded: boolean;
  rowsParsed: number;
  rowsRejected: number;
  inserted: number;
  revised: number;
  unchanged: number;
  refusal: { reason: string; detail: string } | null;
}

export interface ProgrammeSweepResult {
  daysAvailable: number;
  daysProcessed: number;
  daysDownloaded: number;
  daysIngested: number;
  daysRefused: number;
  daysStandingRefused: number;
  rowsParsed: number;
  rowsRejected: number;
  inserted: number;
  revised: number;
  unchanged: number;
  days: ProgrammeDayResult[];
  refusals: DessemRefusal[];
  /** Counters only the ingestor that owns them can name — the PDP crosswalk's, for one. */
  extra: Record<string, number>;
  /**
   * Findings worth reading in full, each prefixed with its reference day and
   * capped at `MAX_NOTES` so a pathological run cannot make the result unbounded.
   * A counter says a PDP code conflicted; this says which.
   */
  notes: string[];
}

const MAX_NOTES = 50;

export interface ProgrammeIngestorDeps {
  db: Database;
  /** Injected so the job is testable without the network. */
  fetch?: typeof fetch;
  /** Where raw payloads are retained. Absent means ingested and not kept. */
  archive?: PayloadArchive;
}

/** What a processor reports for the day it just wrote. */
export interface ProgrammeDayWork {
  rowsParsed: number;
  rowsRejected: number;
  written: VersionedWriteResult;
  extra?: Record<string, number>;
  /** Things an operator should be able to read rather than count — a conflicting PDP code, say. */
  notes?: string[];
}

export interface ProgrammeSweepSpec {
  slug: string;
  /** The file name's own prefix — keeps a stray resource out of the selection. */
  filePrefix: string;
  /**
   * Parse the day's bytes and write them. **Must not** call `markIngested`: the
   * sweep does, after this returns, and a processor that marked early would
   * bring back the day of history that never arrives and never complains.
   */
  process: (
    acquired: BulkResource & { bytes: ArrayBuffer },
    day: string,
    resources: CatalogueResource[],
  ) => Promise<ProgrammeDayWork>;
}

/**
 * CSV preferred, Parquet where a day exists only as Parquet — 18 days across the
 * three datasets, which a CSV-only sweep would never have seen. See
 * `ons/programme-parquet.ts`.
 */
export const PROGRAMME_FORMATS = ["CSV", "PARQUET"] as const;
const FORMATS = PROGRAMME_FORMATS;

/** A day's bytes as a table, whichever rendition ONS published it in. */
export async function programmeTable(acquired: {
  format: "CSV" | "PARQUET";
  bytes: ArrayBuffer;
}): Promise<DelimitedTable> {
  return acquired.format === "PARQUET"
    ? readProgrammeParquet(acquired.bytes)
    : parseDelimited(new TextDecoder("utf-8").decode(acquired.bytes));
}

export function createProgrammeSweep(
  deps: ProgrammeIngestorDeps,
  spec: ProgrammeSweepSpec,
): Execute<ProgrammeSweepPayload, ProgrammeSweepResult> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (payload, report) => {
    const resources = await fetchPackage(spec.slug, fetchImpl);
    const from = payload.from ?? PROGRAMME_COVERAGE_START;
    const days = availableResourceDays(resources, FORMATS, spec.filePrefix).filter(
      (day) => day >= from && (payload.to === undefined || day <= payload.to),
    );

    const result: ProgrammeSweepResult = {
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
      days: [],
      refusals: [],
      extra: {},
      notes: [],
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
        slug: spec.slug,
        resources,
        select: (candidates) =>
          selectResourceForDay(
            candidates,
            year,
            month,
            dayOfMonth,
            FORMATS,
            spec.filePrefix,
          ),
        force: payload.force,
        archive: deps.archive,
        context: payload.context,
      });

      result.daysProcessed += 1;
      const dayResult: ProgrammeDayResult = {
        referenceDay: day,
        resourceName: acquired.resource.name,
        changed: acquired.changed,
        downloaded: acquired.bytes !== null,
        rowsParsed: 0,
        rowsRejected: 0,
        inserted: 0,
        revised: 0,
        unchanged: 0,
        refusal: null,
      };

      if (acquired.bytes) {
        result.daysDownloaded += 1;
        try {
          const work = await spec.process(
            acquired as BulkResource & { bytes: ArrayBuffer },
            day,
            resources,
          );
          // Only now is the resource version a day that loaded: before this call
          // it is bytes in custody and nothing more, which is what makes a throw
          // above retryable rather than permanent.
          await acquired.markIngested();
          result.daysIngested += 1;

          dayResult.rowsParsed = work.rowsParsed;
          dayResult.rowsRejected = work.rowsRejected;
          dayResult.inserted = work.written.inserted;
          dayResult.revised = work.written.revised;
          dayResult.unchanged = work.written.unchanged;
          result.rowsParsed += work.rowsParsed;
          result.rowsRejected += work.rowsRejected;
          result.inserted += work.written.inserted;
          result.revised += work.written.revised;
          result.unchanged += work.written.unchanged;
          for (const [key, value] of Object.entries(work.extra ?? {})) {
            result.extra[key] = (result.extra[key] ?? 0) + value;
          }
          for (const note of work.notes ?? []) {
            if (result.notes.length < MAX_NOTES) {
              result.notes.push(`${day}: ${note}`);
            }
          }
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

/**
 * Acquire one bulk ONS CSV, decode it, parse it, write it, and settle it.
 *
 * ## Why this exists
 *
 * Four job modules carried the same body. Diffed, `daily-load-job.ts` and
 * `interchange-job.ts` were 62 and 66 lines with **28 lines differing**, and the
 * differences were five names: the slug, the period selector, the source's name
 * in one refusal, the parser and the writer. The skeleton between them was
 * identical, step for step:
 *
 *     acquire → zeroed base → return early if nothing downloaded
 *             → refuse a non-CSV format → decode UTF-8 → parse
 *             → write → markIngested() → report BULK_STEPS
 *
 * `new TextDecoder("utf-8").decode(...)` appeared in five files, identically.
 *
 * ## The ordering this protects, which has already been got wrong once
 *
 * `bulk-resource.ts`'s header records the incident: a parse that threw left the
 * resource **marked ingested**, and the task then reported
 * `changed: false, inserted: 0` for ever after — a source that had silently
 * stopped ingesting while every run looked clean. The rule is that
 * `markIngested()` happens **after** the write resolves and never before, and it
 * was restated by hand in every job file. It is one line here, and a sixth bulk
 * source cannot get it wrong by copying 60 lines and losing the order.
 *
 * ## The shape
 *
 * This is the pattern `ingest/versioned-write.ts` already proved one layer
 * down, where `VersionedTableSpec` turned nine repositories into data. The same
 * move, one layer up: a spec per source, one body for all of them.
 *
 * What a source still owns is everything that makes it that source — which
 * resource of the catalogue answers for a given payload, how its CSV parses,
 * where its rows are written, and the counters it reports beyond the shared
 * four. What it no longer owns is the order of operations.
 */

import type { Database } from "../database/connection.js";
import { UpstreamError } from "../errors.js";
import type { ReportProgress } from "../jobs/types.js";
import type { PayloadArchive } from "./archive.js";
import { acquireBulkResource, BULK_STEPS } from "./bulk-resource.js";
import type { CatalogueResource, ResourceFormat } from "./ons/catalogue.js";
import type { ObservationContext } from "./resource-version.js";

/** What every bulk write returns, whatever the source. */
export interface WrittenCounts {
  readonly inserted: number;
  readonly revised: number;
  readonly unchanged: number;
}

/** The fields every bulk job reports, before its own are added. */
export interface BulkBase extends WrittenCounts {
  readonly resourceName: string;
  readonly format: ResourceFormat;
  readonly changed: boolean;
  readonly rowsParsed: number;
  readonly rowsRejected: number;
}

/**
 * One source, as data.
 *
 * `TPayload` is the job's own payload — the year, the period, the range — and
 * only `select` reads it, because choosing which file answers for a period is
 * the one part of acquisition that is genuinely per-source.
 */
export interface BulkCsvSpec<TPayload, TParsed, TExtra> {
  /**
   * The CKAN dataset slug, or how to derive it.
   *
   * A function because `constrained-off` picks its dataset by technology: wind
   * and solar are two slugs answering one job.
   */
  readonly slug: string | ((payload: TPayload) => string);
  /**
   * The dataset's name as the refusal should say it. A reader who sees
   * "returned PARQUET" needs to know which of a dozen sources did.
   */
  readonly source: string;
  /** Which resource of the catalogue answers for this payload. */
  readonly select: (
    resources: CatalogueResource[],
    payload: TPayload,
  ) => CatalogueResource;
  /** The payload travels too: `constrained-off` parses differently per technology. */
  readonly parse: (text: string, payload: TPayload) => TParsed;
  /**
   * Write what was parsed, and own the order of doing it.
   *
   * Handed the **whole** parsed result rather than its rows, because a source
   * may have to write more than one thing and the order can matter:
   * `constrained-off` upserts its reporting entities first, since the fact
   * table has a foreign key to them and a month can introduce a conjunto that
   * has never been settled against before. That ordering is domain knowledge
   * and belongs at the source, not in a hook this module would have to invent.
   *
   * It may also return counters of its own, for a source that only learns them
   * by writing: `constrained-off-detail` reconciles plant identity after the
   * fact rows land, and reports what that linked. Those win over `extra`'s,
   * which is the correct precedence — one is derived from the parse, the other
   * from what actually happened.
   */
  readonly write: (
    db: Database,
    parsed: TParsed,
    version: {
      publishedAt: Date;
      publishedAtPrecision: "file";
      sourceVersionId: string;
    },
  ) => Promise<WrittenCounts & Partial<TExtra>>;
  /** Rows parsed and rows rejected, read off whatever shape `parse` returns. */
  readonly counted: (parsed: TParsed) => { parsed: number; rejected: number };
  /** This source's own counters, zeroed — the shape of the `downloaded: false` answer. */
  readonly empty: TExtra;
  /** This source's own counters, filled, once there is something to count. */
  readonly extra: (parsed: TParsed) => TExtra;
}

export interface BulkCsvDeps {
  readonly db: Database;
  readonly fetch?: typeof fetch;
  readonly archive?: PayloadArchive;
}

/** What a bulk job is handed on every call. */
interface BulkPayload {
  readonly force?: boolean;
  readonly context?: ObservationContext;
}

/**
 * Build the handler for one bulk CSV source.
 *
 * The `downloaded: false` return is the common case and the whole reason the
 * `HEAD` happens first: an unchanged file costs one request.
 */
export function createBulkCsvIngestor<
  TPayload extends BulkPayload,
  TParsed,
  TExtra extends object,
>(
  spec: BulkCsvSpec<TPayload, TParsed, TExtra>,
  deps: BulkCsvDeps,
): (
  payload: TPayload,
  report: ReportProgress,
) => Promise<BulkBase & TExtra & { downloaded: boolean }> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (payload, report) => {
    const acquired = await acquireBulkResource({
      db: deps.db,
      fetch: fetchImpl,
      slug: typeof spec.slug === "string" ? spec.slug : spec.slug(payload),
      select: (resources) => spec.select(resources, payload),
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
      inserted: 0,
      revised: 0,
      unchanged: 0,
      ...spec.empty,
    };

    if (!acquired.bytes) {
      return { ...base, downloaded: false };
    }
    if (acquired.format !== "CSV") {
      // Every spec asks the catalogue for CSV, so this is unreachable unless
      // the catalogue starts answering something else — in which case failing
      // beats parsing Parquet bytes as text.
      throw new UpstreamError(
        `${spec.source} returned ${acquired.format}; only CSV is ingested`,
      );
    }

    const parsed = spec.parse(new TextDecoder("utf-8").decode(acquired.bytes), payload);
    const written = await spec.write(deps.db, parsed, {
      publishedAt: acquired.publishedAt,
      publishedAtPrecision: acquired.publishedAtPrecision,
      sourceVersionId: acquired.versionId,
    });
    /*
      **After the write resolves, never before.** A parse or a write that threw
      used to leave the resource marked ingested, and the task then reported
      `changed: false, inserted: 0` for ever — a source that had stopped
      ingesting while every run looked clean. See `bulk-resource.ts`'s header
      for the incident. One line, one place.
    */
    await acquired.markIngested();
    report({ done: BULK_STEPS, total: BULK_STEPS });

    const counts = spec.counted(parsed);
    return {
      ...base,
      downloaded: true,
      rowsParsed: counts.parsed,
      rowsRejected: counts.rejected,
      ...spec.extra(parsed),
      ...written,
    };
  };
}

import type { Database } from "../database/connection.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { acquireBulkResource, BULK_STEPS } from "./bulk-resource.js";
import { upsertReportingEntities, writeCurtailment } from "./curtailment-repository.js";
import { type CatalogueResource, selectResourceForMonth } from "./ons/catalogue.js";
import {
  parseConstrainedOffCsv,
  SOLAR_DATASET_SLUG,
  WIND_DATASET_SLUG,
} from "./ons/constrained-off.js";
import type { ObservationContext } from "./resource-version.js";
import type { Technology } from "./types.js";

/**
 * Ingestion for the entity-grain constrained-off datasets, one month at a time
 * — the unit ONS publishes.
 *
 * Acquisition is shared with every other bulk dataset (`bulk-resource.ts`).
 * The conditional-download policy it implements matters more here than
 * anywhere else, because ONS rewrites closed months of this dataset years
 * after the fact — the whole of 2025 was restated in 2026 — so a sweep over
 * closed history has to be cheap enough to run often.
 */

/** One month of one technology. */
export interface IngestConstrainedOffPayload {
  technology: Technology;
  year: number;
  /** 1–12. */
  month: number;
  /** Re-download and re-diff even when the fingerprint is unchanged. */
  force?: boolean;
  /**
   * The sweep this run belongs to. Stamped on any re-publication the run
   * discovers, which is what makes "the history sweep found this" — the
   * evidence that a settled period was rewritten — a queryable fact.
   */
  context?: ObservationContext;
}

export interface IngestConstrainedOffResult {
  resourceName: string;
  changed: boolean;
  downloaded: boolean;
  rowsParsed: number;
  rowsRejected: number;
  entitiesSeen: number;
  /** Whether this file carried `dsc_restricao` at all. */
  hasDescriptionColumn: boolean;
  inserted: number;
  revised: number;
  unchanged: number;
}

export interface ConstrainedOffIngestorDeps {
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
 * CSV first, deliberately.
 *
 * Parquet is roughly a tenth the bytes, but it does not cover the full wind
 * history — the adapter is written against the rendition that always exists,
 * and the size win is not worth a silent hole in 2021–2023.
 */
const FORMATS = ["CSV"] as const;

const slugFor = (technology: Technology): string =>
  technology === "WIND" ? WIND_DATASET_SLUG : SOLAR_DATASET_SLUG;

export function createConstrainedOffIngestor(
  deps: ConstrainedOffIngestorDeps,
): Execute<IngestConstrainedOffPayload, IngestConstrainedOffResult> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (payload, report) => {
    const slug = slugFor(payload.technology);
    const acquired = await acquireBulkResource({
      db: deps.db,
      fetch: fetchImpl,
      slug,
      select: (resources: CatalogueResource[]) =>
        selectResourceForMonth(resources, payload.year, payload.month, FORMATS),
      force: payload.force,
      archive: deps.archive,
      context: payload.context,
      report,
    });

    const base = {
      resourceName: acquired.resource.name,
      changed: acquired.changed,
      rowsParsed: 0,
      rowsRejected: 0,
      entitiesSeen: 0,
      hasDescriptionColumn: false,
      inserted: 0,
      revised: 0,
      unchanged: 0,
    };

    if (!acquired.bytes) {
      return { ...base, downloaded: false };
    }

    const parsed = parseConstrainedOffCsv(
      new TextDecoder("utf-8").decode(acquired.bytes),
      payload.technology,
    );

    // Entities first: the fact table has a foreign key to them, and a month can
    // introduce a conjunto that has never been settled against before.
    await upsertReportingEntities(deps.db, parsed.entities);

    const written = await writeCurtailment(deps.db, {
      rows: parsed.rows,
      publishedAt: acquired.publishedAt,
      publishedAtPrecision: acquired.publishedAtPrecision,
      sourceVersionId: acquired.versionId,
    });
    await acquired.markIngested();
    report({ done: BULK_STEPS, total: BULK_STEPS });

    return {
      ...base,
      downloaded: true,
      rowsParsed: parsed.rows.length,
      rowsRejected: parsed.rejected.length,
      entitiesSeen: parsed.entities.length,
      hasDescriptionColumn: parsed.hasDescriptionColumn,
      ...written,
    };
  };
}

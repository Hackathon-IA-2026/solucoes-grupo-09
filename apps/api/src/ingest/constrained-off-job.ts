import type { Database } from "../database/connection.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { createBulkCsvIngestor } from "./bulk-csv-ingestor.js";
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

/**
 * Build the job handler.
 *
 * A spec, not a body — see `bulk-csv-ingestor.ts`. Two things here are this
 * source's own and are why the spec takes them as functions: the dataset is
 * chosen **by technology** (wind and solar are two slugs answering one job),
 * and `write` owns its own ordering, because the fact table has a foreign key
 * to the reporting entities and a month can introduce a conjunto that has never
 * been settled against before.
 */
export function createConstrainedOffIngestor(
  deps: ConstrainedOffIngestorDeps,
): Execute<IngestConstrainedOffPayload, IngestConstrainedOffResult> {
  return createBulkCsvIngestor<
    IngestConstrainedOffPayload,
    ReturnType<typeof parseConstrainedOffCsv>,
    { entitiesSeen: number; hasDescriptionColumn: boolean }
  >(
    {
      slug: (payload) => slugFor(payload.technology),
      source: "restricao-coff",
      select: (resources, payload) =>
        selectResourceForMonth(resources, payload.year, payload.month, FORMATS),
      parse: (text, payload) => parseConstrainedOffCsv(text, payload.technology),
      write: async (db, parsed, version) => {
        // Entities first: the fact table has a foreign key to them, and a month
        // can introduce a conjunto that has never been settled against before.
        await upsertReportingEntities(db, parsed.entities);
        return writeCurtailment(db, { rows: parsed.rows, ...version });
      },
      counted: (parsed) => ({
        parsed: parsed.rows.length,
        rejected: parsed.rejected.length,
      }),
      empty: { entitiesSeen: 0, hasDescriptionColumn: false },
      extra: (parsed) => ({
        entitiesSeen: parsed.entities.length,
        hasDescriptionColumn: parsed.hasDescriptionColumn,
      }),
    },
    deps,
  );
}

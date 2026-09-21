import type { Database } from "../database/connection.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { createBulkCsvIngestor } from "./bulk-csv-ingestor.js";
import { type CatalogueResource, selectResourceForMonth } from "./ons/catalogue.js";
import {
  parseConstrainedOffDetailCsv,
  SOLAR_DETAIL_DATASET_SLUG,
  WIND_DETAIL_DATASET_SLUG,
} from "./ons/constrained-off-detail.js";
import {
  reconcilePlantIdentity,
  upsertObservedPlants,
  writePlantDetail,
} from "./plant-detail-repository.js";
import type { ObservationContext } from "./resource-version.js";
import type { Technology } from "./types.js";

/**
 * Ingestion for the plant-grain constrained-off datasets, one month at a time —
 * the unit ONS publishes.
 *
 * Acquisition is shared with every other bulk dataset (`bulk-resource.ts`), and
 * the conditional-download policy matters more here than anywhere: these are
 * the largest files in scope by an order of magnitude — 171 MB for one month of
 * wind, against 29 MB for the entity-grain file of the same month — and ONS
 * rewrites closed months of them years after the fact.
 *
 * **Coverage differs by technology and is not a bug to chase**: wind reaches
 * back to 2021-10, solar only to 2024-04. A solar month before that has no
 * resource, and the catalogue selector says so rather than returning an empty
 * file.
 */

/** One month of one technology. */
export interface IngestConstrainedOffDetailPayload {
  technology: Technology;
  year: number;
  /** 1–12. */
  month: number;
  /** Re-download and re-diff even when the fingerprint is unchanged. */
  force?: boolean;
  /**
   * The sweep this run belongs to. Stamped on any re-publication the run
   * discovers, which is what makes "the history sweep found this" — the
   * evidence that a settled period was rewritten — a queryable fact. It matters
   * more here than at the entity grain: these are the files ONS rewrites years
   * later and the largest in scope, so an overwrite is both likelier and more
   * expensive to have missed.
   */
  context?: ObservationContext;
}

export interface IngestConstrainedOffDetailResult {
  resourceName: string;
  changed: boolean;
  downloaded: boolean;
  rowsParsed: number;
  rowsRejected: number;
  plantsSeen: number;
  /** Rows where a conjunto was named without the plant being Tipo II-C. */
  modalityConjuntoMismatches: number;
  inserted: number;
  revised: number;
  unchanged: number;
  /** Plants this file put both an `id_ons` and a CEG on, linked into `plant`. */
  linkedRegistryPlants: number;
  /** ONS codes whose identity the entity grain disagrees about. Expected: 0. */
  identityConflicts: number;
}

export interface ConstrainedOffDetailIngestorDeps {
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
 * CSV first, deliberately — same reasoning as the entity grain, and stronger.
 *
 * Parquet is a sixteenth of the bytes here (10 MB against 171 MB) but starts
 * 2023-01 for wind against the CSV's 2021-10. Ingesting one rendition for
 * recent years and another for the history is how a schema difference becomes
 * invisible, so the format that always exists is the one used throughout.
 */
const FORMATS = ["CSV"] as const;

const slugFor = (technology: Technology): string =>
  technology === "WIND" ? WIND_DETAIL_DATASET_SLUG : SOLAR_DETAIL_DATASET_SLUG;

/**
 * Build the job handler.
 *
 * A spec, not a body — see `bulk-csv-ingestor.ts`. Three things stay here
 * because they are what makes this the plant-detail source: the dataset is
 * chosen by technology, and `write` owns both an ordering and a consequence —
 * plants before facts, because of the foreign key, and the identity
 * reconciliation afterwards, because this is the only dataset that names a
 * plant by both identifiers and so is the only place that can do it.
 */
export function createConstrainedOffDetailIngestor(
  deps: ConstrainedOffDetailIngestorDeps,
): Execute<IngestConstrainedOffDetailPayload, IngestConstrainedOffDetailResult> {
  return createBulkCsvIngestor<
    IngestConstrainedOffDetailPayload,
    ReturnType<typeof parseConstrainedOffDetailCsv>,
    {
      plantsSeen: number;
      modalityConjuntoMismatches: number;
      linkedRegistryPlants: number;
      identityConflicts: number;
    }
  >(
    {
      slug: (payload) => slugFor(payload.technology),
      source: "restricao-coff-detail",
      select: (resources, payload) =>
        selectResourceForMonth(resources, payload.year, payload.month, FORMATS),
      parse: (text, payload) => parseConstrainedOffDetailCsv(text, payload.technology),
      write: async (db, parsed, version) => {
        // Plants first: the fact table has a foreign key to them, and a month
        // can introduce a plant that has never been measured before.
        await upsertObservedPlants(db, parsed.plants);
        const written = await writePlantDetail(db, { rows: parsed.rows, ...version });
        // This dataset is the only one that names a plant by both identifiers,
        // so reconciliation belongs to its ingest rather than to a later batch
        // job — and it happens before the resource is settled, as it did.
        const identity = await reconcilePlantIdentity(db);
        return {
          ...written,
          linkedRegistryPlants: identity.linkedRegistryPlants,
          identityConflicts: identity.conflicts.length,
        };
      },
      counted: (parsed) => ({
        parsed: parsed.rows.length,
        rejected: parsed.rejected.length,
      }),
      empty: {
        plantsSeen: 0,
        modalityConjuntoMismatches: 0,
        linkedRegistryPlants: 0,
        identityConflicts: 0,
      },
      extra: (parsed) => ({
        plantsSeen: parsed.plants.length,
        modalityConjuntoMismatches: parsed.modalityConjuntoMismatches,
        linkedRegistryPlants: 0,
        identityConflicts: 0,
      }),
    },
    deps,
  );
}

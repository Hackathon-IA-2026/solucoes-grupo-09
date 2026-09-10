import type { Database } from "../database/connection.js";
import type { Execute } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { acquireBulkResource } from "./bulk-resource.js";
import { selectSingleResource } from "./ons/catalogue.js";
import {
  CONJUNTO_DATASET_SLUG,
  parseConjuntoMembershipCsv,
} from "./ons/conjunto-membership.js";
import { CAPACITY_DATASET_SLUG, parseCapacityRegistryCsv } from "./ons/plant-registry.js";
import {
  linkPlantOnsCodes,
  upsertConjuntos,
  upsertPlants,
  writeConjuntoMemberships,
  writeGeneratingUnits,
} from "./registry-repository.js";
import type { ObservationContext } from "./resource-version.js";

/**
 * Ingestion for the ONS fleet registry: `capacidade-geracao` and
 * `usina_conjunto`, in one run.
 *
 * **One job for two datasets, deliberately.** They are two halves of a single
 * snapshot and neither is complete alone: capacity has no ONS plant code (the
 * live file has no `id_ons` column), the bridge has no capacity, and the link
 * between them can only be made once both have landed. Splitting them would
 * make `plant.ons_plant_code` depend on the order two independent jobs happened
 * to run in.
 *
 * **Both files are overwritten in place, twice a day, and yesterday's is
 * unrecoverable** — there is no archive and no object versioning. That is why
 * the shared conditional-download path matters here even though the files are
 * small: an unchanged snapshot costs one `HEAD` and writes nothing, so this can
 * run daily and the version history stays a record of ONS's corrections rather
 * than of the schedule.
 *
 * The third companion dataset, `modalidade-usina`, is **not** ingested.
 * `capacidade-geracao` already carries `nom_modalidadeoperacao` on every row,
 * measured to be internally consistent across a plant's units (zero conflicts
 * over the whole live file), while `modalidade-usina` has 42 duplicate CEGs —
 * four of them disagreeing with themselves on the modality — and leaves
 * `id_ons` empty on 2,621 of 5,993 rows. The dataset with the better key wins.
 */

/** Steps this job reports against: two acquisitions of four steps each. */
const REGISTRY_STEPS = 8;

export interface IngestPlantRegistryPayload {
  /** Re-download and re-diff even when the fingerprint is unchanged. */
  force?: boolean;
  /**
   * Take a snapshot that records a renewable deactivation inside the modelling
   * window. Off by default — see `findRenewableDeactivations`.
   */
  allowRenewableDeactivations?: boolean;
  /**
   * Take a bridge snapshot that puts a plant in two conjuntos at once. Off by
   * default — the domain model calls that an ingest failure, not a merge.
   */
  allowOverlappingMembership?: boolean;
  /**
   * The sweep this run belongs to. Stamped on any re-publication the run
   * discovers, which is what makes "the history sweep found this" — the
   * evidence that a settled period was rewritten — a queryable fact.
   */
  context?: ObservationContext;
}

export interface IngestPlantRegistryResult {
  capacityResourceName: string;
  membershipResourceName: string;
  changed: boolean;
  downloaded: boolean;
  plantsSeen: number;
  conjuntosSeen: number;
  unitRowsParsed: number;
  unitRowsRejected: number;
  membershipRowsParsed: number;
  membershipRowsRejected: number;
  /** Hydro, thermal and nuclear rows filtered at the boundary. */
  outOfScopeRowsFiltered: number;
  /** Units whose deactivation date precedes their commissioning date. */
  inconsistentUnitDates: number;
  /** Plants whose ONS code was resolved from the bridge on this run. */
  plantCodesLinked: number;
  /** CEG cores the bridge maps to more than one ONS code; left unresolved. */
  plantCodesAmbiguous: number;
  units: { inserted: number; revised: number; unchanged: number };
  memberships: { inserted: number; revised: number; unchanged: number };
}

export interface PlantRegistryIngestorDeps {
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
 * CSV, not Parquet.
 *
 * Parquet is a fifth the bytes here, but the whole registry is 1.6 MB of CSV
 * and the INT96 timestamp trap that bit the balanço adapter lives on the
 * Parquet path. Paying 1.3 MB a day to keep one parser is the right trade; the
 * balanço file, at 171 MB a year, was not.
 */
const FORMATS = ["CSV"] as const;

export function createPlantRegistryIngestor(
  deps: PlantRegistryIngestorDeps,
): Execute<IngestPlantRegistryPayload, IngestPlantRegistryResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const decoder = new TextDecoder("utf-8");

  return async (payload, report) => {
    const capacity = await acquireBulkResource({
      db: deps.db,
      fetch: fetchImpl,
      slug: CAPACITY_DATASET_SLUG,
      select: (resources) => selectSingleResource(resources, FORMATS),
      force: payload.force,
      archive: deps.archive,
      context: payload.context,
      report: ({ done }) => report({ done, total: REGISTRY_STEPS }),
    });
    const membership = await acquireBulkResource({
      db: deps.db,
      fetch: fetchImpl,
      slug: CONJUNTO_DATASET_SLUG,
      select: (resources) => selectSingleResource(resources, FORMATS),
      force: payload.force,
      archive: deps.archive,
      context: payload.context,
      report: ({ done }) => report({ done: 4 + done, total: REGISTRY_STEPS }),
    });

    const base: IngestPlantRegistryResult = {
      capacityResourceName: capacity.resource.name,
      membershipResourceName: membership.resource.name,
      changed: capacity.changed || membership.changed,
      downloaded: false,
      plantsSeen: 0,
      conjuntosSeen: 0,
      unitRowsParsed: 0,
      unitRowsRejected: 0,
      membershipRowsParsed: 0,
      membershipRowsRejected: 0,
      outOfScopeRowsFiltered: 0,
      inconsistentUnitDates: 0,
      plantCodesLinked: 0,
      plantCodesAmbiguous: 0,
      units: { inserted: 0, revised: 0, unchanged: 0 },
      memberships: { inserted: 0, revised: 0, unchanged: 0 },
    };

    // Both halves or neither: linking the two identifiers needs both, and a
    // half-applied snapshot would leave the link reflecting two different days.
    if (!(capacity.bytes && membership.bytes)) {
      return base;
    }

    const registry = parseCapacityRegistryCsv(decoder.decode(capacity.bytes), {
      allowRenewableDeactivations: payload.allowRenewableDeactivations,
    });
    const bridge = parseConjuntoMembershipCsv(decoder.decode(membership.bytes), {
      allowOverlappingMembership: payload.allowOverlappingMembership,
    });

    // Dimensions first — both versioned tables have a foreign key into them.
    await upsertPlants(deps.db, registry.plants);
    await upsertConjuntos(deps.db, bridge.conjuntos);

    const units = await writeGeneratingUnits(deps.db, {
      units: registry.units,
      publishedAt: capacity.publishedAt,
      publishedAtPrecision: capacity.publishedAtPrecision,
      sourceVersionId: capacity.versionId,
    });
    const memberships = await writeConjuntoMemberships(deps.db, {
      memberships: bridge.memberships,
      publishedAt: membership.publishedAt,
      publishedAtPrecision: membership.publishedAtPrecision,
      sourceVersionId: membership.versionId,
    });

    // The bridge is the only ONS source that publishes `ceg` and `id_ons` on
    // one row, so this is where a plant acquires its ONS code.
    const linked = await linkPlantOnsCodes(deps.db);
    // Both halves, because the link above needed both and neither snapshot is
    // complete without the other. Marking one alone would leave the next sweep
    // re-downloading a file to redo a snapshot it already holds.
    await capacity.markIngested();
    await membership.markIngested();
    report({ done: REGISTRY_STEPS, total: REGISTRY_STEPS });

    return {
      ...base,
      downloaded: true,
      plantsSeen: registry.plants.length,
      conjuntosSeen: bridge.conjuntos.length,
      unitRowsParsed: registry.units.length,
      unitRowsRejected: registry.rejected.length,
      membershipRowsParsed: bridge.memberships.length,
      membershipRowsRejected: bridge.rejected.length,
      outOfScopeRowsFiltered: registry.outOfScopeRowsFiltered,
      inconsistentUnitDates: registry.inconsistentUnitDates,
      plantCodesLinked: linked.linked,
      plantCodesAmbiguous: linked.ambiguous,
      units,
      memberships,
    };
  };
}

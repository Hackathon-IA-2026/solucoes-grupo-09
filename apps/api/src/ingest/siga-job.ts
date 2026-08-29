import type { Database } from "../database/connection.js";
import type { Execute } from "../jobs/index.js";
import {
  fetchAneelPackage,
  SIGA_DATASET_SLUG,
  selectDailySigaResource,
} from "./aneel/catalogue.js";
import { assertMatchRate, measureMatchRate } from "./aneel/match-rate.js";
import {
  isFleetScale,
  type MunicipalityCentroidSource,
  parseSigaCsv,
  resolveLocations,
} from "./aneel/siga.js";
import { acquireBulkResource } from "./bulk-resource.js";
import {
  findWithdrawnPlants,
  readCurrentPlantLocations,
  readPreviousMatchRate,
  readRegistryPlantKeys,
  recordSigaSnapshot,
  writePlantLocations,
} from "./siga-repository.js";
import type { ResolvedPlantLocation } from "./types.js";

/**
 * Ingestion for the ANEEL SIGA daily extract — the job that gives every plant
 * in the registry a location.
 *
 * **Ordered so the assertion happens before the write.** The join is measured
 * against `plant` and asserted first; nothing is stored if the rate has
 * regressed. That ordering is the whole design: a job that wrote first and
 * checked afterwards would leave a table of nulls behind on the run that
 * detected the problem, which is precisely the state the ticket exists to
 * prevent.
 *
 * **Depends on the ONS registry job having run**, and does not pretend
 * otherwise: the match rate's denominator is `plant`, so on an empty registry
 * the rate is reported as 1 over 0 plants and nothing is written. Wiring the
 * two into one job would be wrong — they are different sources on different
 * cadences, and SIGA changes daily while `capacidade-geracao` is ONS's.
 *
 * Licence: SIGA is ODbL 1.0 and the derived table is a Derivative Database.
 * See `plant_geo` in `src/database/schema.ts` for what that obliges and what
 * this ticket deliberately leaves to the public-surface work.
 */

/** Four acquisition steps, then the join, then the write. */
const SIGA_STEPS = 6;

export interface IngestSigaPayload {
  /** Re-download and re-diff even when the fingerprint is unchanged. */
  force?: boolean;
  /** Override the absolute match-rate floor. Rarely correct. */
  matchRateFloor?: number;
  /** Override the slack allowed against the previous ingest's rate. */
  matchRateTolerance?: number;
}

export interface IngestSigaResult {
  resourceName: string;
  changed: boolean;
  downloaded: boolean;
  /** `DatGeracaoConjuntoDados` of the extract, or null if nothing was read. */
  snapshotDate: string | null;
  sourceRows: number;
  rejectedRows: number;
  /** Rows passing the technology, phase and size filters. */
  fleetRows: number;
  /** SIGA capacity over the filtered fleet, kW. A diagnostic, never a source. */
  fleetCapacityKw: number;
  registryPlants: number;
  matchedPlants: number;
  matchRate: number;
  /** Raw `CodCEG` against raw ONS `ceg`. Measured at zero; watched, not used. */
  verbatimMatchedPlants: number;
  previousMatchRate: number | null;
  nullIslandRows: number;
  outOfBoundsRows: number;
  duplicateCegCores: number;
  conflictingDuplicates: number;
  locatedPlants: number;
  centroidFallbackPlants: number;
  unlocatedPlants: number;
  /** Plants that vanished from SIGA since the prior snapshot. */
  withdrawnPlants: number;
  locations: { inserted: number; revised: number; unchanged: number };
}

export interface SigaIngestorDeps {
  db: Database;
  /** Injected so the job is testable without the network. */
  fetch?: typeof fetch;
  /**
   * An external municipality centroid source — IBGE's mesh, when one is wired
   * in. Without it the fallback uses the mean of the valid SIGA coordinates
   * registered in the same municipality, which needs no dataset the repository
   * does not have.
   */
  centroids?: MunicipalityCentroidSource;
}

/** CSV. The XML mirrors are ~4× the bytes and carry the same 23 columns. */
const FORMATS = ["CSV"] as const;

export function createSigaIngestor(
  deps: SigaIngestorDeps,
): Execute<IngestSigaPayload, IngestSigaResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const decoder = new TextDecoder("utf-8");

  return async (payload, report) => {
    // The package is fetched here rather than inside the acquisition helper
    // because the helper's default catalogue is ONS's. ANEEL is a second CKAN,
    // and the resource list is handed in through the door that already exists.
    const resources = await fetchAneelPackage(SIGA_DATASET_SLUG, fetchImpl);
    const extract = await acquireBulkResource({
      db: deps.db,
      fetch: fetchImpl,
      slug: SIGA_DATASET_SLUG,
      resources,
      select: (available) => selectDailySigaResource(available, FORMATS),
      force: payload.force,
      report: ({ done }) => report({ done, total: SIGA_STEPS }),
    });

    const base: IngestSigaResult = {
      resourceName: extract.resource.name,
      changed: extract.changed,
      downloaded: false,
      snapshotDate: null,
      sourceRows: 0,
      rejectedRows: 0,
      fleetRows: 0,
      fleetCapacityKw: 0,
      registryPlants: 0,
      matchedPlants: 0,
      matchRate: 0,
      verbatimMatchedPlants: 0,
      previousMatchRate: null,
      nullIslandRows: 0,
      outOfBoundsRows: 0,
      duplicateCegCores: 0,
      conflictingDuplicates: 0,
      locatedPlants: 0,
      centroidFallbackPlants: 0,
      unlocatedPlants: 0,
      withdrawnPlants: 0,
      locations: { inserted: 0, revised: 0, unchanged: 0 },
    };

    if (!extract.bytes) {
      return base;
    }

    const parse = parseSigaCsv(decoder.decode(extract.bytes));

    // The join, and the assertion, before anything is written.
    const registry = await readRegistryPlantKeys(deps.db);
    const match = measureMatchRate(registry, parse.rows);
    const previousMatchRate = await readPreviousMatchRate(deps.db);
    assertMatchRate(match, {
      floor: payload.matchRateFloor,
      tolerance: payload.matchRateTolerance,
      previousRate: previousMatchRate,
    });
    report({ done: 5, total: SIGA_STEPS });

    // The fleet filter, applied where a capacity number is produced rather than
    // left to whoever reads one: SIGA's UFV population is 17,260 rooftops at a
    // median of 1 kW, and an unfiltered sum is a different quantity, not a
    // rougher one.
    let fleetRows = 0;
    let fleetCapacityKw = 0;
    for (const row of parse.rows) {
      if (isFleetScale(row)) {
        fleetRows += 1;
        fleetCapacityKw += row.inspectedCapacityKw ?? 0;
      }
    }

    // Only plants the ONS registry knows about are stored. SIGA's other 23,000
    // rows are rooftop and thermal registrations WattSteer has no plant for,
    // and extracting them would widen the ODbL Derivative Database for nothing.
    const resolved = resolveLocations(parse.rows, { centroids: deps.centroids });
    const locations: ResolvedPlantLocation[] = [];
    for (const plant of registry) {
      const location = resolved.get(plant.cegCore);
      if (location) {
        locations.push(location);
      }
    }

    const present = new Set(locations.map((location) => location.cegCore));
    const previous = await readCurrentPlantLocations(deps.db);
    const withdrawn = findWithdrawnPlants(previous, present, parse.snapshotDate);

    const written = await writePlantLocations(deps.db, {
      locations: [...locations, ...withdrawn],
      observedOn: parse.snapshotDate,
      publishedAt: extract.publishedAt,
      publishedAtPrecision: extract.publishedAtPrecision,
      sourceVersionId: extract.versionId,
    });

    const count = (source: ResolvedPlantLocation["locationSource"]) =>
      locations.filter((location) => location.locationSource === source).length;
    const locatedPlants = count("siga_coordinate");
    const centroidFallbackPlants = count("siga_municipality_centroid");
    const unlocatedPlants = count("unlocated");

    await recordSigaSnapshot(deps.db, {
      snapshotDate: parse.snapshotDate,
      sourceVersionId: extract.versionId,
      sourceRows: parse.rows.length,
      fleetRows,
      registryPlants: match.registryPlants,
      matchedPlants: match.matched,
      matchRate: match.rate,
      verbatimMatchedPlants: match.verbatimMatched,
      nullIslandRows: parse.nullIslandRows,
      outOfBoundsRows: parse.outOfBoundsRows,
      locatedPlants,
      centroidFallbackPlants,
      unlocatedPlants,
      withdrawnPlants: withdrawn.length,
    });
    report({ done: SIGA_STEPS, total: SIGA_STEPS });

    return {
      ...base,
      downloaded: true,
      snapshotDate: parse.snapshotDate.toISOString().slice(0, 10),
      sourceRows: parse.rows.length,
      rejectedRows: parse.rejected.length,
      fleetRows,
      fleetCapacityKw,
      registryPlants: match.registryPlants,
      matchedPlants: match.matched,
      matchRate: match.rate,
      verbatimMatchedPlants: match.verbatimMatched,
      previousMatchRate,
      nullIslandRows: parse.nullIslandRows,
      outOfBoundsRows: parse.outOfBoundsRows,
      duplicateCegCores: parse.duplicateCegCores,
      conflictingDuplicates: parse.conflictingDuplicates,
      locatedPlants,
      centroidFallbackPlants,
      unlocatedPlants,
      withdrawnPlants: withdrawn.length,
      locations: written,
    };
  };
}

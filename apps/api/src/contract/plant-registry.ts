import type { Technology } from "@wattsteer/core/domain";
import { sql } from "drizzle-orm";
import { canonicalPlantRegistry } from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import { readOnly } from "./read-only.js";
import { applyAxes, readGoLive } from "./scope.js";
import { type VintageFidelity, vintageFidelity } from "./vintage.js";

/**
 * The plant registry, as the contract sees it.
 *
 * The read behind `GET /v1/plants` — the one endpoint in
 * `docs/specs/api-surface.md` that exists for a **licence** rather than for a
 * screen. WattSteer's plant table extracts a substantial part of ANEEL SIGA
 * into Postgres, which ODbL §4.4(b) makes a Derivative Database; §4.4(c) pulls
 * that under share-alike because the public charts built from it are Publicly
 * Used Produced Works; and §4.6 then obliges machine-readable access, free of
 * charge, from day one. `docs/research/plant-registry.md` §7 is the reading.
 *
 * It reads `canonical_plant_registry` and **no base table**. That is the same
 * rule every other contract read follows, and here it buys something extra: the
 * two `AsOf` picks, the ONS↔SIGA join and the capacity sum are the *alterations*
 * §4.6(b) talks about, and having them in one SQL definition is what makes the
 * published description of them true.
 *
 * ### Three shapes that carry a decision
 *
 * - **Capacity is a function of time.** It is summed over the units live on the
 *   fleet date, in the view, and never read from a stored scalar. Fixed
 *   present-day weights were measured misallocating 50.4% of the SE-solar
 *   weight mass at window start and moving that centroid 94 km.
 * - **An absent coordinate is `null`, and absent is broader than missing.** The
 *   database refuses a point outside the Brazil bounding box and refuses
 *   `(0, 0)` outright — nearly two percent of registry rows sit at exactly Null
 *   Island — so by the time a row reaches here, a latitude that exists is a
 *   latitude that means something. This module still pairs the two halves
 *   explicitly rather than trusting that, because a `0` reaching a map is the
 *   failure the whole rule exists to prevent.
 * - **The location's provenance rides with it.** `locationSource` separates a
 *   surveyed SIGA coordinate from the municipality centroid four plants fall
 *   back to. A fallback presented as a survey is a plausible lie, which is the
 *   worse kind.
 */

/** Where a row's point came from. Never inferred at read time. */
export type PlantLocationSource =
  | "siga_coordinate"
  | "siga_municipality_centroid"
  | "unlocated";

/** ONS's four operation modalities. Closed, like every other domain enum. */
export type OperationModality = "TIPO_I" | "TIPO_II_A" | "TIPO_II_B" | "TIPO_II_C";

/** WGS-84 decimal degrees, inside the Brazil bounding box. Never `(0, 0)`. */
export interface PlantCoordinate {
  latitude: number;
  longitude: number;
}

/** One plant, at the grain the registry publishes. */
export interface RegistryPlantRecord {
  /** ONS `id_ons`. Null is genuinely unknown, not optional. */
  onsPlantCode: string | null;
  /** ANEEL CEG, version segment stripped. The identity and the SIGA bridge. */
  cegCore: string;
  /** ONS `nom_usina` — never SIGA's alias-carrying `NomEmpreendimento`. */
  name: string;
  subsystem: SubsystemCode;
  stateCode: string;
  technology: Technology;
  operationModality: OperationModality;
  /** `Name - UF`, from SIGA. Null where SIGA names no municipality. */
  municipality: string | null;
  ownerName: string;
  operatorName: string;
  /** Summed over the units live on the fleet date. Never a stored scalar. */
  installedCapacityMw: number;
  generatingUnits: number;
  /** `null` when absent — and out-of-bounds and Null Island are absent. */
  coordinate: PlantCoordinate | null;
  locationSource: PlantLocationSource;
}

export interface PlantRegistryReadQuery {
  /** Vintage cut: what WattSteer had learned by this instant. */
  asOf: Date;
  /** The date capacity is summed at. Truncated to a UTC day by the database. */
  fleetDate: Date;
  subsystem?: SubsystemCode;
  technology?: Technology;
}

export interface PlantRegistryObservation {
  asOf: Date;
  fleetDate: Date;
  vintageFidelity: VintageFidelity;
  plants: RegistryPlantRecord[];
  /**
   * The freshest registry snapshot behind the answer, or `null` when the
   * registry is empty.
   *
   * Not part of the payload: it is what `api-surface.md`'s caching table makes
   * this route's ETag, because the response moves with the daily SIGA/ONS
   * snapshot and with nothing else.
   */
  latestIngestedAt: Date | null;
}

/** The view's row, as Postgres hands it back. Indexed because `execute` is. */
interface RegistryRow {
  [column: string]: unknown;
  ceg_core: string;
  ons_plant_code: string | null;
  name: string;
  subsystem: SubsystemCode;
  state_code: string;
  technology: Technology;
  operation_modality: OperationModality;
  owner_name: string;
  operator_name: string;
  installed_capacity_mw: number | string;
  generating_units: number;
  latitude: number | string | null;
  longitude: number | string | null;
  location_source: PlantLocationSource;
  municipality_name: string | null;
  municipality_uf: string | null;
  ingested_at: string;
}

/**
 * The coordinate, or `null` — and the pairing is the assertion.
 *
 * `plant_geo` already refuses half a coordinate and refuses Null Island with
 * check constraints, so this is belt and braces. It is written anyway because
 * the cost of the constraint being relaxed one day by a migration someone did
 * not read is a `(0, 0)` on a public map, and the cost of this function is four
 * lines.
 */
function coordinateOf(row: RegistryRow): PlantCoordinate | null {
  if (row.latitude === null || row.longitude === null) {
    return null;
  }
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  if (!(Number.isFinite(latitude) && Number.isFinite(longitude))) {
    return null;
  }
  // Null Island is an absence wearing a location's clothes, and so is anything
  // outside Brazil. Both are `null` here, never a zero pair.
  if (latitude === 0 && longitude === 0) {
    return null;
  }
  if (latitude < -34 || latitude > 6 || longitude < -74 || longitude > -33) {
    return null;
  }
  return { latitude, longitude };
}

/** `Guamaré - RN`, or null. Assembled here so the wire has one municipality field. */
function municipalityOf(row: RegistryRow): string | null {
  if (row.municipality_name === null) {
    return null;
  }
  return row.municipality_uf === null
    ? row.municipality_name
    : `${row.municipality_name} - ${row.municipality_uf}`;
}

/**
 * Read the registry.
 *
 * An empty registry is an **empty list**, not an error: a database with no SIGA
 * snapshot yet has genuinely no plants to publish, and §4.6 is discharged by
 * offering the file rather than by the file being non-empty. The as-of and the
 * fleet date are still stamped, so a caller can tell "nothing yet" from
 * "nothing matching your filter".
 */
export async function readPlantRegistry(
  db: Database,
  query: PlantRegistryReadQuery,
): Promise<PlantRegistryObservation> {
  return readOnly(db, async (tx) => {
    // Both axes, on the transaction, before any read. `canonical_as_of()` and
    // `canonical_fleet_date()` each raise 22023 when unset, so there is no path
    // through this function that reaches the view without naming its vintage
    // and its fleet date.
    await applyAxes(tx, { asOf: query.asOf, fleetDate: query.fleetDate });

    const subsystemFilter =
      query.subsystem === undefined ? sql`` : sql`and subsystem = ${query.subsystem}`;
    const technologyFilter =
      query.technology === undefined ? sql`` : sql`and technology = ${query.technology}`;

    const rows = await tx.execute<RegistryRow>(sql`
      select * from ${canonicalPlantRegistry}
      where true ${subsystemFilter} ${technologyFilter}
      order by subsystem, technology, ceg_core
    `);

    let latestIngestedAt: Date | null = null;
    const plants: RegistryPlantRecord[] = [];
    for (const row of [...rows]) {
      const ingested = new Date(row.ingested_at);
      if (latestIngestedAt === null || ingested.getTime() > latestIngestedAt.getTime()) {
        latestIngestedAt = ingested;
      }
      plants.push({
        onsPlantCode: row.ons_plant_code,
        cegCore: row.ceg_core,
        name: row.name,
        subsystem: row.subsystem,
        stateCode: row.state_code,
        technology: row.technology,
        operationModality: row.operation_modality,
        municipality: municipalityOf(row),
        ownerName: row.owner_name,
        operatorName: row.operator_name,
        installedCapacityMw: Number(row.installed_capacity_mw),
        generatingUnits: row.generating_units,
        coordinate: coordinateOf(row),
        locationSource: row.location_source,
      });
    }

    // The registry is a snapshot read rather than a window read, so the instant
    // the fidelity rule is asked about is the cut itself — exactly as
    // `readPlantLocationsAsOf` does it. `installed-capacity` is the go-live
    // that matters: SIGA has no archive at all before WattSteer's first
    // snapshot, so an `as_of` earlier than go-live is honestly a restatement of
    // today's belief and the response says so rather than implying a
    // point-in-time reconstruction nobody can make.
    const goLiveAt = await readGoLive(tx, "installed-capacity");

    return {
      asOf: query.asOf,
      fleetDate: query.fleetDate,
      vintageFidelity: vintageFidelity(query.asOf, goLiveAt),
      plants,
      latestIngestedAt,
    };
  });
}

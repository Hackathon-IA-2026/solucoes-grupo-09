import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { plantGeo, sigaSnapshot } from "../database/schema.js";
import type { VintageFidelity } from "./repository.js";
import type {
  CoordinateRejection,
  PlantLocationSource,
  RegistryPlantKey,
  ResolvedPlantLocation,
} from "./types.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Persistence for the SIGA half of the registry: `plant_geo` and the ingest
 * ledger `siga_snapshot`.
 *
 * Two things live here that no other repository needs.
 *
 * **The prior snapshot has to be readable**, because SIGA represents a
 * retirement by deleting the row. There is no phase, no date and no tombstone;
 * the only way the event exists at all is a diff between two of WattSteer's own
 * vintages, so `readCurrentPlantLocations` is not a convenience read — it is
 * half of `findWithdrawnPlants`.
 *
 * **The previous match rate has to be readable**, because "assert the rate"
 * against a fixed floor catches a format change but not a slide. `siga_snapshot`
 * is the ledger that makes the second check possible.
 */

/** A `plant_geo` row as stored, latest version. */
export interface StoredPlantLocation extends ResolvedPlantLocation {
  observedOn: Date;
  dataVersion: number;
  ingestedAt: Date;
}

/**
 * The ONS registry's identity columns — the match rate's denominator.
 *
 * Read from `plant` rather than from a parse: the two jobs run independently
 * and the question the assertion answers is "does every plant the platform
 * currently models have a location", which is a question about the database.
 */
export async function readRegistryPlantKeys(db: Database): Promise<RegistryPlantKey[]> {
  const rows = await db.execute<{ ceg_core: string; ceg_raw: string }>(
    sql`select ceg_core, ceg_raw from plant order by ceg_core`,
  );
  return [...rows].map((row) => ({ cegCore: row.ceg_core, cegRaw: row.ceg_raw }));
}

/** Shared latest-version projection of `plant_geo`. */
const latestLocations = (asOf: Date) => sql`
  select distinct on (plant_ceg_core)
    plant_ceg_core, ceg_raw, siga_name, latitude, longitude, location_source,
    coordinate_rejection, municipality_name, municipality_uf, municipalities_raw,
    ownership, observed_on, withdrawn_on, data_version, ingested_at
  from plant_geo
  where ingested_at <= ${asOf.toISOString()}::timestamptz
  order by plant_ceg_core, ingested_at desc, data_version desc
`;

interface LocationRow {
  plant_ceg_core: string;
  ceg_raw: string;
  siga_name: string;
  latitude: number | null;
  longitude: number | null;
  location_source: PlantLocationSource;
  coordinate_rejection: CoordinateRejection | null;
  municipality_name: string | null;
  municipality_uf: string | null;
  municipalities_raw: string;
  ownership: string;
  observed_on: string;
  withdrawn_on: string | null;
  data_version: number;
  ingested_at: string;
}

/** What `db.execute` needs: an interface carries no implicit index signature. */
type LocationResult = LocationRow & Record<string, unknown>;

function toStored(row: LocationRow): StoredPlantLocation {
  return {
    cegCore: row.plant_ceg_core,
    cegRaw: row.ceg_raw,
    sigaName: row.siga_name,
    coordinate:
      row.latitude === null || row.longitude === null
        ? null
        : { latitude: Number(row.latitude), longitude: Number(row.longitude) },
    locationSource: row.location_source,
    coordinateRejection: row.coordinate_rejection,
    municipality:
      row.municipality_name === null || row.municipality_uf === null
        ? null
        : { name: row.municipality_name, uf: row.municipality_uf },
    municipalitiesRaw: row.municipalities_raw,
    ownership: row.ownership,
    withdrawnOn: row.withdrawn_on === null ? null : new Date(row.withdrawn_on),
    observedOn: new Date(row.observed_on),
    dataVersion: row.data_version,
    ingestedAt: new Date(row.ingested_at),
  };
}

/**
 * Every plant's currently believed location, keyed by CEG core.
 *
 * Includes rows already marked withdrawn: a plant that comes back — ANEEL
 * re-registering after a revocation is exactly the case the version segment
 * exists for — must revise its own row rather than be inserted a second time.
 */
export async function readCurrentPlantLocations(
  db: Database,
  asOf: Date = new Date(),
): Promise<Map<string, StoredPlantLocation>> {
  const rows = await db.execute<LocationResult>(latestLocations(asOf));
  const current = new Map<string, StoredPlantLocation>();
  for (const row of rows) {
    current.set(row.plant_ceg_core, toStored(row));
  }
  return current;
}

/**
 * The plants that were in the prior snapshot and are not in this one.
 *
 * A withdrawal is written as a **revision of the plant's own row** — its last
 * known location, restated with `withdrawn_on` set — rather than as a deletion
 * or as a null location. Deleting would destroy a prior belief, which this
 * schema never does; nulling the coordinate would conflate "ANEEL removed the
 * registration" with "ANEEL never had a coordinate", which are the two facts
 * this table works hardest to keep apart.
 *
 * Already-withdrawn rows are skipped, so a plant that stays absent is written
 * once and the ledger's `withdrawn_plants` counts events rather than a
 * cumulative backlog.
 */
export function findWithdrawnPlants(
  previous: ReadonlyMap<string, StoredPlantLocation>,
  present: ReadonlySet<string>,
  snapshotDate: Date,
): ResolvedPlantLocation[] {
  const withdrawn: ResolvedPlantLocation[] = [];
  for (const [cegCore, stored] of previous) {
    if (present.has(cegCore) || stored.withdrawnOn !== null) {
      continue;
    }
    withdrawn.push({
      cegCore,
      cegRaw: stored.cegRaw,
      sigaName: stored.sigaName,
      coordinate: stored.coordinate,
      locationSource: stored.locationSource,
      coordinateRejection: stored.coordinateRejection,
      municipality: stored.municipality,
      municipalitiesRaw: stored.municipalitiesRaw,
      ownership: stored.ownership,
      withdrawnOn: snapshotDate,
    });
  }
  return withdrawn.sort((a, b) => a.cegCore.localeCompare(b.cegCore));
}

/**
 * Digest of a location's stored values.
 *
 * `observed_on` is **not** in it, and that is the difference between a version
 * history of ANEEL's corrections and a version history of WattSteer's polling
 * schedule: the daily extract restates the same coordinates every day, and a
 * digest that included the snapshot date would append 1,600 rows a day saying
 * nothing changed.
 *
 * `withdrawn_on` *is* in it, because a disappearance is the one restatement
 * this source makes that carries no values at all.
 */
export function plantLocationDigest(row: ResolvedPlantLocation): string {
  return digestValues([
    row.cegRaw,
    row.sigaName,
    row.coordinate?.latitude ?? null,
    row.coordinate?.longitude ?? null,
    row.locationSource,
    row.coordinateRejection,
    row.municipality?.name ?? null,
    row.municipality?.uf ?? null,
    row.municipalitiesRaw,
    row.ownership,
    row.withdrawnOn?.toISOString() ?? null,
  ]);
}

/**
 * The spec, built per write so it can close over the snapshot date.
 *
 * `observed_on` is a stored value rather than part of the key — one row per
 * plant, revised in place — so the latest-version lookup reads the whole table
 * for the same reason `generating_unit`'s does: a ranged lookup would miss the
 * row it is meant to revise and write a second version 1.
 */
function locationSpec(
  observedOn: Date,
): VersionedTableSpec<ResolvedPlantLocation, typeof plantGeo.$inferInsert> {
  return {
    table: plantGeo,
    tableName: "plant_geo",
    keyColumns: ["plant_ceg_core"],
    validTimeColumn: "observed_on",
    latestLookup: "whole_table",
    businessKey: (row) => row.cegCore,
    validTime: () => observedOn,
    digest: plantLocationDigest,
    toInsert: (row, version, vintage) => ({
      plantCegCore: row.cegCore,
      cegRaw: row.cegRaw,
      sigaName: row.sigaName,
      latitude: row.coordinate?.latitude ?? null,
      longitude: row.coordinate?.longitude ?? null,
      locationSource: row.locationSource,
      coordinateRejection: row.coordinateRejection,
      municipalityName: row.municipality?.name ?? null,
      municipalityUf: row.municipality?.uf ?? null,
      municipalitiesRaw: row.municipalitiesRaw,
      ownership: row.ownership,
      observedOn,
      withdrawnOn: row.withdrawnOn,
      dataVersion: version.dataVersion,
      publishedAt: vintage.publishedAt,
      publishedAtPrecision: vintage.publishedAtPrecision,
      ingestedAt: vintage.ingestedAt,
      valueDigest: version.valueDigest,
      sourceVersionId: vintage.sourceVersionId,
    }),
  };
}

export interface PlantLocationWrite extends VintageStamp {
  locations: ResolvedPlantLocation[];
  /** `DatGeracaoConjuntoDados` — this write's valid time. */
  observedOn: Date;
}

/** Append the locations whose values actually changed. */
export async function writePlantLocations(
  db: Database,
  write: PlantLocationWrite,
): Promise<VersionedWriteResult> {
  const { locations, observedOn, ...vintage } = write;
  return writeVersioned(db, locationSpec(observedOn), locations, vintage);
}

// ---------------------------------------------------------------------------
// The ingest ledger
// ---------------------------------------------------------------------------

/** One row of `siga_snapshot`, without the identity and the stamp. */
export type SigaSnapshotRecord = Omit<
  typeof sigaSnapshot.$inferInsert,
  "id" | "ingestedAt"
>;

/** Record what this ingest saw. Written on every run that read bytes. */
export async function recordSigaSnapshot(
  db: Database,
  record: SigaSnapshotRecord,
): Promise<void> {
  await db.insert(sigaSnapshot).values(record);
}

/** The most recent ingest's core match rate, or null on the very first run. */
export async function readPreviousMatchRate(db: Database): Promise<number | null> {
  const [row] = await db.execute<{ match_rate: number }>(
    sql`select match_rate from siga_snapshot order by ingested_at desc limit 1`,
  );
  return row ? Number(row.match_rate) : null;
}

// ---------------------------------------------------------------------------
// As-of reads
// ---------------------------------------------------------------------------

export interface PlantLocationQuery {
  /** Vintage axis: what WattSteer had learned by this instant. */
  asOf: Date;
  /** Include plants SIGA has since deleted. Off by default. */
  includeWithdrawn?: boolean;
  /** Only plants with a usable point — what a weather sample actually needs. */
  locatedOnly?: boolean;
}

export interface PlantLocationResult {
  rows: StoredPlantLocation[];
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

/**
 * Plant locations as WattSteer knew them at an instant.
 *
 * One time axis, not two, and the asymmetry is deliberate: `generating_unit`
 * takes a fleet date as well because a unit's existence is genuinely a function
 * of the day, whereas a plant's coordinates do not vary with the calendar —
 * only with what ANEEL had recorded when WattSteer looked. Adding a second axis
 * here would invite a caller to ask a question the source cannot answer.
 */
export async function readPlantLocationsAsOf(
  db: Database,
  query: PlantLocationQuery,
): Promise<PlantLocationResult> {
  const withdrawnFilter = query.includeWithdrawn
    ? sql``
    : sql`and l.withdrawn_on is null`;
  const locatedFilter = query.locatedOnly ? sql`and l.latitude is not null` : sql``;

  const rows = await db.execute<LocationResult>(sql`
    with latest as (${latestLocations(query.asOf)})
    select * from latest l
    where true ${withdrawnFilter} ${locatedFilter}
    order by l.plant_ceg_core
  `);

  const [live] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from plant_geo`,
  );
  const goLiveAt = live?.go_live ? new Date(live.go_live) : null;

  return {
    rows: [...rows].map(toStored),
    // SIGA has no archive at all: before WattSteer's first snapshot the only
    // answer available is today's extract, and the read says so rather than
    // implying a point-in-time reconstruction it cannot make.
    vintageFidelity:
      goLiveAt && query.asOf >= goLiveAt ? "point_in_time" : "revision_optimistic",
    goLiveAt,
  };
}

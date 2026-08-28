import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import {
  conjunto,
  conjuntoMembership,
  generatingUnit,
  plant,
} from "../database/schema.js";
import type { SubsystemCode } from "./normalise.js";
import { toUtcDay } from "./normalise.js";
import type { VintageFidelity } from "./repository.js";
import type {
  OperationModality,
  RegistryConjunto,
  RegistryConjuntoMembership,
  RegistryGeneratingUnit,
  RegistryPlant,
  Technology,
} from "./types.js";
import {
  digestValues,
  INSERT_CHUNK,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Persistence and as-of reads for the ONS fleet registry.
 *
 * The append-and-version algorithm is shared (`versioned-write.ts`). What lives
 * here is what genuinely differs: two dimensions that are upserted, two
 * versioned tables whose valid time is a *date* rather than an hour, and the
 * two reads the rest of the platform is built on —
 * `InstalledCapacityAsOf(scope, technology, t)` and membership resolved as of a
 * date.
 *
 * Both reads take **two** times and they are not interchangeable:
 *
 * - `asOf` is the vintage axis — what WattSteer had learned by then. It is what
 *   makes a backtest honest about ONS's retroactive corrections.
 * - `on` is the fleet date — which units existed and which conjunto a plant was
 *   in *on that day*.
 *
 * Conflating them is the mistake this whole ticket exists to prevent: reading
 * today's fleet as if it were 2024's misallocates 25.8% of fleet MW at window
 * start.
 */

/** A calendar day, normalised the way both source files write one: UTC midnight. */
const asDay = (date: Date): string => toUtcDay(date).toISOString();

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * Upsert the plants a snapshot described.
 *
 * A genuine upsert, not an append: the row answers "what is this plant?", which
 * has one current answer. `first_seen_at` never moves; `ons_plant_code` is
 * deliberately **not** in the update set, because it comes from the conjunto
 * bridge rather than from this file and a capacity ingest must not blank it.
 */
export async function upsertPlants(
  db: Database,
  plants: readonly RegistryPlant[],
  seenAt: Date = new Date(),
): Promise<number> {
  if (plants.length === 0) {
    return 0;
  }
  for (let offset = 0; offset < plants.length; offset += INSERT_CHUNK) {
    await db
      .insert(plant)
      .values(
        plants.slice(offset, offset + INSERT_CHUNK).map((row) => ({
          ...row,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
        })),
      )
      .onConflictDoUpdate({
        target: plant.cegCore,
        set: {
          cegRaw: sql`excluded.ceg_raw`,
          name: sql`excluded.name`,
          subsystem: sql`excluded.subsystem`,
          stateCode: sql`excluded.state_code`,
          technology: sql`excluded.technology`,
          operationModality: sql`excluded.operation_modality`,
          ownerName: sql`excluded.owner_name`,
          operatorName: sql`excluded.operator_name`,
          lastSeenAt: sql`greatest(${plant.lastSeenAt}, excluded.last_seen_at)`,
        },
      });
  }
  return plants.length;
}

/** Upsert the conjuntos a bridge snapshot mentioned. Same dimension reasoning. */
export async function upsertConjuntos(
  db: Database,
  conjuntos: readonly RegistryConjunto[],
  seenAt: Date = new Date(),
): Promise<number> {
  if (conjuntos.length === 0) {
    return 0;
  }
  for (let offset = 0; offset < conjuntos.length; offset += INSERT_CHUNK) {
    await db
      .insert(conjunto)
      .values(
        conjuntos.slice(offset, offset + INSERT_CHUNK).map((row) => ({
          ...row,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
        })),
      )
      .onConflictDoUpdate({
        target: conjunto.onsConjuntoCode,
        set: {
          name: sql`excluded.name`,
          subsystem: sql`excluded.subsystem`,
          stateCode: sql`excluded.state_code`,
          technology: sql`excluded.technology`,
          sourceTypeCode: sql`excluded.source_type_code`,
          lastSeenAt: sql`greatest(${conjunto.lastSeenAt}, excluded.last_seen_at)`,
        },
      });
  }
  return conjuntos.length;
}

/**
 * Fill in `plant.ons_plant_code` from the conjunto bridge.
 *
 * `capacidade-geracao` carries no `id_ons` — the research says it gained one in
 * January 2026 and the live header disagrees — so the plant's ONS code has to
 * come from the one dataset that publishes both identifiers on the same row.
 *
 * Assigned **only where the CEG core maps to exactly one ONS code**. One core
 * in the live file (`EOL.CV.RN.047240-9`) carries two, `RNST6` and `RNST06`;
 * picking either would be a guess presented as a fact, so the column stays null
 * and the ambiguity is returned to the caller rather than resolved.
 */
export async function linkPlantOnsCodes(
  db: Database,
): Promise<{ linked: number; ambiguous: number }> {
  const [ambiguity] = await db.execute<{ ambiguous: number }>(sql`
    select count(*)::int as ambiguous from (
      select plant_ceg_core
      from conjunto_membership
      where plant_ceg_core is not null
      group by plant_ceg_core
      having count(distinct plant_ons_code) > 1
    ) as multiples
  `);

  const updated = await db.execute<{ ceg_core: string }>(sql`
    update plant set ons_plant_code = unique_codes.plant_ons_code
    from (
      select plant_ceg_core, min(plant_ons_code) as plant_ons_code
      from conjunto_membership
      where plant_ceg_core is not null
      group by plant_ceg_core
      having count(distinct plant_ons_code) = 1
    ) as unique_codes
    where plant.ceg_core = unique_codes.plant_ceg_core
      and plant.ons_plant_code is distinct from unique_codes.plant_ons_code
    returning plant.ceg_core
  `);

  return { linked: [...updated].length, ambiguous: ambiguity?.ambiguous ?? 0 };
}

// ---------------------------------------------------------------------------
// Versioned writes
// ---------------------------------------------------------------------------

/**
 * Digest of a generating unit's stored values.
 *
 * The dates are in it, and that is the whole point: a retroactive correction to
 * `dat_entradaoperacao` changes no capacity number but changes the fleet on
 * every day between the old date and the new one. Without the dates in the
 * digest that correction would be invisible, and the snapshot's vintage would
 * record nothing.
 */
export function generatingUnitDigest(unit: RegistryGeneratingUnit): string {
  return digestValues([
    unit.plantCegCore,
    unit.equipmentCode,
    unit.unitNumber,
    unit.name,
    unit.ratedPowerMw,
    unit.testEntryOn?.toISOString() ?? null,
    unit.commissionedOn.toISOString(),
    unit.decommissionedOn?.toISOString() ?? null,
  ]);
}

const UNIT_SPEC: VersionedTableSpec<
  RegistryGeneratingUnit,
  typeof generatingUnit.$inferInsert
> = {
  table: generatingUnit,
  tableName: "generating_unit",
  keyColumns: ["plant_ceg_core", "equipment_code"],
  // The commissioning date *is* this table's valid time — the instant the row's
  // assertion became true in the world. See the schema comment.
  validTimeColumn: "commissioned_on",
  // And because it is a *value* rather than part of the key, a correction moves
  // it: the whole point of storing this snapshot with a vintage is to catch a
  // retroactively changed commissioning date, and a ranged lookup would miss
  // exactly that row and write a second first version instead.
  latestLookup: "whole_table",
  businessKey: (unit) => `${unit.plantCegCore}|${unit.equipmentCode}`,
  validTime: (unit) => unit.commissionedOn,
  digest: generatingUnitDigest,
  toInsert: (unit, version, vintage) => ({
    plantCegCore: unit.plantCegCore,
    equipmentCode: unit.equipmentCode,
    unitNumber: unit.unitNumber,
    name: unit.name,
    ratedPowerMw: unit.ratedPowerMw,
    testEntryOn: unit.testEntryOn,
    commissionedOn: unit.commissionedOn,
    decommissionedOn: unit.decommissionedOn,
    dataVersion: version.dataVersion,
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

/** Digest of a membership's stored values. Closing a membership is a revision. */
export function conjuntoMembershipDigest(row: RegistryConjuntoMembership): string {
  return digestValues([
    row.plantOnsCode,
    row.conjuntoCode,
    row.memberFrom.toISOString(),
    row.memberTo?.toISOString() ?? null,
    row.plantCegCore,
  ]);
}

const MEMBERSHIP_SPEC: VersionedTableSpec<
  RegistryConjuntoMembership,
  typeof conjuntoMembership.$inferInsert
> = {
  table: conjuntoMembership,
  tableName: "conjunto_membership",
  keyColumns: ["plant_ons_code", "conjunto_code", "member_from"],
  validTimeColumn: "member_from",
  // `member_from` is part of the key here, so a ranged lookup would be correct
  // — but the bridge is 2,000 rows and one ingest is the whole file, so the
  // range is the table anyway. Stated rather than inferred.
  latestLookup: "whole_table",
  businessKey: (row) =>
    `${row.plantOnsCode}|${row.conjuntoCode}|${row.memberFrom.toISOString()}`,
  validTime: (row) => row.memberFrom,
  digest: conjuntoMembershipDigest,
  toInsert: (row, version, vintage) => ({
    plantOnsCode: row.plantOnsCode,
    conjuntoCode: row.conjuntoCode,
    memberFrom: row.memberFrom,
    memberTo: row.memberTo,
    plantCegCore: row.plantCegCore,
    dataVersion: version.dataVersion,
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

/** What to write, and the vintage to stamp on it. */
export interface GeneratingUnitWrite extends VintageStamp {
  units: RegistryGeneratingUnit[];
}

export interface ConjuntoMembershipWrite extends VintageStamp {
  memberships: RegistryConjuntoMembership[];
}

export type RegistryWriteResult = VersionedWriteResult;

/**
 * Append the units whose values actually changed.
 *
 * This is what makes the daily snapshot storable at all. ONS overwrites the
 * file twice a day and yesterday's is unrecoverable; polling it every day would
 * write 3,385 rows a day if versions were counted rather than diffed. Diffing
 * means an ordinary day writes nothing and a real correction writes exactly the
 * units it touched.
 */
export async function writeGeneratingUnits(
  db: Database,
  write: GeneratingUnitWrite,
): Promise<RegistryWriteResult> {
  const { units, ...vintage } = write;
  return writeVersioned(db, UNIT_SPEC, units, vintage);
}

/** Append the memberships whose values actually changed. */
export async function writeConjuntoMemberships(
  db: Database,
  write: ConjuntoMembershipWrite,
): Promise<RegistryWriteResult> {
  const { memberships, ...vintage } = write;
  return writeVersioned(db, MEMBERSHIP_SPEC, memberships, vintage);
}

// ---------------------------------------------------------------------------
// As-of reads
// ---------------------------------------------------------------------------

/** The two axes every registry read needs. */
export interface RegistryAsOfQuery {
  /** Vintage axis: what WattSteer had learned by this instant. */
  asOf: Date;
  /** Fleet date: which units existed / which conjunto applied on this day. */
  on: Date;
}

export interface InstalledCapacityQuery extends RegistryAsOfQuery {
  subsystem?: SubsystemCode;
  technology?: Technology;
}

/** One (subsystem, technology) scope of the fleet at a date. */
export interface InstalledCapacityGroup {
  subsystem: SubsystemCode;
  technology: Technology;
  plants: number;
  units: number;
  capacityMw: number;
}

export interface InstalledCapacityResult {
  groups: InstalledCapacityGroup[];
  /** Sum over the returned groups, in MW. */
  totalMw: number;
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

/**
 * Shared latest-version projection of `generating_unit`.
 *
 * The `DISTINCT ON` runs **before** the interval filter, deliberately: a
 * revision can move a commissioning date, and filtering first would compare the
 * question's date against a superseded answer and then pick a winner among the
 * survivors — which is a different query and quietly a wrong one.
 */
const latestUnits = (asOf: Date) => sql`
  select distinct on (plant_ceg_core, equipment_code)
    plant_ceg_core, equipment_code, rated_power_mw,
    commissioned_on, decommissioned_on, data_version, ingested_at, published_at
  from generating_unit
  where ingested_at <= ${asOf.toISOString()}::timestamptz
  order by plant_ceg_core, equipment_code, ingested_at desc, data_version desc
`;

/** Units live on `[commissioned_on, decommissioned_on)` — closed, then open. */
const liveOn = (on: Date) => sql`
  units.commissioned_on <= ${asDay(on)}::timestamptz
  and (units.decommissioned_on is null
       or units.decommissioned_on > ${asDay(on)}::timestamptz)
`;

async function registryGoLive(db: Database, table: string): Promise<Date | null> {
  const [row] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from ${sql.identifier(table)}`,
  );
  return row?.go_live ? new Date(row.go_live) : null;
}

/**
 * `InstalledCapacityAsOf(scope, technology, t) → MW` — the domain model's
 * function, made a query.
 *
 * Sums `rated_power_mw` over the units live on the fleet date, grouped by the
 * plant's subsystem and technology. Not a stored column anywhere: a plant's
 * capacity is the sum over its units *at a date*, and the units of one plant
 * routinely commission months apart.
 */
export async function readInstalledCapacityAsOf(
  db: Database,
  query: InstalledCapacityQuery,
): Promise<InstalledCapacityResult> {
  const subsystemFilter = query.subsystem
    ? sql`and p.subsystem = ${query.subsystem}`
    : sql``;
  const technologyFilter = query.technology
    ? sql`and p.technology = ${query.technology}`
    : sql``;

  const rows = await db.execute<{
    subsystem: SubsystemCode;
    technology: Technology;
    plants: number;
    units: number;
    capacity_mw: number;
  }>(sql`
    with units as (${latestUnits(query.asOf)})
    select p.subsystem, p.technology,
           count(distinct units.plant_ceg_core)::int as plants,
           count(*)::int as units,
           sum(units.rated_power_mw) as capacity_mw
    from units
    join plant p on p.ceg_core = units.plant_ceg_core
    where ${liveOn(query.on)}
      ${subsystemFilter}
      ${technologyFilter}
    group by p.subsystem, p.technology
    order by p.subsystem, p.technology
  `);

  const groups = [...rows].map((row) => ({
    subsystem: row.subsystem,
    technology: row.technology,
    plants: row.plants,
    units: row.units,
    capacityMw: Number(row.capacity_mw),
  }));
  const goLiveAt = await registryGoLive(db, "generating_unit");

  return {
    groups,
    totalMw: groups.reduce((total, group) => total + group.capacityMw, 0),
    // The registry snapshot is today's record of the past: a fleet date before
    // WattSteer's first ingest can only be answered from ONS's current cut.
    vintageFidelity:
      goLiveAt && query.on >= goLiveAt ? "point_in_time" : "revision_optimistic",
    goLiveAt,
  };
}

/** One plant's capacity at a date — the grain capacity weighting consumes. */
export interface PlantCapacityRow {
  cegCore: string;
  onsPlantCode: string | null;
  name: string;
  subsystem: SubsystemCode;
  technology: Technology;
  operationModality: OperationModality;
  capacityMw: number;
  units: number;
}

/**
 * Per-plant installed capacity at a date.
 *
 * The same reconstruction as `readInstalledCapacityAsOf`, one grain finer: this
 * is the vector capacity-weighted weather aggregation weights by, and the
 * reason it must be time-varying rather than fixed.
 */
export async function readPlantCapacityAsOf(
  db: Database,
  query: InstalledCapacityQuery,
): Promise<PlantCapacityRow[]> {
  const subsystemFilter = query.subsystem
    ? sql`and p.subsystem = ${query.subsystem}`
    : sql``;
  const technologyFilter = query.technology
    ? sql`and p.technology = ${query.technology}`
    : sql``;

  const rows = await db.execute<{
    ceg_core: string;
    ons_plant_code: string | null;
    name: string;
    subsystem: SubsystemCode;
    technology: Technology;
    operation_modality: OperationModality;
    capacity_mw: number;
    units: number;
  }>(sql`
    with units as (${latestUnits(query.asOf)})
    select p.ceg_core, p.ons_plant_code, p.name, p.subsystem, p.technology,
           p.operation_modality,
           sum(units.rated_power_mw) as capacity_mw,
           count(*)::int as units
    from units
    join plant p on p.ceg_core = units.plant_ceg_core
    where ${liveOn(query.on)}
      ${subsystemFilter}
      ${technologyFilter}
    group by p.ceg_core, p.ons_plant_code, p.name, p.subsystem, p.technology,
             p.operation_modality
    order by p.ceg_core
  `);

  return [...rows].map((row) => ({
    cegCore: row.ceg_core,
    onsPlantCode: row.ons_plant_code,
    name: row.name,
    subsystem: row.subsystem,
    technology: row.technology,
    operationModality: row.operation_modality,
    capacityMw: Number(row.capacity_mw),
    units: row.units,
  }));
}

export interface ConjuntoMembershipQuery extends RegistryAsOfQuery {
  conjuntoCode?: string;
  plantOnsCode?: string;
}

export interface ConjuntoMembershipRow extends RegistryConjuntoMembership {
  dataVersion: number;
  publishedAt: Date;
  ingestedAt: Date;
}

export interface ConjuntoMembershipResult {
  rows: ConjuntoMembershipRow[];
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

/**
 * Conjunto membership resolved as of a date, honouring the validity dates.
 *
 * `member_to` is compared with `>=` because it is the **inclusive** last day of
 * membership — measured against the live file, where all 331 sequential
 * memberships hand over on consecutive days. An exclusive reading would leave
 * every plant that ever changed conjunto unattributed for exactly one day.
 *
 * The one-conjunto-per-plant invariant is asserted at ingest rather than
 * enforced here, so this returns at most one row per plant by construction —
 * and the Postgres suite checks that it does.
 */
export async function readConjuntoMembershipAsOf(
  db: Database,
  query: ConjuntoMembershipQuery,
): Promise<ConjuntoMembershipResult> {
  const conjuntoFilter = query.conjuntoCode
    ? sql`and m.conjunto_code = ${query.conjuntoCode}`
    : sql``;
  const plantFilter = query.plantOnsCode
    ? sql`and m.plant_ons_code = ${query.plantOnsCode}`
    : sql``;

  const rows = await db.execute<{
    plant_ons_code: string;
    plant_ceg_core: string | null;
    conjunto_code: string;
    member_from: string;
    member_to: string | null;
    data_version: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    with latest as (
      select distinct on (plant_ons_code, conjunto_code, member_from)
        plant_ons_code, plant_ceg_core, conjunto_code, member_from, member_to,
        data_version, published_at, ingested_at
      from conjunto_membership
      where ingested_at <= ${query.asOf.toISOString()}::timestamptz
      order by plant_ons_code, conjunto_code, member_from,
               ingested_at desc, data_version desc
    )
    select * from latest m
    where m.member_from <= ${asDay(query.on)}::timestamptz
      and (m.member_to is null or m.member_to >= ${asDay(query.on)}::timestamptz)
      ${conjuntoFilter}
      ${plantFilter}
    order by m.conjunto_code, m.plant_ons_code
  `);

  const goLiveAt = await registryGoLive(db, "conjunto_membership");

  return {
    rows: [...rows].map((row) => ({
      plantOnsCode: row.plant_ons_code,
      plantCegCore: row.plant_ceg_core,
      conjuntoCode: row.conjunto_code,
      memberFrom: new Date(row.member_from),
      memberTo: row.member_to === null ? null : new Date(row.member_to),
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintageFidelity:
      goLiveAt && query.on >= goLiveAt ? "point_in_time" : "revision_optimistic",
    goLiveAt,
  };
}

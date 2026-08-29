import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { observedPlant, plantDetailHour } from "../database/schema.js";
import type { VintageFidelity } from "./repository.js";
import type {
  ObservedPlant,
  PlantDetailHour,
  ResourceMeasurement,
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
 * Bitemporal persistence for the plant-grain constrained-off detail.
 *
 * The append-and-version algorithm is shared — see `versioned-write.ts`. What
 * lives here is the plant dimension, the technology-dependent placement of the
 * one measured resource, and the reconciliation of this dataset's plant
 * identity against the entity-grain and registry dimensions.
 *
 * Nothing in this module reads, writes or joins a restriction reason, and there
 * is no column here through which one could travel: the `_detail` files carry
 * none, and at Tipo II-C grain none exists to carry.
 */

/** Digest of the values a plant-hour stores. */
export function plantDetailDigest(row: PlantDetailHour): string {
  return digestValues([
    row.plantOnsCode,
    row.technology,
    row.validTime.toISOString(),
    row.estimatedGenerationMwh,
    row.verifiedGenerationMwh,
    // The measured resource is part of the value: ONS restating a wind speed
    // without touching a generation number is a real revision, and a digest
    // over the energies alone would swallow it.
    row.measurement?.value ?? null,
    row.measurement === null ? null : row.measurement.invalid ? "1" : "0",
    String(row.halfHoursObserved),
  ]);
}

const SPEC: VersionedTableSpec<PlantDetailHour, typeof plantDetailHour.$inferInsert> = {
  table: plantDetailHour,
  tableName: "plant_detail_hour",
  keyColumns: ["plant_ons_code", "technology", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) =>
    `${row.plantOnsCode}|${row.technology}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: plantDetailDigest,
  toInsert: (row, version, vintage) => ({
    plantOnsCode: row.plantOnsCode,
    technology: row.technology,
    validTime: row.validTime,
    dataVersion: version.dataVersion,
    estimatedGenerationMwh: row.estimatedGenerationMwh,
    verifiedGenerationMwh: row.verifiedGenerationMwh,
    // The technology decides which unit-bearing column the one measurement
    // lands in; the CHECK constraints make any other placement unrepresentable
    // for every writer, not just this one.
    measuredWindSpeedMs:
      row.technology === "WIND" ? (row.measurement?.value ?? null) : null,
    measuredIrradianceWm2:
      row.technology === "SOLAR" ? (row.measurement?.value ?? null) : null,
    measurementInvalid: row.measurement === null ? null : row.measurement.invalid ? 1 : 0,
    halfHoursObserved: row.halfHoursObserved,
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

/**
 * Upsert the plants a file mentioned.
 *
 * A dimension, so a genuine upsert: the row answers "what is this ONS code?",
 * which has one current answer. `last_seen_at` advances; `first_seen_at` never
 * moves.
 */
export async function upsertObservedPlants(
  db: Database,
  plants: ObservedPlant[],
  seenAt: Date = new Date(),
): Promise<number> {
  if (plants.length === 0) {
    return 0;
  }
  for (let offset = 0; offset < plants.length; offset += INSERT_CHUNK) {
    await db
      .insert(observedPlant)
      .values(
        plants.slice(offset, offset + INSERT_CHUNK).map((plant) => ({
          ...plant,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
        })),
      )
      .onConflictDoUpdate({
        target: observedPlant.onsCode,
        set: {
          cegCore: sql`excluded.ceg_core`,
          cegRaw: sql`excluded.ceg_raw`,
          name: sql`excluded.name`,
          subsystem: sql`excluded.subsystem`,
          stateCode: sql`excluded.state_code`,
          technology: sql`excluded.technology`,
          operationModality: sql`excluded.operation_modality`,
          lastSeenAt: sql`greatest(${observedPlant.lastSeenAt}, excluded.last_seen_at)`,
        },
      });
  }
  return plants.length;
}

/** What to write, and the vintage to stamp on it. */
export interface PlantDetailWrite extends VintageStamp {
  rows: PlantDetailHour[];
}

export type PlantDetailWriteResult = VersionedWriteResult;

/** Append the rows whose values actually changed. Idempotent on re-ingest. */
export async function writePlantDetail(
  db: Database,
  write: PlantDetailWrite,
): Promise<PlantDetailWriteResult> {
  const { rows, ...vintage } = write;
  return writeVersioned(db, SPEC, rows, vintage);
}

/** One row of an as-of read, carrying the vintage it came from. */
export interface PlantDetailAsOfRow extends PlantDetailHour {
  dataVersion: number;
  publishedAt: Date;
  ingestedAt: Date;
}

export interface PlantDetailAsOfResult {
  rows: PlantDetailAsOfRow[];
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

export interface PlantDetailAsOfQuery {
  asOf: Date;
  from: Date;
  to: Date;
  technology?: Technology;
  plantOnsCode?: string;
}

/**
 * `AsOf(t)` — the only sanctioned read of the fact table.
 *
 * The projected columns are the whole table. There is deliberately no variant
 * of this read that joins a reason in, and no parameter by which one could be
 * requested: `curtailment_report_hour` is keyed by reporting entity and this is
 * keyed by plant, and the two are the same key only for the 18 self-reporting
 * plants. A caller that wants a reason must ask for the entity's reason at the
 * entity's grain and say so on the screen.
 */
export async function readPlantDetailAsOf(
  db: Database,
  query: PlantDetailAsOfQuery,
): Promise<PlantDetailAsOfResult> {
  const technologyFilter = query.technology
    ? sql`and technology = ${query.technology}`
    : sql``;
  const plantFilter = query.plantOnsCode
    ? sql`and plant_ons_code = ${query.plantOnsCode}`
    : sql``;

  const rows = await db.execute<{
    plant_ons_code: string;
    technology: Technology;
    valid_time: string;
    data_version: number;
    estimated_generation_mwh: number | null;
    verified_generation_mwh: number | null;
    measured_wind_speed_ms: number | null;
    measured_irradiance_wm2: number | null;
    measurement_invalid: number | null;
    half_hours_observed: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select distinct on (plant_ons_code, technology, valid_time)
      plant_ons_code, technology, valid_time, data_version,
      estimated_generation_mwh, verified_generation_mwh,
      measured_wind_speed_ms, measured_irradiance_wm2,
      measurement_invalid, half_hours_observed,
      published_at, ingested_at
    from plant_detail_hour
    where ingested_at <= ${query.asOf.toISOString()}::timestamptz
      and valid_time >= ${query.from.toISOString()}::timestamptz
      and valid_time < ${query.to.toISOString()}::timestamptz
      ${technologyFilter}
      ${plantFilter}
    order by plant_ons_code, technology, valid_time,
             ingested_at desc, data_version desc
  `);

  const [goLive] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from plant_detail_hour`,
  );
  const goLiveAt = goLive?.go_live ? new Date(goLive.go_live) : null;

  return {
    rows: [...rows].map((row) => {
      const raw =
        row.technology === "WIND"
          ? row.measured_wind_speed_ms
          : row.measured_irradiance_wm2;
      // Reconstructed as the value object it is: reading and flag, or neither.
      const measurement: ResourceMeasurement | null =
        raw === null || row.measurement_invalid === null
          ? null
          : { value: Number(raw), invalid: row.measurement_invalid === 1 };
      return {
        plantOnsCode: row.plant_ons_code,
        technology: row.technology,
        validTime: new Date(row.valid_time),
        estimatedGenerationMwh:
          row.estimated_generation_mwh === null
            ? null
            : Number(row.estimated_generation_mwh),
        verifiedGenerationMwh:
          row.verified_generation_mwh === null
            ? null
            : Number(row.verified_generation_mwh),
        measurement,
        halfHoursObserved: row.half_hours_observed,
        dataVersion: row.data_version,
        publishedAt: new Date(row.published_at),
        ingestedAt: new Date(row.ingested_at),
      };
    }),
    vintageFidelity:
      goLiveAt && query.from >= goLiveAt ? "point_in_time" : "revision_optimistic",
    goLiveAt,
  };
}

/** A plant whose identity the two grains disagree about. */
export interface PlantIdentityConflict {
  onsCode: string;
  /** What the `_detail` file said. */
  detailCegCore: string;
  /** What the entity-grain file said — null for a conjunto, which has no CEG. */
  entityCegCore: string | null;
  entityKind: "CONJUNTO" | "PLANT";
}

/** What reconciling the plant-grain identity against the other two found. */
export interface PlantIdentityReconciliation {
  /** ONS codes present in both `observed_plant` and `reporting_entity`. */
  selfReporting: number;
  /** Of those, the ones whose kind or CEG disagree. Expected: none. */
  conflicts: PlantIdentityConflict[];
  /** `plant.ons_plant_code` filled in from this dataset. */
  linkedRegistryPlants: number;
  /** CEG cores carrying more than one ONS code, so nothing was linked. */
  ambiguousCegCores: number;
}

/**
 * Reconcile plant identity across the three dimensions that name plants.
 *
 * Three tables carry a plant's identity and each is missing a piece of it:
 * `plant` (registry) has the CEG and no `id_ons`; `reporting_entity`
 * (entity-grain constrained-off) has the `id_ons` but only for the 18
 * self-reporting plants — everything else there is a `CJU_` conjunto code; and
 * `observed_plant` (this dataset) has both, for every plant that was ever
 * measured. This function is what makes the third resolve the other two rather
 * than sit beside them:
 *
 * - **Against `reporting_entity`**: an ONS code in both must be a `PLANT`
 *   there, with the same `ceg_core`. A conjunto code appearing in a `_detail`
 *   file, or two CEGs for one code, means the identity assumption has broken
 *   and it is reported, not repaired.
 * - **Against `plant`**: fill `ons_plant_code` where it is still null and this
 *   dataset maps the CEG core to exactly one ONS code. Where a core carries
 *   several the column stays null, exactly as `linkPlantOnsCodes` leaves it —
 *   picking one would be a guess presented as a fact.
 *
 * Note what is *not* reconciled: nothing here resolves a plant to the conjunto
 * it settles under. That resolution exists, is time-dependent, and lives in
 * `conjunto_membership` where every read must pass a date through it.
 */
export async function reconcilePlantIdentity(
  db: Database,
): Promise<PlantIdentityReconciliation> {
  const conflicts = await db.execute<{
    ons_code: string;
    detail_ceg_core: string;
    entity_ceg_core: string | null;
    entity_kind: "CONJUNTO" | "PLANT";
  }>(sql`
    select
      op.ons_code,
      op.ceg_core as detail_ceg_core,
      re.ceg_core as entity_ceg_core,
      re.kind as entity_kind
    from observed_plant op
    join reporting_entity re on re.ons_code = op.ons_code
    where re.kind <> 'PLANT' or re.ceg_core is distinct from op.ceg_core
    order by op.ons_code
  `);

  const [shared] = await db.execute<{ shared: number }>(sql`
    select count(*)::int as shared
    from observed_plant op
    join reporting_entity re on re.ons_code = op.ons_code
  `);

  const [ambiguity] = await db.execute<{ ambiguous: number }>(sql`
    select count(*)::int as ambiguous from (
      select ceg_core from observed_plant
      group by ceg_core having count(distinct ons_code) > 1
    ) as multiples
  `);

  const linked = await db.execute<{ ceg_core: string }>(sql`
    update plant set ons_plant_code = unique_codes.ons_code
    from (
      select ceg_core, min(ons_code) as ons_code
      from observed_plant
      group by ceg_core having count(distinct ons_code) = 1
    ) as unique_codes
    where plant.ceg_core = unique_codes.ceg_core
      and plant.ons_plant_code is null
    returning plant.ceg_core
  `);

  return {
    selfReporting: shared?.shared ?? 0,
    conflicts: [...conflicts].map((row) => ({
      onsCode: row.ons_code,
      detailCegCore: row.detail_ceg_core,
      entityCegCore: row.entity_ceg_core,
      entityKind: row.entity_kind,
    })),
    linkedRegistryPlants: [...linked].length,
    ambiguousCegCores: ambiguity?.ambiguous ?? 0,
  };
}

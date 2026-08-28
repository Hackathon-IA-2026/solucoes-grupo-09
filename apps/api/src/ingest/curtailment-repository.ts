import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { curtailmentReportHour, reportingEntity } from "../database/schema.js";
import type { VintageFidelity } from "./repository.js";
import type {
  CurtailmentReportHour,
  ObservedReportingEntity,
  ReasonCode,
  RestrictionOrigin,
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
 * Bitemporal persistence for constrained-off.
 *
 * The append-and-version algorithm is shared — see `versioned-write.ts`. What
 * lives here is what is specific to this table: an entity dimension to
 * maintain, a composite key carrying a technology, a nullable value object, and
 * its own as-of projection.
 */

/**
 * Digest of the values a row stores.
 *
 * The cause is part of the value: the source revising a reason from `CNF` to
 * `ENE` without changing a single number is a real restatement, and a digest
 * over the measures alone would silently swallow it.
 */
export function curtailmentDigest(row: CurtailmentReportHour): string {
  return digestValues([
    row.reportingEntityCode,
    row.technology,
    row.validTime.toISOString(),
    row.generationMwh,
    row.constrainedOffMwh,
    row.referenceGenerationMwh,
    row.finalReferenceGenerationMwh,
    row.availabilityMw,
    String(row.halfHoursObserved),
    row.cause?.reason ?? null,
    row.cause?.origin ?? null,
    row.cause?.description ?? null,
    row.causeMixed ? "1" : "0",
  ]);
}

const SPEC: VersionedTableSpec<
  CurtailmentReportHour,
  typeof curtailmentReportHour.$inferInsert
> = {
  table: curtailmentReportHour,
  tableName: "curtailment_report_hour",
  keyColumns: ["reporting_entity_code", "technology", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) =>
    `${row.reportingEntityCode}|${row.technology}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: curtailmentDigest,
  toInsert: (row, version, vintage) => ({
    reportingEntityCode: row.reportingEntityCode,
    technology: row.technology,
    validTime: row.validTime,
    dataVersion: version.dataVersion,
    generationMwh: row.generationMwh,
    constrainedOffMwh: row.constrainedOffMwh,
    referenceGenerationMwh: row.referenceGenerationMwh,
    finalReferenceGenerationMwh: row.finalReferenceGenerationMwh,
    availabilityMw: row.availabilityMw,
    halfHoursObserved: row.halfHoursObserved,
    // Written as a whole or not at all — the CHECK constraint on this table
    // makes a half-populated pair unrepresentable, not merely discouraged.
    reason: row.cause?.reason ?? null,
    origin: row.cause?.origin ?? null,
    restrictionDescription: row.cause?.description ?? null,
    causeMixed: row.causeMixed ? 1 : 0,
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

/**
 * Upsert the entities a file mentioned.
 *
 * A dimension, so this is a genuine upsert rather than an append: the row
 * answers "what is this code?", which has one current answer. `last_seen_at`
 * advances; `first_seen_at` never moves.
 */
export async function upsertReportingEntities(
  db: Database,
  entities: ObservedReportingEntity[],
  seenAt: Date = new Date(),
): Promise<number> {
  if (entities.length === 0) {
    return 0;
  }
  for (let offset = 0; offset < entities.length; offset += INSERT_CHUNK) {
    await db
      .insert(reportingEntity)
      .values(
        entities.slice(offset, offset + INSERT_CHUNK).map((entity) => ({
          ...entity,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
        })),
      )
      .onConflictDoUpdate({
        target: reportingEntity.onsCode,
        set: {
          name: sql`excluded.name`,
          subsystem: sql`excluded.subsystem`,
          stateCode: sql`excluded.state_code`,
          cegCore: sql`excluded.ceg_core`,
          kind: sql`excluded.kind`,
          lastSeenAt: sql`greatest(${reportingEntity.lastSeenAt}, excluded.last_seen_at)`,
        },
      });
  }
  return entities.length;
}

/** What to write, and the vintage to stamp on it. */
export interface CurtailmentWrite extends VintageStamp {
  rows: CurtailmentReportHour[];
}

export type CurtailmentWriteResult = VersionedWriteResult;

/** Append the rows whose values actually changed. Idempotent on re-ingest. */
export async function writeCurtailment(
  db: Database,
  write: CurtailmentWrite,
): Promise<CurtailmentWriteResult> {
  const { rows, ...vintage } = write;
  return writeVersioned(db, SPEC, rows, vintage);
}

/** One row of an as-of read, carrying the vintage it came from. */
export interface CurtailmentAsOfRow extends CurtailmentReportHour {
  dataVersion: number;
  publishedAt: Date;
  ingestedAt: Date;
}

export interface CurtailmentAsOfResult {
  rows: CurtailmentAsOfRow[];
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

export interface CurtailmentAsOfQuery {
  asOf: Date;
  from: Date;
  to: Date;
  technology?: Technology;
  reportingEntityCode?: string;
}

/**
 * `AsOf(t)` — the only sanctioned read of the fact table.
 *
 * `DISTINCT ON` over the business key ordered by descending `ingested_at`
 * returns exactly one row per key or none. The `data_version` tiebreak matters
 * because a backfill can write several versions at one instant.
 */
export async function readCurtailmentAsOf(
  db: Database,
  query: CurtailmentAsOfQuery,
): Promise<CurtailmentAsOfResult> {
  const technologyFilter = query.technology
    ? sql`and technology = ${query.technology}`
    : sql``;
  const entityFilter = query.reportingEntityCode
    ? sql`and reporting_entity_code = ${query.reportingEntityCode}`
    : sql``;

  const rows = await db.execute<{
    reporting_entity_code: string;
    technology: Technology;
    valid_time: string;
    data_version: number;
    generation_mwh: number;
    constrained_off_mwh: number;
    reference_generation_mwh: number | null;
    final_reference_generation_mwh: number | null;
    availability_mw: number | null;
    half_hours_observed: number;
    reason: string | null;
    origin: string | null;
    restriction_description: string | null;
    cause_mixed: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select distinct on (reporting_entity_code, technology, valid_time)
      reporting_entity_code, technology, valid_time, data_version,
      generation_mwh, constrained_off_mwh,
      reference_generation_mwh, final_reference_generation_mwh,
      availability_mw, half_hours_observed,
      reason, origin, restriction_description, cause_mixed,
      published_at, ingested_at
    from curtailment_report_hour
    where ingested_at <= ${query.asOf.toISOString()}::timestamptz
      and valid_time >= ${query.from.toISOString()}::timestamptz
      and valid_time < ${query.to.toISOString()}::timestamptz
      ${technologyFilter}
      ${entityFilter}
    order by reporting_entity_code, technology, valid_time,
             ingested_at desc, data_version desc
  `);

  const [goLive] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from curtailment_report_hour`,
  );
  const goLiveAt = goLive?.go_live ? new Date(goLive.go_live) : null;

  return {
    rows: [...rows].map((row) => ({
      reportingEntityCode: row.reporting_entity_code,
      technology: row.technology,
      validTime: new Date(row.valid_time),
      generationMwh: Number(row.generation_mwh),
      constrainedOffMwh: Number(row.constrained_off_mwh),
      referenceGenerationMwh:
        row.reference_generation_mwh === null
          ? null
          : Number(row.reference_generation_mwh),
      finalReferenceGenerationMwh:
        row.final_reference_generation_mwh === null
          ? null
          : Number(row.final_reference_generation_mwh),
      availabilityMw: row.availability_mw === null ? null : Number(row.availability_mw),
      halfHoursObserved: row.half_hours_observed,
      // Reconstructed as the value object it is: all three or none.
      cause:
        row.reason === null || row.origin === null
          ? null
          : {
              reason: row.reason as ReasonCode,
              origin: row.origin as RestrictionOrigin,
              description: row.restriction_description,
            },
      causeMixed: row.cause_mixed === 1,
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintageFidelity:
      goLiveAt && query.from >= goLiveAt ? "point_in_time" : "revision_optimistic",
    goLiveAt,
  };
}

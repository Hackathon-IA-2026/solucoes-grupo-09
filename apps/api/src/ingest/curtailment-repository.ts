import { createHash } from "node:crypto";
import { and, gte, lte, sql } from "drizzle-orm";
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

/**
 * Bitemporal persistence for constrained-off, following the decisions the
 * energy-balance repository established: facts are wide and append-only, and
 * `data_version` is a digest of the stored value tuple rather than of the
 * source file or a counter.
 *
 * Kept in its own module rather than added to `repository.ts` because the two
 * tables share a *pattern*, not code — this one has an entity dimension to
 * maintain, a nullable value object, and a composite key with a technology in
 * it. Forcing them into one generic would obscure both.
 */

const INSERT_CHUNK = 1000;
const DIGEST_PRECISION = 6;

/**
 * Digest of the values a row stores, and of nothing else.
 *
 * The cause is part of the value: ONS revising a reason from `CNF` to `ENE`
 * without changing a single number is a real restatement, and a digest over
 * the measures alone would silently swallow it.
 */
export function curtailmentDigest(row: CurtailmentReportHour): string {
  const parts = [
    row.reportingEntityCode,
    row.technology,
    row.validTime.toISOString(),
    row.generationMwh.toFixed(DIGEST_PRECISION),
    row.constrainedOffMwh.toFixed(DIGEST_PRECISION),
    row.referenceGenerationMwh?.toFixed(DIGEST_PRECISION) ?? "",
    row.finalReferenceGenerationMwh?.toFixed(DIGEST_PRECISION) ?? "",
    row.availabilityMw?.toFixed(DIGEST_PRECISION) ?? "",
    String(row.halfHoursObserved),
    row.cause?.reason ?? "",
    row.cause?.origin ?? "",
    row.cause?.description ?? "",
    row.causeMixed ? "1" : "0",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

const businessKey = (row: {
  reportingEntityCode: string;
  technology: string;
  validTime: Date;
}): string =>
  `${row.reportingEntityCode}|${row.technology}|${row.validTime.toISOString()}`;

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

export interface CurtailmentWrite {
  rows: CurtailmentReportHour[];
  publishedAt: Date;
  publishedAtPrecision: "row" | "file";
  sourceVersionId: string;
  ingestedAt?: Date;
}

export interface CurtailmentWriteResult {
  inserted: number;
  revised: number;
  unchanged: number;
}

interface LatestVersion {
  dataVersion: number;
  valueDigest: string;
}

async function loadLatest(
  db: Database,
  from: Date,
  to: Date,
): Promise<Map<string, LatestVersion>> {
  const rows = await db
    .selectDistinctOn(
      [
        curtailmentReportHour.reportingEntityCode,
        curtailmentReportHour.technology,
        curtailmentReportHour.validTime,
      ],
      {
        reportingEntityCode: curtailmentReportHour.reportingEntityCode,
        technology: curtailmentReportHour.technology,
        validTime: curtailmentReportHour.validTime,
        dataVersion: curtailmentReportHour.dataVersion,
        valueDigest: curtailmentReportHour.valueDigest,
      },
    )
    .from(curtailmentReportHour)
    .where(
      and(
        gte(curtailmentReportHour.validTime, from),
        lte(curtailmentReportHour.validTime, to),
      ),
    )
    .orderBy(
      curtailmentReportHour.reportingEntityCode,
      curtailmentReportHour.technology,
      curtailmentReportHour.validTime,
      sql`${curtailmentReportHour.dataVersion} desc`,
    );

  return new Map(
    rows.map((row) => [
      businessKey(row),
      { dataVersion: row.dataVersion, valueDigest: row.valueDigest },
    ]),
  );
}

/**
 * Append the rows whose values actually changed.
 *
 * Idempotent: a second run over the same parse writes nothing, because every
 * digest matches the version already stored. That is what makes a retry safe.
 */
export async function writeCurtailment(
  db: Database,
  write: CurtailmentWrite,
): Promise<CurtailmentWriteResult> {
  const result: CurtailmentWriteResult = { inserted: 0, revised: 0, unchanged: 0 };
  if (write.rows.length === 0) {
    return result;
  }

  const times = write.rows.map((row) => row.validTime.getTime());
  const latest = await loadLatest(
    db,
    new Date(Math.min(...times)),
    new Date(Math.max(...times)),
  );
  const ingestedAt = write.ingestedAt ?? new Date();

  const pending: (typeof curtailmentReportHour.$inferInsert)[] = [];
  for (const row of write.rows) {
    const digest = curtailmentDigest(row);
    const current = latest.get(businessKey(row));
    if (current?.valueDigest === digest) {
      result.unchanged += 1;
      continue;
    }
    if (current) {
      result.revised += 1;
    } else {
      result.inserted += 1;
    }
    pending.push({
      reportingEntityCode: row.reportingEntityCode,
      technology: row.technology,
      validTime: row.validTime,
      dataVersion: (current?.dataVersion ?? 0) + 1,
      generationMwh: row.generationMwh,
      constrainedOffMwh: row.constrainedOffMwh,
      referenceGenerationMwh: row.referenceGenerationMwh,
      finalReferenceGenerationMwh: row.finalReferenceGenerationMwh,
      availabilityMw: row.availabilityMw,
      halfHoursObserved: row.halfHoursObserved,
      reason: row.cause?.reason ?? null,
      origin: row.cause?.origin ?? null,
      restrictionDescription: row.cause?.description ?? null,
      causeMixed: row.causeMixed ? 1 : 0,
      publishedAt: write.publishedAt,
      publishedAtPrecision: write.publishedAtPrecision,
      ingestedAt,
      valueDigest: digest,
      sourceVersionId: write.sourceVersionId,
    });
  }

  for (let offset = 0; offset < pending.length; offset += INSERT_CHUNK) {
    await db
      .insert(curtailmentReportHour)
      .values(pending.slice(offset, offset + INSERT_CHUNK))
      .onConflictDoNothing();
  }

  return result;
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

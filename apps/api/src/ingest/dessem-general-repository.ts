import type { Database } from "../database/connection.js";
import { dessemGeneralHalfHour } from "../database/schema.js";
import { PayloadRefusedError } from "../errors.js";
import { upstreamCause } from "./dessem-repository.js";
import type { DessemGeneralHalfHour } from "./types.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Bitemporal persistence for `balanco_dessem_geral` — the second bulk-file
 * **`Forecast`**, and a cross-check on the first.
 *
 * Everything that makes `dessem-repository.ts` what it is applies here and is
 * not restated: the append-and-version algorithm is the shared one, and
 * `published_at` is the evening-of-D−1 file creation, which is what makes
 * `published_at ≤ gate` a genuine point-in-time filter over backfilled history.
 * What is *absent* is the coverage bookkeeping — this adapter refuses a short
 * day, so every stored day is whole and there is no shortfall to encode in the
 * digest.
 */

/**
 * Digest of a geral row's stored values, and nothing else.
 *
 * The run label is part of the value tuple, not of the vintage: a *different
 * reference day* producing the same half hour would be a different forecast,
 * not a restatement of this one.
 */
export function dessemGeneralDigest(row: DessemGeneralHalfHour): string {
  return digestValues([
    row.subsystem,
    row.validTime.toISOString(),
    row.referenceDay,
    row.demandMw,
    row.renewableGenerationMw,
    row.hydroGenerationMw,
    row.thermalGenerationMw,
    row.pumpingConsumptionMw,
  ]);
}

const SPEC: VersionedTableSpec<
  DessemGeneralHalfHour,
  typeof dessemGeneralHalfHour.$inferInsert
> = {
  table: dessemGeneralHalfHour,
  tableName: "dessem_general_half_hour",
  keyColumns: ["subsystem", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) => `${row.subsystem}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: dessemGeneralDigest,
  toInsert: (row, version, vintage) => ({
    subsystem: row.subsystem,
    validTime: row.validTime,
    forecastProducer: "ons_dessem" as const,
    runLabel: row.referenceDay,
    demandMw: row.demandMw,
    renewableGenerationMw: row.renewableGenerationMw,
    hydroGenerationMw: row.hydroGenerationMw,
    thermalGenerationMw: row.thermalGenerationMw,
    pumpingConsumptionMw: row.pumpingConsumptionMw,
    dataVersion: version.dataVersion,
    // The file's `Last-Modified`: ONS stamps no row individually, so the
    // coarsest honest answer is the file, and the precision column says so.
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

export interface DessemGeneralWrite extends VintageStamp {
  rows: DessemGeneralHalfHour[];
  /**
   * CKAN's `created` for the resource these rows came from — never written and
   * never compared against. It exists so a `forecast_integrity` refusal can say
   * which of two upstream facts produced it, exactly as on the detalhe write.
   */
  firstPublishedAt?: Date | null;
}

export type DessemGeneralWriteResult = VersionedWriteResult;

/**
 * Append the geral rows whose values actually changed. Idempotent.
 *
 * The forecast shape is checked here, before the first insert, rather than left
 * to the table's check constraint: the constraint is the guarantee and this is
 * the *diagnosis* — which reference day was published too late, and by how much.
 */
export async function writeDessemGeneral(
  db: Database,
  write: DessemGeneralWrite,
): Promise<DessemGeneralWriteResult> {
  const { rows, firstPublishedAt, ...vintage } = write;
  for (const row of rows) {
    if (row.validTime.getTime() <= vintage.publishedAt.getTime()) {
      throw new PayloadRefusedError(
        "forecast_integrity",
        `DESSEM geral reference day ${row.referenceDay} was published at ` +
          `${vintage.publishedAt.toISOString()}, at or after the ` +
          `${row.validTime.toISOString()} half hour it describes. A row with ` +
          "published_at ≥ valid_time is an observation, and this table holds " +
          `forecasts. ${upstreamCause(row.validTime, firstPublishedAt)}`,
      );
    }
  }
  return writeVersioned(db, SPEC, rows, vintage);
}

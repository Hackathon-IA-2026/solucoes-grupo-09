import type { Database } from "../database/connection.js";
import {
  controlledFlowHalfHour,
  programmedGenerationHalfHour,
  programmedVsForecastHalfHour,
} from "../database/schema.js";
import { PayloadRefusedError } from "../errors.js";
import type {
  ControlledFlowHalfHour,
  ProgrammedGenerationHalfHour,
  ProgrammedVsForecastHalfHour,
} from "./types.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Bitemporal persistence for the three day-ahead programme datasets —
 * `programacao_diaria`, `programacao_x_previsao`, `programacao_fluxo_controlado`.
 *
 * All three are **`Forecast`s** and share everything `dessem-general-repository.ts`
 * argues for: the append-and-version algorithm is the shared one, a re-ingest with
 * identical numbers writes nothing, and `published_at` is what makes
 * `published_at ≤ gate` a point-in-time filter. What differs is where the stamp
 * comes from. It is `programmeFilePublishedAt`'s 23:00 on D−1, passed in by the
 * job, and **not** the file's `Last-Modified` — see `ons/programme.ts` for the
 * two measured days on which that would have broken the forecast constraint.
 *
 * A restatement therefore has the *same* `published_at` as the row it revises and
 * a later `ingested_at`, which is exactly what the vintage axes are for: the
 * digest excludes both, so only a change in the numbers bumps `data_version`.
 */

/** The forecast shape, checked before the first insert so the refusal can say which day. */
function assertForecast(
  dataset: string,
  rows: readonly { validTime: Date; referenceDay: string }[],
  publishedAt: Date,
): void {
  for (const row of rows) {
    if (row.validTime.getTime() <= publishedAt.getTime()) {
      throw new PayloadRefusedError(
        "forecast_integrity",
        `${dataset} reference day ${row.referenceDay} is stamped published at ` +
          `${publishedAt.toISOString()}, at or after the ${row.validTime.toISOString()} half hour ` +
          "it describes. A row with published_at ≥ valid_time is an observation, and this " +
          "table holds forecasts.",
      );
    }
  }
}

// ── programacao_diaria ───────────────────────────────────────────────────────

export function programmedGenerationDigest(row: ProgrammedGenerationHalfHour): string {
  return digestValues([
    row.subsystem,
    row.technology,
    row.validTime.toISOString(),
    row.referenceDay,
    row.plantCount,
    row.reportingPlantCount,
    row.programmedMw,
    row.availabilityMw,
    row.inflexibilityMw,
    row.unitCommitmentMw,
    row.electricalReasonMw,
    row.energyGuaranteeMw,
    row.exportMw,
  ]);
}

const GENERATION_SPEC: VersionedTableSpec<
  ProgrammedGenerationHalfHour,
  typeof programmedGenerationHalfHour.$inferInsert
> = {
  table: programmedGenerationHalfHour,
  tableName: "programmed_generation_half_hour",
  keyColumns: ["subsystem", "technology", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) =>
    `${row.subsystem}|${row.technology}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: programmedGenerationDigest,
  toInsert: (row, version, vintage) => ({
    subsystem: row.subsystem,
    technology: row.technology,
    validTime: row.validTime,
    runLabel: row.referenceDay,
    plantCount: row.plantCount,
    reportingPlantCount: row.reportingPlantCount,
    programmedMw: row.programmedMw,
    availabilityMw: row.availabilityMw,
    inflexibilityMw: row.inflexibilityMw,
    unitCommitmentMw: row.unitCommitmentMw,
    electricalReasonMw: row.electricalReasonMw,
    energyGuaranteeMw: row.energyGuaranteeMw,
    exportMw: row.exportMw,
    dataVersion: version.dataVersion,
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

export interface ProgrammedGenerationWrite extends VintageStamp {
  rows: ProgrammedGenerationHalfHour[];
}

export async function writeProgrammedGeneration(
  db: Database,
  write: ProgrammedGenerationWrite,
): Promise<VersionedWriteResult> {
  const { rows, ...vintage } = write;
  assertForecast("programacao_diaria", rows, vintage.publishedAt);
  return writeVersioned(db, GENERATION_SPEC, rows, vintage);
}

// ── programacao_x_previsao ───────────────────────────────────────────────────

export function programmedVsForecastDigest(row: ProgrammedVsForecastHalfHour): string {
  return digestValues([
    row.pdpCode,
    row.validTime.toISOString(),
    row.referenceDay,
    row.pdpName,
    row.forecastMw,
    row.programmedMw,
  ]);
}

const VS_FORECAST_SPEC: VersionedTableSpec<
  ProgrammedVsForecastHalfHour,
  typeof programmedVsForecastHalfHour.$inferInsert
> = {
  table: programmedVsForecastHalfHour,
  tableName: "programmed_vs_forecast_half_hour",
  keyColumns: ["pdp_code", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) => `${row.pdpCode}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: programmedVsForecastDigest,
  toInsert: (row, version, vintage) => ({
    pdpCode: row.pdpCode,
    validTime: row.validTime,
    runLabel: row.referenceDay,
    pdpName: row.pdpName,
    forecastMw: row.forecastMw,
    programmedMw: row.programmedMw,
    dataVersion: version.dataVersion,
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

export interface ProgrammedVsForecastWrite extends VintageStamp {
  rows: ProgrammedVsForecastHalfHour[];
}

export async function writeProgrammedVsForecast(
  db: Database,
  write: ProgrammedVsForecastWrite,
): Promise<VersionedWriteResult> {
  const { rows, ...vintage } = write;
  assertForecast("programacao_x_previsao", rows, vintage.publishedAt);
  return writeVersioned(db, VS_FORECAST_SPEC, rows, vintage);
}

// ── programacao_fluxo_controlado ─────────────────────────────────────────────

export function controlledFlowDigest(row: ControlledFlowHalfHour): string {
  return digestValues([
    row.element,
    row.terminal,
    row.validTime.toISOString(),
    row.referenceDay,
    row.description,
    row.submarket,
    row.loadMw,
  ]);
}

const FLOW_SPEC: VersionedTableSpec<
  ControlledFlowHalfHour,
  typeof controlledFlowHalfHour.$inferInsert
> = {
  table: controlledFlowHalfHour,
  tableName: "controlled_flow_half_hour",
  keyColumns: ["element", "terminal", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) => `${row.element}|${row.terminal}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: controlledFlowDigest,
  toInsert: (row, version, vintage) => ({
    element: row.element,
    terminal: row.terminal,
    validTime: row.validTime,
    runLabel: row.referenceDay,
    description: row.description,
    submarket: row.submarket,
    loadMw: row.loadMw,
    dataVersion: version.dataVersion,
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

export interface ControlledFlowWrite extends VintageStamp {
  rows: ControlledFlowHalfHour[];
}

export async function writeControlledFlow(
  db: Database,
  write: ControlledFlowWrite,
): Promise<VersionedWriteResult> {
  const { rows, ...vintage } = write;
  assertForecast("programacao_fluxo_controlado", rows, vintage.publishedAt);
  return writeVersioned(db, FLOW_SPEC, rows, vintage);
}

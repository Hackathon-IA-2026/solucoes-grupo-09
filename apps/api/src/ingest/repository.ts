import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { subsystemEnergyBalanceHour } from "../database/schema.js";
import type { SubsystemCode } from "./normalise.js";
import type { EnergyBalanceHour } from "./types.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Bitemporal persistence for the energy balance.
 *
 * The append-and-version algorithm lives in `versioned-write.ts` and is shared
 * with every other fact table; what stays here is what is genuinely specific —
 * this table's key, its digest, its insert shape, and its as-of read.
 */

/** Digest of the six stored measures, keyed by the business key. */
export function valueDigest(row: EnergyBalanceHour): string {
  return digestValues([
    row.subsystem,
    row.validTime.toISOString(),
    row.loadMwh,
    row.hydroGenerationMwh,
    row.thermalGenerationMwh,
    row.windGenerationMwh,
    row.solarGenerationMwh,
    row.netExchangeMwh,
  ]);
}

const SPEC: VersionedTableSpec<
  EnergyBalanceHour,
  typeof subsystemEnergyBalanceHour.$inferInsert
> = {
  table: subsystemEnergyBalanceHour,
  tableName: "subsystem_energy_balance_hour",
  keyColumns: ["subsystem", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) => `${row.subsystem}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: valueDigest,
  toInsert: (row, version, vintage) => ({
    ...row,
    dataVersion: version.dataVersion,
    valueDigest: version.valueDigest,
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

/** What to write, and the vintage to stamp on it. */
export interface EnergyBalanceWrite extends VintageStamp {
  rows: EnergyBalanceHour[];
}

export type EnergyBalanceWriteResult = VersionedWriteResult;

/** Append the rows whose values actually changed. Idempotent on re-ingest. */
export async function writeEnergyBalance(
  db: Database,
  write: EnergyBalanceWrite,
): Promise<EnergyBalanceWriteResult> {
  const { rows, ...vintage } = write;
  return writeVersioned(db, SPEC, rows, vintage);
}

/** One row of an as-of read, carrying the vintage it came from. */
export interface EnergyBalanceAsOfRow extends EnergyBalanceHour {
  dataVersion: number;
  publishedAt: Date;
  ingestedAt: Date;
}

/**
 * Whether an as-of read is honestly point-in-time.
 *
 * A window that predates ingestion go-live cannot be: the "past" it returns is
 * the source's *current* restatement of it, because prior vintages are
 * unrecoverable. This can never be repaired retroactively, so it is reported
 * rather than silently answered.
 */
export type VintageFidelity = "point_in_time" | "revision_optimistic";

export interface EnergyBalanceAsOfResult {
  rows: EnergyBalanceAsOfRow[];
  vintageFidelity: VintageFidelity;
  /** Earliest ingestion for this table — WattSteer's own go-live. */
  goLiveAt: Date | null;
}

export interface AsOfQuery {
  /** What WattSteer knew at this instant. */
  asOf: Date;
  /** Valid-time window, `[from, to)`. */
  from: Date;
  to: Date;
  subsystem?: SubsystemCode;
}

/**
 * `AsOf(t)` — the only sanctioned read of this table.
 *
 * The reads are deliberately *not* shared with the other fact tables: each
 * projects different columns and rebuilds a different shape, and a generic that
 * returned untyped rows would push that work onto every caller instead.
 */
export async function readEnergyBalanceAsOf(
  db: Database,
  query: AsOfQuery,
): Promise<EnergyBalanceAsOfResult> {
  const subsystemFilter = query.subsystem
    ? sql`and subsystem = ${query.subsystem}`
    : sql``;

  const rows = await db.execute<{
    subsystem: SubsystemCode;
    valid_time: string;
    data_version: number;
    load_mwh: number;
    hydro_generation_mwh: number;
    thermal_generation_mwh: number;
    wind_generation_mwh: number;
    solar_generation_mwh: number;
    net_exchange_mwh: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select distinct on (subsystem, valid_time)
      subsystem, valid_time, data_version,
      load_mwh, hydro_generation_mwh, thermal_generation_mwh,
      wind_generation_mwh, solar_generation_mwh, net_exchange_mwh,
      published_at, ingested_at
    from subsystem_energy_balance_hour
    where ingested_at <= ${query.asOf.toISOString()}::timestamptz
      and valid_time >= ${query.from.toISOString()}::timestamptz
      and valid_time < ${query.to.toISOString()}::timestamptz
      ${subsystemFilter}
    order by subsystem, valid_time, ingested_at desc, data_version desc
  `);

  const [goLive] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from subsystem_energy_balance_hour`,
  );
  const goLiveAt = goLive?.go_live ? new Date(goLive.go_live) : null;

  return {
    rows: [...rows].map((row) => ({
      subsystem: row.subsystem,
      validTime: new Date(row.valid_time),
      loadMwh: Number(row.load_mwh),
      hydroGenerationMwh: Number(row.hydro_generation_mwh),
      thermalGenerationMwh: Number(row.thermal_generation_mwh),
      windGenerationMwh: Number(row.wind_generation_mwh),
      solarGenerationMwh: Number(row.solar_generation_mwh),
      netExchangeMwh: Number(row.net_exchange_mwh),
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintageFidelity:
      goLiveAt && query.from >= goLiveAt ? "point_in_time" : "revision_optimistic",
    goLiveAt,
  };
}

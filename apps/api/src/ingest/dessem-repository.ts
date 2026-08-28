import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { dessemBalanceHalfHour } from "../database/schema.js";
import { UpstreamError } from "../errors.js";
import type { SubsystemCode } from "./normalise.js";
import type { VintageFidelity } from "./repository.js";
import type { DessemBalanceHalfHour } from "./types.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Bitemporal persistence for the DESSEM day-ahead balance — the platform's
 * first bulk-file **`Forecast`**.
 *
 * The append-and-version algorithm is the shared one (`versioned-write.ts`);
 * what is specific here is the third time axis. Everything else in the platform
 * stores a fact ONS asserted *after* the instant it describes, so the pair
 * (`published_at`, `ingested_at`) is a vintage and nothing more. Here
 * `published_at` also carries information about the *future*: it is the
 * evening-of-D−1 file creation, which is what makes `published_at ≤ gate` a
 * genuine point-in-time filter even over backfilled history, where filtering on
 * `ingested_at` would filter nothing at all
 * (`docs/specs/feature-engineering.md`).
 *
 * So this module refuses to write a row that is not shaped like a forecast, and
 * its read exposes `lead_time` as a derived value rather than a column.
 */

/** Digest of a DESSEM row's stored values, and nothing else. */
export function dessemBalanceDigest(row: DessemBalanceHalfHour): string {
  return digestValues([
    row.subsystem,
    row.validTime.toISOString(),
    // The run label is part of the value tuple, not of the vintage: a *different
    // reference day* producing the same half hour would be a different forecast,
    // not a restatement of this one.
    row.referenceDay,
    row.demandMw,
    row.hydroGenerationMw,
    row.smallHydroGenerationMw,
    row.thermalGenerationMw,
    row.smallThermalGenerationMw,
    row.windGenerationMw,
    row.solarGenerationMw,
    row.mmgdGenerationMw,
    row.pumpingConsumptionMw,
  ]);
}

const SPEC: VersionedTableSpec<
  DessemBalanceHalfHour,
  typeof dessemBalanceHalfHour.$inferInsert
> = {
  table: dessemBalanceHalfHour,
  tableName: "dessem_balance_half_hour",
  keyColumns: ["subsystem", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) => `${row.subsystem}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: dessemBalanceDigest,
  toInsert: (row, version, vintage) => ({
    subsystem: row.subsystem,
    validTime: row.validTime,
    forecastProducer: "ons_dessem" as const,
    runLabel: row.referenceDay,
    demandMw: row.demandMw,
    hydroGenerationMw: row.hydroGenerationMw,
    smallHydroGenerationMw: row.smallHydroGenerationMw,
    thermalGenerationMw: row.thermalGenerationMw,
    smallThermalGenerationMw: row.smallThermalGenerationMw,
    windGenerationMw: row.windGenerationMw,
    solarGenerationMw: row.solarGenerationMw,
    mmgdGenerationMw: row.mmgdGenerationMw,
    pumpingConsumptionMw: row.pumpingConsumptionMw,
    dataVersion: version.dataVersion,
    // The file's `Last-Modified`: ONS stamps no DESSEM row individually, so the
    // coarsest honest answer is the file, and the precision column says so.
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: vintage.publishedAtPrecision,
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceVersionId: vintage.sourceVersionId,
  }),
};

export interface DessemBalanceWrite extends VintageStamp {
  rows: DessemBalanceHalfHour[];
}

export type DessemBalanceWriteResult = VersionedWriteResult;

/**
 * Append the DESSEM rows whose values actually changed. Idempotent.
 *
 * The forecast shape is checked here, before the first insert, rather than left
 * to the table's check constraint. Both exist on purpose: the constraint is the
 * guarantee, and this is the *diagnosis* — a violation reaching Postgres would
 * surface as a constraint name and a row, where the real question is which
 * reference day was published too late and by how much.
 */
export async function writeDessemBalance(
  db: Database,
  write: DessemBalanceWrite,
): Promise<DessemBalanceWriteResult> {
  const { rows, ...vintage } = write;
  for (const row of rows) {
    if (row.validTime.getTime() <= vintage.publishedAt.getTime()) {
      throw new UpstreamError(
        `DESSEM reference day ${row.referenceDay} was published at ` +
          `${vintage.publishedAt.toISOString()}, at or after the ` +
          `${row.validTime.toISOString()} half hour it describes. A row with ` +
          "published_at ≥ valid_time is an observation, and this table holds forecasts.",
      );
    }
  }
  return writeVersioned(db, SPEC, rows, vintage);
}

/** One row of a DESSEM as-of read, with its origin and its derived lead time. */
export interface DessemBalanceAsOfRow extends DessemBalanceHalfHour {
  dataVersion: number;
  forecastProducer: "ons_dessem" | "open_meteo" | "wattsteer";
  publishedAt: Date;
  ingestedAt: Date;
  /**
   * `valid_time − published_at`, in minutes.
   *
   * Derived on read and never stored (`docs/domain-model.md` §4): a stored lead
   * time could disagree with the two timestamps it is computed from.
   */
  leadTimeMinutes: number;
}

export interface DessemBalanceAsOfResult {
  rows: DessemBalanceAsOfRow[];
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

export interface DessemBalanceAsOfQuery {
  asOf: Date;
  from: Date;
  to: Date;
  subsystem?: SubsystemCode;
  /**
   * The gate. Forecast-sourced features are cut on `published_at ≤ gate`, not
   * on `ingested_at` — over backfilled history every row was ingested at
   * go-live, so `AsOf` alone filters nothing, while this genuinely reproduces
   * what was knowable (`docs/specs/feature-engineering.md`).
   */
  publishedAtOrBefore?: Date;
}

const MS_PER_MINUTE = 60_000;

/**
 * `AsOf(t)` over the DESSEM balance, optionally cut at a gate.
 *
 * `DISTINCT ON (subsystem, valid_time)` ordered by descending `ingested_at`
 * returns exactly one row per business key or none — the same read as every
 * other fact table, because a forecast's *vintage* behaves like anything else's.
 */
export async function readDessemBalanceAsOf(
  db: Database,
  query: DessemBalanceAsOfQuery,
): Promise<DessemBalanceAsOfResult> {
  const subsystemFilter = query.subsystem
    ? sql`and subsystem = ${query.subsystem}`
    : sql``;
  const gateFilter = query.publishedAtOrBefore
    ? sql`and published_at <= ${query.publishedAtOrBefore.toISOString()}::timestamptz`
    : sql``;

  const rows = await db.execute<{
    subsystem: SubsystemCode;
    valid_time: string;
    forecast_producer: DessemBalanceAsOfRow["forecastProducer"];
    run_label: string;
    data_version: number;
    demand_mw: number;
    hydro_generation_mw: number;
    small_hydro_generation_mw: number;
    thermal_generation_mw: number;
    small_thermal_generation_mw: number;
    wind_generation_mw: number;
    solar_generation_mw: number;
    mmgd_generation_mw: number;
    pumping_consumption_mw: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select distinct on (subsystem, valid_time)
      subsystem, valid_time, forecast_producer, run_label, data_version,
      demand_mw, hydro_generation_mw, small_hydro_generation_mw,
      thermal_generation_mw, small_thermal_generation_mw,
      wind_generation_mw, solar_generation_mw, mmgd_generation_mw,
      pumping_consumption_mw, published_at, ingested_at
    from dessem_balance_half_hour
    where ingested_at <= ${query.asOf.toISOString()}::timestamptz
      and valid_time >= ${query.from.toISOString()}::timestamptz
      and valid_time < ${query.to.toISOString()}::timestamptz
      ${subsystemFilter}
      ${gateFilter}
    order by subsystem, valid_time, ingested_at desc, data_version desc
  `);

  const [live] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from dessem_balance_half_hour`,
  );
  const goLiveAt = live?.go_live ? new Date(live.go_live) : null;

  return {
    rows: [...rows].map((row) => {
      const validTime = new Date(row.valid_time);
      const publishedAt = new Date(row.published_at);
      return {
        subsystem: row.subsystem,
        validTime,
        referenceDay: row.run_label,
        forecastProducer: row.forecast_producer,
        demandMw: Number(row.demand_mw),
        hydroGenerationMw: Number(row.hydro_generation_mw),
        smallHydroGenerationMw: Number(row.small_hydro_generation_mw),
        thermalGenerationMw: Number(row.thermal_generation_mw),
        smallThermalGenerationMw: Number(row.small_thermal_generation_mw),
        windGenerationMw: Number(row.wind_generation_mw),
        solarGenerationMw: Number(row.solar_generation_mw),
        mmgdGenerationMw: Number(row.mmgd_generation_mw),
        pumpingConsumptionMw: Number(row.pumping_consumption_mw),
        dataVersion: row.data_version,
        publishedAt,
        ingestedAt: new Date(row.ingested_at),
        leadTimeMinutes: Math.round(
          (validTime.getTime() - publishedAt.getTime()) / MS_PER_MINUTE,
        ),
      };
    }),
    vintageFidelity:
      goLiveAt && query.from >= goLiveAt ? "point_in_time" : "revision_optimistic",
    goLiveAt,
  };
}

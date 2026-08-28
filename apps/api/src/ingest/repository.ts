import { createHash } from "node:crypto";
import { and, gte, lte, sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { subsystemEnergyBalanceHour } from "../database/schema.js";
import type { SubsystemCode } from "./normalise.js";
import type { EnergyBalanceHour } from "./types.js";

/**
 * Bitemporal persistence for the energy balance: how a revision becomes a new
 * row, and how `AsOf(t)` reads exactly one row per key back out.
 *
 * The two decisions this file implements are recorded in
 * `docs/specs/data-platform.md`. In short: facts are wide (one table per
 * grain), and `data_version` is derived from a digest of the stored value tuple
 * rather than from the source file or from a bare counter.
 */

/** Postgres caps bind parameters at 65535; this keeps a batch well inside it. */
const INSERT_CHUNK = 1000;

/** Decimal places the digest rounds to — below the noise floor of ONS values. */
const DIGEST_PRECISION = 6;

/**
 * Digest of the values a row stores, and of nothing else.
 *
 * Deliberately excludes `published_at`, `ingested_at` and the source file: a
 * re-publication that restates a byte of a 171 MB file must not bump the
 * version of every row inside it, and a poll that finds the same numbers must
 * not bump anything at all. Vintage history records ONS restatements, not
 * WattSteer's polling schedule.
 */
export function valueDigest(row: EnergyBalanceHour): string {
  const parts = [
    row.subsystem,
    row.validTime.toISOString(),
    row.loadMwh,
    row.hydroGenerationMwh,
    row.thermalGenerationMwh,
    row.windGenerationMwh,
    row.solarGenerationMwh,
    row.netExchangeMwh,
  ].map((part) => (typeof part === "number" ? part.toFixed(DIGEST_PRECISION) : part));
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

const businessKey = (subsystem: string, validTime: Date): string =>
  `${subsystem}|${validTime.toISOString()}`;

/** What to write, and the vintage to stamp on it. */
export interface EnergyBalanceWrite {
  rows: EnergyBalanceHour[];
  /** When ONS asserted these values — the file's `Last-Modified` here. */
  publishedAt: Date;
  publishedAtPrecision: "row" | "file";
  /** The `ons_resource_version` these rows were parsed from. */
  sourceVersionId: string;
  /** Overridable so a test can place a write at a chosen instant. */
  ingestedAt?: Date;
}

/** What a write actually did — the shape an operator wants in a run summary. */
export interface EnergyBalanceWriteResult {
  /** Business keys seen for the first time. */
  inserted: number;
  /** Keys whose values changed — a real ONS restatement. */
  revised: number;
  /** Keys re-ingested with identical values. No row was written. */
  unchanged: number;
}

interface LatestVersion {
  dataVersion: number;
  valueDigest: string;
}

/**
 * Load the current latest version of every key in the rows' valid-time range.
 *
 * Ranged rather than keyed by an `IN` list because one ingest covers one
 * contiguous file, so the range is exactly the batch and the index serves it.
 */
async function loadLatest(
  db: Database,
  from: Date,
  to: Date,
): Promise<Map<string, LatestVersion>> {
  const rows = await db
    .selectDistinctOn(
      [subsystemEnergyBalanceHour.subsystem, subsystemEnergyBalanceHour.validTime],
      {
        subsystem: subsystemEnergyBalanceHour.subsystem,
        validTime: subsystemEnergyBalanceHour.validTime,
        dataVersion: subsystemEnergyBalanceHour.dataVersion,
        valueDigest: subsystemEnergyBalanceHour.valueDigest,
      },
    )
    .from(subsystemEnergyBalanceHour)
    .where(
      and(
        gte(subsystemEnergyBalanceHour.validTime, from),
        lte(subsystemEnergyBalanceHour.validTime, to),
      ),
    )
    .orderBy(
      subsystemEnergyBalanceHour.subsystem,
      subsystemEnergyBalanceHour.validTime,
      sql`${subsystemEnergyBalanceHour.dataVersion} desc`,
    );

  return new Map(
    rows.map((row) => [
      businessKey(row.subsystem, row.validTime),
      { dataVersion: row.dataVersion, valueDigest: row.valueDigest },
    ]),
  );
}

/**
 * Append the rows whose values actually changed.
 *
 * Idempotent by construction: running it twice over the same parse writes
 * nothing the second time, because every digest matches the version already
 * stored. That is what makes a BullMQ retry after a partial failure safe.
 */
export async function writeEnergyBalance(
  db: Database,
  write: EnergyBalanceWrite,
): Promise<EnergyBalanceWriteResult> {
  const result: EnergyBalanceWriteResult = { inserted: 0, revised: 0, unchanged: 0 };
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

  const pending: (typeof subsystemEnergyBalanceHour.$inferInsert)[] = [];
  for (const row of write.rows) {
    const digest = valueDigest(row);
    const current = latest.get(businessKey(row.subsystem, row.validTime));
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
      ...row,
      dataVersion: (current?.dataVersion ?? 0) + 1,
      publishedAt: write.publishedAt,
      publishedAtPrecision: write.publishedAtPrecision,
      ingestedAt,
      valueDigest: digest,
      sourceVersionId: write.sourceVersionId,
    });
  }

  for (let offset = 0; offset < pending.length; offset += INSERT_CHUNK) {
    await db
      .insert(subsystemEnergyBalanceHour)
      .values(pending.slice(offset, offset + INSERT_CHUNK))
      // A retry that got as far as inserting is not a failure: the same key at
      // the same version carries the same values by construction.
      .onConflictDoNothing();
  }

  return result;
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
 * ONS's *current* restatement of it, because prior vintages are unrecoverable.
 * This can never be repaired retroactively, so it is reported rather than
 * silently answered.
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
 * `AsOf(t)` — the only sanctioned read of a fact table.
 *
 * `DISTINCT ON` over the business key, ordered by descending `ingested_at`,
 * returns exactly one row per key or none. The tiebreak on `data_version`
 * matters because a backfill can write several versions at one instant.
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

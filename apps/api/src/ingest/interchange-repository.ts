import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { subsystemExchangeHour } from "../database/schema.js";
import type { SubsystemCode } from "./normalise.js";
import type { VintageFidelity } from "./repository.js";
import type { SubsystemExchangeHour } from "./types.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Bitemporal persistence for the inter-subsystem exchange.
 *
 * The append-and-version algorithm lives in `versioned-write.ts` and is shared
 * with every other fact table; what stays here is this table's key, its digest,
 * its insert shape and its as-of read.
 */

/** Digest of the two stored measures, keyed by the business key. */
export function exchangeDigest(row: SubsystemExchangeHour): string {
  return digestValues([
    row.fromSubsystem,
    row.toSubsystem,
    row.validTime.toISOString(),
    row.verifiedExchangeMwh,
    // Null and 0 render differently in the digest, so the year ONS added
    // `val_intercambioprogmwmed` is a revision of every hour it covers and not
    // of any hour it does not.
    row.programmedExchangeMwh,
  ]);
}

const SPEC: VersionedTableSpec<
  SubsystemExchangeHour,
  typeof subsystemExchangeHour.$inferInsert
> = {
  table: subsystemExchangeHour,
  tableName: "subsystem_exchange_hour",
  keyColumns: ["from_subsystem", "to_subsystem", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) =>
    `${row.fromSubsystem}|${row.toSubsystem}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: exchangeDigest,
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
export interface SubsystemExchangeWrite extends VintageStamp {
  rows: SubsystemExchangeHour[];
}

export type SubsystemExchangeWriteResult = VersionedWriteResult;

/** Append the rows whose values actually changed. Idempotent on re-ingest. */
export async function writeSubsystemExchange(
  db: Database,
  write: SubsystemExchangeWrite,
): Promise<SubsystemExchangeWriteResult> {
  const { rows, ...vintage } = write;
  return writeVersioned(db, SPEC, rows, vintage);
}

/** One row of an as-of read, carrying the vintage it came from. */
export interface SubsystemExchangeAsOfRow extends SubsystemExchangeHour {
  dataVersion: number;
  publishedAt: Date;
  ingestedAt: Date;
}

export interface SubsystemExchangeAsOfResult {
  rows: SubsystemExchangeAsOfRow[];
  vintageFidelity: VintageFidelity;
  /** Earliest ingestion for this table — WattSteer's own go-live. */
  goLiveAt: Date | null;
}

export interface SubsystemExchangeAsOfQuery {
  /** What WattSteer knew at this instant. */
  asOf: Date;
  /** Valid-time window, `[from, to)`. */
  from: Date;
  to: Date;
  /** Either end of the link — orientation is canonical, so this is not a pair. */
  subsystem?: SubsystemCode;
}

/** `AsOf(t)` — the only sanctioned read of this table. */
export async function readSubsystemExchangeAsOf(
  db: Database,
  query: SubsystemExchangeAsOfQuery,
): Promise<SubsystemExchangeAsOfResult> {
  const linkFilter = query.subsystem
    ? sql`and (from_subsystem = ${query.subsystem} or to_subsystem = ${query.subsystem})`
    : sql``;

  const rows = await db.execute<{
    from_subsystem: SubsystemCode;
    to_subsystem: SubsystemCode;
    valid_time: string;
    data_version: number;
    verified_exchange_mwh: number;
    programmed_exchange_mwh: number | null;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select distinct on (from_subsystem, to_subsystem, valid_time)
      from_subsystem, to_subsystem, valid_time, data_version,
      verified_exchange_mwh, programmed_exchange_mwh,
      published_at, ingested_at
    from subsystem_exchange_hour
    where ingested_at <= ${query.asOf.toISOString()}::timestamptz
      and valid_time >= ${query.from.toISOString()}::timestamptz
      and valid_time < ${query.to.toISOString()}::timestamptz
      ${linkFilter}
    order by from_subsystem, to_subsystem, valid_time, ingested_at desc, data_version desc
  `);

  const [goLive] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from subsystem_exchange_hour`,
  );
  const goLiveAt = goLive?.go_live ? new Date(goLive.go_live) : null;

  return {
    rows: [...rows].map((row) => ({
      fromSubsystem: row.from_subsystem,
      toSubsystem: row.to_subsystem,
      validTime: new Date(row.valid_time),
      verifiedExchangeMwh: Number(row.verified_exchange_mwh),
      programmedExchangeMwh:
        row.programmed_exchange_mwh === null ? null : Number(row.programmed_exchange_mwh),
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintageFidelity:
      goLiveAt && query.from >= goLiveAt ? "point_in_time" : "revision_optimistic",
    goLiveAt,
  };
}

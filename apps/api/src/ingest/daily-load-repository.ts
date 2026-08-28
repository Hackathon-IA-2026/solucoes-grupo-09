import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { subsystemLoadDay } from "../database/schema.js";
import type { SubsystemCode } from "./normalise.js";
import type { VintageFidelity } from "./repository.js";
import type { LoadMethodologyRegime, SubsystemLoadDay } from "./types.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Bitemporal persistence for the daily load series.
 *
 * The append-and-version algorithm is the shared one; what stays here is this
 * table's key, its digest, its insert shape and its as-of read.
 */

/**
 * Digest of the stored values.
 *
 * `methodologyRegime` and `dayMinutes` are inside it deliberately. Both are
 * derived from `valid_time` today, so including them costs nothing — but if ONS
 * ever restates *where* a break falls, that restatement is a real revision of
 * the rows either side of it and should appear as one.
 */
export function dailyLoadDigest(row: SubsystemLoadDay): string {
  return digestValues([
    row.subsystem,
    row.validTime.toISOString(),
    row.loadMwh,
    row.dayMinutes,
    row.methodologyRegime,
  ]);
}

const SPEC: VersionedTableSpec<SubsystemLoadDay, typeof subsystemLoadDay.$inferInsert> = {
  table: subsystemLoadDay,
  tableName: "subsystem_load_day",
  keyColumns: ["subsystem", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) => `${row.subsystem}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: dailyLoadDigest,
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
export interface SubsystemLoadDayWrite extends VintageStamp {
  rows: SubsystemLoadDay[];
}

export type SubsystemLoadDayWriteResult = VersionedWriteResult;

/** Append the rows whose values actually changed. Idempotent on re-ingest. */
export async function writeSubsystemLoadDays(
  db: Database,
  write: SubsystemLoadDayWrite,
): Promise<SubsystemLoadDayWriteResult> {
  const { rows, ...vintage } = write;
  return writeVersioned(db, SPEC, rows, vintage);
}

/** One row of an as-of read, carrying the vintage it came from. */
export interface SubsystemLoadDayAsOfRow extends SubsystemLoadDay {
  dataVersion: number;
  publishedAt: Date;
  ingestedAt: Date;
}

export interface SubsystemLoadDayAsOfResult {
  rows: SubsystemLoadDayAsOfRow[];
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
  /**
   * The regimes the returned window actually spans.
   *
   * Returned rather than left for the caller to compute: a window that crosses
   * 2021-03 or 2023-04-29 contains a level shift ONS introduced by redefining
   * the series, and a read that does not say so invites it to be modelled as a
   * change in the grid.
   */
  regimesSpanned: LoadMethodologyRegime[];
}

export interface SubsystemLoadDayAsOfQuery {
  /** What WattSteer knew at this instant. */
  asOf: Date;
  /** Valid-time window, `[from, to)`. */
  from: Date;
  to: Date;
  subsystem?: SubsystemCode;
}

/** `AsOf(t)` — the only sanctioned read of this table. */
export async function readSubsystemLoadDaysAsOf(
  db: Database,
  query: SubsystemLoadDayAsOfQuery,
): Promise<SubsystemLoadDayAsOfResult> {
  const subsystemFilter = query.subsystem
    ? sql`and subsystem = ${query.subsystem}`
    : sql``;

  const rows = await db.execute<{
    subsystem: SubsystemCode;
    valid_time: string;
    data_version: number;
    load_mwh: number;
    day_minutes: number;
    methodology_regime: LoadMethodologyRegime;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select distinct on (subsystem, valid_time)
      subsystem, valid_time, data_version,
      load_mwh, day_minutes, methodology_regime,
      published_at, ingested_at
    from subsystem_load_day
    where ingested_at <= ${query.asOf.toISOString()}::timestamptz
      and valid_time >= ${query.from.toISOString()}::timestamptz
      and valid_time < ${query.to.toISOString()}::timestamptz
      ${subsystemFilter}
    order by subsystem, valid_time, ingested_at desc, data_version desc
  `);

  const [goLive] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from subsystem_load_day`,
  );
  const goLiveAt = goLive?.go_live ? new Date(goLive.go_live) : null;

  const mapped = [...rows].map((row) => ({
    subsystem: row.subsystem,
    validTime: new Date(row.valid_time),
    loadMwh: Number(row.load_mwh),
    dayMinutes: Number(row.day_minutes),
    methodologyRegime: row.methodology_regime,
    dataVersion: row.data_version,
    publishedAt: new Date(row.published_at),
    ingestedAt: new Date(row.ingested_at),
  }));

  return {
    rows: mapped,
    vintageFidelity:
      goLiveAt && query.from >= goLiveAt ? "point_in_time" : "revision_optimistic",
    goLiveAt,
    regimesSpanned: [...new Set(mapped.map((row) => row.methodologyRegime))],
  };
}

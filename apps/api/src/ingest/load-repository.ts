import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import {
  loadApiRequest,
  programmedLoadHalfHour,
  verifiedLoadHalfHour,
} from "../database/schema.js";
import { UpstreamError } from "../errors.js";
import type { SubsystemCode } from "./normalise.js";
import type {
  LoadAreaCode,
  LoadAreaKind,
  LoadResponse,
  LoadSeries,
} from "./ons/carga-api.js";
import type { VintageFidelity } from "./repository.js";
import type { ProgrammedLoadHalfHour, VerifiedLoadHalfHour } from "./types.js";
import {
  digestValues,
  type VersionedTableSpec,
  type VersionedWriteResult,
  type VintageStamp,
  writeVersioned,
} from "./versioned-write.js";

/**
 * Bitemporal persistence for the two carga series.
 *
 * The append-and-version algorithm is the shared one (`versioned-write.ts`) —
 * this source differs from the bulk ones in how its bytes are *acquired*, not
 * in how a revision is recorded, and reimplementing the write here would be two
 * chances to disagree about what "changed" means.
 *
 * The one thing this table does that no other does: **`published_at` comes off
 * the row.** `/cargaverificada` returns `din_atualizacao` per row, the only
 * genuine row-level vintage marker anywhere in ONS open data, so the write
 * stamps each row with its own and marks the precision `row`. Everything else
 * in the platform falls back to a file's `Last-Modified`.
 */

/** The request that produced a page of rows, recorded before anything is written. */
export interface RecordedLoadRequest {
  series: LoadSeries;
  areaCode: LoadAreaCode;
  rangeStart: string;
  rangeEnd: string;
  response: LoadResponse;
}

/**
 * Record one answered API call and return its id.
 *
 * Written unconditionally, before the facts: the row is the provenance every
 * fact points at, and it is also the only record that a given range was asked
 * for at a given instant — which is what makes a re-run explicable.
 */
export async function recordLoadApiRequest(
  db: Database,
  request: RecordedLoadRequest,
): Promise<string> {
  const { response } = request;
  const [inserted] = await db
    .insert(loadApiRequest)
    .values({
      series: request.series,
      areaCode: request.areaCode,
      rangeStart: request.rangeStart,
      rangeEnd: request.rangeEnd,
      requestUrl: response.url,
      httpStatus: response.httpStatus,
      rowCount: response.rows.length,
      contentSha256: createHash("sha256").update(response.body).digest("hex"),
      byteSize: Buffer.byteLength(response.body),
      jsonRepaired: response.repaired ? 1 : 0,
      fetchedAt: response.fetchedAt,
    })
    .returning({ id: loadApiRequest.id });

  if (!inserted) {
    throw new UpstreamError("Failed to record the carga API request");
  }
  return inserted.id;
}

/**
 * Digest of a verified row's stored values, and nothing else.
 *
 * `din_atualizacao` is deliberately excluded even though it is a genuine ONS
 * stamp: ONS re-stamping a row it did not change is not a restatement, and a
 * digest that included it would record ONS's batch schedule instead of its
 * revisions — the same mistake as digesting a file hash.
 */
export function verifiedLoadDigest(row: VerifiedLoadHalfHour): string {
  return digestValues([
    row.areaCode,
    row.validTime.toISOString(),
    row.loadMwh,
    row.consistedLoadMwh,
    row.loadNetOfMmgdMwh,
    row.supervisedLoadMwh,
    row.unsupervisedLoadMwh,
    row.mmgdLoadMwh,
    row.consistencyAdjustmentMwh,
  ]);
}

/** Digest of a programmed row. One measure, but the same rule. */
export function programmedLoadDigest(row: ProgrammedLoadHalfHour): string {
  return digestValues([row.areaCode, row.validTime.toISOString(), row.programmedLoadMwh]);
}

const VERIFIED_SPEC: VersionedTableSpec<
  VerifiedLoadHalfHour,
  typeof verifiedLoadHalfHour.$inferInsert
> = {
  table: verifiedLoadHalfHour,
  tableName: "verified_load_half_hour",
  keyColumns: ["area_code", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) => `${row.areaCode}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: verifiedLoadDigest,
  toInsert: (row, version, vintage) => ({
    areaCode: row.areaCode,
    areaKind: row.areaKind,
    subsystem: row.subsystem,
    validTime: row.validTime,
    dataVersion: version.dataVersion,
    loadMwh: row.loadMwh,
    consistedLoadMwh: row.consistedLoadMwh,
    loadNetOfMmgdMwh: row.loadNetOfMmgdMwh,
    supervisedLoadMwh: row.supervisedLoadMwh,
    unsupervisedLoadMwh: row.unsupervisedLoadMwh,
    mmgdLoadMwh: row.mmgdLoadMwh,
    consistencyAdjustmentMwh: row.consistencyAdjustmentMwh,
    // The row's own stamp when ONS gave one; the response's fetch time, marked
    // as the coarser thing it is, when it did not.
    publishedAt: row.publishedAt ?? vintage.publishedAt,
    publishedAtPrecision: row.publishedAt ? "row" : "file",
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceRequestId: vintage.sourceVersionId,
  }),
};

const PROGRAMMED_SPEC: VersionedTableSpec<
  ProgrammedLoadHalfHour,
  typeof programmedLoadHalfHour.$inferInsert
> = {
  table: programmedLoadHalfHour,
  tableName: "programmed_load_half_hour",
  keyColumns: ["area_code", "valid_time"],
  validTimeColumn: "valid_time",
  businessKey: (row) => `${row.areaCode}|${row.validTime.toISOString()}`,
  validTime: (row) => row.validTime,
  digest: programmedLoadDigest,
  toInsert: (row, version, vintage) => ({
    areaCode: row.areaCode,
    areaKind: row.areaKind,
    subsystem: row.subsystem,
    validTime: row.validTime,
    dataVersion: version.dataVersion,
    programmedLoadMwh: row.programmedLoadMwh,
    // This endpoint returns no row-level stamp at all, so the honest answer is
    // always the response's fetch time at `file` precision.
    publishedAt: vintage.publishedAt,
    publishedAtPrecision: "file",
    ingestedAt: vintage.ingestedAt,
    valueDigest: version.valueDigest,
    sourceRequestId: vintage.sourceVersionId,
  }),
};

/** What to write, and the vintage to fall back on where a row carries none. */
export interface VerifiedLoadWrite extends VintageStamp {
  rows: VerifiedLoadHalfHour[];
}

export interface ProgrammedLoadWrite extends VintageStamp {
  rows: ProgrammedLoadHalfHour[];
}

export type LoadWriteResult = VersionedWriteResult;

/** Append the verified rows whose values actually changed. Idempotent. */
export async function writeVerifiedLoad(
  db: Database,
  write: VerifiedLoadWrite,
): Promise<LoadWriteResult> {
  const { rows, ...vintage } = write;
  return writeVersioned(db, VERIFIED_SPEC, rows, vintage);
}

/** Append the programmed rows whose values actually changed. Idempotent. */
export async function writeProgrammedLoad(
  db: Database,
  write: ProgrammedLoadWrite,
): Promise<LoadWriteResult> {
  const { rows, ...vintage } = write;
  return writeVersioned(db, PROGRAMMED_SPEC, rows, vintage);
}

/** One row of an as-of read, carrying the vintage it came from. */
export interface VerifiedLoadAsOfRow extends VerifiedLoadHalfHour {
  dataVersion: number;
  publishedAt: Date;
  publishedAtPrecision: "row" | "file";
  ingestedAt: Date;
}

export interface VerifiedLoadAsOfResult {
  rows: VerifiedLoadAsOfRow[];
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

export interface LoadAsOfQuery {
  asOf: Date;
  from: Date;
  to: Date;
  areaCode?: LoadAreaCode;
  subsystem?: SubsystemCode;
}

async function goLiveOf(db: Database, table: string): Promise<Date | null> {
  const [row] = await db.execute<{ go_live: string | null }>(
    sql`select min(ingested_at) as go_live from ${sql.identifier(table)}`,
  );
  return row?.go_live ? new Date(row.go_live) : null;
}

const fidelity = (from: Date, goLiveAt: Date | null): VintageFidelity =>
  goLiveAt && from >= goLiveAt ? "point_in_time" : "revision_optimistic";

/**
 * `AsOf(t)` over the verified series — the only sanctioned read of the table.
 *
 * `DISTINCT ON` over (`area_code`, `valid_time`) ordered by descending
 * `ingested_at` returns exactly one row per key or none.
 */
export async function readVerifiedLoadAsOf(
  db: Database,
  query: LoadAsOfQuery,
): Promise<VerifiedLoadAsOfResult> {
  const areaFilter = query.areaCode ? sql`and area_code = ${query.areaCode}` : sql``;
  const subsystemFilter = query.subsystem
    ? sql`and subsystem = ${query.subsystem}`
    : sql``;

  const rows = await db.execute<{
    area_code: LoadAreaCode;
    area_kind: LoadAreaKind;
    subsystem: SubsystemCode | null;
    valid_time: string;
    data_version: number;
    load_mwh: number;
    consisted_load_mwh: number | null;
    load_net_of_mmgd_mwh: number | null;
    supervised_load_mwh: number | null;
    unsupervised_load_mwh: number | null;
    mmgd_load_mwh: number | null;
    consistency_adjustment_mwh: number | null;
    published_at: string;
    published_at_precision: "row" | "file";
    ingested_at: string;
  }>(sql`
    select distinct on (area_code, valid_time)
      area_code, area_kind, subsystem, valid_time, data_version,
      load_mwh, consisted_load_mwh, load_net_of_mmgd_mwh,
      supervised_load_mwh, unsupervised_load_mwh, mmgd_load_mwh,
      consistency_adjustment_mwh,
      published_at, published_at_precision, ingested_at
    from verified_load_half_hour
    where ingested_at <= ${query.asOf.toISOString()}::timestamptz
      and valid_time >= ${query.from.toISOString()}::timestamptz
      and valid_time < ${query.to.toISOString()}::timestamptz
      ${areaFilter}
      ${subsystemFilter}
    order by area_code, valid_time, ingested_at desc, data_version desc
  `);

  const goLiveAt = await goLiveOf(db, "verified_load_half_hour");
  const number = (value: number | null): number | null =>
    value === null ? null : Number(value);

  return {
    rows: [...rows].map((row) => ({
      areaCode: row.area_code,
      areaKind: row.area_kind,
      subsystem: row.subsystem,
      validTime: new Date(row.valid_time),
      loadMwh: Number(row.load_mwh),
      consistedLoadMwh: number(row.consisted_load_mwh),
      loadNetOfMmgdMwh: number(row.load_net_of_mmgd_mwh),
      supervisedLoadMwh: number(row.supervised_load_mwh),
      unsupervisedLoadMwh: number(row.unsupervised_load_mwh),
      mmgdLoadMwh: number(row.mmgd_load_mwh),
      consistencyAdjustmentMwh: number(row.consistency_adjustment_mwh),
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      publishedAtPrecision: row.published_at_precision,
      ingestedAt: new Date(row.ingested_at),
    })),
    vintageFidelity: fidelity(query.from, goLiveAt),
    goLiveAt,
  };
}

/** One row of a programmed as-of read. */
export interface ProgrammedLoadAsOfRow extends ProgrammedLoadHalfHour {
  dataVersion: number;
  publishedAt: Date;
  ingestedAt: Date;
}

export interface ProgrammedLoadAsOfResult {
  rows: ProgrammedLoadAsOfRow[];
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

/** `AsOf(t)` over the programmed series. A forecast, read the same way. */
export async function readProgrammedLoadAsOf(
  db: Database,
  query: LoadAsOfQuery,
): Promise<ProgrammedLoadAsOfResult> {
  const areaFilter = query.areaCode ? sql`and area_code = ${query.areaCode}` : sql``;

  const rows = await db.execute<{
    area_code: LoadAreaCode;
    area_kind: LoadAreaKind;
    subsystem: SubsystemCode | null;
    valid_time: string;
    data_version: number;
    programmed_load_mwh: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select distinct on (area_code, valid_time)
      area_code, area_kind, subsystem, valid_time, data_version,
      programmed_load_mwh, published_at, ingested_at
    from programmed_load_half_hour
    where ingested_at <= ${query.asOf.toISOString()}::timestamptz
      and valid_time >= ${query.from.toISOString()}::timestamptz
      and valid_time < ${query.to.toISOString()}::timestamptz
      ${areaFilter}
    order by area_code, valid_time, ingested_at desc, data_version desc
  `);

  const goLiveAt = await goLiveOf(db, "programmed_load_half_hour");

  return {
    rows: [...rows].map((row) => ({
      areaCode: row.area_code,
      areaKind: row.area_kind,
      subsystem: row.subsystem,
      validTime: new Date(row.valid_time),
      programmedLoadMwh: Number(row.programmed_load_mwh),
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintageFidelity: fidelity(query.from, goLiveAt),
    goLiveAt,
  };
}

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "../database/connection.js";

/**
 * The append-only versioned write, once.
 *
 * Every fact table in WattSteer answers the same three questions on ingest:
 * have we seen this business key before, have its values actually changed, and
 * what ordinal does this version get. The answers are identical whatever the
 * table holds, so they live here rather than being reimplemented per dataset —
 * two implementations of "did this change?" are two chances to disagree.
 *
 * What stays with each table is what genuinely differs: its key columns, how a
 * canonical row becomes an insert, and how its values are digested.
 */

/** Postgres caps bind parameters at 65535; this keeps a batch well inside it. */
export const INSERT_CHUNK = 1000;

/** Decimal places digests round to — below the noise floor of ONS values. */
export const DIGEST_PRECISION = 6;

/**
 * Digest a row's values, and nothing else.
 *
 * Deliberately excludes `published_at`, `ingested_at` and the source file: a
 * re-publication that restates one byte of a 171 MB file must not bump the
 * version of every row inside it, and a poll that finds the same numbers must
 * not bump anything at all. Vintage history records upstream restatements, not
 * WattSteer's polling schedule.
 *
 * Numbers are fixed to `DIGEST_PRECISION` and nulls become empty strings, so
 * "absent" and "zero" stay distinguishable in the digest as they are in the data.
 */
export function digestValues(
  parts: readonly (string | number | null | undefined)[],
): string {
  const rendered = parts.map((part) => {
    if (part === null || part === undefined) {
      return "";
    }
    return typeof part === "number" ? part.toFixed(DIGEST_PRECISION) : part;
  });
  return createHash("sha256").update(rendered.join("|")).digest("hex");
}

/** The vintage stamped on every row of one write. */
export interface VintageStamp {
  /** When the upstream source asserted these values. */
  publishedAt: Date;
  publishedAtPrecision: "row" | "file";
  /**
   * The provenance row these rows were parsed from — `ons_resource_version`
   * for a bulk file, `load_api_request` for a page of the carga REST API. The
   * table each id points at is the fact table's business, not this write's.
   */
  sourceVersionId: string;
  /** Overridable so a test can place a write at a chosen instant. */
  ingestedAt?: Date;
}

/** What a write actually did — the shape an operator wants in a run summary. */
export interface VersionedWriteResult {
  /** Business keys seen for the first time. */
  inserted: number;
  /** Keys whose values changed — a real upstream restatement. */
  revised: number;
  /** Keys re-ingested with identical values. No row was written. */
  unchanged: number;
}

/**
 * How much of the table the latest-version lookup has to read.
 *
 * `valid_time_range` — the default, and right for a fact table. One ingest
 * covers one contiguous file of hours, so the batch's valid-time range *is* the
 * batch and the as-of index serves it. A key's valid time never moves, because
 * it is part of the key.
 *
 * `whole_table` — right for a registry snapshot, where the valid time is one of
 * the stored values rather than part of the key, so a revision can move it. A
 * corrected commissioning date lands outside the new batch's range, and a
 * ranged lookup would miss the row it is meant to be revising and append a
 * second version-1 row instead. These tables are thousands of rows, not
 * millions, so reading all of them is the cheaper of the two mistakes.
 */
export type LatestLookup = "valid_time_range" | "whole_table";

/**
 * How one fact table plugs into the shared write.
 *
 * `keyColumns` and `validTimeColumn` are snake_case database names because the
 * latest-version lookup is issued as raw SQL: expressing `DISTINCT ON` over a
 * caller-supplied key list through the typed query builder costs more in
 * generic gymnastics than the safety it buys, and the names are checked against
 * the schema by the tests that exercise each table.
 *
 * `latestLookup` says how much of the table the latest-version lookup must
 * read; see `LatestLookup`.
 */
export interface VersionedTableSpec<TRow, TInsert> {
  table: PgTable;
  /** Table name, for the raw latest-version query. */
  tableName: string;
  /** Business-key columns, in `DISTINCT ON` order. */
  keyColumns: readonly string[];
  /** The valid-time column the batch range is expressed over. */
  validTimeColumn: string;
  /** Defaults to `valid_time_range`; see `LatestLookup`. */
  latestLookup?: LatestLookup;
  /** Business key of a canonical row, matching `keyColumns`' order. */
  businessKey: (row: TRow) => string;
  /** Valid time of a canonical row — used to bound the lookup. */
  validTime: (row: TRow) => Date;
  /** Digest of the row's stored values. */
  digest: (row: TRow) => string;
  /** Turn a canonical row plus its resolved version into an insert. */
  toInsert: (
    row: TRow,
    version: { dataVersion: number; valueDigest: string },
    vintage: Required<Pick<VintageStamp, "ingestedAt">> & VintageStamp,
  ) => TInsert;
}

interface LatestVersion {
  dataVersion: number;
  valueDigest: string;
}

/**
 * Load the current latest version of every key the batch might revise.
 *
 * Ranged rather than keyed by an `IN` list because one ingest covers one
 * contiguous file, so the range *is* the batch and the as-of index serves it.
 * A table whose valid time is a value rather than part of its key opts out of
 * the range — see `LatestLookup`.
 */
async function loadLatest<TRow, TInsert>(
  db: Database,
  spec: VersionedTableSpec<TRow, TInsert>,
  from: Date,
  to: Date,
): Promise<Map<string, LatestVersion>> {
  const keys = spec.keyColumns.map((column) => sql.identifier(column));
  const keyList = sql.join(keys, sql`, `);
  const scope =
    (spec.latestLookup ?? "valid_time_range") === "whole_table"
      ? sql``
      : sql`where ${sql.identifier(spec.validTimeColumn)} >= ${from.toISOString()}::timestamptz
             and ${sql.identifier(spec.validTimeColumn)} <= ${to.toISOString()}::timestamptz`;

  const rows = await db.execute<Record<string, string | number>>(sql`
    select distinct on (${keyList})
      ${keyList}, data_version, value_digest
    from ${sql.identifier(spec.tableName)}
    ${scope}
    order by ${keyList}, data_version desc
  `);

  const latest = new Map<string, LatestVersion>();
  for (const row of rows) {
    const key = spec.keyColumns
      .map((column) => {
        const value = row[column];
        // Timestamps come back as strings; normalising through Date keeps the
        // key identical to the one built from a parsed row.
        return column === spec.validTimeColumn
          ? new Date(String(value)).toISOString()
          : String(value);
      })
      .join("|");
    latest.set(key, {
      dataVersion: Number(row.data_version),
      valueDigest: String(row.value_digest),
    });
  }
  return latest;
}

/**
 * The earliest and latest valid time of a batch, in one pass.
 *
 * Not `Math.min(...times)`: spreading passes every element as an argument, and
 * a month of the plant-level wind detail (August 2026, a 244 MB file) is enough
 * rows to overflow the call stack — `RangeError: Maximum call stack size
 * exceeded` here, measured on 19/09/2026, and the month never ingested.
 */
export function validTimeBounds<TRow>(
  rows: readonly TRow[],
  validTime: (row: TRow) => Date,
): { from: Date; to: Date } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const time = validTime(row).getTime();
    if (time < min) {
      min = time;
    }
    if (time > max) {
      max = time;
    }
  }
  return { from: new Date(min), to: new Date(max) };
}

/**
 * Append the rows whose values actually changed.
 *
 * Idempotent by construction: running it twice over the same parse writes
 * nothing the second time, because every digest matches the version already
 * stored. That is what makes a retry after a partial failure safe.
 */
export async function writeVersioned<TRow, TInsert>(
  db: Database,
  spec: VersionedTableSpec<TRow, TInsert>,
  rows: TRow[],
  vintage: VintageStamp,
): Promise<VersionedWriteResult> {
  const result: VersionedWriteResult = { inserted: 0, revised: 0, unchanged: 0 };
  if (rows.length === 0) {
    return result;
  }

  const { from, to } = validTimeBounds(rows, spec.validTime);
  const latest = await loadLatest(db, spec, from, to);
  const stamped = { ...vintage, ingestedAt: vintage.ingestedAt ?? new Date() };

  const pending: TInsert[] = [];
  for (const row of rows) {
    const valueDigest = spec.digest(row);
    const current = latest.get(spec.businessKey(row));
    if (current?.valueDigest === valueDigest) {
      result.unchanged += 1;
      continue;
    }
    if (current) {
      result.revised += 1;
    } else {
      result.inserted += 1;
    }
    pending.push(
      spec.toInsert(
        row,
        { dataVersion: (current?.dataVersion ?? 0) + 1, valueDigest },
        stamped,
      ),
    );
  }

  for (let offset = 0; offset < pending.length; offset += INSERT_CHUNK) {
    await db
      .insert(spec.table)
      // The spec's `toInsert` is the type-safe boundary: it is written against
      // the concrete table, so the values are correct by construction. Drizzle
      // cannot see that through the generic `PgTable`, hence the one cast.
      .values(pending.slice(offset, offset + INSERT_CHUNK) as never)
      // A retry that got as far as inserting is not a failure: the same key at
      // the same version carries the same values by construction.
      .onConflictDoNothing();
  }

  return result;
}

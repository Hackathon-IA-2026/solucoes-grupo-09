import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { PayloadRefusedError } from "../../errors.js";
import type { DelimitedTable } from "../csv.js";

/**
 * The Parquet rendition of a programme day, read into the table the CSV parser
 * produces — so the three adapters have **one** parse path, and a Parquet day is
 * not a second, differently-buggy reading of the same file.
 *
 * **Why Parquet is read at all.** These datasets were first written CSV-only, on
 * `dessem-general.ts`'s argument that a second parse path costs more than it
 * saves. That argument held for a dataset with no Parquet-only days. Here it does
 * not: measured against the CKAN listings on 2026-09-19, **18 days exist only as
 * Parquet** (7 of `programacao_x_previsao`, 3 of `programacao_diaria`, 8 of
 * `programacao_fluxo_controlado`), and a CSV-only sweep never loads them — it does
 * not fail on them, it does not see them. CSV stays the preferred rendition where
 * both exist; `selectResourceForDay` takes formats in order.
 *
 * **What the cells look like**, measured on one day of each dataset: every value
 * is the same string the CSV carries (`"35.00"`, padded codes and all), except
 * `num_patamar` and `tip_terminal`, which arrive as numbers, and
 * `programacao_diaria`'s `din_programacaodia`, which arrives as a `Date`.
 *
 * **The `Date` is the INT96 hazard, and is handled by where it is read.**
 * `docs/specs/data-platform.md` records that a Parquet timestamp written as a
 * naive Brasília wall clock arrives as a `Date` whose *UTC* fields are the local
 * reading. The value here is local midnight of the reference day, so its UTC date
 * fields are the reference day — read with `toISOString`, not `toLocaleDateString`
 * or the local getters. Should that ever shift, `assertFileIsForDay` compares the
 * day against the day the resource is named for and **refuses** the file, rather
 * than storing a day of forecasts a day early.
 */

/** One Parquet cell as the string the CSV would have carried. */
export function cellOf(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  throw new PayloadRefusedError(
    "schema",
    `A Parquet cell of type ${typeof value} has no reading as a programme value`,
  );
}

/** Rows as objects — what `hyparquet` returns — into a table with a header. */
export function tableFromObjects(
  rows: readonly Record<string, unknown>[],
): DelimitedTable {
  const first = rows[0];
  if (!first) {
    return { columns: [], rows: [] };
  }
  const columns = Object.keys(first);
  return {
    columns,
    rows: rows.map((row) => columns.map((column) => cellOf(row[column]))),
  };
}

export async function readProgrammeParquet(bytes: ArrayBuffer): Promise<DelimitedTable> {
  let records: Record<string, unknown>[];
  try {
    records = (await parquetReadObjects({ file: bytes, compressors })) as Record<
      string,
      unknown
    >[];
  } catch (error) {
    // Bytes in, error out: a file the reader cannot decode is a fact about the
    // file, not about the network or the process, so it is a refusal — recorded
    // against these bytes and not retried — rather than a throw that would fail
    // the sweep every hour until ONS republished it.
    throw new PayloadRefusedError(
      "schema",
      `The Parquet file could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return tableFromObjects(records);
}

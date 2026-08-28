import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { UpstreamError } from "../../errors.js";
import { mwmedToMwh, parseDecimal, resolveSubsystem, trimmed } from "../normalise.js";
import {
  parseWallClock,
  type WallClock,
  wallClockFromNaiveDate,
  zonedWallClockToUtc,
} from "../time.js";
import type {
  EnergyBalanceHour,
  EnergyBalanceParse,
  RejectedRow,
  RejectionReason,
} from "../types.js";

/**
 * Adapter for ONS dataset 5, `balanco-energia-subsistema` — hourly load and
 * generation by subsystem, the system context every other series is explained
 * against.
 *
 * The schema has been stable since 2000, which is why this is the tracer: the
 * work here is the machinery, not the dataset. It nonetheless carries four of
 * the normalisation traps the research found — padded subsystem codes, the
 * `SIN` aggregate row, an undocumented local timezone, and MWmed values — plus
 * one the research did not record (see `PARQUET_TIMESTAMP` below).
 */

/** ONS CKAN package id for this dataset. */
export const DATASET_SLUG = "balanco-energia-subsistema";

/** CSV is `;`-delimited, UTF-8, no BOM, `.` as the decimal separator. */
const DELIMITER = ";";

/** The rows are hourly, so MWmed converts to MWh over 60 minutes. */
const INTERVAL_MINUTES = 60;

/**
 * Columns this adapter requires. The header is read from every file on every
 * ingest and reconciled against this list rather than cached per year — ONS
 * backfills columns into old files retroactively, so "the schema for year Y" is
 * not a thing that exists.
 */
const REQUIRED_COLUMNS = [
  "id_subsistema",
  "din_instante",
  "val_gerhidraulica",
  "val_gertermica",
  "val_gereolica",
  "val_gersolar",
  "val_carga",
  "val_intercambio",
] as const;

/** The six measures, in the order the digest and the canonical row use them. */
const MEASURES = {
  loadMwh: "val_carga",
  hydroGenerationMwh: "val_gerhidraulica",
  thermalGenerationMwh: "val_gertermica",
  windGenerationMwh: "val_gereolica",
  solarGenerationMwh: "val_gersolar",
  netExchangeMwh: "val_intercambio",
} as const;

type MeasureKey = keyof typeof MEASURES;

/**
 * A source row as read from either format: every required column present as a
 * string, or absent from the map entirely. The distinction is load-bearing —
 * a column present but empty is a rejected row, a column missing from the
 * header is a failed file.
 */
type SourceRow = Partial<Record<string, string>>;

function assertColumns(columns: string[]): void {
  const present = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new UpstreamError(
      `balanco-energia-subsistema is missing required columns: ${missing.join(", ")}`,
    );
  }
}

/**
 * Turn one source row into a canonical row, or into the reason it could not be
 * one. Both formats funnel through here so neither can drift.
 */
function normaliseRow(
  row: SourceRow,
  rowNumber: number,
  wall: WallClock | null,
): { row: EnergyBalanceHour } | { rejected: RejectedRow } | { aggregate: true } {
  const reject = (reason: RejectionReason, detail: string) => ({
    rejected: { reason, rowNumber, detail },
  });

  const subsystem = resolveSubsystem(row.id_subsistema ?? "");
  if (subsystem.kind === "aggregate") {
    // Filtered at the boundary: `SIN` is the national total and would
    // double-count any sum over subsystems.
    return { aggregate: true };
  }
  if (subsystem.kind === "unknown") {
    return reject("unknown_subsystem", `id_subsistema=${JSON.stringify(subsystem.raw)}`);
  }

  if (!wall) {
    return reject(
      "unparsable_timestamp",
      `din_instante=${JSON.stringify(row.din_instante ?? null)}`,
    );
  }

  // `din_instante` is Brasília local civil time and labels the START of the
  // interval, so the canonical start-of-interval convention is preserved
  // rather than shifted — but the zone conversion is not optional.
  const zoned = zonedWallClockToUtc(wall);
  if (zoned.kind === "gap") {
    // Spring forward: this dataset emits a placeholder row for the local hour
    // that never happened. Rejected rather than interpolated.
    return reject("dst_gap", `din_instante=${row.din_instante} never occurred locally`);
  }
  if (zoned.kind === "ambiguous") {
    // Fall back: ONS silently drops one of the two duplicated local hours, so
    // which one survived is unrecoverable. Rejecting is the honest answer.
    return reject(
      "dst_ambiguous",
      `din_instante=${row.din_instante} occurred twice locally`,
    );
  }

  const measures = {} as Record<MeasureKey, number>;
  for (const [key, column] of Object.entries(MEASURES) as [MeasureKey, string][]) {
    const value = parseDecimal(row[column]);
    if (value === null) {
      return reject("empty_value", `${column} is present but empty`);
    }
    if (Number.isNaN(value)) {
      return reject("unparsable_value", `${column}=${JSON.stringify(row[column])}`);
    }
    measures[key] = mwmedToMwh(value, INTERVAL_MINUTES);
  }

  return {
    row: { subsystem: subsystem.code, validTime: zoned.instant, ...measures },
  };
}

function collect(
  rows: { row: SourceRow; wall: WallClock | null }[],
  columns: string[],
): EnergyBalanceParse {
  const parsed: EnergyBalanceHour[] = [];
  const rejected: RejectedRow[] = [];
  let aggregateRowsFiltered = 0;

  rows.forEach((entry, index) => {
    const outcome = normaliseRow(entry.row, index + 1, entry.wall);
    if ("aggregate" in outcome) {
      aggregateRowsFiltered += 1;
    } else if ("rejected" in outcome) {
      rejected.push(outcome.rejected);
    } else {
      parsed.push(outcome.row);
    }
  });

  return { rows: parsed, rejected, aggregateRowsFiltered, columns };
}

/** Split a CSV line, tolerating a trailing `\r` from a CRLF file. */
function splitLine(line: string): string[] {
  return line.replace(/\r$/, "").split(DELIMITER);
}

/** Parse the CSV rendition. The fallback path — used where Parquet is absent. */
export function parseEnergyBalanceCsv(text: string): EnergyBalanceParse {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const header = lines.shift();
  if (!header) {
    throw new UpstreamError("balanco-energia-subsistema CSV is empty");
  }
  const columns = splitLine(header).map(trimmed);
  assertColumns(columns);

  const rows = lines.map((line) => {
    const cells = splitLine(line);
    const row: SourceRow = {};
    columns.forEach((column, index) => {
      // Absent from the map when the row is short — "column not there" rather
      // than "column empty", which are different failures.
      if (index < cells.length) {
        row[column] = cells[index];
      }
    });
    return { row, wall: parseWallClock(row.din_instante ?? "") };
  });

  return collect(rows, columns);
}

/**
 * Parse the Parquet rendition. Preferred: roughly half the bytes of the CSV for
 * this dataset and an order of magnitude less on the larger ones.
 *
 * PARQUET_TIMESTAMP: `din_instante` is stored as INT96, which every reader
 * materialises as an epoch instant — so the naive Brasília wall clock arrives
 * as a `Date` whose UTC fields are the local reading. Using it directly is a
 * silent three-hour error. This is not in the research file; it was found while
 * writing this adapter and the fixture test pins it.
 */
export async function parseEnergyBalanceParquet(
  bytes: ArrayBuffer,
): Promise<EnergyBalanceParse> {
  const records = (await parquetReadObjects({
    file: bytes,
    compressors,
  })) as Record<string, unknown>[];

  const first = records[0];
  if (!first) {
    throw new UpstreamError("balanco-energia-subsistema Parquet has no rows");
  }
  const columns = Object.keys(first);
  assertColumns(columns);

  const rows = records.map((record) => {
    const row: SourceRow = {};
    for (const column of columns) {
      const value = record[column];
      if (value !== undefined && !(value instanceof Date)) {
        row[column] = value === null ? "" : String(value);
      }
    }
    const instante = record.din_instante;
    row.din_instante =
      instante instanceof Date ? instante.toISOString() : String(instante ?? "");
    return {
      row,
      wall: instante instanceof Date ? wallClockFromNaiveDate(instante) : null,
    };
  });

  return collect(rows, columns);
}

/** Parse either rendition, chosen by the format CKAN reported. */
export async function parseEnergyBalance(
  format: "PARQUET" | "CSV",
  bytes: ArrayBuffer,
): Promise<EnergyBalanceParse> {
  if (format === "PARQUET") {
    return parseEnergyBalanceParquet(bytes);
  }
  return parseEnergyBalanceCsv(new TextDecoder("utf-8").decode(bytes));
}

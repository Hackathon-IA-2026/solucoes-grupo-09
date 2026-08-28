import { UpstreamError } from "../../errors.js";
import { parseDelimited, toRecord } from "../csv.js";
import { mwmedToMwh, parseDecimal, resolveSubsystem, trimmed } from "../normalise.js";
import { localDayInterval, parseCalendarDate } from "../time.js";
import type {
  LoadMethodologyRegime,
  RejectedRow,
  RejectionReason,
  SubsystemLoadDay,
  SubsystemLoadDayParse,
} from "../types.js";

/**
 * Adapter for ONS dataset 8, `carga-energia` — daily load per subsystem, 2000 →.
 *
 * The schema has never moved. The *meaning* has, twice, and nothing in the file
 * says so — which is the whole reason this adapter exists as its own module
 * rather than as a two-column variant of the balanço.
 *
 * **The two methodology breaks.** ONS's own CKAN notes describe three
 * definitional regimes: load met by plants ONS dispatches or programmes; from
 * March 2021, plus forecast generation of plants it does not dispatch; and from
 * **29 April 2023**, plus an estimate of micro and mini distributed generation
 * (MMGD) derived from weather forecasts. Each transition is a **level shift in
 * the series with no column change to signal it**, so every row is stamped with
 * the regime it was measured under (`LOAD_METHODOLOGY_REGIMES`). A model that
 * reads the shift as a change in the grid is wrong, and the stamp is what makes
 * that mistake avoidable rather than invisible.
 *
 * This series is also **not a daily rollup of the half-hourly carga API** and
 * must never be joined to it as one — the regimes are precisely the difference.
 *
 * **Interval labelling.** `din_instante` here is a bare date (`2026-01-01`).
 * Every other source in the platform stores the *start of the interval* as a UTC
 * instant, so a day becomes the first instant of that local day — 03:00Z in the
 * modern fixed −3 era, 02:00Z inside horário de verão. The conversion to MWh
 * uses the length that local day actually had, which is not always 24 hours:
 * see `localDayInterval`.
 *
 * **CSV, not Parquet.** Parquet covers all 27 years here, but the files are
 * ~1 460 rows each and one parse path per dataset is worth more than the bytes.
 */

/** ONS CKAN package id for this dataset. */
export const DAILY_LOAD_DATASET_SLUG = "carga-energia";

/** The format asked of the catalogue. See the module note. */
export const DAILY_LOAD_FORMATS = ["CSV"] as const;

const REQUIRED_COLUMNS = [
  "id_subsistema",
  "din_instante",
  "val_cargaenergiamwmed",
] as const;

/**
 * One definitional regime of the daily load series.
 *
 * `startsOn` is the first **local** date measured under it, so the boundary is
 * compared as ONS states it rather than through a timezone.
 */
export interface LoadMethodologyBreak {
  regime: LoadMethodologyRegime;
  /** First local date under this regime; null for the original one. */
  startsOn: string | null;
  /** What ONS says changed, in English. The Portuguese is in the CKAN notes. */
  meaning: string;
}

/**
 * The three regimes, newest first so a lookup takes the first match.
 *
 * Exported because this is metadata a consumer needs: any chart, feature or
 * backtest that spans 2021-03 or 2023-04-29 crosses a break, and the platform
 * should be able to say where the breaks are without re-reading the CKAN page.
 */
export const LOAD_METHODOLOGY_REGIMES: readonly LoadMethodologyBreak[] = [
  {
    regime: "WITH_MMGD",
    startsOn: "2023-04-29",
    meaning:
      "Everything below, plus an estimate of micro and mini distributed generation (MMGD) derived from forecast weather.",
  },
  {
    regime: "WITH_NON_DISPATCHED",
    startsOn: "2021-03-01",
    meaning:
      "Load met by plants ONS dispatches or programmes, plus forecast generation of plants it does not dispatch.",
  },
  {
    regime: "DISPATCHED_ONLY",
    startsOn: null,
    meaning: "Load met by plants ONS dispatches and/or programmes, only.",
  },
];

/**
 * Which regime a local date was measured under.
 *
 * ISO dates compare correctly as strings, so the boundary stays written the way
 * ONS writes it instead of becoming an instant that a timezone could shift.
 */
export function regimeForDate(isoDate: string): LoadMethodologyRegime {
  for (const regime of LOAD_METHODOLOGY_REGIMES) {
    if (regime.startsOn === null || isoDate >= regime.startsOn) {
      return regime.regime;
    }
  }
  // Unreachable: the last entry has a null start.
  return "DISPATCHED_ONLY";
}

function assertColumns(columns: string[]): void {
  const present = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new UpstreamError(
      `carga-energia is missing required columns: ${missing.join(", ")}`,
    );
  }
}

/** Turn one source row into a canonical row, or into the reason it cannot be. */
function normaliseRow(
  row: Record<string, string>,
  rowNumber: number,
): { row: SubsystemLoadDay } | { rejected: RejectedRow } {
  const reject = (reason: RejectionReason, detail: string) => ({
    rejected: { reason, rowNumber, detail },
  });

  const subsystem = resolveSubsystem(row.id_subsistema ?? "");
  if (subsystem.kind === "aggregate") {
    // No `SIN` row has ever appeared in this dataset — unlike the balanço — so
    // one turning up is a change worth failing on rather than filtering away.
    return reject(
      "unknown_subsystem",
      'id_subsistema="SIN" — unexpected in carga-energia',
    );
  }
  if (subsystem.kind === "unknown") {
    return reject("unknown_subsystem", `id_subsistema=${JSON.stringify(subsystem.raw)}`);
  }

  const raw = trimmed(row.din_instante ?? "");
  const date = parseCalendarDate(raw);
  if (!date) {
    // Date-only, not a timestamp: a `din_instante` that gained a time-of-day
    // would mean the grain moved, which must not be read as a midnight.
    return reject(
      "unparsable_timestamp",
      `din_instante=${JSON.stringify(row.din_instante ?? null)} is not a bare date`,
    );
  }
  const day = localDayInterval(date);
  if (!day) {
    return reject("dst_gap", `din_instante=${raw} has no local start`);
  }

  const value = parseDecimal(row.val_cargaenergiamwmed);
  if (value === null) {
    return reject("empty_value", "val_cargaenergiamwmed is present but empty");
  }
  if (Number.isNaN(value)) {
    return reject(
      "unparsable_value",
      `val_cargaenergiamwmed=${JSON.stringify(row.val_cargaenergiamwmed)}`,
    );
  }

  return {
    row: {
      subsystem: subsystem.code,
      validTime: day.start,
      loadMwh: mwmedToMwh(value, day.minutes),
      dayMinutes: day.minutes,
      methodologyRegime: regimeForDate(raw),
    },
  };
}

/** Parse one yearly `CARGA_ENERGIA_<YYYY>.csv`. */
export function parseDailyLoadCsv(text: string): SubsystemLoadDayParse {
  const { columns: rawColumns, rows: cells } = parseDelimited(text);
  if (rawColumns.length === 0) {
    throw new UpstreamError("carga-energia file is empty");
  }
  const columns = rawColumns.map(trimmed);
  assertColumns(columns);

  const rows: SubsystemLoadDay[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<string, number>();
  let irregularDays = 0;

  cells.forEach((cell, index) => {
    const rowNumber = index + 1;
    const outcome = normaliseRow(toRecord(columns, cell), rowNumber);
    if ("rejected" in outcome) {
      rejected.push(outcome.rejected);
      return;
    }

    const key = `${outcome.row.subsystem}|${outcome.row.validTime.toISOString()}`;
    const first = seen.get(key);
    if (first !== undefined) {
      rejected.push({
        reason: "duplicate_key",
        rowNumber,
        detail: `${key} already given on row ${first}`,
      });
      return;
    }
    seen.set(key, rowNumber);

    if (outcome.row.dayMinutes !== 1440) {
      irregularDays += 1;
    }
    rows.push(outcome.row);
  });

  return { rows, rejected, columns, irregularDays };
}

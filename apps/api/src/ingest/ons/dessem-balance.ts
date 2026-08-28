import { UpstreamError } from "../../errors.js";
import { parseDelimited, toRecord } from "../csv.js";
import {
  parseDecimal,
  resolveSubsystem,
  type SubsystemCode,
  trimmed,
} from "../normalise.js";
import { zonedWallClockToUtc } from "../time.js";
import type { DessemBalanceHalfHour, DessemBalanceParse, RejectedRow } from "../types.js";

/**
 * Adapter for ONS dataset 11, `balanco_dessem_detalhe` — the day-ahead
 * electro-energetic balance the DESSEM model produces, per subsystem, per
 * half hour.
 *
 * This is WattSteer's only *forward-looking* per-subsystem wind and solar
 * dispatch expectation, and the only ONS source in scope that is a `Forecast`
 * rather than an `Observation` at the file level: the file for reference day D
 * is created the evening of D−1. Three traps distinguish it from the adapters
 * it otherwise resembles, and each is defended below rather than commented on:
 *
 * 1. **`num_patamar` has no documented mapping to wall-clock time.** The
 *    research inferred it from one day's cross-check against the load API. This
 *    adapter therefore *asserts* the mapping on every file instead of trusting
 *    it — see `assertDaylightAlignment`.
 * 2. **The published header contradicts the data dictionary.** ONS's dictionary
 *    says `val_geracao_hidraulica` / `val_geracao_termica`; every file says
 *    `val_ger_hidraulica` / `val_ger_termica`. The file wins, and the
 *    dictionary spelling is not read at all — so if ONS ever "fixes" the file
 *    to match its own dictionary, this adapter fails loudly on a missing column
 *    rather than silently storing nulls for hydro and thermal.
 * 3. **Values are MW, not MWmed.** No `mwmedToMwh` here, deliberately.
 *
 * **CSV only, measured.** The Parquet rendition exists for every day and is
 * 16 634 bytes against the CSV's 17 236 for 2026-08-29 — a 3.5% saving on a
 * 17 kB file. That is not worth a second parse path, and specifically not worth
 * importing the INT96-materialised-as-instant hazard that the balanço adapter
 * had to defend against for `din_instante`.
 */

/** ONS CKAN package id. Underscores, unlike most ONS slugs — read, never built. */
export const DESSEM_DETAIL_DATASET_SLUG = "balanco_dessem_detalhe";

/**
 * First reference day ONS published. There is nothing before it: the DESSEM
 * balances are by far the shortest series in scope, which is why the domain
 * model records them as an A/B rather than an assumption.
 */
export const DESSEM_COVERAGE_START = "2025-05-23";

/** One patamar is one half hour. */
export const PATAMAR_MINUTES = 30;

const MS_PER_MINUTE = 60_000;

/**
 * Columns this adapter requires, spelled as the **file** spells them.
 *
 * Read from every file on every ingest and reconciled against this list — ONS
 * has already been observed backfilling columns into closed months of another
 * dataset, so "the schema of a 2025 file" is not a thing that exists.
 */
const REQUIRED_COLUMNS = [
  "din_programacaodia",
  "num_patamar",
  "cod_subsistema",
  "val_demanda",
  "val_ger_hidraulica",
  "val_ger_pch",
  "val_ger_termica",
  "val_ger_pct",
  "val_ger_eolica",
  "val_ger_fotovoltaica",
  "val_ger_mmgd",
  "val_cons_elevatoria",
] as const;

/** The nine measures, and the column each is read from. */
const MEASURES = {
  demandMw: "val_demanda",
  hydroGenerationMw: "val_ger_hidraulica",
  smallHydroGenerationMw: "val_ger_pch",
  thermalGenerationMw: "val_ger_termica",
  smallThermalGenerationMw: "val_ger_pct",
  windGenerationMw: "val_ger_eolica",
  solarGenerationMw: "val_ger_fotovoltaica",
  mmgdGenerationMw: "val_ger_mmgd",
  pumpingConsumptionMw: "val_cons_elevatoria",
} as const;

type MeasureKey = keyof typeof MEASURES;

const REFERENCE_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertColumns(columns: string[]): void {
  const present = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new UpstreamError(
      `balanco_dessem_detalhe is missing required columns: ${missing.join(", ")}. ` +
        "The published header is authoritative over the data dictionary; a rename " +
        "here is a schema change, not a parse bug.",
    );
  }
}

/**
 * The UTC instant that a reference day's local civil midnight falls at, and the
 * number of half hours the day contains.
 *
 * Derived from the zone rather than fixed at 48 so that a day is measured, not
 * assumed: Brazil abolished DST in 2019 and every day in the DESSEM window is
 * 48 patamares long, but *that is a fact about the data*, and a hard-coded 48
 * would turn a future 46- or 50-patamar day into silently shifted timestamps
 * instead of a loud rejection.
 */
export function referenceDayAnchor(referenceDay: string): {
  midnightUtc: Date;
  halfHours: number;
} {
  const match = REFERENCE_DAY.exec(referenceDay);
  if (!match) {
    throw new UpstreamError(
      `balanco_dessem_detalhe has an unreadable din_programacaodia: ${JSON.stringify(referenceDay)}`,
    );
  }
  const [, year, month, day] = match;
  const wall = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: 0,
    minute: 0,
    second: 0,
  };
  const start = zonedWallClockToUtc(wall);
  const nextDay = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  const end = zonedWallClockToUtc({
    year: nextDay.getUTCFullYear(),
    month: nextDay.getUTCMonth() + 1,
    day: nextDay.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  });
  // Neither boundary can be a DST gap or ambiguity in this zone — the
  // transitions never fell at midnight — but a silent guess at a boundary is
  // exactly the three-hour error this layer exists to refuse.
  if (start.kind !== "ok" || end.kind !== "ok") {
    throw new UpstreamError(
      `Reference day ${referenceDay} does not start and end at an unambiguous local midnight`,
    );
  }
  const halfHours = Math.round(
    (end.instant.getTime() - start.instant.getTime()) / (PATAMAR_MINUTES * MS_PER_MINUTE),
  );
  return { midnightUtc: start.instant, halfHours };
}

/**
 * The UTC start of the half hour `num_patamar` denotes.
 *
 * Patamar *k* is the half hour **ending** at 00:00 + k×30 min Brasília, so it
 * starts half an hour earlier — k = 1 is 00:00–00:30 local. This is the one
 * inference in the whole platform that ONS documents nowhere; it is applied
 * here and asserted in `assertDaylightAlignment`.
 */
export function patamarStart(midnightUtc: Date, patamar: number): Date {
  return new Date(
    midnightUtc.getTime() + (patamar - 1) * PATAMAR_MINUTES * MS_PER_MINUTE,
  );
}

/**
 * The daylight assertion — the inferred patamar mapping, checked against
 * physics on every single file.
 *
 * Solar output is the one quantity in this file whose wall-clock shape is known
 * a priori: it is exactly zero at night and large in the middle of the day.
 * Summed over subsystems, `val_ger_fotovoltaica + val_ger_mmgd` must therefore
 * be zero across local 00:00–04:00 and 21:00–24:00 and positive somewhere
 * across 09:00–15:00. Any offset in the mapping — an end/start relabelling, a
 * UTC-versus-Brasília slip, a 1-based/0-based change — walks the solar day into
 * the night window and fails here.
 *
 * Its known blind spot, stated rather than hidden: the solar day is nearly
 * symmetric about local noon, so a *reversed* patamar order would pass. Nothing
 * cheap catches that; the numeric cross-check against `/cargaprogramada` in
 * `test/ons-dessem-balance.test.ts` does, and it is asymmetric enough to.
 * Summing the four subsystems rather than checking each is deliberate too — a
 * subsystem with no modelled solar at all is a plausible future, a *grid* with
 * none is not.
 */
function assertDaylightAlignment(
  rows: DessemBalanceHalfHour[],
  referenceDay: string,
  midnightUtc: Date,
): void {
  const hourOf = (row: DessemBalanceHalfHour): number =>
    (row.validTime.getTime() - midnightUtc.getTime()) / (60 * MS_PER_MINUTE);
  const solar = (row: DessemBalanceHalfHour): number =>
    row.solarGenerationMw + row.mmgdGenerationMw;

  let nightMax = 0;
  let middayMax = 0;
  for (const row of rows) {
    const hour = hourOf(row);
    if (hour < 4 || hour >= 21) {
      nightMax = Math.max(nightMax, solar(row));
    }
    if (hour >= 9 && hour < 15) {
      middayMax = Math.max(middayMax, solar(row));
    }
  }

  if (nightMax > 0) {
    throw new UpstreamError(
      `Reference day ${referenceDay} has ${nightMax} MW of solar generation in local ` +
        "night hours: the num_patamar → wall-clock mapping this adapter infers " +
        "(patamar k = the half hour ending 00:00 + k×30 min Brasília) no longer holds.",
    );
  }
  if (middayMax <= 0) {
    throw new UpstreamError(
      `Reference day ${referenceDay} has no solar generation in local midday hours: ` +
        "the num_patamar → wall-clock mapping this adapter infers no longer holds.",
    );
  }
}

/**
 * Assert the reference day is complete: every subsystem present carries every
 * patamar of the local day exactly once.
 *
 * Loud rather than lenient, and file-level rather than row-level. A day short
 * one patamar is not a day with a hole in it — it is a day whose period index
 * may mean something other than what this adapter assumes, and storing 47 of 48
 * half hours under a mapping that might have shifted is worse than storing none.
 */
function assertCoverage(
  seen: Map<SubsystemCode, Set<number>>,
  referenceDay: string,
  halfHours: number,
): void {
  for (const [subsystem, patamares] of seen) {
    if (patamares.size !== halfHours) {
      throw new UpstreamError(
        `Reference day ${referenceDay} has ${patamares.size} patamares for subsystem ` +
          `${subsystem}; the local civil day is ${halfHours} half hours long`,
      );
    }
    for (let patamar = 1; patamar <= halfHours; patamar += 1) {
      if (!patamares.has(patamar)) {
        throw new UpstreamError(
          `Reference day ${referenceDay} is missing patamar ${patamar} for subsystem ${subsystem}`,
        );
      }
    }
  }
  if (seen.size === 0) {
    throw new UpstreamError(`Reference day ${referenceDay} carries no subsystem rows`);
  }
}

/**
 * Parse one reference day's CSV.
 *
 * Row-level defects (an unknown subsystem, a blank measure) are rejected with a
 * reason, as everywhere else. Defects that would make the *time axis* a guess —
 * more than one reference day in a file, a patamar outside the day, an
 * incomplete subsystem, a solar profile that does not sit in daylight — throw,
 * because there is no honest partial answer to them.
 */
export function parseDessemBalanceCsv(text: string): DessemBalanceParse {
  const table = parseDelimited(text);
  const columns = table.columns.map(trimmed);
  if (columns.length === 0) {
    throw new UpstreamError("balanco_dessem_detalhe CSV is empty");
  }
  assertColumns(columns);

  const days = new Set<string>();
  const source = table.rows.map((cells) => toRecord(columns, cells));
  for (const record of source) {
    days.add(trimmed(record.din_programacaodia ?? ""));
  }
  if (days.size !== 1) {
    throw new UpstreamError(
      `balanco_dessem_detalhe file covers ${days.size} reference days (${[...days].join(", ")}); ` +
        "these files are split per reference day and must carry exactly one",
    );
  }
  const referenceDay = [...days][0] as string;
  const { midnightUtc, halfHours } = referenceDayAnchor(referenceDay);

  const rows: DessemBalanceHalfHour[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<SubsystemCode, Set<number>>();
  let aggregateRowsFiltered = 0;

  source.forEach((record, index) => {
    const rowNumber = index + 1;
    const reject = (reason: RejectedRow["reason"], detail: string): void => {
      rejected.push({ reason, rowNumber, detail });
    };

    const subsystem = resolveSubsystem(record.cod_subsistema ?? "");
    if (subsystem.kind === "aggregate") {
      // No DESSEM file observed carries `SIN`, but the filter is the platform's
      // boundary rule and a file that started to would double-count without it.
      aggregateRowsFiltered += 1;
      return;
    }
    if (subsystem.kind === "unknown") {
      reject("unknown_subsystem", `cod_subsistema=${JSON.stringify(subsystem.raw)}`);
      return;
    }

    const patamar = Number(trimmed(record.num_patamar ?? ""));
    if (!Number.isInteger(patamar) || patamar < 1 || patamar > halfHours) {
      throw new UpstreamError(
        `Reference day ${referenceDay} carries num_patamar=${JSON.stringify(record.num_patamar ?? null)}, ` +
          `outside the ${halfHours} half hours of the local civil day`,
      );
    }
    const patamares = seen.get(subsystem.code) ?? new Set<number>();
    if (patamares.has(patamar)) {
      throw new UpstreamError(
        `Reference day ${referenceDay} repeats patamar ${patamar} for subsystem ${subsystem.code}`,
      );
    }
    patamares.add(patamar);
    seen.set(subsystem.code, patamares);

    const measures = {} as Record<MeasureKey, number>;
    let failed = false;
    for (const [key, column] of Object.entries(MEASURES) as [MeasureKey, string][]) {
      const value = parseDecimal(record[column]);
      if (value === null) {
        reject("empty_value", `${column} is present but empty`);
        failed = true;
        break;
      }
      if (Number.isNaN(value)) {
        reject("unparsable_value", `${column}=${JSON.stringify(record[column])}`);
        failed = true;
        break;
      }
      // No MWmed conversion: DESSEM publishes MW. Applying the conversion the
      // other adapters apply would halve every half-hourly value.
      measures[key] = value;
    }
    if (failed) {
      return;
    }

    rows.push({
      subsystem: subsystem.code,
      validTime: patamarStart(midnightUtc, patamar),
      referenceDay,
      ...measures,
    });
  });

  assertCoverage(seen, referenceDay, halfHours);
  assertDaylightAlignment(rows, referenceDay, midnightUtc);

  return {
    rows,
    rejected,
    columns,
    referenceDay,
    patamaresPerSubsystem: halfHours,
    aggregateRowsFiltered,
  };
}

import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core/constants";
import { PayloadRefusedError } from "../../errors.js";
import { parseDelimited, toRecord } from "../csv.js";
import {
  parseDecimal,
  resolveSubsystem,
  type SubsystemCode,
  trimmed,
} from "../normalise.js";
import type { DessemGeneralHalfHour, DessemGeneralParse, RejectedRow } from "../types.js";
import { patamarStart, referenceDayAnchor } from "./dessem-balance.js";

/**
 * Adapter for ONS `balanco_dessem_geral` — the same day-ahead DESSEM run that
 * `balanco_dessem_detalhe` publishes, in a coarser subsystem-grain vocabulary.
 *
 * It is a **cross-check**, and no feature reads it: see `dessemGeneralHalfHour`
 * in the schema. Three things differ from the detalhe adapter it is modelled on,
 * and each is a decision rather than an omission.
 *
 * 1. **Whole days only.** The detalhe adapter admits a reference day ONS
 *    published short, and it can only do that because the solar profile pins
 *    `num_patamar` to wall-clock time: a contiguous run that reaches local midday
 *    is readable, one that does not is not. This file has no photovoltaic-only
 *    column — `val_geracao_renovavel` is wind, solar and MMGD together and is
 *    nonzero at night because wind is — so nothing in it pins the index, and a
 *    short day cannot be shown to mean what it says. It is refused as
 *    `coverage` rather than stored with a shortfall nobody can interpret.
 *
 * 2. **No daylight assertion, and that is stated rather than hidden.** The
 *    detalhe adapter checks its inferred `num_patamar` → wall-clock mapping
 *    against physics on every file. This one cannot: there is no quantity here
 *    whose wall-clock shape is known a priori. The mapping is the dictionary in
 *    `patamar.ts` (48 half hours), which was verified against an *independent*
 *    series — this dataset's `val_demanda` agrees with `/cargaprogramada` to
 *    0.03% at half-hour offsets (`docs/research/ons-datasets.md`, §10 & 11) —
 *    but that was one day, by hand. **No per-file check enforces it yet.** The
 *    natural one is `canonical_day_ahead_general.demand_mw` against
 *    `canonical_programmed_load` for the same half hour, which needs both tables
 *    populated, so it belongs to the database suite and has not been written.
 *
 * 3. **The published header is the dictionary's spelling here.** The detalhe
 *    file says `val_ger_hidraulica` / `val_ger_termica` against its own
 *    dictionary; this one says `val_geracao_hidraulica` / `val_geracao_termica`,
 *    read from the 2026-09-17 file. A required column that goes missing fails
 *    loudly instead of storing nulls for hydro and thermal.
 *
 * Values are MW, not MWmed, exactly as in detalhe: no `mwmedToMwh`.
 *
 * **CSV only.** The Parquet rendition exists for every day, and the detalhe
 * adapter measured what a second parse path costs — including the INT96
 * timestamp hazard — against a 3.5% saving on a 17 kB file.
 */

/** ONS CKAN package id. Underscores, as `balanco_dessem_detalhe` — read, never built. */
export const DESSEM_GENERAL_DATASET_SLUG = "balanco_dessem_geral";

/**
 * First reference day ONS published: the same day as the detalhe file, which is
 * what makes the two comparable over their whole shared history.
 */
export { DESSEM_COVERAGE_START as DESSEM_GENERAL_COVERAGE_START } from "./dessem-balance.js";

/** Columns this adapter requires, spelled as the **file** spells them. */
const REQUIRED_COLUMNS = [
  "din_programacaodia",
  "num_patamar",
  "cod_subsistema",
  "val_demanda",
  "val_geracao_renovavel",
  "val_geracao_hidraulica",
  "val_geracao_termica",
  "val_cons_elevatoria",
] as const;

/** The five measures, and the column each is read from. */
const MEASURES = {
  demandMw: "val_demanda",
  renewableGenerationMw: "val_geracao_renovavel",
  hydroGenerationMw: "val_geracao_hidraulica",
  thermalGenerationMw: "val_geracao_termica",
  pumpingConsumptionMw: "val_cons_elevatoria",
} as const;

type MeasureKey = keyof typeof MEASURES;

function assertColumns(columns: string[]): void {
  const present = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new PayloadRefusedError(
      "schema",
      `balanco_dessem_geral is missing required columns: ${missing.join(", ")}. ` +
        "The published header is authoritative over the data dictionary; a rename " +
        "here is a schema change, not a parse bug.",
    );
  }
}

/**
 * Parse one reference day's CSV.
 *
 * Row-level defects — an unknown subsystem, a blank or unparsable measure — are
 * rejected with a reason, as everywhere else. **But a rejected row makes the day
 * short**, and a short day is refused, so a value defect in this file refuses
 * the day rather than storing it with a hole in it. Defects that make the time
 * axis a guess — more than one reference day in a file, a patamar outside the
 * day, a repeated patamar — throw for the reason they do in the detalhe adapter.
 */
export function parseDessemGeneralCsv(text: string): DessemGeneralParse {
  const table = parseDelimited(text);
  const columns = table.columns.map(trimmed);
  if (columns.length === 0) {
    throw new PayloadRefusedError("schema", "balanco_dessem_geral CSV is empty");
  }
  assertColumns(columns);

  const source = table.rows.map((cells) => toRecord(columns, cells));
  const days = new Set<string>();
  for (const record of source) {
    days.add(trimmed(record.din_programacaodia ?? ""));
  }
  if (days.size !== 1) {
    throw new PayloadRefusedError(
      "coverage",
      `balanco_dessem_geral file covers ${days.size} reference days (${[...days].join(", ")}); ` +
        "these files are split per reference day and must carry exactly one",
    );
  }
  const referenceDay = [...days][0] as string;
  const { midnightUtc, halfHours } = referenceDayAnchor(referenceDay);

  const rows: DessemGeneralHalfHour[] = [];
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
      aggregateRowsFiltered += 1;
      return;
    }
    if (subsystem.kind === "unknown") {
      reject("unknown_subsystem", `cod_subsistema=${JSON.stringify(subsystem.raw)}`);
      return;
    }

    const patamar = Number(trimmed(record.num_patamar ?? ""));
    if (!Number.isInteger(patamar) || patamar < 1 || patamar > halfHours) {
      throw new PayloadRefusedError(
        "time_axis",
        `Reference day ${referenceDay} carries num_patamar=${JSON.stringify(record.num_patamar ?? null)}, ` +
          `outside the ${halfHours} half hours of the local civil day`,
      );
    }
    const patamares = seen.get(subsystem.code) ?? new Set<number>();
    if (patamares.has(patamar)) {
      throw new PayloadRefusedError(
        "coverage",
        `Reference day ${referenceDay} repeats patamar ${patamar} for subsystem ${subsystem.code}`,
      );
    }
    patamares.add(patamar);
    seen.set(subsystem.code, patamares);

    const measures = {} as Record<MeasureKey, number>;
    for (const [key, column] of Object.entries(MEASURES) as [MeasureKey, string][]) {
      const value = parseDecimal(record[column]);
      if (value === null) {
        reject("empty_value", `${column} is present but empty`);
        return;
      }
      if (Number.isNaN(value)) {
        reject("unparsable_value", `${column}=${JSON.stringify(record[column])}`);
        return;
      }
      // No MWmed conversion: DESSEM publishes MW.
      measures[key] = value;
    }

    rows.push({
      subsystem: subsystem.code,
      validTime: patamarStart(midnightUtc, patamar),
      referenceDay,
      ...measures,
    });
  });

  assertWholeDay(rows, seen, referenceDay, halfHours);

  return {
    rows,
    rejected,
    columns,
    referenceDay,
    halfHoursInCivilDay: halfHours,
    aggregateRowsFiltered,
  };
}

/**
 * Refuse anything but the whole civil day in all four subsystems.
 *
 * Checked against the *rows that survived*, not against `seen`: a patamar whose
 * measures were rejected counted as seen, and admitting it would store a day
 * with a hole while claiming it was whole. The subsystem set is checked too — a
 * file that carries three of the four is a different upstream event from one
 * cut short, and no subsystem's rows can be read as the grid's day without it.
 */
function assertWholeDay(
  rows: readonly DessemGeneralHalfHour[],
  seen: ReadonlyMap<SubsystemCode, ReadonlySet<number>>,
  referenceDay: string,
  halfHours: number,
): void {
  const missing = SUBSYSTEM_DISPLAY_ORDER.filter((code) => !seen.has(code));
  if (missing.length > 0) {
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} carries no rows for subsystem ${missing.join(", ")}; ` +
        "a day is the four subsystems together or it is not a day this adapter reads.",
    );
  }

  const stored = new Map<SubsystemCode, number>();
  for (const row of rows) {
    stored.set(row.subsystem, (stored.get(row.subsystem) ?? 0) + 1);
  }
  const short = SUBSYSTEM_DISPLAY_ORDER.filter(
    (code) => (stored.get(code) ?? 0) !== halfHours,
  );
  if (short.length > 0) {
    const detail = short
      .map((code) => `${code} ${stored.get(code) ?? 0}/${halfHours}`)
      .join(", ");
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} is not a whole civil day: ${detail}. This file has ` +
        "no photovoltaic-only column, so nothing in it pins num_patamar to wall-clock " +
        "time, and a short run cannot be shown to mean what its patamares say " +
        "(compare balanco_dessem_detalhe, whose solar profile does). The day is " +
        "refused rather than stored with a shortfall nobody can interpret.",
    );
  }
}

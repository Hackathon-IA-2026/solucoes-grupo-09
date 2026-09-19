import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core/constants";
import { PayloadRefusedError } from "../../errors.js";
import { type DelimitedTable, parseDelimited, toRecord } from "../csv.js";
import {
  parseDecimal,
  resolveSubsystem,
  type SubsystemCode,
  trimmed,
} from "../normalise.js";
import type {
  ProgrammedGenerationHalfHour,
  ProgrammedGenerationParse,
  ProgrammePlantVector,
  ProgrammeTechnology,
  RejectedRow,
} from "../types.js";
import {
  assertRequiredColumns,
  patamarStart,
  readPatamar,
  roundSum,
  soleReferenceDay,
} from "./programme.js";

/**
 * Adapter for ONS `programacao_diaria` — the day-ahead generation programme, one
 * row per plant per half hour, **aggregated here to (subsystem, technology,
 * half hour)**.
 *
 * `docs/specs/data-platform.md` and `docs/specs/feature-engineering.md` scoped
 * this dataset out because the forecast grain is the subsystem and the plant
 * grain is noise to it. That rejected the *plant grain*, not the dataset, and
 * aggregating at the adapter is what honours it: a day is ~204,000 rows and
 * ~39 MB, and 768 rows afterwards. Nothing downstream can meet a plant row.
 *
 * **Why keep it at all.** It says which dispatchable plants ONS programmed to
 * run and *why* — inflexibility, unit commitment, electrical reason — during the
 * hours it also expects renewable surplus. That is context for a curtailment
 * reader, not a cause: the product forecasts how much, and the reason on screen
 * stays ONS's, read from the settled record.
 *
 * **Three decisions, each measured on 2026-09-18.**
 *
 * 1. **`val_ordemmerito` is not stored.** The dictionary calls it a value in
 *    MWmed, and it is `999.00` on 612 rows across 22 thermal plants. On 595 of
 *    those rows it is larger than the plant's *entire* programmed generation
 *    (a plant programmed at 114 MW carries 999), so it cannot be a megawatt
 *    component of that programme, and a sum of it would be fabricated megawatts. The components ONS lists do **not** reconcile to the
 *    programmed value either (they sum to it on 13,575 of 26,640 thermal rows),
 *    so the columns that are stored are sums of what ONS published and are never
 *    to be presented as a breakdown of `programmed_mw`.
 * 2. **Components are null, never zero, where nothing reported one.** Every
 *    measure past `val_disponibilidade` is empty on all 137,000 wind, solar and
 *    hydro rows and populated only for thermal, so a zero on a wind row would
 *    assert a quantity wind does not have.
 * 3. **A value defect refuses the day.** Dropping a plant row from a sum
 *    understates the group without a trace, so — unlike a row that belongs to
 *    no group — an unreadable programmed value refuses the whole file as
 *    `coverage`, the same policy `dessem-general.ts` states for a short day.
 *    An *empty* availability is not a defect: 14 thermal plants publish none, and
 *    the group says so through `reportingPlantCount`.
 *
 * Values are MWmed. The file is `;`-delimited, and `id_subsistema` is padded.
 */

export const PROGRAMME_DAILY_DATASET_SLUG = "programacao_diaria";

/** Prefix of a genuine file; the sibling dataset's resource list carries a stray one of these. */
export const PROGRAMME_DAILY_FILE_PREFIX = "PROGRAMACAO_DIARIA_";

/** First reference day ONS published — 2024-10-01 in all three programme datasets. */
export const PROGRAMME_COVERAGE_START = "2024-10-01";

const REQUIRED_COLUMNS = [
  "din_programacaodia",
  "num_patamar",
  "cod_exibicaousina",
  "tip_geracao",
  "id_subsistema",
  "val_geracaoprogramada",
  "val_disponibilidade",
  "val_inflexibilidade",
  "val_uc",
  "val_razaoeletrica",
  "val_geracaoenergetica",
  "val_exportacao",
] as const;

/** `tip_geracao`, as the file spells it, to WattSteer's vocabulary. */
const TECHNOLOGY: Record<string, ProgrammeTechnology> = {
  EÓLICA: "WIND",
  SOLAR: "SOLAR",
  HIDRÁULICA: "HYDRO",
  TÉRMICA: "THERMAL",
};

/** The optional components, and the column each is read from. */
const COMPONENTS = {
  inflexibilityMw: "val_inflexibilidade",
  unitCommitmentMw: "val_uc",
  electricalReasonMw: "val_razaoeletrica",
  energyGuaranteeMw: "val_geracaoenergetica",
  exportMw: "val_exportacao",
} as const;

type ComponentKey = keyof typeof COMPONENTS;

interface Accumulator {
  subsystem: SubsystemCode;
  technology: ProgrammeTechnology;
  patamar: number;
  plants: number;
  reporting: number;
  programmed: number;
  availability: number | null;
  components: Record<ComponentKey, number | null>;
}

/**
 * Parse the file as the CSV text ONS publishes. The CSV and Parquet renditions
 * of a day reach the same table parser, so there is one parse path and not two.
 */
export function parseProgrammeDailyCsv(text: string): ProgrammedGenerationParse {
  return parseProgrammeDailyTable(parseDelimited(text));
}

/** Parse a day's file already read into a table, from either rendition. */
export function parseProgrammeDailyTable(
  table: DelimitedTable,
): ProgrammedGenerationParse {
  const columns = table.columns.map(trimmed);
  if (columns.length === 0) {
    throw new PayloadRefusedError("schema", "programacao_diaria CSV is empty");
  }
  assertRequiredColumns("programacao_diaria", columns, REQUIRED_COLUMNS);

  const source = table.rows.map((cells) => toRecord(columns, cells));
  const { referenceDay, midnightUtc, halfHours } = soleReferenceDay(
    "programacao_diaria",
    source.map((record) => record.din_programacaodia ?? ""),
  );

  const groups = new Map<string, Accumulator>();
  const seenPlantPatamar = new Set<string>();
  const vectors = new Map<string, ProgrammePlantVector>();
  const rejected: RejectedRow[] = [];
  const defects: string[] = [];

  source.forEach((record, index) => {
    const rowNumber = index + 1;
    const reject = (reason: RejectedRow["reason"], detail: string): void => {
      rejected.push({ reason, rowNumber, detail });
    };

    const subsystem = resolveSubsystem(record.id_subsistema ?? "");
    if (subsystem.kind === "aggregate") {
      return;
    }
    if (subsystem.kind === "unknown") {
      reject("unknown_subsystem", `id_subsistema=${JSON.stringify(subsystem.raw)}`);
      return;
    }
    const technology = TECHNOLOGY[trimmed(record.tip_geracao ?? "").toUpperCase()];
    if (technology === undefined) {
      reject("unknown_technology", `tip_geracao=${JSON.stringify(record.tip_geracao)}`);
      return;
    }
    const plant = trimmed(record.cod_exibicaousina ?? "");
    if (plant === "") {
      reject("missing_identity", "cod_exibicaousina is empty");
      return;
    }
    const patamar = readPatamar(referenceDay, record.num_patamar, halfHours);

    const key = `${plant}|${patamar}`;
    if (seenPlantPatamar.has(key)) {
      throw new PayloadRefusedError(
        "coverage",
        `Reference day ${referenceDay} repeats patamar ${patamar} for plant ${plant}`,
      );
    }
    seenPlantPatamar.add(key);

    // Only the programmed value is required of a plant. `val_disponibilidade` is
    // empty for 14 thermal plants (672 rows) on the day measured while their
    // programmed value is present — first written as required, which refused
    // the real 2026-09-18 file — so an empty one is "not reported", and a
    // non-numeric one is still a defect.
    const programmed = parseDecimal(record.val_geracaoprogramada);
    const availability = parseDecimal(record.val_disponibilidade);
    if (programmed === null || Number.isNaN(programmed) || Number.isNaN(availability)) {
      defects.push(
        `${plant} patamar ${patamar}: val_geracaoprogramada=${JSON.stringify(record.val_geracaoprogramada)}, ` +
          `val_disponibilidade=${JSON.stringify(record.val_disponibilidade)}`,
      );
      return;
    }

    const groupKey = `${subsystem.code}|${technology}|${patamar}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        subsystem: subsystem.code,
        technology,
        patamar,
        plants: 0,
        reporting: 0,
        programmed: 0,
        availability: null,
        components: {
          inflexibilityMw: null,
          unitCommitmentMw: null,
          electricalReasonMw: null,
          energyGuaranteeMw: null,
          exportMw: null,
        },
      };
      groups.set(groupKey, group);
    }
    group.plants += 1;
    group.programmed += programmed;
    if (availability !== null) {
      group.reporting += 1;
      group.availability = (group.availability ?? 0) + availability;
    }
    for (const [componentKey, column] of Object.entries(COMPONENTS) as [
      ComponentKey,
      string,
    ][]) {
      const value = parseDecimal(record[column]);
      if (value === null) {
        continue; // Not reported by this plant: contributes nothing, and is not a zero.
      }
      if (Number.isNaN(value)) {
        defects.push(
          `${plant} patamar ${patamar}: ${column}=${JSON.stringify(record[column])}`,
        );
        continue;
      }
      group.components[componentKey] = (group.components[componentKey] ?? 0) + value;
    }

    if (technology === "WIND" || technology === "SOLAR") {
      let vector = vectors.get(plant);
      if (!vector) {
        vector = {
          plantCode: plant,
          subsystem: subsystem.code,
          technology,
          programmedMw: new Array<number | null>(halfHours).fill(null),
        };
        vectors.set(plant, vector);
      }
      vector.programmedMw[patamar - 1] = programmed;
    }
  });

  if (defects.length > 0) {
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} has ${defects.length} plant row(s) with an unreadable value ` +
        `(first: ${defects[0]}). A plant left out of a sum understates its group without a ` +
        "trace, so the day is refused rather than stored short.",
    );
  }

  assertWholeDay(groups, referenceDay, halfHours);

  const rows: ProgrammedGenerationHalfHour[] = [...groups.values()].map((group) => ({
    subsystem: group.subsystem,
    technology: group.technology,
    validTime: patamarStart(midnightUtc, group.patamar),
    referenceDay,
    plantCount: group.plants,
    reportingPlantCount: group.reporting,
    programmedMw: roundSum(group.programmed),
    availabilityMw: sumOrNull(group.availability),
    inflexibilityMw: sumOrNull(group.components.inflexibilityMw),
    unitCommitmentMw: sumOrNull(group.components.unitCommitmentMw),
    electricalReasonMw: sumOrNull(group.components.electricalReasonMw),
    energyGuaranteeMw: sumOrNull(group.components.energyGuaranteeMw),
    exportMw: sumOrNull(group.components.exportMw),
  }));

  return {
    rows,
    rejected,
    columns,
    referenceDay,
    halfHoursInCivilDay: halfHours,
    plantRowsRead: seenPlantPatamar.size,
    plantVectors: [...vectors.values()],
  };
}

function sumOrNull(value: number | null): number | null {
  return value === null ? null : roundSum(value);
}

/**
 * Refuse anything but the whole civil day, in every group the file carries and
 * in all four subsystems.
 *
 * A group is judged against the civil day rather than against a fixed roster of
 * (subsystem, technology) pairs, because the roster is a fact about the fleet —
 * `N` has one wind plant and `SE` one — that changes when a plant is built. What
 * cannot change is that a group that appears must appear for all 48 half hours.
 */
function assertWholeDay(
  groups: ReadonlyMap<string, Accumulator>,
  referenceDay: string,
  halfHours: number,
): void {
  const perGroup = new Map<string, number>();
  const subsystems = new Set<SubsystemCode>();
  for (const group of groups.values()) {
    const key = `${group.subsystem}/${group.technology}`;
    perGroup.set(key, (perGroup.get(key) ?? 0) + 1);
    subsystems.add(group.subsystem);
  }
  const missing = SUBSYSTEM_DISPLAY_ORDER.filter((code) => !subsystems.has(code));
  if (missing.length > 0) {
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} carries no rows for subsystem ${missing.join(", ")}`,
    );
  }
  const short = [...perGroup].filter(([, count]) => count !== halfHours);
  if (short.length > 0) {
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} is not a whole civil day: ` +
        short.map(([key, count]) => `${key} ${count}/${halfHours}`).join(", "),
    );
  }
}

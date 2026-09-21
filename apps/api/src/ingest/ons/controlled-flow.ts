import { PayloadRefusedError } from "../../errors.js";
import { type DelimitedTable, parseDelimited, toRecord } from "../csv.js";
import { parseDecimal, resolveSubsystem, trimmed } from "../normalise.js";
import type {
  ControlledFlowHalfHour,
  ControlledFlowParse,
  ControlledFlowSubmarket,
  RejectedRow,
} from "../types.js";
import {
  assertRequiredColumns,
  patamarStart,
  readPatamar,
  soleReferenceDay,
} from "./programme.js";

/**
 * Adapter for ONS `programacao_fluxo_controlado` — the day-ahead programmed flow
 * through each **controlled-flow element**, the transmission corridors ONS
 * limits the day before. The input to the `CNF` cause: a curtailment for a
 * network constraint is ONS holding an element's flow to a programmed value.
 *
 * **Element grain, and no aggregate — deliberately.** A day is 40 elements ×
 * 48 patamares = 1,920 rows, keyed `(element, terminal, half hour)` with no
 * duplicate on the day measured. `val_carga` is **signed** (−1500…1500 MW): the
 * sign is the direction across the element, and different elements are
 * different corridors, so a subsystem sum of them is not a quantity and this
 * dataset publishes none.
 *
 * **`cod_submercado` includes `RR`.** Roraima is a submarket ONS publishes here
 * and not one of WattSteer's four subsystems. It is stored as what the file says
 * rather than rejected: the code describes where the *element* sits, not a
 * subsystem row this adapter must place, and dropping it would drop a real
 * corridor. An unrecognised code is still rejected as `unknown_submarket`, and
 * because the element is then short, the day is refused rather than stored
 * without a corridor.
 * The values are padded (`SE `, `RR `) and are trimmed.
 *
 * **The resource list carries a stray file.** `PROGRAMACAO_DIARIA_2026_07_21.parquet`
 * sits in this dataset's resources, pointing at the other dataset's folder. It is
 * kept out by selecting on `PROGRAMACAO_FLUXO_CONTROLADO_` (see the job), never
 * by reading it and noticing.
 *
 * Whole days only: an element that carries fewer than 48 patamares, or a
 * patamar whose value cannot be read, refuses the day.
 */

export const CONTROLLED_FLOW_DATASET_SLUG = "programacao_fluxo_controlado";
export const CONTROLLED_FLOW_FILE_PREFIX = "PROGRAMACAO_FLUXO_CONTROLADO_";

const REQUIRED_COLUMNS = [
  "din_programacaodia",
  "num_patamar",
  "nom_elementofluxocontrolado",
  "dsc_elementofluxocontrolado",
  "tip_terminal",
  "cod_submercado",
  "val_carga",
] as const;

function resolveSubmarket(raw: string): ControlledFlowSubmarket | null {
  if (trimmed(raw).toUpperCase() === "RR") {
    return "RR";
  }
  const subsystem = resolveSubsystem(raw);
  return subsystem.kind === "subsystem" ? subsystem.code : null;
}

/**
 * Parse the file as the CSV text ONS publishes. The CSV and Parquet renditions
 * of a day reach the same table parser, so there is one parse path and not two.
 */
export function parseControlledFlowCsv(text: string): ControlledFlowParse {
  return parseControlledFlowTable(parseDelimited(text));
}

/** Parse a day's file already read into a table, from either rendition. */
export function parseControlledFlowTable(table: DelimitedTable): ControlledFlowParse {
  const columns = table.columns.map(trimmed);
  if (columns.length === 0) {
    throw new PayloadRefusedError("schema", "programacao_fluxo_controlado CSV is empty");
  }
  assertRequiredColumns("programacao_fluxo_controlado", columns, REQUIRED_COLUMNS);

  const source = table.rows.map((cells) => toRecord(columns, cells));
  const { referenceDay, midnightUtc, halfHours } = soleReferenceDay(
    "programacao_fluxo_controlado",
    source.map((record) => record.din_programacaodia ?? ""),
  );

  const rows: ControlledFlowHalfHour[] = [];
  const rejected: RejectedRow[] = [];
  const perElement = new Map<string, Set<number>>();

  source.forEach((record, index) => {
    const rowNumber = index + 1;
    const reject = (reason: RejectedRow["reason"], detail: string): void => {
      rejected.push({ reason, rowNumber, detail });
    };

    const element = trimmed(record.nom_elementofluxocontrolado ?? "");
    if (element === "") {
      reject("missing_identity", "nom_elementofluxocontrolado is empty");
      return;
    }
    const terminal = Number(trimmed(record.tip_terminal ?? ""));
    if (!Number.isInteger(terminal) || terminal < 1) {
      reject("unparsable_value", `tip_terminal=${JSON.stringify(record.tip_terminal)}`);
      return;
    }
    const patamar = readPatamar(referenceDay, record.num_patamar, halfHours);

    const identity = `${element}|${terminal}`;
    const patamares = perElement.get(identity) ?? new Set<number>();
    if (patamares.has(patamar)) {
      throw new PayloadRefusedError(
        "coverage",
        `Reference day ${referenceDay} repeats patamar ${patamar} for element ${element} terminal ${terminal}`,
      );
    }
    patamares.add(patamar);
    perElement.set(identity, patamares);

    // Checked **after** the element is registered, deliberately. Checked before,
    // an element whose every row names an unknown submarket never counted as seen
    // and simply vanished from the day, reported only in `rejected` — first
    // written that way, and caught by a test asserting the day is refused. A row
    // rejected here leaves its element short, and a short element refuses the
    // day, as everywhere else in this family.
    const submarket = resolveSubmarket(record.cod_submercado ?? "");
    if (submarket === null) {
      reject(
        "unknown_submarket",
        `cod_submercado=${JSON.stringify(record.cod_submercado)}`,
      );
      return;
    }

    const load = parseDecimal(record.val_carga);
    if (load === null) {
      reject("empty_value", "val_carga is present but empty");
      return;
    }
    if (Number.isNaN(load)) {
      reject("unparsable_value", `val_carga=${JSON.stringify(record.val_carga)}`);
      return;
    }

    rows.push({
      element,
      description: trimmed(record.dsc_elementofluxocontrolado ?? ""),
      terminal,
      submarket,
      validTime: patamarStart(midnightUtc, patamar),
      referenceDay,
      loadMw: load,
    });
  });

  const stored = new Map<string, number>();
  for (const row of rows) {
    const identity = `${row.element}|${row.terminal}`;
    stored.set(identity, (stored.get(identity) ?? 0) + 1);
  }
  const short = [...perElement.keys()].filter(
    (id) => (stored.get(id) ?? 0) !== halfHours,
  );
  if (rows.length === 0 || short.length > 0) {
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} is not a whole civil day for ${short.length} controlled-flow ` +
        `element(s) (${short
          .slice(0, 3)
          .map((id) => `${id} ${stored.get(id) ?? 0}/${halfHours}`)
          .join(", ")}); refused rather than stored with a hole.`,
    );
  }

  return { rows, rejected, columns, referenceDay, halfHoursInCivilDay: halfHours };
}

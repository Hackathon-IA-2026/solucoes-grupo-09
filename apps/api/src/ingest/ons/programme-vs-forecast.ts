import { PayloadRefusedError } from "../../errors.js";
import { type DelimitedTable, parseDelimited, toRecord } from "../csv.js";
import { parseDecimal, trimmed } from "../normalise.js";
import type {
  ProgrammedVsForecastHalfHour,
  ProgrammedVsForecastParse,
  RejectedRow,
} from "../types.js";
import {
  assertRequiredColumns,
  patamarStart,
  readPatamar,
  soleReferenceDay,
} from "./programme.js";

/**
 * Adapter for ONS `programacao_x_previsao` — for each wind and solar PDP entity,
 * ONS's own forecast of its output beside what it then programmed for it.
 *
 * **The dataset carries no subsystem and no technology**, and its
 * `cod_usinapdp` is a third code namespace: zero overlap with the registry's
 * `id_ons`, its `ceg`, or `programacao_diaria`'s `cod_exibicaousina`, on any of
 * the 628 codes seen. This adapter therefore stores what the file says and
 * nothing it does not; the mapping to a subsystem is `pdp-fingerprint.ts` and
 * `pdp_crosswalk`, a separate belief with its own vintage.
 *
 * `val_previsao` against `val_programado` is the measurement that matters for
 * curtailment: where ONS programmed less than it forecast, it decided in
 * advance to leave energy on the table. It is a statement of intent by the
 * operator, published before the day, and is not the settled constrained-off
 * that the observed record holds.
 *
 * Whole days only, as `dessem-general.ts`: a short entity is a hole in a
 * series, and a value that cannot be read leaves one, so either refuses the day.
 * `dat_programacao` is written `YYYYMMDD` here and `YYYY-MM-DD` elsewhere in the
 * family; both are read. Padded codes and names are trimmed.
 */

export const PROGRAMME_VS_FORECAST_DATASET_SLUG = "programacao_x_previsao";
export const PROGRAMME_VS_FORECAST_FILE_PREFIX = "PROGRAMACAO_X_PREVISAO_";

const REQUIRED_COLUMNS = [
  "dat_programacao",
  "num_patamar",
  "cod_usinapdp",
  "nom_usinapdp",
  "val_previsao",
  "val_programado",
] as const;

/**
 * Parse the file as the CSV text ONS publishes. The CSV and Parquet renditions
 * of a day reach the same table parser, so there is one parse path and not two.
 */
export function parseProgrammeVsForecastCsv(text: string): ProgrammedVsForecastParse {
  return parseProgrammeVsForecastTable(parseDelimited(text));
}

/** Parse a day's file already read into a table, from either rendition. */
export function parseProgrammeVsForecastTable(
  table: DelimitedTable,
): ProgrammedVsForecastParse {
  const columns = table.columns.map(trimmed);
  if (columns.length === 0) {
    throw new PayloadRefusedError("schema", "programacao_x_previsao CSV is empty");
  }
  assertRequiredColumns("programacao_x_previsao", columns, REQUIRED_COLUMNS);

  const source = table.rows.map((cells) => toRecord(columns, cells));
  const { referenceDay, midnightUtc, halfHours } = soleReferenceDay(
    "programacao_x_previsao",
    source.map((record) => record.dat_programacao ?? ""),
  );

  const rows: ProgrammedVsForecastHalfHour[] = [];
  const rejected: RejectedRow[] = [];
  const perEntity = new Map<string, Set<number>>();

  source.forEach((record, index) => {
    const rowNumber = index + 1;
    const reject = (reason: RejectedRow["reason"], detail: string): void => {
      rejected.push({ reason, rowNumber, detail });
    };

    const pdpCode = trimmed(record.cod_usinapdp ?? "");
    if (pdpCode === "") {
      reject("missing_identity", "cod_usinapdp is empty");
      return;
    }
    const patamar = readPatamar(referenceDay, record.num_patamar, halfHours);
    const patamares = perEntity.get(pdpCode) ?? new Set<number>();
    if (patamares.has(patamar)) {
      throw new PayloadRefusedError(
        "coverage",
        `Reference day ${referenceDay} repeats patamar ${patamar} for PDP entity ${pdpCode}`,
      );
    }
    patamares.add(patamar);
    perEntity.set(pdpCode, patamares);

    const forecast = parseDecimal(record.val_previsao);
    const programmed = parseDecimal(record.val_programado);
    for (const [column, value] of [
      ["val_previsao", forecast],
      ["val_programado", programmed],
    ] as const) {
      if (value === null) {
        reject("empty_value", `${column} is present but empty`);
        return;
      }
      if (Number.isNaN(value)) {
        reject("unparsable_value", `${column}=${JSON.stringify(record[column])}`);
        return;
      }
    }

    rows.push({
      pdpCode,
      pdpName: trimmed(record.nom_usinapdp ?? ""),
      validTime: patamarStart(midnightUtc, patamar),
      referenceDay,
      forecastMw: forecast as number,
      programmedMw: programmed as number,
    });
  });

  // Judged on the rows that survived: an entity whose value was rejected counted
  // as seen, and admitting it would store a series with a hole in it.
  const stored = new Map<string, number>();
  for (const row of rows) {
    stored.set(row.pdpCode, (stored.get(row.pdpCode) ?? 0) + 1);
  }
  const short = [...perEntity.keys()].filter(
    (code) => (stored.get(code) ?? 0) !== halfHours,
  );
  if (rows.length === 0 || short.length > 0) {
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} is not a whole civil day for ${short.length} PDP ` +
        `entit${short.length === 1 ? "y" : "ies"} (${short
          .slice(0, 3)
          .map((code) => `${code} ${stored.get(code) ?? 0}/${halfHours}`)
          .join(", ")}); a short series is a hole and is refused rather than stored.`,
    );
  }

  return { rows, rejected, columns, referenceDay, halfHoursInCivilDay: halfHours };
}

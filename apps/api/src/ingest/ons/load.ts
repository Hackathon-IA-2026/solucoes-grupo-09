import { mwmedToMwh, trimmed } from "../normalise.js";
import type {
  LoadParse,
  ProgrammedLoadHalfHour,
  RejectedRow,
  RejectionReason,
  VerifiedLoadHalfHour,
} from "../types.js";
import {
  isLoadAreaCode,
  type LoadAreaCode,
  loadAreaKind,
  type RawLoadRow,
  subsystemForArea,
} from "./carga-api.js";

/**
 * Adapter for ONS datasets 6 and 7 — carga de energia verificada and
 * programada, at half-hourly grain.
 *
 * The transport (paging, the `SECO` dialect, the tolerant parser) is
 * `carga-api.ts`. What is here is the conversion from an ONS row to a canonical
 * one, and it turns on three facts that are invisible in the code that would
 * otherwise be written:
 *
 * 1. **`din_referenciautc` is genuinely UTC.** It is one of only two fields in
 *    the whole ONS catalogue with a documented timezone, and the documented
 *    zone is UTC+0. Passing it through the `America/Sao_Paulo` conversion every
 *    other adapter needs would move it three hours in the one dataset that did
 *    not need moving. So the `Z` is required and the instant is taken as-is.
 * 2. **It labels the END of the half hour.** "Data de referência do **final** do
 *    intervalo da semi-hora". Constrained-off and balanço label the start. The
 *    difference is exactly the half hour that misaligns curtailment against
 *    load, so it is removed here, once.
 * 3. **The values are MWmed.** Half an hour of MWmed is half as many MWh.
 */

/** These rows are half-hourly, so MWmed converts to MWh over 30 minutes. */
export const INTERVAL_MINUTES = 30;

const MS_PER_MINUTE = 60_000;

/**
 * `din_referenciautc` with its explicit `Z`.
 *
 * The designator is required rather than assumed: ONS's PDF dictionary gives
 * the format as `YYYY-MM-DDTHH:MM:SSZ`, every observed response carries it, and
 * a response that stopped carrying it would mean the convention had changed —
 * which must be an error, not a guess.
 */
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

/** Parse an explicitly-UTC ONS timestamp. Null when it is not one. */
export function parseUtcInstant(value: string): Date | null {
  if (!UTC_INSTANT.test(trimmed(value))) {
    return null;
  }
  const parsed = new Date(trimmed(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * End-of-interval label → start-of-interval instant.
 *
 * Exported and named because it is the whole of trap 2: a reviewer can check
 * one subtraction rather than trust that a timestamp somewhere was shifted.
 */
export function intervalStartFromEnd(end: Date): Date {
  return new Date(end.getTime() - INTERVAL_MINUTES * MS_PER_MINUTE);
}

/** Distinguishes "present but not a number" from "not published". */
const INVALID = Symbol("invalid");

/**
 * Read a numeric field. `null` covers three cases that are all "ONS published
 * nothing here": the field is absent, it is JSON `null`, or the tolerant parser
 * filled a missing value in a malformed historical response. None of them is
 * zero, and none is silently made zero.
 */
function readNumber(row: RawLoadRow, field: string): number | null | typeof INVALID {
  const value = row[field];
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : INVALID;
}

const asMwh = (mwmed: number | null): number | null =>
  mwmed === null ? null : mwmedToMwh(mwmed, INTERVAL_MINUTES);

interface Common {
  areaCode: LoadAreaCode;
  validTime: Date;
}

/** Resolve the area and the interval start, or say why the row cannot be used. */
function readCommon(
  row: RawLoadRow,
  reject: (reason: RejectionReason, detail: string) => void,
): Common | null {
  const rawArea = trimmed(String(row.cod_areacarga ?? ""));
  if (!isLoadAreaCode(rawArea)) {
    reject(
      "unknown_load_area",
      `cod_areacarga '${rawArea}' is not one of the 33 published codes`,
    );
    return null;
  }

  const rawEnd = String(row.din_referenciautc ?? "");
  const end = parseUtcInstant(rawEnd);
  if (!end) {
    reject(
      rawEnd.trim() === "" ? "unparsable_timestamp" : "non_utc_timestamp",
      `din_referenciautc '${rawEnd}' is not an explicitly-UTC instant`,
    );
    return null;
  }

  const validTime = intervalStartFromEnd(end);
  const minutes = validTime.getUTCMinutes();
  if (
    (minutes !== 0 && minutes !== INTERVAL_MINUTES) ||
    validTime.getUTCSeconds() !== 0
  ) {
    reject(
      "misaligned_interval",
      `din_referenciautc '${rawEnd}' does not bound a half-hour`,
    );
    return null;
  }
  return { areaCode: rawArea, validTime };
}

/** The seven measures `/cargaverificada` publishes, in canonical order. */
const VERIFIED_MEASURES = {
  loadMwh: "val_cargaglobal",
  consistedLoadMwh: "val_cargaglobalcons",
  // The live field name, not the dictionary's `val_cargaglobalsmmg`.
  loadNetOfMmgdMwh: "val_cargaglobalsmmgd",
  supervisedLoadMwh: "val_cargasupervisionada",
  unsupervisedLoadMwh: "val_carganaosupervisionada",
  mmgdLoadMwh: "val_cargammgd",
  consistencyAdjustmentMwh: "val_consistencia",
} as const;

/**
 * Normalise a `/cargaverificada` response.
 *
 * `val_cargaglobal` is required — a row with no global load is not a load
 * observation — and every other measure is nullable, because the malformed
 * historical responses genuinely omit `val_cargaglobalsmmgd` and
 * `val_cargammgd` and the honest rendering of an omission is a null.
 */
export function parseVerifiedLoad(
  rows: readonly RawLoadRow[],
): LoadParse<VerifiedLoadHalfHour> {
  const parsed: VerifiedLoadHalfHour[] = [];
  const rejected: RejectedRow[] = [];
  let rowsWithoutVintage = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const reject = (reason: RejectionReason, detail: string): void => {
      rejected.push({ reason, rowNumber, detail });
    };

    const common = readCommon(row, reject);
    if (!common) {
      return;
    }

    const measures: Record<string, number | null> = {};
    let bad = false;
    for (const [name, field] of Object.entries(VERIFIED_MEASURES)) {
      const value = readNumber(row, field);
      if (value === INVALID) {
        reject("unparsable_value", `${field} is not a number`);
        bad = true;
        break;
      }
      measures[name] = value;
    }
    if (bad) {
      return;
    }
    if (measures.loadMwh === null) {
      reject("empty_value", "val_cargaglobal was not published for this half-hour");
      return;
    }

    // The one true row-level vintage marker in ONS open data. Undocumented in
    // both dictionaries, so its absence is counted rather than assumed away.
    const rawVintage = String(row.din_atualizacao ?? "");
    const publishedAt = rawVintage === "" ? null : parseUtcInstant(rawVintage);
    if (!publishedAt) {
      rowsWithoutVintage += 1;
    }

    parsed.push({
      areaCode: common.areaCode,
      areaKind: loadAreaKind(common.areaCode),
      subsystem: subsystemForArea(common.areaCode),
      validTime: common.validTime,
      loadMwh: mwmedToMwh(measures.loadMwh as number, INTERVAL_MINUTES),
      consistedLoadMwh: asMwh(measures.consistedLoadMwh ?? null),
      loadNetOfMmgdMwh: asMwh(measures.loadNetOfMmgdMwh ?? null),
      supervisedLoadMwh: asMwh(measures.supervisedLoadMwh ?? null),
      unsupervisedLoadMwh: asMwh(measures.unsupervisedLoadMwh ?? null),
      mmgdLoadMwh: asMwh(measures.mmgdLoadMwh ?? null),
      consistencyAdjustmentMwh: asMwh(measures.consistencyAdjustmentMwh ?? null),
      publishedAt,
    });
  });

  return { rows: parsed, rejected, rowsWithoutVintage };
}

/**
 * Normalise a `/cargaprogramada` response.
 *
 * Every row is a forecast. `rowsWithoutVintage` is the row count by
 * construction: this endpoint returns no `din_atualizacao` at all, and saying
 * so in the run summary is more useful than a field that is always null.
 */
export function parseProgrammedLoad(
  rows: readonly RawLoadRow[],
): LoadParse<ProgrammedLoadHalfHour> {
  const parsed: ProgrammedLoadHalfHour[] = [];
  const rejected: RejectedRow[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const reject = (reason: RejectionReason, detail: string): void => {
      rejected.push({ reason, rowNumber, detail });
    };

    const common = readCommon(row, reject);
    if (!common) {
      return;
    }

    const value = readNumber(row, "val_cargaglobalprogramada");
    if (value === INVALID) {
      reject("unparsable_value", "val_cargaglobalprogramada is not a number");
      return;
    }
    if (value === null) {
      reject(
        "empty_value",
        "val_cargaglobalprogramada was not published for this half-hour",
      );
      return;
    }

    parsed.push({
      areaCode: common.areaCode,
      areaKind: loadAreaKind(common.areaCode),
      subsystem: subsystemForArea(common.areaCode),
      validTime: common.validTime,
      programmedLoadMwh: mwmedToMwh(value, INTERVAL_MINUTES),
    });
  });

  return { rows: parsed, rejected, rowsWithoutVintage: parsed.length };
}

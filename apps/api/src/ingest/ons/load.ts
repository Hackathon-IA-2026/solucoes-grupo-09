import { mwmedToMwh, trimmed } from "../normalise.js";
import { ONS_TIME_ZONE, zonedWallClock, zonedWallClockToUtc } from "../time.js";
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
 * The local hour on D−1 at which the programme for day D is taken to have been
 * published. **15:00 in `America/Sao_Paulo`.**
 *
 * ## Why this constant has to exist at all
 *
 * `/cargaprogramada` returns **no row-level update stamp**: no
 * `din_atualizacao`, nothing in the OpenAPI schema, nothing in either data
 * dictionary (`docs/research/ons-datasets.md` §6&7, discrepancy 2). Until now
 * the adapter fell back to the response's fetch instant, which is the coarsest
 * honest stamp for a value ONS said nothing about — and which is wrong here
 * in a way that is not a matter of precision:
 *
 * - `docs/domain-model.md` §4 discriminates the two fact families by shape.
 *   An `Observation` has `published_at > valid_time`; a **`Forecast` has
 *   `published_at < valid_time`**. A backfilled programme row for 2021 stamped
 *   with a 2026 fetch carries an observation's shape, so the one structural
 *   guarantee that keeps a forecast from being read as an actual is inverted
 *   for the entire history of the series.
 * - Downstream, every forecast-sourced feature is cut on
 *   `published_at <= gate` (`docs/specs/feature-engineering.md` §"Where the cut
 *   actually falls"). Under the fetch instant that predicate is false for every
 *   historical target date, so `dessem_free_v1`'s spine — the one series that
 *   makes the DESSEM-free set a contender rather than a control arm — is a
 *   column of NULLs across its whole window.
 *
 * So the instant is **decided**, and it is decided here rather than in the
 * feature layer, because a publication time is a property of the fact and not
 * of the question being asked of it. The alternative — a feature-side rule that
 * treats a programme row as available anyway — would be a second definition of
 * "published", reachable only from SQL, and it would make the ablation seam
 * unable to see a leak it was itself the cause of.
 *
 * ## Why 15:00 BRT on D−1, and not an hour that would be more convenient
 *
 * The series is a **day-ahead programme**: `docs/research/ons-datasets.md`
 * records a live call on 2026-08-28 returning the full 48 half-hours of
 * 2026-08-29, and the fixtures in `test/fixtures/ons/` hold that response. So
 * the programme for day D exists on D−1. *When* on D−1 is the open question the
 * research could not close.
 *
 * The tightest instant the evidence does pin is this. ONS's DESSEM file for
 * reference day D is created on the evening of D−1 — measured at
 * **2026-08-27T17:48Z** for target 2026-08-28 — and DESSEM's `val_demanda`
 * agrees with `cargaprogramada` for the same subsystem-day **to 0.03%**
 * (`ons-datasets.md` §10&11). A run cannot consume a programme that does not
 * exist, so the programme for D had been published by D−1 17:48Z = 14:48 BRT.
 *
 * 15:00 BRT is that bound, rounded in the **conservative** direction — later,
 * so the assumption claims no availability the evidence does not carry. The
 * consequences are stated rather than discovered:
 *
 * - At `gate_late` (D−1 19:00 BRT) the programme clears the gate by four hours,
 *   across the whole 2021-03-05 → now coverage.
 * - At `gate_early` (D−1 09:00 BRT) it does **not** clear, and every
 *   `programmed_*` feature is NULL. That is a visible hole and not a leak,
 *   which is the failure mode the spec asks for — but it is a real hole, and
 *   closing it needs the measurement `.scratch/feature-engineering/issues/
 *   12-publication-lag-conformance.md` owns.
 *
 * ## Moving it is a re-ingest and a retrain, not an edit
 *
 * This constant is the same kind of object as a row of
 * `feature_publication_lag`: a conservative default standing in for a
 * measurement, loosenable only *by* measurement. It differs in where it lands —
 * a lag is applied when a feature is read, a publication instant is written
 * into the fact — so moving this one restates `published_at` on every
 * programmed row and requires the series to be re-ingested before it takes
 * effect. That is heavier than a migration, and it changes which rows clear
 * which gate, so it is a retrain trigger in exactly the sense the spec means.
 */
export const PROGRAMME_PUBLICATION_HOUR_BRT = 15;

/**
 * The publication instant of the programme a half hour belongs to.
 *
 * The reference day is read from `valid_time` in Brasília civil time rather
 * than from `dat_referencia`, so the derivation cannot disagree with the
 * timestamp it is derived from — and through the full IANA zone rather than a
 * fixed −3, which is right today and was wrong every summer before 2019.
 *
 * Returns null only if 15:00 never happened on D−1 in `America/Sao_Paulo`,
 * which no transition in this zone has ever produced; a null is rejected as an
 * unusable row rather than replaced by a plausible instant.
 */
export function programmePublishedAt(validTime: Date): Date | null {
  const local = zonedWallClock(validTime, ONS_TIME_ZONE);
  // Date.UTC normalises day 0 back into the previous month, so no calendar
  // arithmetic is written here.
  const dayBefore = new Date(Date.UTC(local.year, local.month - 1, local.day - 1));
  const zoned = zonedWallClockToUtc(
    {
      year: dayBefore.getUTCFullYear(),
      month: dayBefore.getUTCMonth() + 1,
      day: dayBefore.getUTCDate(),
      hour: PROGRAMME_PUBLICATION_HOUR_BRT,
      minute: 0,
      second: 0,
    },
    ONS_TIME_ZONE,
  );
  // A fall-back hour that happened twice: the earlier occurrence is the
  // conservative reading in the opposite direction to everything else here,
  // so the *later* one is taken — it is the one that claims less.
  if (zoned.kind === "ok") {
    return zoned.instant;
  }
  return zoned.kind === "ambiguous" ? zoned.instants[1] : null;
}

/**
 * Normalise a `/cargaprogramada` response.
 *
 * Every row is a forecast, and every row carries the publication instant
 * `programmePublishedAt` derives from its own reference day — never the fetch
 * instant. `rowsWithoutVintage` is the row count by construction: this endpoint
 * returns no `din_atualizacao` at all, and saying so in the run summary is more
 * useful than a field that is always null.
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

    const publishedAt = programmePublishedAt(common.validTime);
    if (!publishedAt) {
      reject(
        "unparsable_timestamp",
        `no 15:00 exists on the day before ${common.validTime.toISOString()} in ${ONS_TIME_ZONE}`,
      );
      return;
    }

    parsed.push({
      areaCode: common.areaCode,
      areaKind: loadAreaKind(common.areaCode),
      subsystem: subsystemForArea(common.areaCode),
      validTime: common.validTime,
      programmedLoadMwh: mwmedToMwh(value, INTERVAL_MINUTES),
      publishedAt,
    });
  });

  return { rows: parsed, rejected, rowsWithoutVintage: parsed.length };
}

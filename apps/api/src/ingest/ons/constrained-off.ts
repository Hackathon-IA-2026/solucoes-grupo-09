import { UpstreamError } from "../../errors.js";
import { parseDelimited, toRecord } from "../csv.js";
import { mwmedToMwh, parseDecimal, resolveSubsystem, trimmed } from "../normalise.js";
import { parseWallClock, zonedWallClockToUtc } from "../time.js";
import type {
  CurtailmentParse,
  CurtailmentReportHour,
  ObservedReportingEntity,
  ReasonCode,
  RejectedRow,
  RejectionReason,
  RestrictionCause,
  RestrictionOrigin,
  Technology,
} from "../types.js";

/**
 * Adapter for the entity-grain constrained-off datasets — ONS 1 and 3,
 * `restricao_coff_eolica_usi` and `restricao_coff_fotovoltaica`. This is
 * WattSteer's target variable.
 *
 * Three things make it materially harder than the balanço tracer:
 *
 * 1. **The row key is a reporting entity, not a plant.** For Tipo II-C — 93% of
 *    wind rows and 98.6% of curtailed energy — it is a *conjunto*, and the
 *    restriction reason exists only at that grain. Nothing here can attach a
 *    reason to a member plant, by construction.
 * 2. **The schema moves under closed months.** `dsc_restricao` entered the
 *    published dictionary in 2025-09 but is present in files from 2025-01,
 *    because ONS rewrote the back catalogue. The header is therefore read from
 *    every file on every ingest, and column *presence* is reported separately
 *    from a value being empty.
 * 3. **Blank is data, not a defect.** Most rows are unrestricted, and ONS says
 *    so by leaving `val_geracaolimitada`, the reason and the origin empty. The
 *    balanço adapter rejects an empty measure; here that would reject almost
 *    every row.
 */

/** ONS CKAN package ids for the two entity-grain datasets. */
export const WIND_DATASET_SLUG = "restricao_coff_eolica_usi";
export const SOLAR_DATASET_SLUG = "restricao_coff_fotovoltaica";

/** The source grain: ONS settles constrained-off every 30 minutes. */
const SOURCE_INTERVAL_MINUTES = 30;

/** Half-hours in the hour these rows are downsampled to. */
const HALF_HOURS_PER_HOUR = 2;

/** ONS writes this in `ceg` for a conjunto, which has no CEG. */
const NO_CEG = "-";

/** `id_ons` prefix that marks a conjunto rather than a plant. */
const CONJUNTO_PREFIX = "CJU_";

/**
 * Columns required in every file. `dsc_restricao` is deliberately absent: it
 * exists in later files only, and requiring it would fail every month before
 * 2025-01.
 */
const REQUIRED_COLUMNS = [
  "id_subsistema",
  "id_estado",
  "nom_usina",
  "id_ons",
  "ceg",
  "din_instante",
  "val_geracao",
  "val_geracaolimitada",
  "val_disponibilidade",
  "val_geracaoreferencia",
  "val_geracaoreferenciafinal",
  "cod_razaorestricao",
  "cod_origemrestricao",
] as const;

/** Present from 2025-01 onward, and backfilled into months closed before that. */
const DESCRIPTION_COLUMN = "dsc_restricao";

const REASON_CODES = new Set<string>(["REL", "CNF", "ENE", "PAR"]);
const ORIGINS = new Set<string>(["LOC", "SIS"]);

/**
 * Strip the version segment from a CEG.
 *
 * ANEEL writes it unpadded (`.1`), ONS zero-pads it (`.01`), so comparing the
 * full strings matches 0 of 1,614 plants — silently, as an empty join rather
 * than an error. The version-stripped core `GGG.FF.UF.NNNNNN-D` matches 100%.
 * Derived here and stored alongside the raw value, never in place of it.
 */
export function cegCore(raw: string): string | null {
  const text = trimmed(raw);
  if (text === "" || text === NO_CEG) {
    return null;
  }
  const parts = text.split(".");
  return parts.length > 4 ? parts.slice(0, 4).join(".") : text;
}

/** One half-hourly source row, before the hourly rollup. */
interface HalfHour {
  entity: ObservedReportingEntity;
  validTime: Date;
  generationMwh: number;
  constrainedOffMwh: number;
  referenceGenerationMwh: number | null;
  finalReferenceGenerationMwh: number | null;
  availabilityMw: number | null;
  cause: RestrictionCause | null;
}

function assertColumns(columns: string[]): void {
  const present = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new UpstreamError(
      `constrained-off file is missing required columns: ${missing.join(", ")}`,
    );
  }
}

/**
 * Read the restriction cause, which is one value object over three columns.
 *
 * Reason and origin are populated together and blank together on every file
 * scanned, so a half-populated pair is rejected rather than partially believed.
 */
function readCause(
  row: Record<string, string>,
  hasDescription: boolean,
): { cause: RestrictionCause | null } | { invalid: string } {
  const reason = trimmed(row.cod_razaorestricao ?? "");
  const origin = trimmed(row.cod_origemrestricao ?? "");

  if (reason === "" && origin === "") {
    return { cause: null };
  }
  if (reason === "" || origin === "") {
    return {
      invalid: `cod_razaorestricao=${JSON.stringify(reason)} cod_origemrestricao=${JSON.stringify(origin)}`,
    };
  }
  if (!REASON_CODES.has(reason)) {
    return { invalid: `cod_razaorestricao=${JSON.stringify(reason)}` };
  }
  if (!ORIGINS.has(origin)) {
    return { invalid: `cod_origemrestricao=${JSON.stringify(origin)}` };
  }

  // Absent column and empty cell both yield null here; the file-level
  // `hasDescriptionColumn` is what distinguishes them.
  const description = hasDescription ? trimmed(row[DESCRIPTION_COLUMN] ?? "") : "";
  return {
    cause: {
      reason: reason as ReasonCode,
      origin: origin as RestrictionOrigin,
      description: description === "" ? null : description,
    },
  };
}

/** Turn one source row into a half-hourly record, or the reason it cannot be. */
function normaliseRow(
  row: Record<string, string>,
  rowNumber: number,
  hasDescription: boolean,
): { half: HalfHour } | { rejected: RejectedRow } {
  const reject = (reason: RejectionReason, detail: string) => ({
    rejected: { reason, rowNumber, detail },
  });

  const subsystem = resolveSubsystem(row.id_subsistema ?? "");
  if (subsystem.kind !== "subsystem") {
    // These files carry no SIN aggregate, so anything unresolved is unknown.
    return reject(
      "unknown_subsystem",
      `id_subsistema=${JSON.stringify(row.id_subsistema ?? null)}`,
    );
  }

  const wall = parseWallClock(row.din_instante ?? "");
  if (!wall) {
    return reject(
      "unparsable_timestamp",
      `din_instante=${JSON.stringify(row.din_instante ?? null)}`,
    );
  }
  const zoned = zonedWallClockToUtc(wall);
  if (zoned.kind === "gap") {
    return reject("dst_gap", `din_instante=${row.din_instante} never occurred locally`);
  }
  if (zoned.kind === "ambiguous") {
    return reject(
      "dst_ambiguous",
      `din_instante=${row.din_instante} occurred twice locally`,
    );
  }

  // Generation is the one measure ONS always settles; an empty one is a defect.
  const generation = parseDecimal(row.val_geracao);
  if (generation === null) {
    return reject("empty_value", "val_geracao is present but empty");
  }
  if (Number.isNaN(generation)) {
    return reject("unparsable_value", `val_geracao=${JSON.stringify(row.val_geracao)}`);
  }

  // Empty here means "not restricted in this half-hour", which is the ordinary
  // case — not a missing value. Zero is the honest reading.
  const optional = (column: string): number | null | typeof NaN => {
    const value = parseDecimal(row[column]);
    return value;
  };
  const limited = optional("val_geracaolimitada");
  if (limited !== null && Number.isNaN(limited)) {
    return reject(
      "unparsable_value",
      `val_geracaolimitada=${JSON.stringify(row.val_geracaolimitada)}`,
    );
  }
  const reference = optional("val_geracaoreferencia");
  const finalReference = optional("val_geracaoreferenciafinal");
  const availability = optional("val_disponibilidade");
  for (const [column, value] of [
    ["val_geracaoreferencia", reference],
    ["val_geracaoreferenciafinal", finalReference],
    ["val_disponibilidade", availability],
  ] as const) {
    if (value !== null && Number.isNaN(value)) {
      return reject("unparsable_value", `${column}=${JSON.stringify(row[column])}`);
    }
  }

  const cause = readCause(row, hasDescription);
  if ("invalid" in cause) {
    return reject("half_populated_cause", cause.invalid);
  }

  const onsCode = trimmed(row.id_ons ?? "");
  const isConjunto = onsCode.startsWith(CONJUNTO_PREFIX);

  return {
    half: {
      entity: {
        onsCode,
        kind: isConjunto ? "CONJUNTO" : "PLANT",
        // Structurally absent on a conjunto: ONS writes "-", not a CEG.
        cegCore: isConjunto ? null : cegCore(row.ceg ?? ""),
        name: trimmed(row.nom_usina ?? ""),
        subsystem: subsystem.code,
        stateCode: trimmed(row.id_estado ?? ""),
      },
      validTime: zoned.instant,
      generationMwh: mwmedToMwh(generation, SOURCE_INTERVAL_MINUTES),
      constrainedOffMwh: mwmedToMwh(limited ?? 0, SOURCE_INTERVAL_MINUTES),
      referenceGenerationMwh:
        reference === null ? null : mwmedToMwh(reference, SOURCE_INTERVAL_MINUTES),
      finalReferenceGenerationMwh:
        finalReference === null
          ? null
          : mwmedToMwh(finalReference, SOURCE_INTERVAL_MINUTES),
      // A power, carried as-is — it is averaged over the hour, never summed.
      availabilityMw: availability,
      cause: cause.cause,
    },
  };
}

/** Truncate an instant to the start of its UTC hour. */
function hourStart(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / 3_600_000) * 3_600_000);
}

const groupKey = (half: HalfHour, technology: Technology): string =>
  `${half.entity.onsCode}|${technology}|${hourStart(half.validTime).toISOString()}`;

/**
 * Roll half-hours up to hours.
 *
 * Energies sum; availability is a mean because it is a power. The cause of the
 * hour is the cause of the half-hour that contributed the most curtailed
 * energy — with `causeMixed` set when the two disagreed, so the simplification
 * is visible rather than silent.
 */
function toHours(halves: HalfHour[], technology: Technology): CurtailmentReportHour[] {
  const groups = new Map<string, HalfHour[]>();
  for (const half of halves) {
    const key = groupKey(half, technology);
    const existing = groups.get(key);
    if (existing) {
      existing.push(half);
    } else {
      groups.set(key, [half]);
    }
  }

  const rows: CurtailmentReportHour[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) {
      continue;
    }

    const sum = (pick: (half: HalfHour) => number): number =>
      group.reduce((total, half) => total + pick(half), 0);

    const nullableSum = (pick: (half: HalfHour) => number | null): number | null => {
      const present = group.map(pick).filter((value): value is number => value !== null);
      return present.length === 0
        ? null
        : present.reduce((total, value) => total + value, 0);
    };

    const availabilities = group
      .map((half) => half.availabilityMw)
      .filter((value): value is number => value !== null);
    const availabilityMw =
      availabilities.length === 0
        ? null
        : availabilities.reduce((total, value) => total + value, 0) /
          availabilities.length;

    const caused = group.filter((half) => half.cause !== null);
    const dominant = caused.reduce<HalfHour | null>(
      (best, half) =>
        best === null || half.constrainedOffMwh > best.constrainedOffMwh ? half : best,
      null,
    );
    const reasons = new Set(caused.map((half) => half.cause?.reason));

    rows.push({
      reportingEntityCode: first.entity.onsCode,
      technology,
      validTime: hourStart(first.validTime),
      generationMwh: sum((half) => half.generationMwh),
      constrainedOffMwh: sum((half) => half.constrainedOffMwh),
      referenceGenerationMwh: nullableSum((half) => half.referenceGenerationMwh),
      finalReferenceGenerationMwh: nullableSum(
        (half) => half.finalReferenceGenerationMwh,
      ),
      availabilityMw,
      halfHoursObserved: Math.min(group.length, HALF_HOURS_PER_HOUR),
      cause: dominant?.cause ?? null,
      causeMixed: reasons.size > 1,
    });
  }

  return rows.sort(
    (a, b) =>
      a.validTime.getTime() - b.validTime.getTime() ||
      a.reportingEntityCode.localeCompare(b.reportingEntityCode),
  );
}

/**
 * Parse the CSV rendition of an entity-grain constrained-off file.
 *
 * CSV rather than Parquet by default for these datasets: Parquet does not cover
 * the full wind history (it starts 2023-10 against the CSV's 2021-10), so the
 * format that always exists is the one the adapter is written against.
 */
export function parseConstrainedOffCsv(
  text: string,
  technology: Technology,
): CurtailmentParse {
  const { columns, rows: cells } = parseDelimited(text);
  if (columns.length === 0) {
    throw new UpstreamError("constrained-off file is empty");
  }
  assertColumns(columns);
  const hasDescriptionColumn = columns.includes(DESCRIPTION_COLUMN);

  const halves: HalfHour[] = [];
  const rejected: RejectedRow[] = [];
  const entities = new Map<string, ObservedReportingEntity>();

  cells.forEach((cell, index) => {
    const outcome = normaliseRow(
      toRecord(columns, cell),
      index + 1,
      hasDescriptionColumn,
    );
    if ("rejected" in outcome) {
      rejected.push(outcome.rejected);
      return;
    }
    halves.push(outcome.half);
    entities.set(outcome.half.entity.onsCode, outcome.half.entity);
  });

  return {
    rows: toHours(halves, technology),
    entities: [...entities.values()],
    rejected,
    columns,
    hasDescriptionColumn,
  };
}

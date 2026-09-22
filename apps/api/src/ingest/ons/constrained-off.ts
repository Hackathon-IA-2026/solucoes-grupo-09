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
 * 4. **The curtailed energy is `val_geracaonaorealizadaapurada`, not
 *    `val_geracaolimitada`.** One is a ceiling and the other is the shortfall
 *    under it; this adapter read the first for months and every observed figure
 *    in the product was ~2.9× too high. The argument, with ONS's own dictionary
 *    quoted and a row that separates them, is at the parse site.
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
  verifiedGenerationMwh: number;
  constrainedOffMwh: number;
  referenceGenerationMwh: number | null;
  finalReferenceGenerationMwh: number | null;
  availableCapacityMw: number | null;
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

/** ONS's own name for the settled shortfall. Absent in files ONS has not rewritten. */
const NOT_GENERATED_COLUMN = "val_geracaonaorealizadaapurada";

/**
 * The curtailed energy of one half-hour, in MWmed.
 *
 * `val_geracaonaorealizadaapurada` — GNRa — is the published quantity and is
 * used wherever ONS has written it. It is **not** required, for the reason
 * `dsc_restricao` is not: the column post-dates the captured fixtures and the
 * archived payloads, and requiring it would reject a file this adapter used to
 * read. `hasNotGenerated` is the file-level flag that tells "ONS left it empty
 * because the half-hour was unrestricted" from "this file has no such column",
 * which is the same distinction that flag exists for one field over.
 *
 * Where the column is absent the value is **derived from ONS's own
 * definition** rather than guessed: the dictionary says GNRa is "a diferença
 * entre a geração de referência e a geração verificada (se menor que zero,
 * GNRa = 0), nos períodos em que houve limitação de geração". So: the
 * difference, floored at zero, and only in half-hours ONS marked as limited —
 * a non-null `val_geracaolimitada` is exactly that mark, per the same
 * dictionary ("se o campo for nulo, não houve limitação estabelecida pelo ONS
 * naquele patamar").
 *
 * Applying a published formula is not inventing a number. Reading the ceiling
 * as the shortfall was, and that is what this replaces.
 */
function curtailedMwmed(
  notGenerated: number | null,
  hasNotGenerated: boolean,
  limited: number | null,
  reference: number | null,
  verified: number,
): number {
  if (hasNotGenerated) {
    return notGenerated ?? 0;
  }
  if (limited === null || reference === null) {
    return 0;
  }
  return Math.max(0, reference - verified);
}

/** Turn one source row into a half-hourly record, or the reason it cannot be. */
function normaliseRow(
  row: Record<string, string>,
  rowNumber: number,
  hasDescription: boolean,
  hasNotGenerated: boolean,
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
  /*
    **`val_geracaolimitada` is a ceiling, and this file read it as the cut.**

    ONS's published dictionary for `restricao_coff_eolica_usi`:

      val_geracaolimitada — "Geração limitada. Representa o **limite** para a
      geração da usina/conjunto estabelecido pelo ONS em Tempo Real, em MWmed.
      Se o campo for nulo, não houve limitação estabelecida pelo ONS naquele
      patamar."

      val_geracaonaorealizadaapurada — "Geração Não Realizada Apurada (GNRa).
      Representa a estimativa de geração frustrada da usina ou conjunto de
      usinas, obtida pela diferença entre a geração de referência e a geração
      verificada (se menor que zero, GNRa = 0), nos períodos em que houve
      limitação de geração."

    The first is how much the plant was *allowed* to generate; the second is how
    much it did not generate because of that. Conj. Paulino Neves, 2026-09-01
    10:00, reason ENE: verified 319,268 · **limitada 322,000** · reference
    428,899 · **GNRa 109,631**, and 428,899 − 319,268 is 109,631 exactly.

    Reading the ceiling as the cut is what made every observed figure in this
    product roughly **2.9×** too high — `docs/todo.md` 5b measured 2–3× and
    could not find the cause, because the arithmetic was right and the field was
    not. It is also why "21.940 MW curtailed against 30.828 MW of installed
    wind" looked impossible: a ceiling is naturally close to what the fleet
    actually generated, so summing ceilings produces a number the size of
    generation itself.

    `val_geracaolimitada` stays parsed and stays required — its presence is
    still the marker of a half-hour ONS restricted at all — but it is not a
    quantity this adapter reports.
  */
  const limited = optional("val_geracaolimitada");
  if (limited !== null && Number.isNaN(limited)) {
    return reject(
      "unparsable_value",
      `val_geracaolimitada=${JSON.stringify(row.val_geracaolimitada)}`,
    );
  }
  const notGenerated = optional("val_geracaonaorealizadaapurada");
  if (notGenerated !== null && Number.isNaN(notGenerated)) {
    return reject(
      "unparsable_value",
      `val_geracaonaorealizadaapurada=${JSON.stringify(row.val_geracaonaorealizadaapurada)}`,
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
      verifiedGenerationMwh: mwmedToMwh(generation, SOURCE_INTERVAL_MINUTES),
      // GNRa, never `val_geracaolimitada` — see above. Empty means the
      // half-hour was not restricted, and zero is the honest reading of it.
      constrainedOffMwh: mwmedToMwh(
        curtailedMwmed(notGenerated, hasNotGenerated, limited, reference, generation),
        SOURCE_INTERVAL_MINUTES,
      ),
      referenceGenerationMwh:
        reference === null ? null : mwmedToMwh(reference, SOURCE_INTERVAL_MINUTES),
      finalReferenceGenerationMwh:
        finalReference === null
          ? null
          : mwmedToMwh(finalReference, SOURCE_INTERVAL_MINUTES),
      // A power, carried as-is — it is averaged over the hour, never summed.
      availableCapacityMw: availability,
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
      .map((half) => half.availableCapacityMw)
      .filter((value): value is number => value !== null);
    const availableCapacityMw =
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
      verifiedGenerationMwh: sum((half) => half.verifiedGenerationMwh),
      constrainedOffMwh: sum((half) => half.constrainedOffMwh),
      referenceGenerationMwh: nullableSum((half) => half.referenceGenerationMwh),
      finalReferenceGenerationMwh: nullableSum(
        (half) => half.finalReferenceGenerationMwh,
      ),
      availableCapacityMw,
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
  const hasNotGeneratedColumn = columns.includes(NOT_GENERATED_COLUMN);

  const halves: HalfHour[] = [];
  const rejected: RejectedRow[] = [];
  const entities = new Map<string, ObservedReportingEntity>();

  cells.forEach((cell, index) => {
    const outcome = normaliseRow(
      toRecord(columns, cell),
      index + 1,
      hasDescriptionColumn,
      hasNotGeneratedColumn,
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
    hasNotGeneratedColumn,
  };
}

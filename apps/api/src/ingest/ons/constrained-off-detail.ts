import { UpstreamError } from "../../errors.js";
import { parseDelimited, toRecord } from "../csv.js";
import { mwmedToMwh, parseDecimal, resolveSubsystem, trimmed } from "../normalise.js";
import { parseWallClock, zonedWallClockToUtc } from "../time.js";
import type {
  ObservedPlant,
  OperationModality,
  PlantDetailHour,
  PlantDetailParse,
  RejectedRow,
  RejectionReason,
  ResourceMeasurement,
  Technology,
} from "../types.js";
import { cegCore } from "./constrained-off.js";
import { parseOperationModality } from "./plant-registry.js";

/**
 * Adapter for the **plant-grain** constrained-off datasets — ONS 2 and 4,
 * `restricao_coff_eolica_detail` and `restricao_coff_fotovoltaica_detail`.
 *
 * The defining property of these files is what they do **not** contain.
 *
 * > There is no `cod_razaorestricao`, no `cod_origemrestricao`, no
 * > `dsc_restricao` and no `val_geracaoreferencia` in either file, on any
 * > vintage. A restriction reason is a property of a `ReportingEntity`
 * > (`docs/domain-model.md` §3), and for a Tipo II-C plant — 93% of wind rows
 * > and 98.6% of curtailed energy — that entity is a *conjunto*, not the plant.
 * > At plant grain the reason is genuinely unknown. Deriving one is an
 * > allocation, and v1 computes none.
 *
 * So this adapter emits no cause, the table it feeds has no cause column, and
 * `nom_conjuntousina` is deliberately **not** carried through: it is the only
 * field in the file from which a plant's settling entity could be reconstructed
 * by name, and reconstructing it is the first step of the join this ticket
 * exists to prevent. The time-resolved bridge (`conjunto_membership`) remains
 * the one authority on membership, and it is a separate, explicit read.
 *
 * Five source facts, each measured rather than assumed, shape the rest:
 *
 * 1. **The two technologies encode the same boolean differently, permanently.**
 *    Wind writes `0.0` / `1.0`; solar writes `False` / `True`. Both have done
 *    so since their dataset's first published month, so this is a dialect, not
 *    drift, and it is unified here into one boolean.
 * 2. **`val_ventoverificado` is documented "em m3/s"**, which is dimensionally
 *    wrong for a wind speed. Observed magnitudes (5.079, 7.18, 8.219) are
 *    speeds. WattSteer stores **m/s** and names the column so; see
 *    `MEASURED_WIND_SPEED_UNIT_CORRECTION`.
 * 3. **The `_detail` files are not symmetric with the entity-grain files.**
 *    They carry `id_estado` but no `nom_estado`, and no `nom_subsistema` at
 *    all. Nothing here may assume a column because its sibling dataset has one.
 * 4. **The measurement is one value object.** `val_ventoverificado` and
 *    `flg_dadoventoinvalido` are blank together and populated together — 480
 *    rows of `RESTRICAO_COFF_EOLICA_DETAIL_2021_10.csv`, no other combination
 *    in 1,084,896 — so half-populated is rejected rather than half-believed.
 * 5. **ONS occasionally publishes a plant-half-hour twice with different
 *    values.** `MGJCN` on 2024-04-13 appears twice for all 48 half-hours of the
 *    day, differing in `val_geracaoestimada` and `val_geracaoverificada`. Both
 *    copies are rejected, as everywhere else in this codebase: a duplicate
 *    inside one file is not a revision, and neither copy can be preferred.
 */

/** ONS CKAN package ids for the two plant-grain datasets. */
export const WIND_DETAIL_DATASET_SLUG = "restricao_coff_eolica_detail";
export const SOLAR_DETAIL_DATASET_SLUG = "restricao_coff_fotovoltaica_detail";

/**
 * The unit correction applied on ingest, recorded rather than merely done.
 *
 * The ONS dictionary for `val_ventoverificado` says *"Vento verificado, em
 * m3/s"*. A volumetric flow rate cannot describe a wind measurement feeding a
 * turbine power curve, and the published magnitudes are ordinary surface wind
 * speeds. WattSteer reads the column as **m/s** and says so in the column name,
 * the domain model and here. No numeric conversion is applied — there is none
 * to apply; the source unit label is wrong, not the source values.
 */
export const MEASURED_WIND_SPEED_UNIT_CORRECTION = {
  column: "val_ventoverificado",
  documentedUnit: "m3/s",
  storedUnit: "m/s",
  conversionFactor: 1,
} as const;

/** The source grain: ONS publishes these files every 30 minutes. */
const SOURCE_INTERVAL_MINUTES = 30;

/** Half-hours in the hour these rows are downsampled to. */
const HALF_HOURS_PER_HOUR = 2;

/**
 * Columns common to both technologies.
 *
 * Note what is *not* here and never will be: no `nom_estado`, no
 * `nom_subsistema` — the entity-grain files have both and these do not.
 */
const COMMON_COLUMNS = [
  "id_subsistema",
  "id_estado",
  "nom_modalidadeoperacao",
  "nom_conjuntousina",
  "nom_usina",
  "id_ons",
  "ceg",
  "din_instante",
  "val_geracaoestimada",
  "val_geracaoverificada",
] as const;

/** The measured-resource pair, which is the only per-technology difference. */
const MEASUREMENT_COLUMNS = {
  WIND: { value: "val_ventoverificado", flag: "flg_dadoventoinvalido" },
  SOLAR: { value: "val_irradianciaverificado", flag: "flg_dadoirradianciainvalido" },
} as const satisfies Record<Technology, { value: string; flag: string }>;

/**
 * The two spellings of the same boolean.
 *
 * Wind has written `0.0`/`1.0` since 2021-10 and solar `False`/`True` since
 * 2024-04. Both dialects are accepted for both technologies rather than being
 * gated on the file, because accepting the other one costs nothing and a file
 * that switched would otherwise fail wholesale rather than parse.
 */
const INVALID_FLAGS: Record<string, boolean> = {
  "0.0": false,
  "1.0": true,
  "0": false,
  "1": true,
  FALSE: false,
  TRUE: true,
};

/** One half-hourly source row, before the hourly rollup. */
interface HalfHour {
  plant: ObservedPlant;
  validTime: Date;
  estimatedGenerationMwh: number | null;
  verifiedGenerationMwh: number | null;
  measurement: ResourceMeasurement | null;
}

function assertColumns(columns: string[], technology: Technology): void {
  const measurement = MEASUREMENT_COLUMNS[technology];
  const required = [...COMMON_COLUMNS, measurement.value, measurement.flag];
  const present = new Set(columns);
  const missing = required.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new UpstreamError(
      `constrained-off detail file is missing required columns: ${missing.join(", ")}`,
    );
  }
}

/**
 * Read the measured resource and its invalid flag as the single value object
 * they are: both present, or neither.
 */
function readMeasurement(
  row: Record<string, string>,
  technology: Technology,
): { measurement: ResourceMeasurement | null } | { invalid: string } {
  const columns = MEASUREMENT_COLUMNS[technology];
  const rawValue = trimmed(row[columns.value] ?? "");
  const rawFlag = trimmed(row[columns.flag] ?? "");

  if (rawValue === "" && rawFlag === "") {
    return { measurement: null };
  }
  if (rawValue === "" || rawFlag === "") {
    return {
      invalid: `${columns.value}=${JSON.stringify(rawValue)} ${columns.flag}=${JSON.stringify(rawFlag)}`,
    };
  }

  const value = parseDecimal(rawValue);
  if (value === null || Number.isNaN(value)) {
    return { invalid: `${columns.value}=${JSON.stringify(rawValue)}` };
  }
  const invalid = INVALID_FLAGS[rawFlag.toUpperCase()];
  if (invalid === undefined) {
    return { invalid: `${columns.flag}=${JSON.stringify(rawFlag)}` };
  }
  // Negative irradiance is real — 3,069 rows of the 2024-04 solar file read
  // between −1 and −2 W/m² at night, flagged valid — and it is a genuine
  // pyranometer offset, not a defect. It is stored as published: clamping it
  // would invent a measurement ONS did not take.
  return { measurement: { value, invalid } };
}

/** Turn one source row into a half-hourly record, or the reason it cannot be. */
function normaliseRow(
  row: Record<string, string>,
  rowNumber: number,
  technology: Technology,
): { half: HalfHour; conjuntoNamed: boolean } | { rejected: RejectedRow } {
  const reject = (reason: RejectionReason, detail: string) => ({
    rejected: { reason, rowNumber, detail },
  });

  const onsCode = trimmed(row.id_ons ?? "");
  if (onsCode === "") {
    // The plant's identity. Nothing can be keyed on a blank, and a synthetic
    // key here would be a plant WattSteer invented.
    return reject("missing_identity", "id_ons is present but empty");
  }

  const subsystem = resolveSubsystem(row.id_subsistema ?? "");
  if (subsystem.kind !== "subsystem") {
    return reject(
      "unknown_subsystem",
      `id_subsistema=${JSON.stringify(row.id_subsistema ?? null)}`,
    );
  }

  const modality: OperationModality | undefined = parseOperationModality(
    row.nom_modalidadeoperacao ?? "",
  );
  if (!modality) {
    return reject(
      "unknown_modality",
      `nom_modalidadeoperacao=${JSON.stringify(row.nom_modalidadeoperacao ?? null)}`,
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

  const measurement = readMeasurement(row, technology);
  if ("invalid" in measurement) {
    return reject("half_populated_measurement", measurement.invalid);
  }

  // Both generation columns are routinely empty and that is data, not a defect:
  // 117,209 rows of the 2021-10 wind file publish no estimate at all. Empty is
  // never read as zero.
  const generation = (column: string): number | null | typeof NaN =>
    parseDecimal(row[column]);
  const estimated = generation("val_geracaoestimada");
  const verified = generation("val_geracaoverificada");
  for (const [column, value] of [
    ["val_geracaoestimada", estimated],
    ["val_geracaoverificada", verified],
  ] as const) {
    if (value !== null && Number.isNaN(value)) {
      return reject("unparsable_value", `${column}=${JSON.stringify(row[column])}`);
    }
  }

  if (measurement.measurement === null && estimated === null && verified === null) {
    // 336 rows of the 2021-10 wind file are identity and timestamp and nothing
    // else. There is no observation in them to store.
    return reject("empty_value", "no measurement and no generation on this row");
  }

  const rawCeg = trimmed(row.ceg ?? "");
  const core = cegCore(rawCeg);
  if (core === null) {
    // Unlike the entity-grain files, every row here is a plant, and a plant
    // always has a CEG — `"-"` belongs to conjuntos, which never appear here.
    return reject("missing_identity", `ceg=${JSON.stringify(rawCeg)}`);
  }

  return {
    conjuntoNamed: trimmed(row.nom_conjuntousina ?? "") !== "",
    half: {
      plant: {
        onsCode,
        cegCore: core,
        cegRaw: rawCeg,
        name: trimmed(row.nom_usina ?? ""),
        subsystem: subsystem.code,
        stateCode: trimmed(row.id_estado ?? ""),
        technology,
        operationModality: modality,
      },
      validTime: zoned.instant,
      estimatedGenerationMwh:
        estimated === null ? null : mwmedToMwh(estimated, SOURCE_INTERVAL_MINUTES),
      verifiedGenerationMwh:
        verified === null ? null : mwmedToMwh(verified, SOURCE_INTERVAL_MINUTES),
      measurement: measurement.measurement,
    },
  };
}

/** Truncate an instant to the start of its UTC hour. */
function hourStart(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / 3_600_000) * 3_600_000);
}

/**
 * Roll half-hours up to hours.
 *
 * Energies sum. The measured resource is a **mean**: a wind speed and an
 * irradiance are intensive quantities, and adding two half-hour readings would
 * report a gale that never blew. The invalid flag is the **disjunction** — an
 * hour built on one failed measurement is not a clean hour, and saying so is
 * the conservative reading.
 */
function toHours(halves: HalfHour[], technology: Technology): PlantDetailHour[] {
  const groups = new Map<string, HalfHour[]>();
  for (const half of halves) {
    const key = `${half.plant.onsCode}|${technology}|${hourStart(half.validTime).toISOString()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(half);
    } else {
      groups.set(key, [half]);
    }
  }

  const rows: PlantDetailHour[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) {
      continue;
    }

    const nullableSum = (pick: (half: HalfHour) => number | null): number | null => {
      const present = group.map(pick).filter((value): value is number => value !== null);
      return present.length === 0
        ? null
        : present.reduce((total, value) => total + value, 0);
    };

    const measured = group
      .map((half) => half.measurement)
      .filter((value): value is ResourceMeasurement => value !== null);
    const measurement: ResourceMeasurement | null =
      measured.length === 0
        ? null
        : {
            value:
              measured.reduce((total, one) => total + one.value, 0) / measured.length,
            invalid: measured.some((one) => one.invalid),
          };

    rows.push({
      plantOnsCode: first.plant.onsCode,
      technology,
      validTime: hourStart(first.validTime),
      estimatedGenerationMwh: nullableSum((half) => half.estimatedGenerationMwh),
      verifiedGenerationMwh: nullableSum((half) => half.verifiedGenerationMwh),
      measurement,
      halfHoursObserved: Math.min(group.length, HALF_HOURS_PER_HOUR),
    });
  }

  return rows.sort(
    (a, b) =>
      a.validTime.getTime() - b.validTime.getTime() ||
      a.plantOnsCode.localeCompare(b.plantOnsCode),
  );
}

/**
 * Parse the CSV rendition of a plant-grain constrained-off file.
 *
 * CSV rather than Parquet for the same reason as the entity-grain adapter:
 * Parquet starts 2023-01 for wind against the CSV's 2021-10, and the rendition
 * that always exists is the one to be written against. These files carry no
 * free-text column — the quoting-aware reader is still used, because a reader
 * that only works while no column contains a delimiter is a reader waiting to
 * be wrong, and `parseDelimited` costs nothing extra when nothing is quoted.
 */
export function parseConstrainedOffDetailCsv(
  text: string,
  technology: Technology,
): PlantDetailParse {
  const { columns, rows: cells } = parseDelimited(text);
  if (columns.length === 0) {
    throw new UpstreamError("constrained-off detail file is empty");
  }
  assertColumns(columns, technology);

  const halves: HalfHour[] = [];
  const rejected: RejectedRow[] = [];
  const plants = new Map<string, ObservedPlant>();
  // ONS names a conjunto on a row exactly when the plant is Tipo II-C —
  // 14,256 blanks in the 2026-08 wind file against 14,256 non-II-C rows. The
  // agreement is counted, not stored: it is the evidence that modality really
  // does decide which `ReportingEntity` variant a plant settles under.
  let modalityConjuntoMismatches = 0;
  // (plant, instant) → index into `halves`, for the in-file duplicate check.
  const byKey = new Map<string, { index: number; rowNumber: number }>();
  const duplicated = new Set<number>();

  cells.forEach((cell, index) => {
    const rowNumber = index + 1;
    const outcome = normaliseRow(toRecord(columns, cell), rowNumber, technology);
    if ("rejected" in outcome) {
      rejected.push(outcome.rejected);
      return;
    }
    const { half, conjuntoNamed } = outcome;
    if (conjuntoNamed !== (half.plant.operationModality === "TIPO_II_C")) {
      modalityConjuntoMismatches += 1;
    }

    const key = `${half.plant.onsCode}|${half.validTime.toISOString()}`;
    const seen = byKey.get(key);
    if (seen) {
      // Neither copy is preferred: a duplicate inside one file is not a
      // revision, and picking one would be a coin toss presented as a fact.
      duplicated.add(seen.index);
      rejected.push({
        reason: "duplicate_key",
        rowNumber,
        detail: `id_ons=${half.plant.onsCode} din_instante duplicates row ${seen.rowNumber}`,
      });
      return;
    }

    byKey.set(key, { index: halves.length, rowNumber });
    halves.push(half);
    plants.set(half.plant.onsCode, half.plant);
  });

  // The first copy was admitted before its twin was seen, so withdraw it now.
  const surviving = halves.filter((_, index) => !duplicated.has(index));
  for (const [key, seen] of byKey) {
    if (duplicated.has(seen.index)) {
      rejected.push({
        reason: "duplicate_key",
        rowNumber: seen.rowNumber,
        detail: `id_ons=${key.split("|")[0]} din_instante is duplicated later in the file`,
      });
    }
  }
  rejected.sort((a, b) => a.rowNumber - b.rowNumber);

  return {
    rows: toHours(surviving, technology),
    plants: [...plants.values()],
    rejected,
    columns,
    modalityConjuntoMismatches,
  };
}

import { UpstreamError } from "../../errors.js";
import { parseDelimited, toRecord } from "../csv.js";
import {
  parseDecimal,
  parseSourceDate,
  resolveSubsystem,
  trimmed,
} from "../normalise.js";
import type {
  OperationModality,
  PlantRegistryParse,
  RegistryGeneratingUnit,
  RegistryPlant,
  RejectedRow,
  RejectionReason,
  Technology,
} from "../types.js";
import { cegCore } from "./constrained-off.js";

/**
 * Adapter for ONS `capacidade-geracao` — the fleet registry, and the only
 * source that makes `InstalledCapacityAsOf` answerable.
 *
 * Four things shape it, and none is obvious from reading the file:
 *
 * 1. **The grain is the generating unit, not the plant.** 3,385 wind and solar
 *    rows describe 1,619 plants. Capacity must be aggregated unit → plant at
 *    read time, never stored as a plant total, because the units commission on
 *    different days and a plant total cannot be time-resolved.
 * 2. **There is no history, and yesterday's file is unrecoverable.** ONS
 *    overwrites this single file twice a day. But the rows carry per-unit
 *    `dat_entradaoperacao` and `dat_desativacao`, so an as-of-date capacity
 *    series is reconstructable from one current cut — which is why the fleet
 *    build-up is a query rather than a missing dataset. The caveat is named
 *    rather than hidden: it is *today's record of the past*, so each snapshot
 *    is stored with its own vintage and a retroactively corrected date shows up
 *    as a new version rather than as an overwrite.
 * 3. **The subsystem is electrical.** `id_subsistema` is taken verbatim and
 *    `id_estado` is never allowed near it: twelve Bahia VRE units in this file
 *    are assigned to `SE`, which any state→subsystem mapping would get wrong.
 * 4. **`id_ons` is not in the file.** `docs/research/ons-datasets.md` §12
 *    records it as added by changelog 1.6 on 2026-01-26. The live header has
 *    18 columns and `id_ons` is not among them, so `ceg_core` is the identity
 *    and the ONS plant code is recovered from the conjunto bridge instead.
 */

/** ONS CKAN package id. Note the S3 path segment is `capacidade-geracao` too. */
export const CAPACITY_DATASET_SLUG = "capacidade-geracao";

/**
 * WattSteer's window opens 2024-04. A VRE deactivation before it cannot affect
 * any capacity weight the platform computes; one on or after it invalidates the
 * "deactivation is an assertion, not a model" decision outright.
 */
export const WINDOW_OPENS_ON = new Date("2024-04-01T00:00:00.000Z");

/**
 * Required columns. `id_ons` is deliberately absent — see the module note.
 * `cod_equipamento` entered the file with changelog 1.3 (2024-04-12) and is the
 * unit's identity, so a file without it cannot be ingested at this grain.
 */
const REQUIRED_COLUMNS = [
  "id_subsistema",
  "id_estado",
  "nom_modalidadeoperacao",
  "nom_agenteproprietario",
  "nom_agenteoperador",
  "nom_tipousina",
  "nom_usina",
  "ceg",
  "nom_unidadegeradora",
  "cod_equipamento",
  "num_unidadegeradora",
  "dat_entradateste",
  "dat_entradaoperacao",
  "dat_desativacao",
  "val_potenciaefetiva",
] as const;

/** ONS `nom_tipousina` → WattSteer technology. Anything else is out of scope. */
const TECHNOLOGIES: Record<string, Technology> = {
  EOLIELÉTRICA: "WIND",
  FOTOVOLTAICA: "SOLAR",
};

/** The technologies this file carries that WattSteer does not model. */
const OUT_OF_SCOPE = new Set(["HIDROELÉTRICA", "TÉRMICA", "NUCLEAR"]);

/** ONS `nom_modalidadeoperacao` → the domain's four dispatched modalities. */
const MODALITIES: Record<string, OperationModality> = {
  "TIPO I": "TIPO_I",
  "TIPO II-A": "TIPO_II_A",
  "TIPO II-B": "TIPO_II_B",
  "TIPO II-C": "TIPO_II_C",
};

/**
 * Read `nom_modalidadeoperacao`, or `undefined` if it is not one of the four.
 *
 * Exported because `capacidade-geracao` is not the only file that publishes the
 * modality: the constrained-off `_detail` files carry it inline on every row,
 * and modality is what decides which `ReportingEntity` variant a plant settles
 * under (`docs/domain-model.md` §3). Two spellings of that vocabulary would be
 * two chances to disagree about it.
 */
export function parseOperationModality(raw: string): OperationModality | undefined {
  return MODALITIES[trimmed(raw).toUpperCase()];
}

function assertColumns(columns: string[]): void {
  const present = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new UpstreamError(
      `capacidade-geracao is missing required columns: ${missing.join(", ")}`,
    );
  }
}

/** One source row, normalised into the plant it describes and the unit it is. */
type NormalisedRow =
  | { plant: RegistryPlant; unit: RegistryGeneratingUnit; datesInconsistent: boolean }
  | { outOfScope: true }
  | { rejected: RejectedRow };

function normaliseRow(row: Record<string, string>, rowNumber: number): NormalisedRow {
  const reject = (reason: RejectionReason, detail: string): NormalisedRow => ({
    rejected: { reason, rowNumber, detail },
  });

  const typeName = trimmed(row.nom_tipousina ?? "").toUpperCase();
  const technology = TECHNOLOGIES[typeName];
  if (!technology) {
    // Hydro, thermal and nuclear are real rows of a real file, not defects —
    // they are simply not WattSteer's fleet. Anything *else* is a change in
    // what the file covers and must not pass as "out of scope".
    return OUT_OF_SCOPE.has(typeName)
      ? { outOfScope: true }
      : reject("unknown_technology", `nom_tipousina=${JSON.stringify(typeName)}`);
  }

  const core = cegCore(row.ceg ?? "");
  if (core === null) {
    return reject("missing_identity", "ceg is present but empty");
  }

  const equipmentCode = trimmed(row.cod_equipamento ?? "");
  if (equipmentCode === "") {
    return reject("missing_identity", "cod_equipamento is present but empty");
  }

  const subsystem = resolveSubsystem(row.id_subsistema ?? "");
  if (subsystem.kind !== "subsystem") {
    return reject(
      "unknown_subsystem",
      `id_subsistema=${JSON.stringify(row.id_subsistema ?? null)}`,
    );
  }

  const modality = parseOperationModality(row.nom_modalidadeoperacao ?? "");
  if (!modality) {
    return reject(
      "unknown_modality",
      `nom_modalidadeoperacao=${JSON.stringify(row.nom_modalidadeoperacao ?? null)}`,
    );
  }

  const rated = parseDecimal(row.val_potenciaefetiva);
  if (rated === null) {
    return reject("empty_value", "val_potenciaefetiva is present but empty");
  }
  if (Number.isNaN(rated)) {
    return reject(
      "unparsable_value",
      `val_potenciaefetiva=${JSON.stringify(row.val_potenciaefetiva)}`,
    );
  }

  const dates: Record<string, Date | null> = {};
  for (const column of ["dat_entradateste", "dat_entradaoperacao", "dat_desativacao"]) {
    const parsed = parseSourceDate(row[column]);
    if ("invalid" in parsed) {
      return reject("unparsable_date", `${column}=${JSON.stringify(parsed.invalid)}`);
    }
    dates[column] = parsed.date;
  }
  const commissionedOn = dates.dat_entradaoperacao;
  if (!commissionedOn) {
    // Without it the unit cannot be placed on the time axis at all, and
    // `InstalledCapacityAsOf` would have to guess. It never guesses.
    return reject("empty_value", "dat_entradaoperacao is present but empty");
  }
  const decommissionedOn = dates.dat_desativacao ?? null;

  return {
    plant: {
      cegCore: core,
      cegRaw: trimmed(row.ceg ?? ""),
      onsPlantCode: null,
      name: trimmed(row.nom_usina ?? ""),
      subsystem: subsystem.code,
      stateCode: trimmed(row.id_estado ?? ""),
      technology,
      operationModality: modality,
      ownerName: trimmed(row.nom_agenteproprietario ?? ""),
      operatorName: trimmed(row.nom_agenteoperador ?? ""),
    },
    unit: {
      plantCegCore: core,
      equipmentCode,
      unitNumber: trimmed(row.num_unidadegeradora ?? ""),
      name: trimmed(row.nom_unidadegeradora ?? ""),
      // Nameplate power in MW. Not an energy — it is never converted from
      // MWmed, and it is summed across units but never across time.
      ratedPowerMw: rated,
      testEntryOn: dates.dat_entradateste ?? null,
      commissionedOn,
      decommissionedOn,
    },
    datesInconsistent:
      decommissionedOn !== null && decommissionedOn.getTime() < commissionedOn.getTime(),
  };
}

/** A VRE unit that carries a deactivation date on or after the window opens. */
export interface RenewableDeactivation {
  plantCegCore: string;
  equipmentCode: string;
  decommissionedOn: Date;
  ratedPowerMw: number;
}

/**
 * The deactivation assertion — a mitigation the research chose deliberately in
 * place of a model.
 *
 * ONS records exactly three VRE deactivations in the whole file (three units of
 * `BELMONTE 1-1`, 50 MW, stamped 2023-05-03) and **none on or after the window
 * opens**. Capacity weighting therefore treats deactivation as impossible in
 * the modelled period. Building a decommissioning estimator for an error that
 * is measurably 0 MW would be waste; *noticing the day that stops being true*
 * is not, because on that day the weighting is silently wrong.
 *
 * Deliberately scoped to the window rather than to "any deactivation at all":
 * the three pre-window rows are permanent, and an assertion that fires on every
 * ingest from the day it lands is an assertion nobody reads.
 */
export function findRenewableDeactivations(
  units: readonly RegistryGeneratingUnit[],
  since: Date = WINDOW_OPENS_ON,
): RenewableDeactivation[] {
  const found: RenewableDeactivation[] = [];
  for (const unit of units) {
    if (unit.decommissionedOn && unit.decommissionedOn.getTime() >= since.getTime()) {
      found.push({
        plantCegCore: unit.plantCegCore,
        equipmentCode: unit.equipmentCode,
        decommissionedOn: unit.decommissionedOn,
        ratedPowerMw: unit.ratedPowerMw,
      });
    }
  }
  return found;
}

export interface ParsePlantRegistryOptions {
  /**
   * Let a within-window deactivation through instead of failing the ingest.
   *
   * The escape exists because the assertion is about an *assumption expiring*,
   * not about corrupt bytes: when ONS really does retire a wind farm, an
   * operator needs a way to take the data while the weighting is revisited.
   */
  allowRenewableDeactivations?: boolean;
  /** Overridable so a test can move the window without moving the constant. */
  deactivationsSince?: Date;
}

/**
 * Parse the CSV rendition of `capacidade-geracao`.
 *
 * CSV rather than Parquet: the file is 1.2 MB either way at this size, and the
 * CSV rendition is the one the schema was established against — the Parquet
 * INT96 trap that bit the balanço adapter does not arise here (these are plain
 * `YYYY-MM-DD` dates, not wall-clock instants) but there is no size win worth
 * a second code path.
 */
export function parseCapacityRegistryCsv(
  text: string,
  options: ParsePlantRegistryOptions = {},
): PlantRegistryParse {
  const { columns, rows: cells } = parseDelimited(text);
  if (columns.length === 0) {
    throw new UpstreamError("capacidade-geracao file is empty");
  }
  assertColumns(columns);

  const plants = new Map<string, RegistryPlant>();
  const units: RegistryGeneratingUnit[] = [];
  const rejected: RejectedRow[] = [];
  let outOfScopeRowsFiltered = 0;
  let inconsistentUnitDates = 0;

  cells.forEach((cell, index) => {
    const outcome = normaliseRow(toRecord(columns, cell), index + 1);
    if ("outOfScope" in outcome) {
      outOfScopeRowsFiltered += 1;
      return;
    }
    if ("rejected" in outcome) {
      rejected.push(outcome.rejected);
      return;
    }
    // First row wins for the plant's attributes. Measured on the live file:
    // zero `ceg` values carry conflicting subsystem, state, technology or
    // modality across their units, so there is nothing to reconcile.
    if (!plants.has(outcome.plant.cegCore)) {
      plants.set(outcome.plant.cegCore, outcome.plant);
    }
    units.push(outcome.unit);
    if (outcome.datesInconsistent) {
      inconsistentUnitDates += 1;
    }
  });

  if (!options.allowRenewableDeactivations) {
    const deactivations = findRenewableDeactivations(units, options.deactivationsSince);
    if (deactivations.length > 0) {
      const listed = deactivations
        .slice(0, 5)
        .map(
          (d) =>
            `${d.plantCegCore}/${d.equipmentCode} on ${d.decommissionedOn.toISOString().slice(0, 10)} (${d.ratedPowerMw} MW)`,
        )
        .join("; ");
      throw new UpstreamError(
        `capacidade-geracao now records ${deactivations.length} renewable deactivation(s) inside the modelling window: ${listed}. ` +
          "Capacity weighting assumes none exist; revisit it before ingesting.",
      );
    }
  }

  return {
    plants: [...plants.values()],
    units,
    rejected,
    outOfScopeRowsFiltered,
    inconsistentUnitDates,
    columns,
  };
}

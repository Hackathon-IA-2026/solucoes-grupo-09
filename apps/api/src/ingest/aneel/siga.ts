import { UpstreamError } from "../../errors.js";
import { parseDelimited, toRecord } from "../csv.js";
import { parseSourceDate, trimmed } from "../normalise.js";
import { cegCore } from "../ons/constrained-off.js";
import type {
  Coordinate,
  CoordinateRejection,
  Municipality,
  PlantLocationSource,
  RejectedRow,
  RejectionReason,
  ResolvedPlantLocation,
  SigaParse,
  SigaRegistration,
} from "../types.js";

/**
 * Adapter for the ANEEL **SIGA** daily extract — the platform's only source of
 * plant coordinates.
 *
 * Five things shape it, all measured in `docs/research/plant-registry.md`:
 *
 * 1. **SIGA contributes coordinates, municipality and ownership. Nothing else.**
 *    Capacity, commissioning and deactivation stay with ONS, which has them per
 *    generating unit, and without SIGA's registration lag — twelve plants were
 *    curtailed by ONS while SIGA still showed them as `Construção` at 0 kW.
 *    `MdaPotenciaFiscalizadaKw` is read here, but only as the input to the size
 *    filter below; it is never returned as a capacity and never stored.
 * 2. **The join key is the CEG with the version segment stripped, on both
 *    sides.** ANEEL writes the version unpadded (`.1`), ONS zero-pads it
 *    (`.01`), so `CodCEG == ceg` matches **0 of 1,614** — and does it silently,
 *    as an empty inner join or a column of nulls. De-padding alone gives 98.95%
 *    and is still wrong, because ANEEL bumps the version on re-registration and
 *    ONS does not follow. `cegCore` from the constrained-off adapter is
 *    deliberately reused rather than re-derived: one function, both sides.
 * 3. **A coordinate outside the Brazil bounding box is *absent*, not a
 *    location** — 1.72% of operating EOL/UFV rows sit at exactly (0, 0), Null
 *    Island in the Gulf of Guinea, which no latitude-only bounds check catches.
 * 4. **The UFV population is overwhelmingly rooftop.** 17,260 operating UFV,
 *    median capacity **1 kW**, only 584 at or above 5 MW. Any aggregation over
 *    SIGA without a technology *and* size filter is counting rooftops, so the
 *    filter is applied inside the aggregate rather than left to the caller.
 * 5. **Rows are deleted, not tombstoned.** A retirement or a revocation is a
 *    row that stops existing, with no phase value and no date to mark it. That
 *    is diffed against the prior snapshot in `siga-repository.ts`; it cannot be
 *    seen from one file.
 *
 * Licence: ODbL 1.0. See `plant_geo` in `src/database/schema.ts`.
 */

/**
 * The columns this adapter needs, spelled as ANEEL spells them —
 * `DscMuninicpios` and `Pariticipacao` are ANEEL's own typos and are the actual
 * header text. Correcting them here would produce a file that never matches.
 */
const REQUIRED_COLUMNS = [
  "DatGeracaoConjuntoDados",
  "NomEmpreendimento",
  "IdeNucleoCEG",
  "CodCEG",
  "SigUFPrincipal",
  "SigTipoGeracao",
  "DscFaseUsina",
  "MdaPotenciaFiscalizadaKw",
  "NumCoordNEmpreendimento",
  "NumCoordEEmpreendimento",
  "DscPropriRegimePariticipacao",
  "DscMuninicpios",
] as const;

/**
 * Brazil's bounding box, from `docs/domain-model.md` §3.
 *
 * Generous rather than tight: the job of this box is to catch a sentinel, a
 * transposed pair or a sign error, not to adjudicate a border. A plant sited in
 * the wrong municipality passes it, and the research says so.
 *
 * It has one measured false positive, and it is kept rather than papered over:
 * the 4.8 MW thermal plant on **Fernando de Noronha** sits at longitude
 * −32.417 and is refused, because the eastern edge at −33 excludes Brazil's
 * Atlantic islands. Exactly one row of 25,127 is affected, it is out of
 * WattSteer's scope, and widening the box to admit it would also admit a class
 * of sign errors — so the box stays as `docs/domain-model.md` §3 specifies it
 * and the rejection is *counted* rather than silent.
 */
export const BRAZIL_BBOX = {
  minLatitude: -34,
  maxLatitude: 6,
  minLongitude: -74,
  maxLongitude: -33,
} as const;

/** ANEEL `SigTipoGeracao` values that are WattSteer's fleet. */
export const FLEET_TECHNOLOGIES: ReadonlySet<string> = new Set(["EOL", "UFV"]);

/**
 * The size floor for treating a SIGA registration as fleet, in kW.
 *
 * 5 MW is the research's own cut: it reduces 17,260 operating UFV to 584. The
 * number is a threshold on a long tail rather than a natural boundary, so it is
 * named and exported instead of being inlined into a comparison.
 */
export const FLEET_MIN_CAPACITY_KW = 5000;

/** ANEEL `DscFaseUsina` for a plant that is generating. */
export const OPERATING_PHASE = "Operação";

/**
 * Parse an ANEEL decimal.
 *
 * **SIGA writes a decimal comma**, which `parseDecimal` — an ONS rule, and ONS
 * writes a decimal point — reads as `NaN`. Kept in this module rather than
 * added to `normalise.ts` for exactly that reason: `normalise.ts` is the ONS
 * dialect, and one function that guesses the separator from the string would be
 * a worse thing than two that each know their source.
 *
 * `null` means present-but-empty; `NaN` means present and unreadable.
 */
export function parseAneelDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = trimmed(value);
  if (text === "") {
    return null;
  }
  // `1.234,56` — dots group, the comma is the point. With no comma there is
  // nothing to group, so a dot is left alone and reads as a decimal point.
  const normalised = text.includes(",")
    ? text.replaceAll(".", "").replace(",", ".")
    : text;
  const parsed = Number(normalised);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Whether a pair is a usable location, and why not when it is not. */
export function classifyCoordinate(
  latitude: number | null,
  longitude: number | null,
): { coordinate: Coordinate } | { rejection: CoordinateRejection } {
  if (latitude === null || longitude === null) {
    return { rejection: "missing" };
  }
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return { rejection: "unparsable" };
  }
  // Checked before the box, though the box would also catch it: (0,0) is a
  // sentinel ANEEL writes for "unknown", and reporting it as merely
  // out-of-bounds would hide how much of the gap is one specific defect.
  if (latitude === 0 && longitude === 0) {
    return { rejection: "null_island" };
  }
  const inside =
    latitude >= BRAZIL_BBOX.minLatitude &&
    latitude <= BRAZIL_BBOX.maxLatitude &&
    longitude >= BRAZIL_BBOX.minLongitude &&
    longitude <= BRAZIL_BBOX.maxLongitude;
  return inside
    ? { coordinate: { latitude, longitude } }
    : { rejection: "out_of_bounds" };
}

/**
 * Split `DscMuninicpios` into municipalities.
 *
 * The field is a comma-separated list of `Município - UF`; a plant straddling a
 * boundary carries several. Entries that do not carry a ` - UF` suffix are
 * dropped rather than kept with a guessed state — the UF is what makes the name
 * unique, and "Bom Jesus" without it names ten different places.
 */
export function parseMunicipalities(raw: string): Municipality[] {
  const municipalities: Municipality[] = [];
  for (const entry of trimmed(raw).split(",")) {
    const text = trimmed(entry);
    if (text === "") {
      continue;
    }
    const separator = text.lastIndexOf(" - ");
    if (separator < 0) {
      continue;
    }
    const name = trimmed(text.slice(0, separator));
    const uf = trimmed(text.slice(separator + 3)).toUpperCase();
    if (name !== "" && /^[A-Z]{2}$/.test(uf)) {
      municipalities.push({ name, uf });
    }
  }
  return municipalities;
}

/** Case- and space-insensitive municipality identity, for grouping. */
export function municipalityKey(municipality: Municipality): string {
  return `${municipality.name.toLocaleUpperCase("pt-BR")}|${municipality.uf}`;
}

function assertColumns(columns: string[]): void {
  const present = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new UpstreamError(
      `SIGA extract is missing required columns: ${missing.join(", ")}`,
    );
  }
}

type NormalisedRow =
  | { registration: SigaRegistration; snapshotDate: Date }
  | { rejected: RejectedRow };

function normaliseRow(row: Record<string, string>, rowNumber: number): NormalisedRow {
  const reject = (reason: RejectionReason, detail: string): NormalisedRow => ({
    rejected: { reason, rowNumber, detail },
  });

  const core = cegCore(row.CodCEG ?? "");
  if (core === null) {
    return reject("missing_identity", "CodCEG is present but empty");
  }

  const stamp = parseSourceDate(row.DatGeracaoConjuntoDados);
  if ("invalid" in stamp) {
    return reject(
      "unparsable_date",
      `DatGeracaoConjuntoDados=${JSON.stringify(stamp.invalid)}`,
    );
  }
  if (!stamp.date) {
    return reject("empty_value", "DatGeracaoConjuntoDados is present but empty");
  }

  const rawLatitude = parseAneelDecimal(row.NumCoordNEmpreendimento);
  const rawLongitude = parseAneelDecimal(row.NumCoordEEmpreendimento);
  const classified = classifyCoordinate(rawLatitude, rawLongitude);
  const municipalitiesRaw = trimmed(row.DscMuninicpios ?? "");

  return {
    snapshotDate: stamp.date,
    registration: {
      cegCore: core,
      cegRaw: trimmed(row.CodCEG ?? ""),
      nucleus: trimmed(row.IdeNucleoCEG ?? ""),
      // Kept for provenance and diffing, never rendered: SIGA writes historical
      // aliases inline — `Cerro Chato I (Antiga Coxilha Negra V)`.
      name: trimmed(row.NomEmpreendimento ?? ""),
      ufPrincipal: trimmed(row.SigUFPrincipal ?? "").toUpperCase(),
      sourceTechnology: trimmed(row.SigTipoGeracao ?? "").toUpperCase(),
      phase: trimmed(row.DscFaseUsina ?? ""),
      // Read for the size filter alone. Never stored, never aggregated as
      // fleet capacity — that is ONS's per-unit series.
      inspectedCapacityKw: parseAneelDecimal(row.MdaPotenciaFiscalizadaKw),
      coordinate: "coordinate" in classified ? classified.coordinate : null,
      coordinateRejection: "rejection" in classified ? classified.rejection : null,
      rawLatitude,
      rawLongitude,
      municipalities: parseMunicipalities(municipalitiesRaw),
      municipalitiesRaw,
      ownership: trimmed(row.DscPropriRegimePariticipacao ?? ""),
    },
  };
}

/**
 * Parse the daily SIGA CSV.
 *
 * Every row is kept, including the ones outside WattSteer's fleet: the match
 * rate is measured against the whole extract (a plant that vanished from SIGA
 * must not look matched because it was filtered out first), and the
 * municipality-centroid fallback is strictly better the more coordinates it can
 * average. Scoping happens at the join, not at the parse.
 */
export function parseSigaCsv(text: string): SigaParse {
  // ANEEL serves the CSV with a UTF-8 BOM; left in place it becomes part of the
  // first column's name and `DatGeracaoConjuntoDados` goes missing.
  const { columns, rows: cells } = parseDelimited(
    text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text,
  );
  if (columns.length === 0) {
    throw new UpstreamError("SIGA extract is empty");
  }
  assertColumns(columns);

  const rows: SigaRegistration[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<string, SigaRegistration>();
  let snapshotDate: Date | null = null;
  let nullIslandRows = 0;
  let outOfBoundsRows = 0;
  let duplicateCegCores = 0;
  let conflictingDuplicates = 0;

  cells.forEach((cell, index) => {
    const outcome = normaliseRow(toRecord(columns, cell), index + 1);
    if ("rejected" in outcome) {
      rejected.push(outcome.rejected);
      return;
    }
    if (snapshotDate === null) {
      snapshotDate = outcome.snapshotDate;
    } else if (snapshotDate.getTime() !== outcome.snapshotDate.getTime()) {
      // One extract, one generation stamp. Two would mean the file is a
      // concatenation of cuts and nothing about its vintage is knowable.
      throw new UpstreamError(
        `SIGA extract carries two DatGeracaoConjuntoDados values: ` +
          `${snapshotDate.toISOString().slice(0, 10)} and ` +
          `${outcome.snapshotDate.toISOString().slice(0, 10)}`,
      );
    }

    const registration = outcome.registration;
    if (registration.coordinateRejection === "null_island") {
      nullIslandRows += 1;
    }
    if (registration.coordinateRejection === "out_of_bounds") {
      outOfBoundsRows += 1;
    }

    const existing = seen.get(registration.cegCore);
    if (existing) {
      // Three duplicate `CodCEG` values exist in the live file, all hydro.
      // They are *not* byte-identical as the research states — each pair
      // differs in `DscTipoOutorga` (`Autorização` against `Concessão`) — but
      // they agree on everything this adapter stores, so folding them is safe
      // and the count is reported. A pair that *disagreed* on a location would
      // be a different fact, and is counted separately: picking a winner
      // between two coordinates would be a guess presented as data.
      duplicateCegCores += 1;
      if (!sameLocation(existing, registration)) {
        conflictingDuplicates += 1;
      }
      return;
    }
    seen.set(registration.cegCore, registration);
    rows.push(registration);
  });

  if (snapshotDate === null) {
    throw new UpstreamError("SIGA extract carried no readable rows");
  }

  return {
    snapshotDate,
    rows,
    rejected,
    nullIslandRows,
    outOfBoundsRows,
    duplicateCegCores,
    conflictingDuplicates,
    columns,
  };
}

function sameLocation(a: SigaRegistration, b: SigaRegistration): boolean {
  return (
    a.rawLatitude === b.rawLatitude &&
    a.rawLongitude === b.rawLongitude &&
    a.municipalitiesRaw === b.municipalitiesRaw
  );
}

// ---------------------------------------------------------------------------
// Aggregation — filtered by construction
// ---------------------------------------------------------------------------

/**
 * Whether a registration is part of the utility-scale fleet.
 *
 * Technology **and** size **and** phase, together: `UFV` alone still admits
 * 17,260 rooftops at a median of 1 kW, and a size floor alone admits thermal.
 */
export function isFleetScale(row: SigaRegistration): boolean {
  return (
    FLEET_TECHNOLOGIES.has(row.sourceTechnology) &&
    row.phase === OPERATING_PHASE &&
    row.inspectedCapacityKw !== null &&
    !Number.isNaN(row.inspectedCapacityKw) &&
    row.inspectedCapacityKw >= FLEET_MIN_CAPACITY_KW
  );
}

/** What a SIGA-side capacity aggregate is allowed to be, and what it excluded. */
export interface SigaFleetSummary {
  plants: number;
  capacityKw: number;
  /** Rows the technology/size/phase filter removed before summing. */
  excludedRows: number;
}

/**
 * Sum SIGA capacity over the utility-scale fleet only.
 *
 * The filter is inside the function rather than a precondition on the caller,
 * which is the entire point: an unfiltered sum over this file is not a worse
 * estimate of the fleet, it is a different quantity — 17,260 rooftop
 * registrations wearing the fleet's name.
 *
 * This is a **diagnostic**, not a capacity source. Fleet capacity is
 * `InstalledCapacityAsOf` over ONS's per-unit rows; this exists so an operator
 * can see the two disagree (measured at −1.15%) rather than to be used.
 */
export function summariseSigaFleetCapacity(
  rows: readonly SigaRegistration[],
): SigaFleetSummary {
  let plants = 0;
  let capacityKw = 0;
  let excludedRows = 0;
  for (const row of rows) {
    if (!isFleetScale(row)) {
      excludedRows += 1;
      continue;
    }
    plants += 1;
    capacityKw += row.inspectedCapacityKw ?? 0;
  }
  return { plants, capacityKw, excludedRows };
}

// ---------------------------------------------------------------------------
// Location resolution and the municipality fallback
// ---------------------------------------------------------------------------

/**
 * An externally supplied municipality centroid — IBGE's municipal mesh, say.
 *
 * A hook rather than a bundled table: WattSteer has no municipal geometry in
 * the repository, and hand-typing coordinates for six municipalities would put
 * unmeasured numbers into a codebase whose whole discipline is that its numbers
 * were measured. When one is wired in it takes precedence over the in-snapshot
 * centroid below, which is an approximation and says so.
 */
export type MunicipalityCentroidSource = (
  municipality: Municipality,
) => Coordinate | null;

export interface ResolveLocationsOptions {
  centroids?: MunicipalityCentroidSource;
}

/**
 * Centroid of every *valid* SIGA coordinate registered in each municipality.
 *
 * The fallback needs no external dataset because the extract is its own
 * reference: a municipality holding a null-island plant almost always holds
 * other registrations that are properly sited, and their mean is a far better
 * answer than the state capital — the research measured a 94 km centroid error
 * from getting fleet location wrong at a much coarser scale than this.
 *
 * It is a **registration** centroid, not a geographic one: it is the middle of
 * where generation is registered in that municipality, which is closer to what
 * a weather sample wants than the municipal seat is, and is not the same thing
 * as the IBGE centroid. Named `siga_municipality_centroid` for that reason.
 */
export function municipalityCentroids(
  rows: readonly SigaRegistration[],
): Map<string, Coordinate> {
  const sums = new Map<string, { lat: number; lon: number; n: number }>();
  for (const row of rows) {
    if (!row.coordinate) {
      continue;
    }
    for (const municipality of row.municipalities) {
      const key = municipalityKey(municipality);
      const current = sums.get(key) ?? { lat: 0, lon: 0, n: 0 };
      current.lat += row.coordinate.latitude;
      current.lon += row.coordinate.longitude;
      current.n += 1;
      sums.set(key, current);
    }
  }
  const centroids = new Map<string, Coordinate>();
  for (const [key, sum] of sums) {
    centroids.set(key, { latitude: sum.lat / sum.n, longitude: sum.lon / sum.n });
  }
  return centroids;
}

/**
 * Resolve every registration to a location, or to an honest absence.
 *
 * Three outcomes and they are distinguishable on the row: the SIGA coordinate,
 * a municipality centroid with the reason the coordinate was refused still
 * attached, or nothing at all. A plant is never silently relocated — a row that
 * fell back says so, and a row that could not be located keeps its capacity and
 * loses only its weather sample.
 */
export function resolveLocations(
  rows: readonly SigaRegistration[],
  options: ResolveLocationsOptions = {},
): Map<string, ResolvedPlantLocation> {
  const centroids = municipalityCentroids(rows);
  const resolved = new Map<string, ResolvedPlantLocation>();

  for (const row of rows) {
    const municipality = row.municipalities[0] ?? null;
    if (row.coordinate) {
      resolved.set(row.cegCore, {
        cegCore: row.cegCore,
        cegRaw: row.cegRaw,
        sigaName: row.name,
        coordinate: row.coordinate,
        locationSource: "siga_coordinate",
        coordinateRejection: null,
        municipality,
        municipalitiesRaw: row.municipalitiesRaw,
        ownership: row.ownership,
        withdrawnOn: null,
      });
      continue;
    }

    const external = municipality ? (options.centroids?.(municipality) ?? null) : null;
    const centroid =
      external ??
      (municipality ? (centroids.get(municipalityKey(municipality)) ?? null) : null);
    const source: PlantLocationSource = centroid
      ? "siga_municipality_centroid"
      : "unlocated";
    resolved.set(row.cegCore, {
      cegCore: row.cegCore,
      cegRaw: row.cegRaw,
      sigaName: row.name,
      coordinate: centroid,
      locationSource: source,
      coordinateRejection: row.coordinateRejection,
      municipality,
      municipalitiesRaw: row.municipalitiesRaw,
      ownership: row.ownership,
      withdrawnOn: null,
    });
  }

  return resolved;
}

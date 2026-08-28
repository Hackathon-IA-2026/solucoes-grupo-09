import { UpstreamError } from "../../errors.js";
import { parseDelimited, toRecord } from "../csv.js";
import { parseSourceDate, resolveSubsystem, trimmed } from "../normalise.js";
import type {
  ConjuntoMembershipParse,
  RegistryConjunto,
  RegistryConjuntoMembership,
  RejectedRow,
  RejectionReason,
  Technology,
} from "../types.js";
import { cegCore } from "./constrained-off.js";

/**
 * Adapter for ONS `usina_conjunto` — the bridge that makes the entity-grain
 * constrained-off datasets usable, and the only time-resolved thing in the
 * whole registry.
 *
 * The CKAN notes claim the dataset carries no historical information. They are
 * wrong about their own file: `dat_iniciorelacionamento` and
 * `dat_fimrelacionamento` make it a genuine SCD2, and a plant that joined a
 * conjunto mid-window is misattributed by any snapshot join that ignores them.
 *
 * Two conventions had to be measured rather than read, because ONS documents
 * neither:
 *
 * 1. **`dat_fimrelacionamento` is the inclusive last day.** All 331 sequential
 *    memberships in the live file have the successor starting the day *after*
 *    the predecessor ends, and none starting on the same day. Treating the end
 *    as exclusive would open a one-day hole in every plant that ever moved.
 * 2. **The membership key is `id_ons_usina`, not the CEG.** One `ceg_core`
 *    (`EOL.CV.RN.047240-9`) carries two ONS codes, `RNST6` and `RNST06`, both
 *    with open memberships of the same conjunto. Keyed on the CEG that is an
 *    overlap violation; keyed on the ONS code it is what it actually is — two
 *    codes ONS uses for one registered plant.
 *
 * The field is `estad_id` here and `id_estado` everywhere else in the ONS
 * catalogue. That is not a typo in this file; it is a typo in ONS's, and the
 * adapter reads the name the file actually has.
 */

/** ONS CKAN package id. The S3 path segment is `usina_conjunto` as well. */
export const CONJUNTO_DATASET_SLUG = "usina_conjunto";

const REQUIRED_COLUMNS = [
  "id_subsistema",
  "estad_id",
  "id_tipousina",
  "id_ons_conjunto",
  "id_ons_usina",
  "nom_conjunto",
  "ceg",
  "dat_iniciorelacionamento",
  "dat_fimrelacionamento",
] as const;

/** `id_tipousina` → WattSteer technology. `UTE`/`UHE` conjuntos exist and map to null. */
const TECHNOLOGIES: Record<string, Technology> = { UEE: "WIND", UFV: "SOLAR" };

function assertColumns(columns: string[]): void {
  const present = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new UpstreamError(
      `usina_conjunto is missing required columns: ${missing.join(", ")}`,
    );
  }
}

type NormalisedRow =
  | { conjunto: RegistryConjunto; membership: RegistryConjuntoMembership }
  | { rejected: RejectedRow };

function normaliseRow(row: Record<string, string>, rowNumber: number): NormalisedRow {
  const reject = (reason: RejectionReason, detail: string): NormalisedRow => ({
    rejected: { reason, rowNumber, detail },
  });

  const plantOnsCode = trimmed(row.id_ons_usina ?? "");
  const conjuntoCode = trimmed(row.id_ons_conjunto ?? "");
  if (plantOnsCode === "" || conjuntoCode === "") {
    return reject(
      "missing_identity",
      `id_ons_usina=${JSON.stringify(plantOnsCode)} id_ons_conjunto=${JSON.stringify(conjuntoCode)}`,
    );
  }

  const subsystem = resolveSubsystem(row.id_subsistema ?? "");
  if (subsystem.kind !== "subsystem") {
    return reject(
      "unknown_subsystem",
      `id_subsistema=${JSON.stringify(row.id_subsistema ?? null)}`,
    );
  }

  const from = parseSourceDate(row.dat_iniciorelacionamento);
  if ("invalid" in from) {
    return reject(
      "unparsable_date",
      `dat_iniciorelacionamento=${JSON.stringify(from.invalid)}`,
    );
  }
  if (!from.date) {
    // A membership with no start cannot be resolved as of any date.
    return reject("empty_value", "dat_iniciorelacionamento is present but empty");
  }
  const to = parseSourceDate(row.dat_fimrelacionamento);
  if ("invalid" in to) {
    return reject(
      "unparsable_date",
      `dat_fimrelacionamento=${JSON.stringify(to.invalid)}`,
    );
  }
  if (to.date && to.date.getTime() < from.date.getTime()) {
    return reject(
      "unparsable_date",
      `dat_fimrelacionamento ${to.date.toISOString().slice(0, 10)} precedes dat_iniciorelacionamento ${from.date.toISOString().slice(0, 10)}`,
    );
  }

  const sourceTypeCode = trimmed(row.id_tipousina ?? "");

  return {
    conjunto: {
      onsConjuntoCode: conjuntoCode,
      name: trimmed(row.nom_conjunto ?? ""),
      subsystem: subsystem.code,
      stateCode: trimmed(row.estad_id ?? ""),
      technology: TECHNOLOGIES[sourceTypeCode.toUpperCase()] ?? null,
      sourceTypeCode,
    },
    membership: {
      plantOnsCode,
      // Null where ONS's own bridge leaves `ceg` empty — a gap in ONS's data,
      // not in ours, and not a reason to drop a real membership.
      plantCegCore: cegCore(row.ceg ?? ""),
      conjuntoCode,
      memberFrom: from.date,
      memberTo: to.date ?? null,
    },
  };
}

/** Two memberships of one plant whose day ranges intersect. */
export interface MembershipOverlap {
  plantOnsCode: string;
  first: RegistryConjuntoMembership;
  second: RegistryConjuntoMembership;
}

/**
 * The one-conjunto-per-plant-per-instant invariant, checked rather than assumed.
 *
 * `docs/domain-model.md` §3 states it as a rule and says explicitly that
 * overlapping intervals are an ingest failure rather than something to merge.
 * The reason it must be *checked* is that 2,078 membership rows cover 1,747
 * distinct plants: the surplus is expected to be sequential membership, and
 * "expected" is exactly the kind of claim that decays silently. This is what
 * proves it, on every ingest, against the file that actually arrived.
 *
 * Ranges are inclusive at both ends — see the module note on
 * `dat_fimrelacionamento` — so two memberships that abut on consecutive days do
 * not overlap, and two that share a day do.
 */
export function findMembershipOverlaps(
  memberships: readonly RegistryConjuntoMembership[],
): MembershipOverlap[] {
  const byPlant = new Map<string, RegistryConjuntoMembership[]>();
  for (const membership of memberships) {
    const existing = byPlant.get(membership.plantOnsCode);
    if (existing) {
      existing.push(membership);
    } else {
      byPlant.set(membership.plantOnsCode, [membership]);
    }
  }

  const overlaps: MembershipOverlap[] = [];
  for (const [plantOnsCode, rows] of byPlant) {
    if (rows.length < 2) {
      continue;
    }
    const sorted = [...rows].sort(
      (a, b) => a.memberFrom.getTime() - b.memberFrom.getTime(),
    );
    for (let index = 0; index + 1 < sorted.length; index += 1) {
      const first = sorted[index];
      const second = sorted[index + 1];
      if (!(first && second)) {
        continue;
      }
      const firstEnds = first.memberTo?.getTime() ?? Number.POSITIVE_INFINITY;
      if (second.memberFrom.getTime() <= firstEnds) {
        overlaps.push({ plantOnsCode, first, second });
      }
    }
  }
  return overlaps;
}

export interface ParseConjuntoMembershipOptions {
  /**
   * Take the file despite an overlap, for an operator triaging a real ONS
   * defect. Off by default: a merged membership is a wrong attribution that
   * looks exactly like a right one.
   */
  allowOverlappingMembership?: boolean;
}

/** Parse the CSV rendition of `usina_conjunto`. */
export function parseConjuntoMembershipCsv(
  text: string,
  options: ParseConjuntoMembershipOptions = {},
): ConjuntoMembershipParse {
  const { columns, rows: cells } = parseDelimited(text);
  if (columns.length === 0) {
    throw new UpstreamError("usina_conjunto file is empty");
  }
  assertColumns(columns);

  const conjuntos = new Map<string, RegistryConjunto>();
  const memberships: RegistryConjuntoMembership[] = [];
  const rejected: RejectedRow[] = [];

  cells.forEach((cell, index) => {
    const outcome = normaliseRow(toRecord(columns, cell), index + 1);
    if ("rejected" in outcome) {
      rejected.push(outcome.rejected);
      return;
    }
    if (!conjuntos.has(outcome.conjunto.onsConjuntoCode)) {
      conjuntos.set(outcome.conjunto.onsConjuntoCode, outcome.conjunto);
    }
    memberships.push(outcome.membership);
  });

  if (!options.allowOverlappingMembership) {
    const overlaps = findMembershipOverlaps(memberships);
    if (overlaps.length > 0) {
      const listed = overlaps
        .slice(0, 5)
        .map(
          (o) =>
            `${o.plantOnsCode} in ${o.first.conjuntoCode} and ${o.second.conjuntoCode}`,
        )
        .join("; ");
      throw new UpstreamError(
        `usina_conjunto puts ${overlaps.length} plant-membership pair(s) in two conjuntos at once: ${listed}. ` +
          "A plant belongs to at most one conjunto at any instant; this is an ingest failure, not a merge.",
      );
    }
  }

  return {
    conjuntos: [...conjuntos.values()],
    memberships,
    rejected,
    columns,
  };
}

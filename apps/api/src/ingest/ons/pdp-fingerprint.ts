import type { SubsystemCode } from "../normalise.js";
import type {
  ProgrammedVsForecastHalfHour,
  ProgrammePlantVector,
  Technology,
} from "../types.js";

/**
 * The PDP → subsystem crosswalk, built from the data rather than from a name.
 *
 * `programacao_x_previsao` identifies an entity by `cod_usinapdp` and says
 * neither its subsystem nor its technology, and ONS publishes no relationship
 * table for that code: measured on 2026-09-18, its 628 codes overlap **nothing**
 * in `usina_conjunto` (all 14 columns tried), and joining on a normalised name
 * reaches 76 of 628 at best. What the two files do share is a *number*: the
 * value `programacao_x_previsao` calls `val_programado` and `programacao_diaria`
 * calls `val_geracaoprogramada` for the same entity, over the same 48 patamares
 * of the same day. A 48-long vector of two-decimal megawatts is a fingerprint.
 *
 * **What it achieved, measured** (2026-09-18, 626 entities vs 2,646 wind and
 * solar plants): the subsystem was determined for 319 entities carrying **99.64%
 * of programmed energy**, ambiguous for 307 carrying 0.19%, unmatched for 2 at
 * 0.17%. The technology was never ambiguous where the subsystem was determined.
 * The ambiguity is a *fingerprint collision* — an entity flat at zero all day
 * matches every plant flat at zero — which is why one day is never taken as the
 * answer:
 *
 * - **A day narrows; it never widens.** `mergeCandidates` intersects a day's
 *   candidate set with what is stored, so a collision on a quiet day is
 *   resolved by the next informative one.
 * - **A day with no match says nothing.** An entity ONS programmes at a value no
 *   plant carries exactly is no evidence against an earlier determination.
 * - **An empty intersection is a conflict, and the stored belief stands.** It is
 *   reported, never written over — two informative days disagreeing is a fact an
 *   operator should see, not a value to overwrite silently.
 *
 * It is a heuristic and calls itself one: the crosswalk is stored as candidate
 * sets rather than answers, and a canonical read that needs a single subsystem
 * gets one only where the set has exactly one member. The share of programmed energy that is
 * determined travels with every total built on it (`canonical_programmed_vre`).
 */

/** Two decimals: what both files print, so equality is exact rather than tolerant. */
const SCALE = 100;

/** A vector as an exact key. A missing patamar keeps its place, as `_`. */
export function vectorKey(vector: readonly (number | null)[]): string {
  return vector
    .map((value) => (value === null ? "_" : Math.round(value * SCALE)))
    .join(",");
}

/** One PDP entity's programme, index 0 = patamar 1. */
export interface PdpVector {
  pdpCode: string;
  programmedMw: (number | null)[];
}

/** Group a day's `programacao_x_previsao` rows into one vector per entity. */
export function pdpVectors(
  rows: readonly ProgrammedVsForecastHalfHour[],
  halfHours: number,
  midnightUtcMs: number,
): PdpVector[] {
  const byCode = new Map<string, (number | null)[]>();
  for (const row of rows) {
    let vector = byCode.get(row.pdpCode);
    if (!vector) {
      vector = new Array<number | null>(halfHours).fill(null);
      byCode.set(row.pdpCode, vector);
    }
    const index = Math.round((row.validTime.getTime() - midnightUtcMs) / 1_800_000);
    if (index >= 0 && index < halfHours) {
      vector[index] = row.programmedMw;
    }
  }
  return [...byCode].map(([pdpCode, programmedMw]) => ({ pdpCode, programmedMw }));
}

/** What a day's fingerprint join says about one entity. */
export interface DayCandidates {
  subsystems: Set<SubsystemCode>;
  technologies: Set<Technology>;
  /** How many plants carried exactly this vector. */
  matchedPlants: number;
}

/**
 * For each PDP entity, the subsystems and technologies of every plant whose
 * programme equals its own on this day. An entity with no equal plant is
 * absent from the result, not present with empty sets.
 */
export function dayCandidates(
  entities: readonly PdpVector[],
  plants: readonly ProgrammePlantVector[],
): Map<string, DayCandidates> {
  const index = new Map<string, ProgrammePlantVector[]>();
  for (const plant of plants) {
    const key = vectorKey(plant.programmedMw);
    const bucket = index.get(key);
    if (bucket) {
      bucket.push(plant);
    } else {
      index.set(key, [plant]);
    }
  }
  const result = new Map<string, DayCandidates>();
  for (const entity of entities) {
    const matches = index.get(vectorKey(entity.programmedMw));
    if (!matches) {
      continue;
    }
    result.set(entity.pdpCode, {
      subsystems: new Set(matches.map((plant) => plant.subsystem)),
      technologies: new Set(matches.map((plant) => plant.technology)),
      matchedPlants: matches.length,
    });
  }
  return result;
}

/** The stored belief about one entity: sorted candidate sets, `[]` for none. */
export interface StoredCandidates {
  subsystems: string[];
  technologies: string[];
}

export type Merge =
  /** Nothing stored, and the day had a match: take it. */
  | { kind: "set"; subsystems: string[]; technologies: string[] }
  /** The intersection is smaller than what was stored. */
  | { kind: "narrowed"; subsystems: string[]; technologies: string[] }
  /** The day agrees with, or says nothing beyond, what was stored. */
  | { kind: "unchanged" }
  /** The day is informative and disjoint from what was stored. The stored belief stands. */
  | { kind: "conflict"; stored: StoredCandidates; day: StoredCandidates };

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

function intersect(left: readonly string[], right: readonly string[]): string[] {
  const keep = new Set(right);
  return left.filter((value) => keep.has(value));
}

/**
 * Combine a day's candidates with the stored belief. Subsystems and
 * technologies are judged together: a disjoint set on either is a conflict,
 * because a day that contradicts the technology is not evidence about the
 * subsystem either.
 */
export function mergeCandidates(
  stored: StoredCandidates | undefined,
  day: DayCandidates | undefined,
): Merge {
  if (!day) {
    return { kind: "unchanged" };
  }
  const daySubsystems = sorted(day.subsystems);
  const dayTechnologies = sorted(day.technologies);
  if (!stored || stored.subsystems.length === 0) {
    return { kind: "set", subsystems: daySubsystems, technologies: dayTechnologies };
  }
  const subsystems = intersect(stored.subsystems, daySubsystems);
  const technologies = intersect(stored.technologies, dayTechnologies);
  if (subsystems.length === 0 || technologies.length === 0) {
    return {
      kind: "conflict",
      stored,
      day: { subsystems: daySubsystems, technologies: dayTechnologies },
    };
  }
  const same =
    subsystems.length === stored.subsystems.length &&
    technologies.length === stored.technologies.length;
  return same ? { kind: "unchanged" } : { kind: "narrowed", subsystems, technologies };
}

import { UpstreamError } from "../../errors.js";
import type { RegistryPlantKey, SigaMatchRate, SigaRegistration } from "../types.js";

/**
 * The join between the ONS registry and SIGA, and the assertion that guards it.
 *
 * **This module exists because the failure mode is silence.** `CodCEG` compared
 * verbatim to ONS `ceg` matches 0 of 1,614 plants; nothing throws, no column is
 * malformed, and the only symptom is a `plant_geo` table full of nulls that
 * nobody notices until a weather sample is asked for months later. So the rate
 * is measured on every ingest and the ingest fails when it drops.
 *
 * Two rates are computed and both are reported:
 *
 * - **core** — the version-stripped CEG on both sides. Measured at 100.00%
 *   against the observed curtailed fleet and 99.72% against full registry
 *   closure. This is the one that is asserted.
 * - **verbatim** — raw `CodCEG` against raw ONS `ceg`. Measured at exactly
 *   **0.00%**, and kept as a live canary: it is the number that would have to
 *   change for the naive join to have started working, and an operator seeing
 *   it move knows ANEEL changed its rendering.
 */

/** The floor the core match rate must clear. */
export const DEFAULT_MATCH_RATE_FLOOR = 0.99;

/**
 * How far the rate may fall below the previous ingest before it is a
 * regression.
 *
 * Not zero: the denominator is the ONS registry, which grows on its own
 * schedule, so a handful of plants ONS lists before ANEEL registers them is
 * ordinary churn rather than a broken join. Five plants in 1,600 is the scale
 * of the four Cerro Chato nuclei the research found genuinely absent from SIGA.
 */
export const DEFAULT_MATCH_RATE_TOLERANCE = 0.005;

export interface MatchOptions {
  /** Absolute floor. Below it the ingest fails whatever the history says. */
  floor?: number;
  /** The previous ingest's core rate, when there is one. */
  previousRate?: number | null;
  /** Slack against `previousRate`. */
  tolerance?: number;
}

/**
 * Measure both match rates.
 *
 * The denominator is the **ONS registry**, not SIGA: SIGA carries 25,127 rows
 * of which the overwhelming majority are rooftop registrations WattSteer has no
 * plant for, so "what fraction of SIGA matched" is a meaningless number that
 * would sit near 6% on a perfectly healthy day. The question that has an
 * answer is *did every plant the platform models get a location*.
 */
export function measureMatchRate(
  registry: readonly RegistryPlantKey[],
  siga: readonly SigaRegistration[],
): SigaMatchRate {
  const byCore = new Map<string, SigaRegistration>();
  const byRaw = new Set<string>();
  for (const row of siga) {
    if (!byCore.has(row.cegCore)) {
      byCore.set(row.cegCore, row);
    }
    byRaw.add(row.cegRaw);
  }

  const unmatched: string[] = [];
  let matched = 0;
  let verbatimMatched = 0;
  for (const plant of registry) {
    if (byCore.has(plant.cegCore)) {
      matched += 1;
    } else {
      unmatched.push(plant.cegCore);
    }
    if (byRaw.has(plant.cegRaw)) {
      verbatimMatched += 1;
    }
  }

  const registryPlants = registry.length;
  return {
    registryPlants,
    matched,
    // A rate of 1 on an empty registry is the honest reading: nothing was asked
    // for and nothing was missed. It also keeps the very first ingest — which
    // may legitimately run before the ONS registry job has — from failing.
    rate: registryPlants === 0 ? 1 : matched / registryPlants,
    verbatimMatched,
    verbatimRate: registryPlants === 0 ? 0 : verbatimMatched / registryPlants,
    unmatched: unmatched.sort(),
  };
}

/**
 * Fail the ingest if the join regressed.
 *
 * Both directions are checked, and they catch different things: the **floor**
 * catches a format change that breaks the join outright on the first run after
 * it lands, and the **previous rate** catches the slow-drip case where ANEEL
 * quietly stops publishing a class of plants and the rate slides a percent a
 * month, each step of which clears an absolute floor.
 */
export function assertMatchRate(match: SigaMatchRate, options: MatchOptions = {}): void {
  const floor = options.floor ?? DEFAULT_MATCH_RATE_FLOOR;
  const tolerance = options.tolerance ?? DEFAULT_MATCH_RATE_TOLERANCE;
  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
  const sample = match.unmatched.slice(0, 5).join(", ");
  const detail =
    `${match.matched}/${match.registryPlants} = ${pct(match.rate)}` +
    (sample === "" ? "" : ` — unmatched include ${sample}`) +
    `. Verbatim CodCEG↔ceg matched ${match.verbatimMatched}, which is the ` +
    "number that stays at zero while ANEEL and ONS render the version segment differently.";

  if (match.rate < floor) {
    throw new UpstreamError(
      `SIGA↔registry match rate is below the ${pct(floor)} floor: ${detail}`,
    );
  }
  if (
    options.previousRate !== null &&
    options.previousRate !== undefined &&
    match.rate < options.previousRate - tolerance
  ) {
    throw new UpstreamError(
      `SIGA↔registry match rate regressed from ${pct(options.previousRate)} to ${detail}`,
    );
  }
}

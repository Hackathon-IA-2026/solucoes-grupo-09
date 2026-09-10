import type { DiagnosisNarrationInput, Driver } from "@wattsteer/core/api";
import { NARRATION_PROMPT_VERSION } from "../../src/diagnosis/index.js";

/**
 * One closed narration document, as the renderer receives it.
 *
 * Shared by the renderer-contract suite and the scheduled live suite so that
 * both argue about the same day. That matters more here than it usually does:
 * the live suite's only assertion is that the real model's paragraph passes the
 * three gates, and a fixture that drifted between the two would mean the
 * offline suite proves a contract against a document the model never sees.
 *
 * The numbers are the spec's worked example, with two adjustments that make the
 * fixture exercise something: the eight `phi_mwh` sum to `day_expected_mwh −
 * baseline_expected_mwh` exactly, and the shares' denominator is the sum over
 * all eight rather than over the ones a screen would show.
 */

/** `Σ|Φ_j|` — the shares' denominator, over all eight groups. */
export const SUM_ABS = 444;

/** `Φ_j` for the day, in MWh. Ranked, two of them downward, summing to 316. */
const PHI: readonly [Driver["code"], number][] = [
  ["renewable_resource", 160],
  ["net_surplus", 96],
  ["export_stress", 64],
  ["demand_level", 48],
  ["ramp_shape", -32],
  ["calendar_season", -24],
  ["recent_history", 12],
  ["data_conditions", -8],
];

/** The eight groups, always eight: a shortlist would lose the denominator. */
export function narrationGroups(overrides: Partial<Driver> = {}): Driver[] {
  return PHI.map(([code, phi], index) => ({
    code,
    labelCode: `driver.${code}`,
    phiMwh: phi,
    share: Math.abs(phi) / SUM_ABS,
    direction: phi >= 0 ? ("raises" as const) : ("lowers" as const),
    headlineFeature: "proxy_renewable_load_ratio",
    observed: 1.42,
    typical: 0.96,
    observedAbsentReason: null,
    typicalAbsentReason: null,
    unit: "ratio" as const,
    hourDisagreement: 1 + index / 10,
    demoted: false,
    ...overrides,
  }));
}

/** The document. `promptVersion` is the real one, so the fixture ages with it. */
export function narrationPayload(
  overrides: Partial<DiagnosisNarrationInput> = {},
): DiagnosisNarrationInput {
  return {
    schemaVersion: "diagnosis.narration.v1",
    promptVersion: NARRATION_PROMPT_VERSION,
    locale: "pt-BR",
    subsystem: "NE",
    subsystemDisplayName: "NORDESTE",
    targetDate: "2026-08-28",
    thresholdMw: 5,
    forecastOrigin: {
      runLabel: "dessem_free_v1__gate_late__thr5/2026-08-27T22:11:07Z",
      gateProfile: "gate_late",
      publishedAt: "2026-08-27T22:11:07.000Z",
    },
    vintageFidelity: "point_in_time",
    risk: { dayOccurrenceProbability: 0.87, riskClass: "high", hoursP50Nonzero: 9 },
    magnitude: {
      dayExpectedMwh: 412,
      baselineExpectedMwh: 96,
      dayEnergyP10Mwh: 0,
      dayEnergyP50Mwh: 370,
      dayEnergyP90Mwh: 980,
      peakPowerP50Mw: 118,
      peakHourLocal: 13,
    },
    attribution: {
      target: "expected_mwh_day",
      totalAttributedMwh: 316,
      sumAbsAttributedMwh: SUM_ABS,
      stderrMwh: 4.1,
      topTwoShare: 0.58,
      groups: narrationGroups(),
    },
    ruleFlags: [],
    ...overrides,
  };
}

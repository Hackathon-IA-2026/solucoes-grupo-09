/**
 * One published attribution, in the modelling service's own payload shape.
 *
 * Shared by the parse suite and the Postgres suite so that both are arguing
 * about the same document: a fixture that drifted between them would let a
 * refusal be proved on a payload the database never sees.
 *
 * The numbers are chosen so the arithmetic the writer checks is real rather
 * than trivially satisfied — the eight contributions sum to
 * `day_expected_mwh − baseline_expected_mwh` exactly, two groups pull downward,
 * and the shares' denominator is the sum over all eight rather than over the
 * ones a screen would show.
 */

import { EVALUABLE_RULE_CODES } from "../../src/diagnosis/publication.js";

/** A day far from any other suite's fixtures, so a repeated run cannot collide. */
export const TARGET_DATE = "2024-05-07";
/** `gate_at('2024-05-07', 'gate_late')` — D−1 19:00 Brasília. */
export const GATE_LATE = "2024-05-06T22:00:00.000Z";
export const GATE_EARLY = "2024-05-06T12:00:00.000Z";
export const ARTIFACT = "2024-05-06T03:11:07Z";
export const REGIME = "conformal_v1_partial_upper";
export const GROUP_HASH =
  "sha256:0f2c9a1e5b6d4c3a8e7f0b1d2c3a4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5";
export const GROUP_VERSION = "3";
export const BACKGROUND_SOURCE = "base_fit";

/** `Φ_j` for the day, in MWh. They sum to 316 — the day's movement. */
const DAY_PHI: Record<string, number> = {
  net_surplus: 128,
  renewable_resource: 96,
  demand_level: 60,
  export_stress: -40,
  ramp_shape: 40,
  calendar_season: 24,
  recent_history: 12,
  data_conditions: -4,
};

/** `φ_j` at the peak hour. They sum to 26.5 — that hour's movement. */
const PEAK_PHI: Record<string, number> = {
  net_surplus: 12,
  renewable_resource: 8,
  demand_level: 5,
  ramp_shape: 4,
  calendar_season: 2,
  recent_history: 1,
  export_stress: -5,
  data_conditions: -0.5,
};

const DISAGREEMENT: Record<string, number> = {
  net_surplus: 1.1,
  renewable_resource: 1,
  demand_level: 2.4,
  export_stress: 1.6,
  ramp_shape: 1,
  calendar_season: 1,
  recent_history: 3.2,
  data_conditions: 1.9,
};

const HEADLINE: Record<string, { feature: string; unit: string }> = {
  net_surplus: { feature: "proxy_renewable_load_ratio", unit: "ratio" },
  renewable_resource: { feature: "wind_speed_100m_mean", unit: "mw" },
  demand_level: { feature: "programmed_load_mwh", unit: "mwh" },
  export_stress: { feature: "interchange_utilisation", unit: "pct" },
  ramp_shape: { feature: "net_load_ramp_3h", unit: "mw" },
  calendar_season: { feature: "is_holiday", unit: "boolean" },
  recent_history: { feature: "constrained_off_lag_24h", unit: "mwh" },
  data_conditions: { feature: "weather_run_age_hours", unit: "hours" },
};

export interface AttributionPayloadOptions {
  /**
   * The roll call of evaluated rules. Defaults to all four shipping codes.
   *
   * Overridable so the roll-call refusals can be exercised on the same
   * document every other assertion in these suites is made against.
   */
  rulesEvaluated?: unknown[];
  gateProfile?: "gate_early" | "gate_late";
  originKind?: "served" | "backfilled_holdout";
  publishedAt?: string;
  artifactId?: string;
  subsystem?: string;
  driverGroupHash?: string;
  backgroundSource?: string;
  backgroundSeed?: number;
  /** Scales every contribution, so a "revision" is one argument. */
  scale?: number;
  ruleFlags?: Record<string, unknown>[];
  demoted?: string[];
  /** Mutate the finished payload — for the refusal and constraint tests. */
  mutate?: (payload: Record<string, unknown>) => void;
}

function ranked(
  phi: Record<string, number>,
  options: AttributionPayloadOptions,
  grain: "day" | "peak_hour",
): Record<string, unknown>[] {
  const scale = options.scale ?? 1;
  const demoted = new Set(options.demoted ?? []);
  const scaled = Object.entries(phi).map(
    ([code, value]) => [code, value * scale] as const,
  );
  const denominator = scaled.reduce((total, [, value]) => total + Math.abs(value), 0);
  return scaled
    .slice()
    .sort(
      (left, right) =>
        Math.abs(right[1]) - Math.abs(left[1]) || left[0].localeCompare(right[0]),
    )
    .map(([code, value], index) => ({
      code,
      label_code: `driver.${code}`,
      rank: index + 1,
      phi_mwh: value,
      share: Math.abs(value) / denominator,
      direction: value < 0 ? "lowers" : "raises",
      ...(grain === "day" ? { hour_disagreement: DISAGREEMENT[code] } : {}),
      headline_feature: HEADLINE[code]?.feature,
      observed: 1.42,
      typical: 0.96,
      observed_absent_reason: null,
      typical_absent_reason: null,
      unit: HEADLINE[code]?.unit,
      demoted: demoted.has(code),
    }));
}

/** One lane-day of attributions, as `wattsteer_ml.diagnosis.publication` writes it. */
export function attributionPayload(
  options: AttributionPayloadOptions = {},
): Record<string, unknown> {
  const scale = options.scale ?? 1;
  const baseline = 96 * scale;
  const dayExpected = 412 * scale;
  const dayGroups = ranked(DAY_PHI, options, "day");
  const peakGroups = ranked(PEAK_PHI, options, "peak_hour");
  const sumAbs = dayGroups.reduce(
    (total, group) => total + Math.abs(group.phi_mwh as number),
    0,
  );
  const built: Record<string, unknown> = {
    lane: "dessem_free_v1__gate_late__thr5",
    feature_set: "dessem_free_v1",
    threshold_mw: 5,
    target_date: TARGET_DATE,
    correction_regime: REGIME,
    forecast_origin: {
      producer: "wattsteer",
      run_label: options.artifactId ?? ARTIFACT,
      published_at:
        options.publishedAt ??
        (options.gateProfile === "gate_early" ? GATE_EARLY : GATE_LATE),
      origin_kind: options.originKind ?? "served",
      gate_profile: options.gateProfile ?? "gate_late",
    },
    subsystems: [options.subsystem ?? "NE"],
    attributions: [
      {
        subsystem: options.subsystem ?? "NE",
        target_date: TARGET_DATE,
        target: "expected_mwh_day",
        hours_attributed: 24,
        baseline_expected_mwh: baseline,
        day_expected_mwh: dayExpected,
        total_attributed_mwh: dayExpected - baseline,
        sum_abs_attributed_mwh: sumAbs,
        local_accuracy_residual_mwh: 0,
        top_two_share: (dayGroups[0]?.share as number) + (dayGroups[1]?.share as number),
        stderr_mwh: 4.1 * scale,
        baseline_stderr_mwh: 2.75 * scale,
        stderr_resamples: 200,
        stderr_seed: 4,
        peak_hour_local: 13,
        peak_hour_expected_mwh: 30.5 * scale,
        peak_hour_baseline_expected_mwh: 4 * scale,
        driver_group_version: GROUP_VERSION,
        driver_group_hash: options.driverGroupHash ?? GROUP_HASH,
        background_source: options.backgroundSource ?? BACKGROUND_SOURCE,
        background_seed: options.backgroundSeed ?? 20_260_828,
        background_rows: 128,
        coalitions: 256,
        rule_flags: options.ruleFlags ?? [],
        // The roll call defaults to the four shipping rules, not to `[]`, and
        // the difference is the point: `[]` is the payload of a publish path
        // that never ran the rules, which the writer refuses. Every test that
        // passes no `ruleFlags` is asserting "the rules ran and were quiet",
        // which is a different document from "nobody asked them".
        rules_evaluated: options.rulesEvaluated ?? [...EVALUABLE_RULE_CODES],
        groups: dayGroups,
        peak_hour_groups: peakGroups,
      },
    ],
  };
  options.mutate?.(built);
  return built;
}

/** The attribution block of a payload, so a mutation reads without assertions. */
export const attributionOf = (
  payload: Record<string, unknown>,
): Record<string, unknown> =>
  (payload.attributions as Record<string, unknown>[])[0] as Record<string, unknown>;

/** The rows of a payload array, likewise. */
export const rowsOf = (value: unknown): Record<string, unknown>[] =>
  value as Record<string, unknown>[];

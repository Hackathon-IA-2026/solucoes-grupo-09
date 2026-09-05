import type {
  AttributionDriverRow,
  PublishedAttributionRow,
} from "../../src/diagnosis/reads.js";
import type { ForecastDayRow, PublishedForecast } from "../../src/forecast/reads.js";

/**
 * The two stored rows `/v1/diagnosis/day-ahead` composes, as they are read back.
 *
 * Shared rather than rebuilt per suite for the reason `./narration-payload.ts`
 * is shared: the route test and the narration tests have to be arguing about
 * the same day, or the route's composition would be proved against a document
 * the renderer never sees. The numbers are the spec's worked example — 412 MWh
 * against a typical 96, a movement of 316 divided between eight groups whose
 * `|Φ|` sum to 444 — and they are the same numbers the renderer suite's clean
 * paragraphs quote, which is what lets a route test send a paragraph through
 * the real validator.
 */

export const SUBSYSTEM = "NE" as const;
export const TARGET_DATE = "2026-08-28";
export const ARTIFACT = "dessem_free_v1__gate_late__thr5/2026-08-27T22:11:07Z";
export const PUBLISHED_AT = new Date("2026-08-27T22:11:07.000Z");

/** `Σ|Φ_j|` — the shares' denominator, over all eight groups. */
export const SUM_ABS = 444;

/**
 * `Φ_j` for the day, in MWh: `160 + 96 + 64 + 48 − 32 − 24 + 12 − 8 = 316`.
 *
 * The last two are deliberately under the client's `share ≥ 0.03` cut
 * (`12/444 ≈ 0.027`, `8/444 ≈ 0.018`), so a route that applied the display rule
 * server-side would return six rows and fail the ranking test rather than pass
 * it by luck.
 */
const PHI: readonly [string, string, number][] = [
  ["renewable_resource", "proxy_renewable_load_ratio", 160],
  ["net_surplus", "proxy_residual_load_mwh", 96],
  ["export_stress", "dessem_export_utilisation", 64],
  ["demand_level", "programmed_load_mwh", 48],
  ["ramp_shape", "proxy_residual_load_ramp_1h", -32],
  ["calendar_season", "calendar_day_of_week", -24],
  ["recent_history", "observed_constrained_off_mwh_lag_24h", 12],
  ["data_conditions", "weather_run_age_hours", -8],
];

/** The eight groups, ranked by `|share|`, as the publication wrote them. */
export function driverRows(): AttributionDriverRow[] {
  return PHI.map(([code, feature, phi], index) => ({
    code,
    labelCode: `driver.${code}`,
    rank: index + 1,
    phiMwh: phi,
    share: Math.abs(phi) / SUM_ABS,
    direction: phi >= 0 ? ("raises" as const) : ("lowers" as const),
    hourDisagreement: 1 + index / 10,
    headlineFeature: feature,
    observed: 1.42,
    typical: 0.96,
    unit: "ratio",
    demoted: false,
  }));
}

export function attributionRow(
  overrides: Partial<PublishedAttributionRow> = {},
): PublishedAttributionRow {
  const day = driverRows();
  return {
    subsystem: SUBSYSTEM,
    targetDate: TARGET_DATE,
    gateProfile: "gate_late",
    thresholdMw: 5,
    artifactId: ARTIFACT,
    featureSet: "dessem_free_v1",
    correctionRegime: "conformal_v1_partial_upper",
    publishedAt: PUBLISHED_AT,
    ingestedAt: PUBLISHED_AT,
    dataVersion: 1,
    target: "expected_mwh_day",
    explains: "diagnosis.explains_expectation_not_band",
    hoursAttributed: 24,
    baselineExpectedMwh: 96,
    dayExpectedMwh: 412,
    totalAttributedMwh: 316,
    sumAbsAttributedMwh: SUM_ABS,
    localAccuracyResidualMwh: 0,
    topTwoShare: (160 + 96) / SUM_ABS,
    attributionStderrMwh: 4.1,
    baselineStderrMwh: 3.2,
    stderrResamples: 200,
    stderrSeed: 7,
    peakHourLocal: 13,
    peakHourExpectedMwh: 41,
    peakHourBaselineExpectedMwh: 9,
    driverGroupVersion: "3",
    driverGroupHash: `sha256:${"0".repeat(64)}`,
    backgroundSource: "base_fit",
    backgroundSeed: 11,
    backgroundRows: 128,
    coalitions: 256,
    ruleFlags: [],
    governingRuleAction: null,
    drivers: day,
    // The peak hour's own eight. `hour_disagreement` is `null` there by
    // construction: one hour has nothing to disagree with.
    peakHourDrivers: day.map((driver) => ({ ...driver, hourDisagreement: null })),
    vintageFidelity: "point_in_time",
    ...overrides,
  };
}

export function forecastDayRow(overrides: Partial<ForecastDayRow> = {}): ForecastDayRow {
  return {
    subsystem: SUBSYSTEM,
    targetDate: TARGET_DATE,
    gateProfile: "gate_late",
    thresholdMw: 5,
    artifactId: ARTIFACT,
    featureSet: "dessem_free_v1",
    trainedThrough: "2026-06-30",
    correctionRegime: "conformal_v1_partial_upper",
    publishedAt: PUBLISHED_AT,
    ingestedAt: PUBLISHED_AT,
    dataVersion: 1,
    dayTotalMwh: { p10: 0, p50: 370, p90: 980 },
    peakPowerMw: { p10: 0, p50: 118, p90: 260 },
    dayOccurrenceProbability: 0.87,
    dayExpectedMwh: 412,
    split: { windMwh: 300, solarMwh: 112 },
    hoursP50Nonzero: 9,
    derivation: "path_ensemble",
    riskBinElevatedFrom: 0.35,
    riskBinHighFrom: 0.7,
    ...overrides,
  };
}

/** The published forecast as the route reads it: the day row is all it uses. */
export function publishedForecast(
  overrides: Partial<ForecastDayRow> = {},
): PublishedForecast {
  return {
    day: forecastDayRow(overrides),
    hours: [],
    vintageFidelity: "point_in_time",
  };
}

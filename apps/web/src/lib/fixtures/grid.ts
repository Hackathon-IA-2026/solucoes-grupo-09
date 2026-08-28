/**
 * Grid Overview fixtures: four subsystems, day-ahead, P10/P50/P90 per hour.
 *
 * The numbers are invented but the *shapes* are not: NE wind curtails
 * overnight into the early morning, solar curtails around solar noon, and the
 * band widens where the magnitude is largest and where the hurdle model is
 * least sure the hour clears the threshold at all.
 */

import type {
  Band,
  CurtailmentHourForecast,
  ForecastOrigin,
  RiskClass,
  SubsystemCode,
  SubsystemDayForecast,
  SubsystemMeta,
  Technology,
} from "./types";

/** `Subsystem` — four members, ONS display names untranslated. */
export const SUBSYSTEMS: SubsystemMeta[] = [
  { code: "N", onsDisplayName: "NORTE", short: "N" },
  { code: "NE", onsDisplayName: "NORDESTE", short: "NE" },
  { code: "SE", onsDisplayName: "SUDESTE/CENTRO-OESTE", short: "SE/CO" },
  { code: "S", onsDisplayName: "SUL", short: "S" },
];

export const SUBSYSTEM_CODES: SubsystemCode[] = ["N", "NE", "SE", "S"];

export function subsystemMeta(code: SubsystemCode): SubsystemMeta {
  return SUBSYSTEMS.find((s) => s.code === code) ?? SUBSYSTEMS[0];
}

/** The day the whole prototype is pointed at. */
export const TARGET_DATE = "2026-08-29";

/** `curtailment_threshold_mw` at subsystem grain. Stamped on every output. */
export const SUBSYSTEM_THRESHOLD_MW = 5;

export type RunLabel = "00Z" | "12Z";

export const RUN_LABELS: RunLabel[] = ["00Z", "12Z"];

/**
 * Both D−1 runs are served, and 12Z supersedes 00Z — a newer vintage of the
 * same valid hours, not a special case. Every screen names the one on show.
 */
export const FORECAST_ORIGINS: Record<RunLabel, ForecastOrigin> = {
  "00Z": {
    producer: "wattsteer",
    runLabel: "hurdle-v0.4 · weather 00Z",
    publishedAt: "2026-08-28T01:40:00Z",
  },
  "12Z": {
    producer: "wattsteer",
    runLabel: "hurdle-v0.4 · weather 12Z",
    publishedAt: "2026-08-28T13:35:00Z",
  },
};

interface ProfileSpec {
  /** Hour of the daily maximum, `America/Sao_Paulo`. */
  peakHour: number;
  /** Half-width of the bump, in hours. */
  width: number;
  /** P50 magnitude at the peak hour, MW. */
  peakMw: number;
  /** A secondary bump, where the day has two regimes. */
  secondary?: { peakHour: number; width: number; peakMw: number };
  /** P(the day contains at least one hour above threshold). */
  occurrence: number;
  /** Relative half-width of the band at the peak (0.3 = ±30% of P50). */
  spread: number;
}

const PROFILES: Record<SubsystemCode, Record<Technology, ProfileSpec>> = {
  N: {
    WIND: { peakHour: 4, width: 3.4, peakMw: 63, occurrence: 0.34, spread: 0.55 },
    SOLAR: { peakHour: 12, width: 2.2, peakMw: 41, occurrence: 0.22, spread: 0.62 },
  },
  NE: {
    WIND: {
      peakHour: 3,
      width: 3.8,
      peakMw: 640,
      secondary: { peakHour: 13, width: 2.4, peakMw: 210 },
      occurrence: 0.89,
      spread: 0.3,
    },
    SOLAR: {
      peakHour: 12,
      width: 2.6,
      peakMw: 470,
      occurrence: 0.81,
      spread: 0.34,
    },
  },
  SE: {
    WIND: { peakHour: 2, width: 3, peakMw: 38, occurrence: 0.12, spread: 0.7 },
    SOLAR: {
      peakHour: 12,
      width: 2.8,
      peakMw: 295,
      occurrence: 0.47,
      spread: 0.45,
    },
  },
  S: {
    WIND: { peakHour: 5, width: 3.6, peakMw: 96, occurrence: 0.18, spread: 0.6 },
    SOLAR: { peakHour: 13, width: 2.2, peakMw: 52, occurrence: 0.09, spread: 0.75 },
  },
};

/** Circular distance in hours — a 03:00 peak has to reach 23:00. */
function hourDistance(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, 24 - raw);
}

function bump(hour: number, peakHour: number, width: number): number {
  const d = hourDistance(hour, peakHour);
  return Math.exp(-0.5 * (d / width) ** 2);
}

/** Deterministic jitter so the profile is not a textbook Gaussian. */
function wobble(seed: number, hour: number): number {
  const x = Math.sin(seed * 12.9898 + hour * 78.233) * 43_758.5453;
  return x - Math.floor(x);
}

function seedFor(
  subsystem: SubsystemCode,
  technology: Technology,
  run: RunLabel,
): number {
  const s = SUBSYSTEM_CODES.indexOf(subsystem) + 1;
  const t = technology === "WIND" ? 3 : 7;
  const r = run === "00Z" ? 1 : 2;
  return s * 17 + t * 5 + r;
}

/**
 * `valid_time` for a Brasília civil hour. UTC−3, no DST since 2019 — the
 * adapters own this conversion in the real system; the fixture just does it.
 */
function validTimeFor(date: string, hourLocal: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d, hourLocal + 3, 0, 0);
  return new Date(utc).toISOString();
}

export function buildForecast(
  subsystem: SubsystemCode,
  technology: Technology,
  run: RunLabel,
): SubsystemDayForecast {
  const spec = PROFILES[subsystem][technology];
  const seed = seedFor(subsystem, technology, run);
  // The 12Z run is measurably the better one; the band narrows accordingly.
  const spreadScale = run === "12Z" ? 0.82 : 1;

  const hours: CurtailmentHourForecast[] = [];
  for (let hourLocal = 0; hourLocal < 24; hourLocal++) {
    const shape =
      bump(hourLocal, spec.peakHour, spec.width) +
      (spec.secondary
        ? (spec.secondary.peakMw / spec.peakMw) *
          bump(hourLocal, spec.secondary.peakHour, spec.secondary.width)
        : 0);
    const noise = 0.85 + 0.3 * wobble(seed, hourLocal);
    const p50 = Math.round(spec.peakMw * shape * noise * spec.occurrence * 10) / 10;

    // The band is widest where the magnitude is largest in absolute terms and
    // relatively widest where the hurdle is least confident.
    const hourOccurrence = Math.min(0.97, spec.occurrence * (0.35 + 0.75 * shape));
    const rel = spec.spread * spreadScale * (1 + 0.9 * (1 - hourOccurrence));
    // Below an even chance of clearing the threshold the honest P10 is zero.
    const p10 =
      hourOccurrence < 0.5 ? 0 : Math.max(0, Math.round(p50 * (1 - rel) * 10) / 10);
    const p90 = Math.round(p50 * (1 + rel * 1.35) * 10) / 10;

    hours.push({
      validTime: validTimeFor(TARGET_DATE, hourLocal),
      hourLocal,
      constrainedOff: { p10, p50, p90 },
      occurrenceProbability: Math.round(hourOccurrence * 100) / 100,
    });
  }

  // A day total is a *joint* forecast, not a sum of hourly quantiles: the P90
  // of a sum is not the sum of the P90s. The fixture therefore widens the P50
  // sum by a sub-additive factor rather than adding the hourly bounds, and
  // nothing in the UI ever adds two bands together.
  const sumP50 = hours.reduce((acc, h) => acc + h.constrainedOff.p50, 0);
  const sumP10 = hours.reduce((acc, h) => acc + h.constrainedOff.p10, 0);
  const sumP90 = hours.reduce((acc, h) => acc + h.constrainedOff.p90, 0);
  const dailyEnergy: Band = {
    p10: Math.round(sumP50 - (sumP50 - sumP10) * 0.62),
    p50: Math.round(sumP50),
    p90: Math.round(sumP50 + (sumP90 - sumP50) * 0.62),
  };

  const peaks = hours.map((h) => h.constrainedOff);
  const peakP50 = Math.max(...peaks.map((b) => b.p50));
  const peakHour = peaks.find((b) => b.p50 === peakP50) ?? peaks[0];

  return {
    subsystem,
    technology,
    targetDate: TARGET_DATE,
    forecastOrigin: FORECAST_ORIGINS[run],
    thresholdMw: SUBSYSTEM_THRESHOLD_MW,
    occurrenceProbability: spec.occurrence,
    dailyEnergy,
    peakPower: {
      p10: Math.round(peakHour.p10),
      p50: Math.round(peakHour.p50),
      p90: Math.round(peakHour.p90),
    },
    hours,
  };
}

export function buildAllForecasts(
  technology: Technology,
  run: RunLabel,
): SubsystemDayForecast[] {
  return SUBSYSTEM_CODES.map((code) => buildForecast(code, technology, run));
}

/**
 * Risk classification.
 *
 * The bin edges are wide and few on purpose — see the long note in
 * `components/charts/risk-class.tsx`. They live here rather than in the
 * component because they are a model-facing decision (they are what a
 * calibration curve would be checked against), not a styling one.
 */
export const RISK_BINS: { klass: RiskClass; from: number; to: number; label: string }[] =
  [
    { klass: "low", from: 0, to: 0.25, label: "Low" },
    { klass: "elevated", from: 0.25, to: 0.6, label: "Elevated" },
    { klass: "high", from: 0.6, to: 1, label: "High" },
  ];

export function riskClass(probability: number): RiskClass {
  const bin = RISK_BINS.find((b) => probability >= b.from && probability < b.to);
  return bin?.klass ?? "high";
}

/**
 * Probabilities are shown rounded to the nearest 5 points. The model does not
 * distinguish 31% from 33%, and printing "31%" claims that it does.
 */
export function roundProbability(probability: number): number {
  return Math.round((probability * 100) / 5) * 5;
}

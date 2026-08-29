/**
 * Grid Overview fixtures: four subsystems, day-ahead, P10/P50/P90 per hour.
 *
 * The numbers are invented but the *shapes* are not: NE wind curtails
 * overnight into the early morning, solar curtails around solar noon, and the
 * band widens where the magnitude is largest and where the hurdle model is
 * least sure the hour clears the threshold at all.
 *
 * **One forecast per subsystem-day.** The two fleets are shapes that add into
 * one subsystem distribution; they never get a band of their own, because the
 * forecaster has no per-technology head to give them one.
 */

import { SUBSYSTEM_CODES, SUBSYSTEM_THRESHOLD_MW } from "@wattsteer/core";
import type {
  Band,
  CurtailmentHourForecast,
  ForecastOrigin,
  RiskClass,
  SubsystemCode,
  SubsystemDayForecast,
} from "./types";

/**
 * The subsystem enum, its ONS display names and the subsystem-grain threshold
 * are **published constants**, not fixtures: the gateway stamps the same
 * threshold on every response and `/v1/meta` echoes the same four names. They
 * are re-exported here so the screens' existing imports keep working, and they
 * are defined in `@wattsteer/core` so a fixture cannot drift from the API.
 */
export {
  SUBSYSTEM_CODES,
  SUBSYSTEM_THRESHOLD_MW,
  SUBSYSTEMS,
  subsystemMeta,
} from "@wattsteer/core";

/** The day the whole prototype is pointed at. */
export const TARGET_DATE = "2026-08-29";

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

/**
 * The shape of one fleet's day, in MW at its peak hour. A *shape*, not a
 * forecast: the two fleets contribute to one subsystem distribution and are
 * never given a band.
 */
interface FleetShape {
  /** Hour of the daily maximum, `America/Sao_Paulo`. */
  peakHour: number;
  /** Half-width of the bump, in hours. */
  width: number;
  /** Magnitude at the peak hour, MW, conditional on the hour curtailing. */
  peakMw: number;
  /** A secondary bump, where the fleet has two regimes. */
  secondary?: { peakHour: number; width: number; peakMw: number };
}

/**
 * One profile per **subsystem** — which is the grain the forecaster works at.
 *
 * This used to be `Record<SubsystemCode, Record<Technology, ProfileSpec>>`, and
 * `buildForecast` took a `Technology` and built a whole band out of one cell of
 * it. That is the model `docs/specs/api-surface.md` contract change 5 says does
 * not exist: no per-technology head, therefore no per-technology band, and a
 * fixture that produces one teaches every screen downstream that it may draw
 * one.
 *
 * The two fleets survive as `wind` and `solar` *shapes*. They are combined at
 * the level where addition is exact — magnitudes, and then expectations — and
 * the band is built once, from the subsystem's combined profile.
 */
interface SubsystemProfile {
  wind: FleetShape;
  solar: FleetShape;
  /** P(the day curtails at all), before the path ensemble refines it. */
  occurrence: number;
  /** Relative half-width of the conditional band at the peak. */
  spread: number;
}

const PROFILES: Record<SubsystemCode, SubsystemProfile> = {
  N: {
    wind: { peakHour: 4, width: 3.4, peakMw: 63 },
    solar: { peakHour: 12, width: 2.2, peakMw: 41 },
    occurrence: 0.38,
    spread: 0.55,
  },
  NE: {
    wind: {
      peakHour: 3,
      width: 3.8,
      peakMw: 640,
      secondary: { peakHour: 13, width: 2.4, peakMw: 210 },
    },
    solar: { peakHour: 12, width: 2.6, peakMw: 470 },
    occurrence: 0.92,
    spread: 0.3,
  },
  SE: {
    wind: { peakHour: 2, width: 3, peakMw: 38 },
    solar: { peakHour: 12, width: 2.8, peakMw: 295 },
    occurrence: 0.52,
    spread: 0.45,
  },
  S: {
    wind: { peakHour: 5, width: 3.6, peakMw: 96 },
    solar: { peakHour: 13, width: 2.2, peakMw: 52 },
    occurrence: 0.12,
    spread: 0.6,
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

/** One fleet's conditional magnitude at one hour, MWh. */
function fleetMagnitude(shape: FleetShape, hourLocal: number, noise: number): number {
  const primary = bump(hourLocal, shape.peakHour, shape.width);
  const secondary =
    shape.secondary === undefined
      ? 0
      : (shape.secondary.peakMw / shape.peakMw) *
        bump(hourLocal, shape.secondary.peakHour, shape.secondary.width);
  return shape.peakMw * (primary + secondary) * noise;
}

function seedFor(subsystem: SubsystemCode, run: RunLabel): number {
  const s = SUBSYSTEM_CODES.indexOf(subsystem) + 1;
  const r = run === "00Z" ? 1 : 2;
  return s * 17 + r;
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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * One hour's marginal law, before it is quantised into a band.
 *
 * A hurdle: mass `1 − occurrence` at exactly zero, and a magnitude
 * distribution above it summarised by three conditional points. Keeping it as
 * an inverse-CDF rather than as three finished numbers is what lets the day
 * figures be *drawn* rather than summed.
 */
interface HourLaw {
  occurrence: number;
  conditional: { low: number; median: number; high: number };
  windMagnitude: number;
  solarMagnitude: number;
}

/**
 * The hour's value at PIT level `u ∈ [0, 1]`.
 *
 * Below `1 − occurrence` the hour did not clear the threshold and the value is
 * zero — which is why the P10 of a shoulder hour is flatly 0 rather than "a
 * small number", and why the hour's expectation sits above its median whenever
 * occurrence is under an even chance.
 */
function hourAt(law: HourLaw, u: number): number {
  if (u <= 1 - law.occurrence) {
    return 0;
  }
  const c = (u - (1 - law.occurrence)) / law.occurrence;
  const { low, median, high } = law.conditional;
  if (c <= 0.1) {
    return round1((low * c) / 0.1);
  }
  if (c <= 0.5) {
    return round1(low + ((median - low) * (c - 0.1)) / 0.4);
  }
  if (c <= 0.9) {
    return round1(median + ((high - median) * (c - 0.5)) / 0.4);
  }
  // Deliberately flat above the 90th conditional percentile rather than
  // extrapolated: a draw that could exceed every hour's own P90 would push the
  // day P90 *above* the componentwise sum, which is the opposite of the
  // sub-additivity imperfect dependence actually implies.
  return round1(high);
}

/** `E[Y]` for the hour, integrated over the same inverse-CDF the band reads. */
function hourExpectation(law: HourLaw): number {
  const STEPS = 200;
  let total = 0;
  for (let i = 0; i < STEPS; i++) {
    total += hourAt(law, (i + 0.5) / STEPS);
  }
  return total / STEPS;
}

/**
 * How many day paths the fixture draws. Enough that the 10th and 90th
 * percentiles are stable, small enough that four subsystems cost nothing.
 */
const ENSEMBLE_DRAWS = 400;

/** P10 / P50 / P90 of a sample, by nearest-rank over the sorted draws. */
function quantiles(sample: number[]): Band {
  const sorted = [...sample].sort((a, b) => a - b);
  const at = (q: number) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}

/**
 * The day-grain figures, **drawn rather than summed**.
 *
 * `docs/specs/forecaster.md` draws whole rows of the PIT matrix so that
 * intra-day dependence survives; the fixture does the same in miniature. Each
 * draw takes one common level `z` — the day's overall luck — perturbs it per
 * hour, reads every hour's inverse-CDF at its own level and totals the
 * values. Quantiles are then taken over the 400 day totals, and the day
 * occurrence probability is the fraction of drawn days that cleared the
 * threshold at some hour.
 *
 * This is not decoration. Summing the hourly P90s would assume all 24 hours
 * land at their 90th percentile together; summing the P50s would assume
 * medians add, which they also do not. `apps/web/test/fixtures.test.ts`
 * asserts the day band is neither.
 */
function drawDayEnsemble(
  laws: HourLaw[],
  seed: number,
  thresholdMw: number,
): { dayEnergy: Band; peakPower: Band; occurrence: number } {
  const totals: number[] = [];
  const peaks: number[] = [];
  let cleared = 0;
  for (let k = 0; k < ENSEMBLE_DRAWS; k++) {
    const z = (k + 0.5) / ENSEMBLE_DRAWS;
    let total = 0;
    let peak = 0;
    for (let t = 0; t < laws.length; t++) {
      const jitter = (wobble(seed + k * 3.7, t) - 0.5) * 0.3;
      const u = Math.min(0.9999, Math.max(0.0001, z + jitter));
      const value = hourAt(laws[t], u);
      total += value;
      peak = Math.max(peak, value);
    }
    totals.push(total);
    peaks.push(peak);
    if (peak >= thresholdMw) {
      cleared++;
    }
  }
  return {
    dayEnergy: quantiles(totals),
    peakPower: quantiles(peaks),
    // Capped, as the hourly hurdle is: a fixture that reported 1.00 would be
    // claiming a certainty no forecast has, and the screen prints it.
    occurrence: Math.min(0.97, Math.round((cleared / ENSEMBLE_DRAWS) * 100) / 100),
  };
}

/**
 * The day-ahead forecast for one subsystem. **No technology argument**: the
 * forecast grain is the subsystem, and the fleets appear only as the scalar
 * `split` on the day and on each hour.
 */
export function buildForecast(
  subsystem: SubsystemCode,
  run: RunLabel,
): SubsystemDayForecast {
  const profile = PROFILES[subsystem];
  const seed = seedFor(subsystem, run);
  // The 12Z run is measurably the better one; the band narrows accordingly.
  const spreadScale = run === "12Z" ? 0.82 : 1;

  // Pass one: the conditional magnitudes, per fleet. Magnitudes add exactly —
  // they are quantities, not quantiles — which is what makes a split honest.
  const magnitudes = Array.from({ length: 24 }, (_, hourLocal) => {
    const wind = fleetMagnitude(
      profile.wind,
      hourLocal,
      0.85 + 0.3 * wobble(seed + 3, hourLocal),
    );
    const solar = fleetMagnitude(
      profile.solar,
      hourLocal,
      0.85 + 0.3 * wobble(seed + 7, hourLocal),
    );
    return { wind, solar, total: wind + solar };
  });
  const peakMagnitude = Math.max(...magnitudes.map((m) => m.total), 1e-9);

  // Pass two: one hurdle law per hour, at subsystem grain.
  const laws: HourLaw[] = magnitudes.map((m) => {
    const shape = m.total / peakMagnitude;
    const occurrence = Math.min(0.97, profile.occurrence * (0.35 + 0.75 * shape));
    // Relatively widest where the hurdle is least confident.
    const rel = profile.spread * spreadScale * (1 + 0.9 * (1 - occurrence));
    // The conditional median sits below the conditional mean: a magnitude
    // distribution with a long right tail, which is what curtailment is.
    const median = m.total * 0.92;
    return {
      occurrence,
      conditional: {
        low: Math.max(0, median * (1 - rel)),
        median,
        high: median * (1 + rel * 1.35),
      },
      windMagnitude: m.wind,
      solarMagnitude: m.solar,
    };
  });

  const hours: CurtailmentHourForecast[] = laws.map((law, hourLocal) => {
    const expected = hourExpectation(law);
    // The split divides the *expectation*, in the proportion the two fleets
    // contribute to the magnitude: two scalars that sum to `expectedMwh`.
    const magnitude = law.windMagnitude + law.solarMagnitude;
    const windShare = magnitude === 0 ? 0.5 : law.windMagnitude / magnitude;
    const windMwh = round1(expected * windShare);
    const solarMwh = round1(expected - windMwh);
    return {
      validTime: validTimeFor(TARGET_DATE, hourLocal),
      hourLocal,
      constrainedOff: {
        p10: hourAt(law, 0.1),
        p50: hourAt(law, 0.5),
        p90: hourAt(law, 0.9),
      },
      // Read off the two scalars rather than beside them, so the sibling and
      // the split cannot round apart.
      expectedMwh: round1(windMwh + solarMwh),
      occurrenceProbability: Math.round(law.occurrence * 100) / 100,
      split: { windMwh, solarMwh },
    };
  });

  const drawn = drawDayEnsemble(laws, seed, SUBSYSTEM_THRESHOLD_MW);

  // Expectations add — exactly, and across grains. This is the one reduction
  // from the hours the day figures are allowed, and it is allowed precisely
  // because it is not a quantile.
  const windMwh = Math.round(hours.reduce((acc, h) => acc + h.split.windMwh, 0));
  const solarMwh = Math.round(hours.reduce((acc, h) => acc + h.split.solarMwh, 0));

  return {
    subsystem,
    targetDate: TARGET_DATE,
    forecastOrigin: FORECAST_ORIGINS[run],
    thresholdMw: SUBSYSTEM_THRESHOLD_MW,
    occurrenceProbability: drawn.occurrence,
    dailyEnergy: drawn.dayEnergy,
    peakPower: drawn.peakPower,
    dayExpectedMwh: windMwh + solarMwh,
    split: { windMwh, solarMwh },
    hours,
  };
}

export function buildAllForecasts(run: RunLabel): SubsystemDayForecast[] {
  return SUBSYSTEM_CODES.map((code) => buildForecast(code, run));
}

/**
 * Risk classification.
 *
 * The bin edges are wide and few on purpose — see the long note in
 * `components/charts/risk-class.tsx`. They live here rather than in the
 * component because they are a model-facing decision (they are what a
 * calibration curve would be checked against), not a styling one.
 *
 * The edges live here; the *names* do not. "Low" and "Baixo" are the same bin,
 * so the class is the key and the word comes from the dictionaries.
 */
export const RISK_BINS: { klass: RiskClass; from: number; to: number }[] = [
  { klass: "low", from: 0, to: 0.25 },
  { klass: "elevated", from: 0.25, to: 0.6 },
  { klass: "high", from: 0.6, to: 1 },
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

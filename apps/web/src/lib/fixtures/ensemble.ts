/**
 * How a day figure comes to exist — drawn, never summed.
 *
 * This module is small and it is shared on purpose. Two fixtures publish
 * day-grain bands: `grid.ts` for the day-ahead outlook and `replay.ts` for a
 * replayed day's `forecast.day_total`. Both used to reach that band their own
 * way, and one of the two ways was wrong: `replay.ts` summed the 24 hourly
 * quantiles and then shrank the interval by a hand-picked factor, which is a
 * sum with an apology attached rather than a joint distribution.
 *
 * Quantiles do not add. Summing 24 P90s describes a day on which every hour
 * lands at its own 90th percentile at once, which is a far worse day than a
 * 90th-percentile day; and the median of a sum is the sum of the medians only
 * when the components are comonotone. `docs/specs/forecaster.md` therefore
 * draws whole rows of the PIT matrix, so intra-day dependence survives into
 * the day total. This module is that idea in miniature, and it lives here so
 * that the two fixtures cannot disagree about what a day band *is*.
 *
 * `test/no-summed-bands.test.ts` is the standing guard on the other half of
 * the rule: nothing under `apps/web/src` may add two quantiles together.
 */

import type { Band } from "@wattsteer/core";

/** Deterministic jitter, so a profile is not a textbook Gaussian. */
export function wobble(seed: number, hour: number): number {
  const x = Math.sin(seed * 12.9898 + hour * 78.233) * 43_758.5453;
  return x - Math.floor(x);
}

export function round1(value: number): number {
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
export interface HourLaw {
  occurrence: number;
  conditional: { low: number; median: number; high: number };
}

/**
 * The hour's value at PIT level `u ∈ [0, 1]`.
 *
 * Below `1 − occurrence` the hour did not clear the threshold and the value is
 * zero — which is why the P10 of a shoulder hour is flatly 0 rather than "a
 * small number", and why the hour's expectation sits above its median whenever
 * occurrence is under an even chance.
 */
export function hourAt(law: HourLaw, u: number): number {
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
export function hourExpectation(law: HourLaw): number {
  const STEPS = 200;
  let total = 0;
  for (let i = 0; i < STEPS; i++) {
    total += hourAt(law, (i + 0.5) / STEPS);
  }
  return total / STEPS;
}

/** The hour's band, read off the law at the three published levels. */
export function hourBand(law: HourLaw): Band {
  return { p10: hourAt(law, 0.1), p50: hourAt(law, 0.5), p90: hourAt(law, 0.9) };
}

/**
 * How many day paths a fixture draws. Enough that the 10th and 90th
 * percentiles are stable, small enough that four subsystems cost nothing.
 */
export const ENSEMBLE_DRAWS = 400;

/** P10 / P50 / P90 of a sample, by nearest-rank over the sorted draws. */
export function quantiles(sample: number[]): Band {
  const sorted = [...sample].sort((a, b) => a - b);
  const at = (q: number) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}

/**
 * The day-grain figures, **drawn rather than summed**.
 *
 * Each draw takes one common level `z` — the day's overall luck — perturbs it
 * per hour, reads every hour's inverse-CDF at its own level and totals the
 * values. The values add; the quantiles that summarise them do not. Quantiles
 * are then taken over the 400 day totals, and the day occurrence probability
 * is the fraction of drawn days that cleared the threshold at some hour.
 */
export function drawDayEnsemble(
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

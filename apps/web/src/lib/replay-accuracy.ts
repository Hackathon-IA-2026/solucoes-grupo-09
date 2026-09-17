/**
 * Where a settled day fell against the band that forecast it.
 *
 * Its own module, with no view in it, for two reasons that turned out to be
 * one: the unit runner cannot import a `.tsx` without pulling react-native in,
 * and this is arithmetic about a contract rather than anything about a screen.
 * `test/replay-accuracy.test.ts` exercises it directly.
 */

import type { Band } from "@wattsteer/core/api";

/** Which side of the band a settlement fell on. */
export type BandPlacement = "inside" | "above" | "below";

/**
 * **Closed interval, both edges inside.**
 *
 * A day that settles exactly at P90 is covered by the band, and rounding that
 * to "above" would understate coverage by whatever fraction of days lands on
 * an edge. The comparisons are strict on purpose.
 */
export function placementOf(band: Band, settled: number): BandPlacement {
  if (settled > band.p90) {
    return "above";
  }
  if (settled < band.p10) {
    return "below";
  }
  return "inside";
}

/**
 * Settled minus the median, **signed**.
 *
 * The sign is the interesting half. A product that under-forecasts curtailment
 * costs a generator the chance to act; one that over-forecasts costs them a
 * plan they did not need. An absolute error hides which of the two happened,
 * and they are not the same mistake.
 */
export function forecastError(band: Band, settled: number): number {
  return settled - band.p50;
}

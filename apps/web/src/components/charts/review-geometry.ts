/**
 * Where the Time Machine dashboard's hourly chart puts its marks.
 *
 * The fan chart's frame and scale, reused rather than re-derived —
 * `fanGeometry` already decides the y-axis from the settled peak, the P90s and
 * twice the threshold, and a second scale rule on the same screen would let
 * two charts of one day disagree about how tall an hour is. What this adds is
 * the three marks the dashboard draws and the fan chart does not:
 *
 * - **P10 and P90 as their own lines**, beside the filled band, so each edge
 *   can be read off the axis rather than guessed from where a gradient fades;
 * - **the settled day as bars**, because a settled hour is one measured number
 *   per slot and a bar is the honest mark for exactly that — the forecast stays
 *   a band and a line, so the two vocabularies do not share a mark;
 * - **the likely window as a shaded span**, decided by `criticalWindow` from
 *   the hours' occurrence probabilities and never from the band.
 *
 * No arithmetic between quantiles happens here. Every y is one value of one
 * hour through the shared scale.
 */

import type { CurtailmentHourForecast, CurtailmentHourObservation } from "@/lib/fixtures";
import { CHART_H, fanGeometry, PAD } from "./fan-geometry";

export interface ReviewBar {
  readonly hourLocal: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ReviewGeometry {
  readonly max: number;
  readonly slot: number;
  readonly x: (index: number) => number;
  readonly y: (value: number) => number;
  readonly bandPath: string;
  readonly medianPath: string;
  readonly p10Path: string;
  readonly p90Path: string;
  /** One per settled hour. Empty when nothing settled — an absence, not zeros. */
  readonly bars: readonly ReviewBar[];
  /** `null` when no hour reached an even chance of curtailment. */
  readonly window: { readonly x: number; readonly width: number } | null;
}

/** The fraction of an hour's slot a settled bar occupies. */
const BAR_FILL = 0.56;

function line(
  hours: readonly CurtailmentHourForecast[],
  x: (index: number) => number,
  y: (value: number) => number,
  pick: (hour: CurtailmentHourForecast) => number,
): string {
  return `M${hours.map((hour, i) => `${x(i).toFixed(1)},${y(pick(hour)).toFixed(1)}`).join(" L")}`;
}

export function reviewGeometry(
  hours: readonly CurtailmentHourForecast[],
  settled: readonly CurtailmentHourObservation[] | undefined,
  thresholdMw: number,
  window: { readonly fromHour: number; readonly toHour: number } | null,
): ReviewGeometry {
  const base = fanGeometry(hours, settled, thresholdMw);
  const { slot, x, y } = base;
  const floor = PAD.top + CHART_H;
  const width = slot * BAR_FILL;
  return {
    max: base.max,
    slot,
    x,
    y,
    bandPath: base.bandPath,
    medianPath: base.medianPath,
    p10Path: line(hours, x, y, (hour) => hour.constrainedOff.p10),
    p90Path: line(hours, x, y, (hour) => hour.constrainedOff.p90),
    bars: (settled ?? []).map((hour) => {
      const top = y(hour.constrainedOffMwh);
      return {
        hourLocal: hour.hourLocal,
        x: x(hour.hourLocal) - width / 2,
        y: top,
        width,
        height: Math.max(0, floor - top),
      };
    }),
    window:
      window === null
        ? null
        : {
            x: x(window.fromHour) - slot / 2,
            width: (window.toHour - window.fromHour + 1) * slot,
          },
  };
}

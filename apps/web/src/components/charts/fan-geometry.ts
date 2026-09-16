/**
 * Where the fan chart's lines go — the arithmetic, with no React in it.
 *
 * A module of its own rather than an export from `fan-chart.tsx`, because a
 * component file that also exports a function cannot be hot-replaced, and
 * because nothing here is a component: it is three inputs, a fixed viewBox and
 * three path strings.
 *
 * The viewBox constants live here too. They are the geometry's own frame, and
 * the component only needs `W` and `H` to size the `<Svg>`.
 */

import type { CurtailmentHourForecast, CurtailmentHourObservation } from "@/lib/fixtures";

/**
 * The chart's arithmetic, separated from the chart.
 *
 * Every number below is a function of three inputs and the module's fixed
 * viewBox — no state, no palette, no hooks — and pulling it out of the
 * component is what makes it checkable: `bandPath` is a closed polygon whose
 * upper edge is the P90s left to right and whose lower edge is the P10s right
 * to left, and that is a claim a test can make against a string rather than a
 * rendered SVG.
 *
 * It was inline, and it was most of why `FanChart` measured cyclomatic
 * complexity 16. The component that is left decides what to *draw*; this
 * decides where.
 *
 * **`max` includes `thresholdMw * 2` deliberately.** A day whose whole band
 * sits under the threshold would otherwise be scaled to its own P90 and drawn
 * as a dramatic fan about nothing — the threshold line is the reference that
 * makes a quiet day look quiet, so the scale has to leave room for it.
 */
const W = 640;
const H = 260;
export const PAD = { top: 18, right: 14, bottom: 30, left: 46 };

/**
 * The plot area inside the viewBox — constants of `W`, `H` and `PAD`, so they
 * are computed once here rather than on every render of every fan on a screen.
 */
export const CHART_W = W - PAD.left - PAD.right;
export const CHART_H = H - PAD.top - PAD.bottom;
export const FONT =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
export const GRID = [1, 0.75, 0.5, 0.25, 0];

function niceMax(value: number): number {
  if (value <= 0) {
    return 10;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
  for (const step of steps) {
    if (step * magnitude >= value) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}

export function fanGeometry(
  hours: readonly CurtailmentHourForecast[],
  observed: readonly CurtailmentHourObservation[] | undefined,
  thresholdMw: number,
): {
  max: number;
  /** One hour's width, which the hit targets and the tick spacing both need. */
  slot: number;
  x: (index: number) => number;
  y: (value: number) => number;
  /** The P10–P90 ribbon, as one closed path. */
  bandPath: string;
  medianPath: string;
  /** `null` when there is nothing settled — an absence, not an empty path. */
  observedPath: string | null;
} {
  const observedPeak =
    observed === undefined ? 0 : Math.max(...observed.map((o) => o.constrainedOffMwh));
  const max = niceMax(
    Math.max(observedPeak, ...hours.map((h) => h.constrainedOff.p90), thresholdMw * 2),
  );
  const slot = CHART_W / hours.length;

  const x = (i: number) => PAD.left + i * slot + slot / 2;
  const y = (v: number) => PAD.top + CHART_H - (v / max) * CHART_H;

  const upper = hours.map(
    (h, i) => `${x(i).toFixed(1)},${y(h.constrainedOff.p90).toFixed(1)}`,
  );
  const lower = hours
    .map((h, i) => `${x(i).toFixed(1)},${y(h.constrainedOff.p10).toFixed(1)}`)
    .reverse();
  return {
    max,
    slot,
    x,
    y,
    bandPath: `M${upper.join(" L")} L${lower.join(" L")} Z`,
    medianPath: `M${hours
      .map((h, i) => `${x(i).toFixed(1)},${y(h.constrainedOff.p50).toFixed(1)}`)
      .join(" L")}`,
    observedPath:
      observed === undefined
        ? null
        : `M${observed
            .map((o, i) => `${x(i).toFixed(1)},${y(o.constrainedOffMwh).toFixed(1)}`)
            .join(" L")}`,
  };
}

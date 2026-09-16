import { describe, expect, it } from "bun:test";
import {
  CHART_H,
  CHART_W,
  fanGeometry,
  PAD,
} from "../src/components/charts/fan-geometry";
import type {
  CurtailmentHourForecast,
  CurtailmentHourObservation,
} from "../src/lib/fixtures";

/**
 * The fan chart's arithmetic, asserted as arithmetic.
 *
 * It was inline in `FanChart` — most of why that component measured cyclomatic
 * complexity 16 — and inline it could only be checked by rendering an SVG and
 * reading attributes back out. The claims below are about strings and numbers,
 * and they are claims the chart's correctness actually rests on: a band drawn
 * with its lower edge in the wrong order is a ribbon that crosses itself, which
 * looks like a plausible chart and is not one.
 */

const hour = (p10: number, p50: number, p90: number): CurtailmentHourForecast =>
  ({
    hourLocal: 0,
    constrainedOff: { p10, p50, p90 },
  }) as unknown as CurtailmentHourForecast;

const settled = (mwh: number): CurtailmentHourObservation =>
  ({
    validTime: "2026-09-14T00:00:00Z",
    hourLocal: 0,
    constrainedOffMwh: mwh,
  }) as unknown as CurtailmentHourObservation;

const HOURS = [hour(10, 40, 90), hour(20, 60, 120), hour(0, 5, 30)];

/** Every `x,y` pair in a path, in order. */
function points(path: string): [number, number][] {
  return path
    .replace(/^M/, "")
    .replace(/ Z$/, "")
    .split(" L")
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return [x as number, y as number];
    });
}

describe("the band is a closed ribbon, not a line that doubles back", () => {
  it("runs the P90s forward and the P10s back, so the path never crosses", () => {
    const { bandPath, x, y } = fanGeometry(HOURS, undefined, 5);
    const drawn = points(bandPath);
    expect(drawn).toHaveLength(HOURS.length * 2);
    // Upper edge, left to right, at each hour's P90.
    for (const [i, h] of HOURS.entries()) {
      expect(drawn[i]).toEqual([
        Number(x(i).toFixed(1)),
        Number(y(h.constrainedOff.p90).toFixed(1)),
      ]);
    }
    // Lower edge, right to left, at each hour's P10. Reversed is the whole
    // claim: forward, the ribbon would fold through itself.
    for (const [i, h] of [...HOURS].reverse().entries()) {
      const at = HOURS.length + i;
      const source = HOURS.length - 1 - i;
      expect(drawn[at]).toEqual([
        Number(x(source).toFixed(1)),
        Number(y(h.constrainedOff.p10).toFixed(1)),
      ]);
    }
    expect(bandPath.endsWith(" Z")).toBe(true);
  });

  it("the median runs inside the band at every hour", () => {
    const { medianPath, y } = fanGeometry(HOURS, undefined, 5);
    for (const [i, h] of points(medianPath).entries()) {
      const source = HOURS[i] as CurtailmentHourForecast;
      // Screen y grows downward, so "inside" is between the P90's y and the
      // P10's y — inverted from the value order, which is exactly the kind of
      // sign error a rendered check would miss.
      expect(h[1]).toBeLessThanOrEqual(y(source.constrainedOff.p10));
      expect(h[1]).toBeGreaterThanOrEqual(y(source.constrainedOff.p90));
    }
  });
});

describe("the scale leaves room for the threshold", () => {
  it("a day entirely below the threshold is not scaled to its own peak", () => {
    // The failure this prevents: a quiet day drawn as a dramatic fan because
    // the axis stopped at its P90, with the threshold line off the top.
    const quiet = [hour(0, 1, 2)];
    const { max } = fanGeometry(quiet, undefined, 50);
    expect(max).toBeGreaterThanOrEqual(100);
  });

  it("a settled peak above every P90 still fits", () => {
    const { max, y } = fanGeometry(HOURS, [settled(400)], 5);
    expect(max).toBeGreaterThanOrEqual(400);
    // And it lands inside the plot area rather than above it.
    expect(y(400)).toBeGreaterThanOrEqual(PAD.top);
  });

  it("zero sits on the floor and `max` on the ceiling", () => {
    const { max, y } = fanGeometry(HOURS, undefined, 5);
    expect(y(0)).toBeCloseTo(PAD.top + CHART_H, 6);
    expect(y(max)).toBeCloseTo(PAD.top, 6);
  });
});

describe("absence is null, never an empty path", () => {
  it("no settled hours means no observed line at all", () => {
    expect(fanGeometry(HOURS, undefined, 5).observedPath).toBeNull();
  });

  it("settled hours produce one", () => {
    const path = fanGeometry(HOURS, [settled(10), settled(20)], 5).observedPath;
    // An empty string would render as nothing *and* pass a null check, which is
    // the shape that turns "not measured" into "measured as zero".
    expect(path).not.toBeNull();
    expect(points(path as string)).toHaveLength(2);
  });
});

describe("the horizontal scale divides the plot area, not the viewBox", () => {
  it("hours are centred in equal slots inside the padding", () => {
    const { x, slot } = fanGeometry(HOURS, undefined, 5);
    expect(slot).toBeCloseTo(CHART_W / HOURS.length, 6);
    expect(x(0)).toBeCloseTo(PAD.left + slot / 2, 6);
    // The last slot's centre stays inside the right padding.
    expect(x(HOURS.length - 1)).toBeLessThanOrEqual(PAD.left + CHART_W);
  });
});

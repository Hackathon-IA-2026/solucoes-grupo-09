import { describe, expect, it } from "bun:test";
import {
  band,
  centre,
  formatMwhExact,
  formatPercent,
  formatProbability,
  formatRange,
  observed,
  railFractions,
  spread,
  upper,
} from "../src/components/landing/band";
import {
  HOURLY_PROFILE,
  MITIGATION,
  NATIONAL_ENERGY,
  SUBSYSTEMS,
} from "../src/components/landing/fixtures";

/**
 * The band type and the fixture's internal consistency.
 *
 * The fixture assertions are not busywork: the landing page states in copy
 * that subsystem medians sum to the national median and that the *bands* do
 * not, and both halves of that claim are easy to break by editing one number
 * later. These tests are what stop the page from telling a small lie about
 * its own arithmetic.
 */

describe("band", () => {
  it("rejects quantiles that are out of order", () => {
    expect(() => band(500, 400, 900)).toThrow(RangeError);
    expect(() => band(100, 900, 400)).toThrow(RangeError);
  });

  it("accepts a degenerate band (a genuinely certain forecast)", () => {
    const figure = band(100, 100, 100);
    expect(centre(figure)).toBe(100);
    expect(upper(figure)).toBe(100);
  });

  it("reads centre and upper off either variant", () => {
    expect(centre(band(1, 2, 3))).toBe(2);
    expect(upper(band(1, 2, 3))).toBe(3);
    expect(centre(observed(7))).toBe(7);
    expect(upper(observed(7))).toBe(7);
  });

  it("measures spread relative to the median, and survives a zero median", () => {
    expect(spread({ p10: 90, p50: 100, p90: 130 })).toBeCloseTo(0.4, 10);
    expect(spread({ p10: 0, p50: 0, p90: 0 })).toBe(0);
  });

  it("places a band on a shared track as three clamped fractions", () => {
    expect(railFractions({ p10: 25, p50: 50, p90: 75 }, 100)).toEqual({
      start: 0.25,
      mid: 0.5,
      end: 0.75,
    });
    // A band wider than the track clamps rather than overflowing the rail.
    expect(railFractions({ p10: -10, p50: 50, p90: 400 }, 100)).toEqual({
      start: 0,
      mid: 0.5,
      end: 1,
    });
    // A zero or negative max must not produce NaN geometry.
    expect(railFractions({ p10: 1, p50: 2, p90: 3 }, 0).mid).toBe(1);
  });
});

describe("formatting", () => {
  it("formats energy with separators and an en dash range", () => {
    expect(formatMwhExact(4180)).toBe("4,180");
    expect(formatMwhExact(4180.4)).toBe("4,180");
    expect(formatRange({ p10: 2640, p50: 4180, p90: 6320 })).toBe("2,640–6,320");
    // An en dash, not a hyphen — a hyphen reads as a minus next to numbers.
    expect(formatRange({ p10: 1, p50: 2, p90: 3 })).toContain("–");
  });

  it("formats shares and probabilities at their respective precisions", () => {
    expect(formatPercent(0.459)).toBe("45.9%");
    expect(formatProbability(0.89)).toBe("89%");
    expect(formatProbability(0.085)).toBe("9%");
  });
});

describe("landing fixture", () => {
  it("has subsystem medians that sum to the national median", () => {
    const total = SUBSYSTEMS.reduce((sum, s) => sum + centre(s.energy), 0);
    expect(total).toBe(centre(NATIONAL_ENERGY));
  });

  it("does not let the subsystem bands sum to the national band", () => {
    // Quantiles are not additive, and the page says so. If a future edit made
    // these add up it would be arithmetically tidy and physically wrong.
    const lows = SUBSYSTEMS.reduce(
      (sum, s) => sum + (s.energy.kind === "band" ? s.energy.band.p10 : 0),
      0,
    );
    const highs = SUBSYSTEMS.reduce(
      (sum, s) => sum + (s.energy.kind === "band" ? s.energy.band.p90 : 0),
      0,
    );
    expect(NATIONAL_ENERGY.kind).toBe("band");
    if (NATIONAL_ENERGY.kind !== "band") {
      return;
    }
    expect(lows).not.toBe(NATIONAL_ENERGY.band.p10);
    expect(highs).not.toBe(NATIONAL_ENERGY.band.p90);
  });

  it("covers all 24 hours with ordered quantiles", () => {
    expect(HOURLY_PROFILE).toHaveLength(24);
    HOURLY_PROFILE.forEach((point, index) => {
      expect(point.hour).toBe(index);
      expect(point.p10).toBeLessThanOrEqual(point.p50);
      expect(point.p50).toBeLessThanOrEqual(point.p90);
    });
  });

  it("has hourly medians summing to the daily median", () => {
    const total = HOURLY_PROFILE.reduce((sum, p) => sum + p.p50, 0);
    expect(total).toBe(centre(NATIONAL_ENERGY));
  });

  it("shrinks curtailment monotonically as flexibility is added", () => {
    const remaining = MITIGATION.map((step) => centre(step.remaining));
    for (let i = 1; i < remaining.length; i += 1) {
      expect(remaining[i]).toBeLessThan(remaining[i - 1]);
    }
    // The baseline is the only step with nothing recovered against it.
    expect(MITIGATION[0].recovered).toBeNull();
    for (const step of MITIGATION.slice(1)) {
      expect(step.recovered).not.toBeNull();
    }
  });

  it("keeps recovered energy consistent with the baseline it is measured from", () => {
    const baseline = centre(MITIGATION[0].remaining);
    for (const step of MITIGATION.slice(1)) {
      if (step.recovered === null) {
        continue;
      }
      expect(centre(step.recovered)).toBe(baseline - centre(step.remaining));
    }
  });
});

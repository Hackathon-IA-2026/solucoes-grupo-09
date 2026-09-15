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
  FORECAST_ORIGIN,
  HOURLY_PROFILE,
  MITIGATION,
  NATIONAL,
  SHOWCASE_MEDIAN,
  SUBSYSTEMS,
} from "../src/components/landing/fixtures";
import { en as EN } from "../src/i18n/copy.en";
import { pt as PT } from "../src/i18n/copy.pt";
import { riskClass } from "../src/lib/fixtures";

/**
 * The band type and the fixture's internal consistency.
 *
 * The fixture assertions are not busywork: the landing page states in copy
 * that the national figure is an expectation *because* an expectation is the
 * only quantity that survives aggregation, and that claim is easy to break by
 * editing one number later. These tests are what stop the page from telling a
 * small lie about its own arithmetic — the lie it told until the API spec
 * caught it, which was a national median summed out of four subsystem
 * medians.
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
    expect(formatMwhExact("en", 4180)).toBe("4,180");
    expect(formatMwhExact("en", 4180.4)).toBe("4,180");
    expect(formatRange("en", { p10: 2640, p50: 4180, p90: 6320 })).toBe("2,640–6,320");
    // An en dash, not a hyphen — a hyphen reads as a minus next to numbers.
    expect(formatRange("en", { p10: 1, p50: 2, p90: 3 })).toContain("–");
  });

  it("groups Portuguese numbers the Brazilian way, not the American one", () => {
    // The page is served from `/pt/` as its own static file, and "4,180" reads
    // there as four point one eight — an order of magnitude out, silently.
    expect(formatMwhExact("pt", 4180)).toBe("4.180");
    expect(formatRange("pt", { p10: 2640, p50: 4180, p90: 6320 })).toBe("2.640–6.320");
    expect(formatPercent("pt", 0.459)).toBe("45,9%");
  });

  it("formats shares and probabilities at their respective precisions", () => {
    expect(formatPercent("en", 0.459)).toBe("45.9%");
    expect(formatProbability("en", 0.89)).toBe("89%");
    expect(formatProbability("en", 0.085)).toBe("9%");
  });
});

describe("landing fixture", () => {
  it("has subsystem expectations that sum exactly to the national one", () => {
    // The whole reason the headline is an expectation: `E[·]` adds, with no
    // assumption at all about how the four subsystems move together.
    const total = SUBSYSTEMS.reduce((sum, s) => sum + s.expectedMwh, 0);
    expect(total).toBeCloseTo(NATIONAL.expectedMwh, 6);
  });

  it("does not let the national figure be a componentwise sum of medians", () => {
    // The defect this fixture was built to stop coming back. The median of a
    // sum is the sum of the medians only for comonotone components, and four
    // subsystems' curtailment is not comonotone — so a national figure equal
    // to the sum of the four P50s is a number with no engine behind it.
    const sumOfMedians = SUBSYSTEMS.reduce((sum, s) => sum + centre(s.energy), 0);
    expect(sumOfMedians).toBe(4180);
    expect(NATIONAL.expectedMwh).not.toBe(sumOfMedians);
    // For a hurdle mixture E[Y] > P50 wherever p < 0.5, which is three of the
    // four. An expectation *below* the summed medians would mean a subsystem
    // expectation had been quietly set to a quantile.
    expect(NATIONAL.expectedMwh).toBeGreaterThan(sumOfMedians);
    for (const s of SUBSYSTEMS) {
      expect(s.expectedMwh).toBeGreaterThan(centre(s.energy));
    }
  });

  it("illustrates with a figure that is not the sum of the column above it", () => {
    // The band explainer's two rails share a median to make its point, and that
    // median was 4,180 — the componentwise sum of the four P50s in the readout
    // above, which `docs/specs/api-surface.md` §"The national readout" names as
    // a quantity that must not be constructed. The section arguing that a
    // single number is dishonest was printing the forbidden one as its example.
    const sumOfMedians = SUBSYSTEMS.reduce((sum, s) => sum + centre(s.energy), 0);
    expect(SHOWCASE_MEDIAN).not.toBe(sumOfMedians);
    // And not any other total this page renders either, because "not 4,180"
    // alone would pass for the national expectation or a subsystem's own.
    expect(SHOWCASE_MEDIAN).not.toBe(NATIONAL.expectedMwh);
    const totals = new Set<number>([
      sumOfMedians,
      NATIONAL.expectedMwh,
      SUBSYSTEMS.reduce((sum, s) => sum + s.expectedMwh, 0),
      ...SUBSYSTEMS.flatMap((s) => [centre(s.energy), s.expectedMwh]),
    ]);
    expect(totals.has(SHOWCASE_MEDIAN)).toBe(false);
  });

  it("publishes no national band, and says why", () => {
    // Quantiles of a sum need a joint draw across subsystems, which the
    // forecaster does not produce yet. Until it does, the honest value is
    // null — and a null with no stated reason is unrepresentable in the type.
    expect(NATIONAL.band).toBeNull();
    expect(NATIONAL.bandUnavailableReason).toBe("no_joint_ensemble");
  });

  it("tallies the risk classes it publishes, and bins them the way the product does", () => {
    const counts = { low: 0, elevated: 0, high: 0 };
    for (const s of SUBSYSTEMS) {
      expect(s.riskClass).toBe(riskClass(s.probability));
      counts[s.riskClass] += 1;
    }
    expect(counts).toEqual(NATIONAL.riskClassCounts);
    expect(counts.low + counts.elevated + counts.high).toBe(4);
  });

  it("names WattSteer as the producer of the forecast, not the weather provider", () => {
    // `open_meteo` produces the weather run. The producer of a curtailment
    // forecast is WattSteer, and the weather run is a second field because it
    // is a second fact about a different artifact.
    expect(FORECAST_ORIGIN.producer).toBe("wattsteer");
    expect(FORECAST_ORIGIN.weatherRunLabel).toBe("D−1 12Z");
    // The WattSteer run label is the artifact version, and it is a different
    // string from the weather run. If a future edit set them equal the two
    // fields would have collapsed back into one fact wearing two names.
    expect(FORECAST_ORIGIN.runLabel).not.toBe(FORECAST_ORIGIN.weatherRunLabel);
  });

  it("prints both artifacts on the panel, in both locales", () => {
    // `api-surface.md` puts `weather_run_label` on the outlook response
    // *beside* the WattSteer origin rather than making the screen choose which
    // of the two to call "the run". A locale that dropped the weather run — or
    // that dropped the producer to make room for it — would put the panel back
    // in the state where one line credits the forecast to the wrong party, and
    // no type can see that: both are valid strings.
    for (const value of [EN.readout.originValue, PT.readout.originValue]) {
      for (const slot of ["{producer}", "{run}", "{published}", "{weatherRun}"]) {
        expect(value).toContain(slot);
      }
    }
  });

  it("covers all 24 hours with ordered quantiles", () => {
    expect(HOURLY_PROFILE).toHaveLength(24);
    HOURLY_PROFILE.forEach((point, index) => {
      expect(point.hour).toBe(index);
      expect(point.p10).toBeLessThanOrEqual(point.p50);
      expect(point.p50).toBeLessThanOrEqual(point.p90);
    });
  });

  it("has hourly expectations summing to the day, and hourly medians summing to nothing", () => {
    const expected = HOURLY_PROFILE.reduce((sum, p) => sum + p.expectedMwh, 0);
    expect(expected).toBeCloseTo(NATIONAL.expectedMwh, 6);
    const medians = HOURLY_PROFILE.reduce((sum, p) => sum + p.p50, 0);
    expect(medians).not.toBe(NATIONAL.expectedMwh);
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

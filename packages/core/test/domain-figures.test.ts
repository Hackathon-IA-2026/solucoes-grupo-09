import { describe, expect, it } from "bun:test";
import {
  band,
  centre,
  observed,
  splitFor,
  splitOther,
  spread,
  upper,
} from "../src/domain.js";

/**
 * The `Figure` constructors, and the axis every chart is scaled by.
 *
 * `domain.ts` states the rule these enforce: a forecast is a band or it is an
 * `observed` measurement, and *"there is no third variant, so no code path can
 * render a forecast as a lone number"*. The type carries that. What the type
 * cannot carry is the two things below, and neither was tested.
 *
 * **`band` asserts its own ordering.** Its comment says so — *"Quantile
 * ordering is asserted, not assumed"* — and it is the only thing standing
 * between a transposed pair and a chart that draws a P90 beneath its P10. On a
 * product whose whole claim is "never a lone number", a band rendered
 * inside-out is not a cosmetic bug: it is the uncertainty statement backwards.
 *
 * **`upper` is not `centre`.** It exists because an axis has to make room for
 * the top of the band rather than its median, and the two functions differ by
 * one property name. A chart scaled by `centre` clips every band it draws, on
 * exactly the rows where the band matters most.
 */

describe("a band asserts the order it was given", () => {
  it("accepts ascending quantiles", () => {
    const figure = band(120, 480, 1900);
    expect(figure.kind).toBe("band");
    expect(figure.kind === "band" && figure.band).toEqual({
      p10: 120,
      p50: 480,
      p90: 1900,
    });
  });

  it("accepts a degenerate band, which is narrow rather than invalid", () => {
    // Three equal quantiles is what a hour with no uncertainty looks like, and
    // `<=` rather than `<` is what lets it through. A guard that refused it
    // would reject a legitimate settled-adjacent forecast.
    expect(() => band(7, 7, 7)).not.toThrow();
    expect(() => band(0, 0, 0)).not.toThrow();
  });

  it("refuses a transposed pair, on either side of the median", () => {
    // The two single-swap mistakes, which are the ones that actually happen:
    // an argument order slip at a call site, not a wholesale reversal.
    expect(() => band(480, 120, 1900)).toThrow(RangeError);
    expect(() => band(120, 1900, 480)).toThrow(RangeError);
  });

  it("refuses a fully inverted triple", () => {
    expect(() => band(1900, 480, 120)).toThrow(RangeError);
  });

  it("says which numbers it refused", () => {
    // The values are in the message because the caller is usually a fixture or
    // a decoded row, and "out of order" alone does not say which row.
    expect(() => band(3, 2, 1)).toThrow(/3, 2, 1/);
  });

  it("accepts negatives in order, because the guard is about order", () => {
    // Non-vacuity for the guard's shape: it must not be a sign check wearing an
    // ordering check's name.
    expect(() => band(-10, -5, 0)).not.toThrow();
  });
});

describe("an observed figure has nothing to be uncertain about", () => {
  it("carries a value and no band", () => {
    const figure = observed(2255);
    expect(figure.kind).toBe("observed");
    expect(figure.kind === "observed" && figure.value).toBe(2255);
    expect("band" in figure).toBe(false);
  });
});

describe("what a chart scales by", () => {
  const forecast = band(120, 480, 1900);
  const measured = observed(2255);

  it("centre is the median of a band and the value of an observation", () => {
    expect(centre(forecast)).toBe(480);
    expect(centre(measured)).toBe(2255);
  });

  it("upper is the P90 of a band, not its median", () => {
    /*
      The assertion this file exists for. `upper` and `centre` differ by one
      property name, and an axis scaled by the wrong one clips every band it
      draws — worst on the rows where the band is widest, which are the rows the
      band was put there for.
    */
    expect(upper(forecast)).toBe(1900);
    expect(upper(forecast)).not.toBe(centre(forecast));
  });

  it("upper and centre agree on an observation, because there is no band", () => {
    expect(upper(measured)).toBe(centre(measured));
  });
});

describe("spread is the band as a fraction of what it is about", () => {
  it("is the P10–P90 width over the median", () => {
    expect(spread({ p10: 100, p50: 200, p90: 400 })).toBeCloseTo(1.5);
  });

  it("is zero at a zero median rather than infinite", () => {
    // A division guard, and the reason it is here: a quiet hour forecasts a
    // median of zero, and an `Infinity` would reach a chart axis.
    expect(spread({ p10: 0, p50: 0, p90: 0 })).toBe(0);
    expect(Number.isFinite(spread({ p10: 0, p50: 0, p90: 50 }))).toBe(true);
  });
});

describe("a technology selection and what it is read against", () => {
  const split = { windMwh: 158_500, solarMwh: 65_000 };

  it("picks the selected technology, and the other one", () => {
    expect(splitFor(split, "WIND")).toBe(158_500);
    expect(splitOther(split, "WIND")).toBe(65_000);
    expect(splitFor(split, "SOLAR")).toBe(65_000);
    expect(splitOther(split, "SOLAR")).toBe(158_500);
  });

  it("the pair is exhaustive and never the same scalar", () => {
    // Non-vacuity: two functions that both returned wind would satisfy half the
    // assertions above, and the screen would show a split against itself.
    for (const technology of ["WIND", "SOLAR"] as const) {
      expect(splitFor(split, technology)).not.toBe(splitOther(split, technology));
      expect(splitFor(split, technology) + splitOther(split, technology)).toBe(
        split.windMwh + split.solarMwh,
      );
    }
  });
});

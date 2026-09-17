/**
 * The Time Machine's accuracy panel, and the statistic it refuses to invent.
 *
 * The brief asks for "Acurácia: 49%". One day cannot produce one, and the
 * interesting half of this feature is the arithmetic it does *not* do — so the
 * placement function and the refusal are both pinned here.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forecastError, placementOf } from "../src/lib/replay-accuracy";

const BAND = { p10: 320, p50: 1240, p90: 2900 };

describe("where a settled day fell against its band", () => {
  it("inside is inclusive of both edges", () => {
    // A band is a closed interval, and a day that settles exactly at P90 is
    // covered by it. Rounding that to "above" would understate coverage by
    // whatever fraction of days lands on the edge.
    expect(placementOf(BAND, 320)).toBe("inside");
    expect(placementOf(BAND, 2900)).toBe("inside");
    expect(placementOf(BAND, 1240)).toBe("inside");
  });

  it("names the side a miss fell on, because the two mean opposite things", () => {
    // Above: the product under-forecast and cost a generator the chance to act.
    // Below: it over-forecast and cost them a plan they did not need.
    expect(placementOf(BAND, 2901)).toBe("above");
    expect(placementOf(BAND, 319)).toBe("below");
  });

  it("a zero settlement is below, not missing", () => {
    // Zero curtailment is a measurement. The hurdle model puts real mass on it,
    // so a day that settles at zero under a band whose P10 is positive is a
    // genuine miss and has to read as one.
    expect(placementOf(BAND, 0)).toBe("below");
  });

  it("a band pinned at zero covers a zero day", () => {
    expect(placementOf({ p10: 0, p50: 0, p90: 0 }, 0)).toBe("inside");
  });
});

describe("the panel invents no accuracy percentage", () => {
  // Both halves: the view and the arithmetic it delegates to. A division moved
  // from one into the other would otherwise slip past this.
  const source = [
    join(
      import.meta.dir,
      "..",
      "src",
      "components",
      "app",
      "replay",
      "accuracy-panel.tsx",
    ),
    join(import.meta.dir, "..", "src", "lib", "replay-accuracy.ts"),
  ]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

  it("divides nothing to make a score", () => {
    /*
      The whole point. Accuracy of a distribution is the fraction of days whose
      settlement landed inside the band — `coverage_p10_in_band`, measured over
      a fold by the gate. A single day either landed inside or it did not, and
      `error / forecast` would be a statistic with a familiar shape and no
      meaning, which is the one thing this product refuses everywhere else.

      Asserted on the code with comments stripped, so the prose above may
      discuss the division the code must not contain.
    */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\/\s*(band\.|settled|forecast)/);
    expect(code).not.toMatch(/percent|accuracy\s*=|score/i);
  });

  it("the error keeps its sign", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // `settled - band.p50`, not `Math.abs(...)` of it: an absolute error hides
    // whether the product under-forecast or over-forecast, and those cost a
    // generator opposite things.
    expect(code).toContain("return settled - band.p50;");
  });
});

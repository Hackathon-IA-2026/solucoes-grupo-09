import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppParams, technologyParam } from "../src/components/app/params";
import { en as EN } from "../src/i18n/copy.en";
import { pt as PT } from "../src/i18n/copy.pt";
import {
  buildForecast,
  DEFAULT_LOAD,
  REPLAY_DAYS,
  riskClass,
  roundProbability,
} from "../src/lib/fixtures";

describe("forecast fixtures", () => {
  const forecast = buildForecast("NE", "12Z");

  test("emits 24 hours", () => {
    expect(forecast.hours).toHaveLength(24);
  });

  test("every hour's band is ordered P10 <= P50 <= P90", () => {
    for (const hour of forecast.hours) {
      expect(hour.constrainedOff.p10).toBeLessThanOrEqual(hour.constrainedOff.p50);
      expect(hour.constrainedOff.p50).toBeLessThanOrEqual(hour.constrainedOff.p90);
    }
  });

  test("the day band is not the componentwise sum of the hourly bands", () => {
    // Quantiles do not add — and neither do medians, which is the half of the
    // rule the fixture used to break by setting the day P50 to the sum of the
    // hourly P50s. The day figures are read from the path ensemble, so *no*
    // component of the band may equal its componentwise sum.
    //
    // The inequality is asserted rather than its direction. Under the strong
    // intra-day dependence a path ensemble preserves, the day P90 sits below
    // the sum of the hourly P90s on a busy subsystem and can sit above it on a
    // rare-event one, where almost every hour's own P90 is zero and the whole
    // day either fires together or not at all. Pinning a direction here would
    // pin an assumption about the dependence structure instead of the rule.
    for (const code of ["N", "NE", "SE", "S"] as const) {
      const each = buildForecast(code, "12Z");
      const sum = (key: "p10" | "p50" | "p90") =>
        Math.round(each.hours.reduce((acc, h) => acc + h.constrainedOff[key], 0));
      expect(each.dailyEnergy.p90).not.toBe(sum("p90"));
      // The median is checked only where the componentwise sum is not zero.
      // On the two quiet subsystems every hour is under an even chance, so
      // every hourly median is zero and so is their sum — the two agree at 0
      // because there is nothing to disagree about, not because a median was
      // added, and asserting inequality there would assert noise.
      if (sum("p50") > 0) {
        expect(each.dailyEnergy.p50).not.toBe(sum("p50"));
      }
    }
    // NE is the busy subsystem, so it is where the whole rule has teeth.
    const busy = buildForecast("NE", "12Z");
    const summed = (key: "p10" | "p50" | "p90") =>
      Math.round(busy.hours.reduce((acc, h) => acc + h.constrainedOff[key], 0));
    expect(summed("p50")).toBeGreaterThan(0);
    expect(busy.dailyEnergy).not.toEqual({
      p10: summed("p10"),
      p50: summed("p50"),
      p90: summed("p90"),
    });
  });

  test("the peak-power band is drawn, not the largest hourly band", () => {
    // A day's peak is a property of a *path*: the biggest hour of a drawn day,
    // not the componentwise extreme of 24 marginals. Reducing it from the
    // hours reports the P90 of the worst hour as if the day were certain to
    // contain that hour.
    const hourlyMaxP90 = Math.max(...forecast.hours.map((h) => h.constrainedOff.p90));
    expect(forecast.peakPower.p90).not.toBe(Math.round(hourlyMaxP90));
    expect(forecast.peakPower.p10).toBeLessThanOrEqual(forecast.peakPower.p50);
    expect(forecast.peakPower.p50).toBeLessThanOrEqual(forecast.peakPower.p90);
  });

  test("the forecast carries no technology, and needs none to build", () => {
    // Contract change 5: one object per subsystem-day. A `technology` key here
    // would be claiming a per-technology head the forecaster does not have,
    // and `buildForecast` taking one would let a screen ask for it.
    expect(Object.keys(forecast)).not.toContain("technology");
    expect(forecast.subsystem).toBe("NE");
    expect(buildForecast.length).toBe(2);
  });

  test("the split is two scalars at both grains, and they sum to E[Y]", () => {
    const day = forecast.split;
    expect(Object.keys(day).sort()).toEqual(["solarMwh", "windMwh"]);
    expect(typeof day.windMwh).toBe("number");
    expect(typeof day.solarMwh).toBe("number");
    expect(day.windMwh + day.solarMwh).toBe(forecast.dayExpectedMwh);
    for (const hour of forecast.hours) {
      expect(Object.keys(hour.split).sort()).toEqual(["solarMwh", "windMwh"]);
      expect(hour.split.windMwh + hour.split.solarMwh).toBeCloseTo(hour.expectedMwh, 6);
    }
  });

  test("the expectation is a sibling of the band, never its centre", () => {
    // For a hurdle mixture the expectation exceeds the median whenever the
    // occurrence probability is below an even chance, so a screen reading the
    // P50 as "the expected figure" under-reports every quiet day — by all of
    // it, where the median is zero.
    expect(forecast.dayExpectedMwh).not.toBe(forecast.dailyEnergy.p50);
    const quiet = buildForecast("S", "12Z");
    expect(quiet.occurrenceProbability).toBeLessThan(0.5);
    expect(quiet.dailyEnergy.p50).toBe(0);
    expect(quiet.dayExpectedMwh).toBeGreaterThan(quiet.dailyEnergy.p50);
    for (const hour of quiet.hours) {
      expect(hour.expectedMwh).toBeGreaterThanOrEqual(hour.constrainedOff.p50);
    }
  });

  test("the 12Z run carries a narrower band than 00Z", () => {
    const early = buildForecast("NE", "00Z");
    const width = (f: typeof forecast) => f.dailyEnergy.p90 - f.dailyEnergy.p10;
    expect(width(forecast)).toBeLessThan(width(early));
  });
});

describe("risk classification", () => {
  test("bins rather than reporting a point probability", () => {
    expect(riskClass(0.08)).toBe("low");
    expect(riskClass(0.31)).toBe("elevated");
    expect(riskClass(0.89)).toBe("high");
  });

  test("probabilities round to the nearest 5 points", () => {
    expect(roundProbability(0.31)).toBe(30);
    expect(roundProbability(0.89)).toBe(90);
  });
});

describe("replay honesty", () => {
  test("the fixture contains days on both sides of the training cut", () => {
    expect(REPLAY_DAYS.some((d) => d.inTrainingWindow)).toBe(true);
    expect(REPLAY_DAYS.some((d) => !d.inTrainingWindow)).toBe(true);
  });

  test("the fixture contains both vintage fidelities", () => {
    const fidelities = new Set(REPLAY_DAYS.map((d) => d.vintageFidelity));
    expect(fidelities.has("point_in_time")).toBe(true);
    expect(fidelities.has("revision_optimistic")).toBe(true);
  });

  test("in-sample-ness and vintage are two axes and neither implies the other", () => {
    // They coincide in the wild today, which is precisely the argument for
    // keeping them apart: a merged badge would be observationally correct now
    // and wrong the moment a post-go-live quarter is held out. The fixture
    // therefore carries a day where the two disagree, so the screen has to
    // render them as two facts rather than one.
    const disagreeing = REPLAY_DAYS.filter(
      (d) => (d.vintageFidelity === "point_in_time") !== !d.inTrainingWindow,
    );
    expect(disagreeing.length).toBeGreaterThan(0);
  });

  test("the caveat's extent is the response's, not the screen's", () => {
    // `packages/core/fixtures/spec-examples/12-replay.json` is the published
    // example of the contract. Asserting the fixture against it is what makes
    // "vintage_affects names the actuals and the lagged features" a checked
    // property rather than a sentence somebody typed into two places.
    const example = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "..",
          "..",
          "..",
          "packages",
          "core",
          "fixtures",
          "spec-examples",
          "12-replay.json",
        ),
        "utf8",
      ),
    ) as { integrity: { vintage_affects: string[]; vintage_exempt: string[] } };
    for (const day of REPLAY_DAYS) {
      expect([...day.vintageAffects]).toEqual(example.integrity.vintage_affects);
      expect([...day.vintageExempt]).toEqual(example.integrity.vintage_exempt);
      // Every part the screen may have to name has copy in both locales; a part
      // with none would render as its wire token to a user.
      for (const part of [...day.vintageAffects, ...day.vintageExempt]) {
        expect(Object.keys(EN.app.replay.vintagePart)).toContain(part);
        expect(Object.keys(PT.app.replay.vintagePart)).toContain(part);
      }
    }
  });

  test("the revision premium is null, and null means unmeasured", () => {
    // The one thing this field must never be until it is computable. A zero
    // would read as "measured, and small", which is the failure mode the
    // nullable field exists to prevent — and the screen's `null` branch says
    // the word rather than falling silent.
    for (const day of REPLAY_DAYS) {
      expect(day.revisionPremiumRecoveredMwh).toBeNull();
    }
    expect(EN.app.replay.revisionPremiumUnmeasured).toContain("unmeasured");
    expect(EN.app.replay.revisionPremiumUnmeasured).not.toContain("0");
  });
});

describe("URL params", () => {
  test("defaults hold for an empty query", () => {
    const params = parseAppParams({});
    expect(params.subsystem).toBe("NE");
    expect(params.technology).toBe("WIND");
    expect(params.run).toBe("12Z");
  });

  test("a hand-edited URL falls back rather than crashing", () => {
    const params = parseAppParams({ subsystem: "SIN", technology: "hydro", run: "18Z" });
    expect(params.subsystem).toBe("NE");
    expect(params.technology).toBe("WIND");
    expect(params.run).toBe("12Z");
  });

  test("valid values survive", () => {
    const params = parseAppParams({ subsystem: "S", technology: "solar", run: "00Z" });
    expect(params.subsystem).toBe("S");
    expect(params.technology).toBe("SOLAR");
    expect(params.run).toBe("00Z");
  });

  test("the URL keeps its own lowercase spelling of technology", () => {
    // The domain, the database enum and the API all say WIND / SOLAR. A URL
    // reads better lowercase, so params.ts owns the translation — the same
    // shape of boundary as the ONS carga API calling SE "SECO". The transport
    // spelling must never leak inward, and the domain spelling must never
    // appear in a query string.
    expect(parseAppParams({ technology: "wind" }).technology).toBe("WIND");
    expect(technologyParam("SOLAR")).toBe("solar");
    // An uppercase value in the URL is not the transport form. Asserted with
    // SOLAR so the expectation cannot be satisfied by the WIND default.
    expect(parseAppParams({ technology: "SOLAR" }).technology).toBe("WIND");
  });
});

describe("defects the specs found in this prototype", () => {
  test("the replay day band is joint, never the sum of the hourly bands", () => {
    // docs/specs/replay.md caught this screen adding 24 hourly P90s. That
    // assumes every hour lands at its 90th percentile together, which is a far
    // worse day than a 90th-percentile day.
    for (const day of REPLAY_DAYS) {
      const summed = day.forecast.reduce(
        (acc, h) => ({
          p10: acc.p10 + h.constrainedOff.p10,
          p90: acc.p90 + h.constrainedOff.p90,
        }),
        { p10: 0, p90: 0 },
      );
      const joint = day.forecastDayEnergy;
      expect(joint.p90).toBeLessThan(summed.p90);
      expect(joint.p10).toBeGreaterThan(summed.p10);
      expect(joint.p10).toBeLessThanOrEqual(joint.p50);
      expect(joint.p50).toBeLessThanOrEqual(joint.p90);
    }
  });

  test("the reference flexible load can actually shed what it claims", () => {
    // flex-optimizer.md rejects max_shift_mw above the implied baseline as
    // SHIFT_EXCEEDS_BASELINE — a load cannot shed more than it was drawing.
    const baselineMw = DEFAULT_LOAD.dailyEnergyMwh / 24;
    expect(DEFAULT_LOAD.maxShiftMw).toBeLessThanOrEqual(baselineMw);
  });

  /**
   * The battery that cannot fill on energy it never received used to be
   * asserted here, against the web app's own `evaluatePlan`. There is one
   * implementation of the execution rule now and it is Python's, so the
   * assertion moved to where the rule lives —
   * `apps/ml/tests/test_optimizer_simulator.py`, and to the golden vectors in
   * `packages/core/fixtures/execution-rule/`, one of which — `the-day-that-
   * never-came.json` — is exactly that: a plan built for a median day and
   * executed against a realisation of nothing at all.
   */
});

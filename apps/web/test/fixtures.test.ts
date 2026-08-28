import { describe, expect, test } from "bun:test";
import { parseAppParams, technologyParam } from "../src/components/app/params";
import {
  buildForecast,
  buildMitigationSteps,
  DEFAULT_BATTERY,
  DEFAULT_LOAD,
  evaluatePlan,
  planDispatch,
  REPLAY_DAYS,
  riskClass,
  roundProbability,
} from "../src/lib/fixtures";

describe("forecast fixtures", () => {
  const forecast = buildForecast("NE", "WIND", "12Z");

  test("emits 24 hours", () => {
    expect(forecast.hours).toHaveLength(24);
  });

  test("every hour's band is ordered P10 <= P50 <= P90", () => {
    for (const hour of forecast.hours) {
      expect(hour.constrainedOff.p10).toBeLessThanOrEqual(hour.constrainedOff.p50);
      expect(hour.constrainedOff.p50).toBeLessThanOrEqual(hour.constrainedOff.p90);
    }
  });

  test("the day total is not the sum of the hourly quantiles", () => {
    // Quantiles do not add. If this ever becomes an equality, someone has
    // summed a band and the screens are lying about the interval.
    const sumP90 = forecast.hours.reduce((acc, h) => acc + h.constrainedOff.p90, 0);
    expect(forecast.dailyEnergy.p90).toBeLessThan(sumP90);
  });

  test("the 12Z run carries a narrower band than 00Z", () => {
    const early = buildForecast("NE", "WIND", "00Z");
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

describe("prototype heuristic", () => {
  const offered = [0, 0, 40, 60, 80, 40, 0, 0, 0, 0, 0, 0];

  test("never imports from the grid", () => {
    const plan = planDispatch({
      offeredMwh: offered,
      battery: DEFAULT_BATTERY,
      load: DEFAULT_LOAD,
      thresholdMw: 5,
    });
    const result = evaluatePlan(plan, offered, 5);
    for (const hour of result.dispatch) {
      expect(hour.absorbedMwh).toBeLessThanOrEqual(hour.offeredMwh + 1e-9);
      expect(hour.absorbedMwh).toBeGreaterThanOrEqual(0);
    }
  });

  test("the battery never charges and discharges in the same hour", () => {
    const plan = planDispatch({
      offeredMwh: offered,
      battery: DEFAULT_BATTERY,
      load: null,
      thresholdMw: 5,
    });
    for (let t = 0; t < offered.length; t++) {
      expect(plan.batteryChargeMw[t] * plan.batteryDischargeMw[t]).toBe(0);
    }
  });

  test("avoidability is null, never zero, when there is nothing to avoid", () => {
    const quiet = offered.map(() => 0);
    const plan = planDispatch({
      offeredMwh: quiet,
      battery: DEFAULT_BATTERY,
      load: DEFAULT_LOAD,
      thresholdMw: 5,
    });
    expect(evaluatePlan(plan, quiet, 5).avoidability).toBeNull();
  });
});

describe("mitigation steps", () => {
  const steps = buildMitigationSteps({
    forecast: buildForecast("NE", "WIND", "12Z"),
    battery: DEFAULT_BATTERY,
    load: DEFAULT_LOAD,
    basis: "p50",
  });

  test("three steps, in reveal order", () => {
    expect(steps.map((s) => s.key)).toEqual(["no_action", "battery", "battery_and_load"]);
  });

  test("each step leaves no more curtailment than the previous one", () => {
    expect(steps[1].remaining.p50).toBeLessThanOrEqual(steps[0].remaining.p50);
    expect(steps[2].remaining.p50).toBeLessThanOrEqual(steps[1].remaining.p50);
  });

  test("no action has no avoidability, and the others do", () => {
    expect(steps[0].avoidability).toBeNull();
    expect(steps[2].avoidability).not.toBeNull();
  });

  test("the share avoided is worst on the P90 realisation", () => {
    const band = steps[2].avoidability;
    expect(band).not.toBeNull();
    if (band !== null) {
      // The band is stored ascending, so p10 is the pessimistic end.
      expect(band.p10).toBeLessThanOrEqual(band.p50);
    }
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

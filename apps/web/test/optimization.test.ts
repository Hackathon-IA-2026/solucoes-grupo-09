import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OptimizationResult, Scenario } from "@wattsteer/core/api";
import { defaultScenario, scenarioLoad } from "../src/components/app/scenario";
import { en as EN } from "../src/i18n/copy.en";
import { pt as PT } from "../src/i18n/copy.pt";
import { mitigationSteps, SOLVED_STEPS, stepScenario } from "../src/lib/optimization";

/**
 * The reveal, assembled from what the solver returned.
 *
 * **What is asserted here is the mapping and nothing else.** The plan's own
 * properties — the floor below the median, absorption never above what was
 * offered, no hour both charging and discharging — belong to the execution rule
 * and to the MILP, and they are asserted in `apps/ml` where those live. This
 * app used to hold a second implementation of the rule and assert them twice;
 * `docs/specs/api-surface.md` decision 6 deleted it, and asserting physics here
 * over a fixture written by hand would only be a test of the fixture.
 *
 * So the fixtures below are deliberately *not* physical. They carry values
 * chosen to be distinguishable — every field a different number — because the
 * failure this file exists to catch is a field read into the wrong slot, and a
 * plausible-looking fixture is exactly the one that hides it.
 */

const ORIGIN = "2026-08-28T15:00:00Z";

function result(over: Partial<OptimizationResult> = {}): OptimizationResult {
  return {
    scenarioHash: "a".repeat(64),
    forecastOrigin: ORIGIN,
    vintageFidelity: "point_in_time",
    thresholdMw: 37,
    planningBasis: "p50",
    executionRule: "follow_curtailment",
    baselineCurtailmentMwh: 1000,
    optimizedCurtailmentMwh: 700,
    avoidedEnergyMwh: 300,
    avoidability: 0.3,
    recoveredFloorMwh: 41,
    scored: {
      p10: { baselineMwh: 101, remainingMwh: 60, recoveredMwh: 41, avoidability: 0.11 },
      p50: { baselineMwh: 1000, remainingMwh: 700, recoveredMwh: 300, avoidability: 0.3 },
      p90: {
        baselineMwh: 2000,
        remainingMwh: 1580,
        recoveredMwh: 420,
        avoidability: 0.21,
      },
    },
    dispatch: [
      { hourLocal: 13, batteryChargeMw: 120, absorbedMwh: 118 },
      { hourLocal: 14, batteryChargeMw: 90, stateOfChargeMwh: 210, absorbedMwh: 88 },
    ],
    storedAtHorizonEndMwh: 190,
    roundTripLossMwh: 12,
    economicScenario: { brlPerMwh: 180, brl: 54_000 },
    solver: { backend: "SCIP", status: "OPTIMAL", wallTimeMs: 3 },
    ...over,
  };
}

const SCENARIO = defaultScenario("NE", "2026-08-29");

describe("the step scenarios", () => {
  it("the two solved steps are the battery, then the battery and the load", () => {
    expect([...SOLVED_STEPS]).toEqual(["battery", "battery_and_load"]);
  });

  it("the battery step is the reader's scenario with the load removed", () => {
    const only = stepScenario(SCENARIO, "battery");
    expect(only.assets.map((asset) => asset.assetType)).toEqual(["battery"]);
    // The load is *removed*, not defaulted away: everything else is the
    // scenario the reader's link describes.
    expect({ ...only, assets: [] }).toEqual({ ...SCENARIO, assets: [] });
  });

  it("the full step is the scenario itself, byte for byte", () => {
    expect(stepScenario(SCENARIO, "battery_and_load")).toEqual(SCENARIO);
  });

  it("a battery carrying fields the editors never touch keeps them", () => {
    // The step is a subset of the fleet. A link that pinned a forecast origin
    // or an availability window is solved as it was shared.
    const rich: Scenario = {
      ...SCENARIO,
      forecastOrigin: ORIGIN,
      assets: [{ ...SCENARIO.assets[0], availableFrom: "11:00" }, scenarioLoad(SCENARIO)],
    } as Scenario;
    const only = stepScenario(rich, "battery");
    expect(only.forecastOrigin).toBe(ORIGIN);
    expect(only.assets[0]).toEqual(rich.assets[0]);
  });

  it("no step asks the solver for an empty fleet", () => {
    // A scenario with no assets is `assets` below its minimum and the refusal
    // table rejects it — correctly, since an empty fleet is not a what-if. "No
    // action" is therefore read off the baseline rather than solved.
    for (const step of SOLVED_STEPS) {
      expect(stepScenario(SCENARIO, step).assets.length).toBeGreaterThan(0);
    }
  });
});

describe("the reveal is read off the answer", () => {
  const battery = result({
    recoveredFloorMwh: 20,
    scored: {
      p10: { baselineMwh: 101, remainingMwh: 81, recoveredMwh: 20, avoidability: 0.05 },
      p50: {
        baselineMwh: 1000,
        remainingMwh: 820,
        recoveredMwh: 180,
        avoidability: 0.18,
      },
      p90: {
        baselineMwh: 2000,
        remainingMwh: 1760,
        recoveredMwh: 240,
        avoidability: 0.12,
      },
    },
    economicScenario: { brlPerMwh: 180, brl: 32_400 },
    storedAtHorizonEndMwh: 90,
    roundTripLossMwh: 7,
  });
  const steps = mitigationSteps({ battery, battery_and_load: result() });

  it("three steps, in reveal order", () => {
    expect(steps.map((step) => step.key)).toEqual([
      "no_action",
      "battery",
      "battery_and_load",
    ]);
  });

  it("no action is the day, read from the baseline the solver reported", () => {
    expect(steps[0].remaining).toEqual({ p10: 101, p50: 1000, p90: 2000 });
    expect(steps[0].recovered).toEqual({ p10: 0, p50: 0, p90: 0 });
    expect(steps[0].dispatch).toEqual([]);
  });

  it("nothing attempted is an absence, never a zero", () => {
    // The screen renders `—` for both. A `0` would read as "nothing could be
    // avoided" rather than "nothing was attempted", and priced at R$ 0 it would
    // read as an outcome.
    expect(steps[0].avoidability).toBeNull();
    expect(steps[0].brl).toBeNull();
  });

  it("the remaining, recovered and avoidability bands come from `scored`", () => {
    expect(steps[1].remaining).toEqual({ p10: 81, p50: 820, p90: 1760 });
    expect(steps[2].recovered).toEqual({ p10: 41, p50: 300, p90: 420 });
    expect(steps[2].avoidability).toEqual({ p10: 0.11, p50: 0.3, p90: 0.21 });
  });

  it("the shares are keyed by realisation and are not sorted into an interval", () => {
    const shares = steps[2].avoidability;
    expect(shares).not.toBeNull();
    if (shares !== null) {
      // The fixture's three are genuinely unordered — the median share is the
      // largest of them — and the mapping must carry them through unsorted, or
      // a strip would draw its median marker outside its own fill.
      expect(shares.p50).toBeGreaterThan(shares.p90);
      expect(shares.p10).toBeLessThan(shares.p90);
    }
  });

  it("an undefined share on any realisation makes the set null, not partial", () => {
    const quiet = result({
      scored: {
        p10: { baselineMwh: 0, remainingMwh: 0, recoveredMwh: 0, avoidability: null },
        p50: { baselineMwh: 40, remainingMwh: 40, recoveredMwh: 0, avoidability: 0 },
        p90: { baselineMwh: 90, remainingMwh: 88, recoveredMwh: 2, avoidability: 0.02 },
      },
    });
    expect(
      mitigationSteps({ battery: quiet, battery_and_load: quiet })[2].avoidability,
    ).toBeNull();
  });

  it("the floor is the contract's field, not the band re-read", () => {
    // `recovered_floor_mwh == scored.p10.recovered_mwh` is an identity the
    // contract states. Reading it from the field rather than from the band is
    // what makes a service that broke the identity visible here.
    expect(steps[2].recoveredFloorMwh).toBe(41);
    expect(steps[1].recoveredFloorMwh).toBe(20);
  });

  it("every step carries the threshold and the forecast origin it was optimised against", () => {
    // The acceptance box. A figure whose threshold is not on it cannot be
    // compared with another one, and a plan without its origin is a statement
    // about whenever the page happened to load.
    for (const step of steps) {
      expect(step.thresholdMw).toBe(37);
      expect(step.forecastOrigin).toBe(ORIGIN);
    }
  });

  it("the money is the solver's own figure, not a second multiplication", () => {
    expect(steps[1].brl).toBe(32_400);
    expect(steps[2].brl).toBe(54_000);
  });

  it("a dispatch hour's absent components are drawn as zero, not as gaps", () => {
    // The schema makes every component optional — a fleet with no battery has
    // no battery leg — and the chart draws series. Defaulting is a rendering
    // decision and it happens once.
    expect(steps[2].dispatch[0]).toEqual({
      hourLocal: 13,
      offeredMwh: 0,
      batteryChargeMw: 120,
      batteryDischargeMw: 0,
      stateOfChargeMwh: 0,
      loadShiftUpMw: 0,
      loadShiftDownMw: 0,
      absorbedMwh: 118,
    });
  });
});

describe("the screen computes nothing", () => {
  it("Mitigate reads the solver's answer and no local evaluator", () => {
    // `test/one-execution-rule.test.ts` is the repository-wide guard; this is
    // the narrow one, on the screen the second implementation existed for.
    const screen = readFileSync(
      join(import.meta.dir, "..", "src", "app", "app", "mitigate.tsx"),
      "utf8",
    );
    for (const token of ["evaluatePlan", "planDispatch", "buildMitigationSteps"]) {
      expect(screen).not.toContain(token);
    }
    expect(screen).toContain("useOptimization");
  });

  /**
   * The step card's figure, and the arithmetic it stopped doing.
   *
   * It used to print `previous.remaining.p50 - step.remaining.p50` and call it
   * the energy the step recovers. The median of a difference is not the
   * difference of the medians — the same error `test/no-summed-bands.test.ts`
   * catches one operation over, and that guard now matches this shape too. The
   * honest number did not have to be invented: the solver scores every step
   * against the same three envelopes and reports `scored.p50.recovered_mwh`,
   * so the card reads the contract's own per-step recovery instead.
   */
  it("the step card reads the contract's per-step recovery, not a delta of two steps", () => {
    const screen = readFileSync(
      join(import.meta.dir, "..", "src", "app", "app", "mitigate.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, " "));
    expect(screen).toContain("step.recovered.p50");
    // The delta, in every spelling it could return in: the subtraction itself,
    // the prop that carried the other step, and the copy key that named it.
    expect(screen).not.toContain("previous");
    expect(screen).not.toContain("remaining.p50 -");
    expect(screen).not.toContain("stepDelta");
  });

  it("the card's sentence is a per-step recovery in both locales", () => {
    for (const catalogue of [EN.app.mitigate, PT.app.mitigate]) {
      const sentence: string = catalogue.stepRecovered;
      expect(sentence).toContain("{recovered}");
      // The realisation it is read off is on the sentence: an unlabelled
      // figure cannot be compared with the one on the next card.
      expect(sentence).toContain("P50");
      // "vs the previous step" was the claim the arithmetic could not support.
      expect(sentence).not.toContain("{delta}");
    }
    expect(EN.app.mitigate.stepRecovered).not.toBe(PT.app.mitigate.stepRecovered);
    // The old key is gone from both dictionaries rather than left orphaned.
    expect("stepDelta" in EN.app.mitigate).toBe(false);
    expect("stepDelta" in PT.app.mitigate).toBe(false);
  });

  it("the per-step recovery is a field on the answer and nothing is combined to make it", () => {
    const steps = mitigationSteps({
      battery: result({ scored: { ...result().scored } }),
      battery_and_load: result(),
    });
    // Read straight off `scored`, per realisation, with no cross-step term.
    expect(steps[1].recovered.p50).toBe(300);
    expect(steps[0].recovered.p50).toBe(0);
  });
});

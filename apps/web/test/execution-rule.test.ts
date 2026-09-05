import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DispatchPlan, evaluatePlan } from "../src/lib/fixtures/optimize";
import type { BatteryAsset } from "../src/lib/fixtures/types";

/**
 * Parity of the execution rule with the Python side.
 *
 * `apps/ml/tests/test_execution_rule_vectors.py` reads the **same** directory
 * and asserts the **same** `expected` values against
 * `wattsteer_ml.optimizer.simulator`. Neither side compares against the other —
 * only against the vectors — so a shared misunderstanding cannot cancel out.
 * See `packages/core/fixtures/execution-rule/README.md`.
 *
 * There is one implementation of the execution rule, and
 * `apps/ml/tests/test_one_simulator.py` walks the repository to keep it that
 * way. It runs in two languages because the prototype scores a plan in a
 * browser; this file is what makes the second site a *port* rather than a
 * reimplementation. A plan scored here and the same plan scored on the server
 * produce the same MWh, which is the only reason a Mitigate number and a Time
 * Machine number can be put beside each other at all.
 */

const FIXTURES = join(import.meta.dir, "../../../packages/core/fixtures/execution-rule");

/**
 * Two IEEE-754 doubles doing the same arithmetic in a different association
 * order. Eleven significant digits against figures in the hundreds of MWh; a
 * real divergence in the rule is orders of magnitude larger than this.
 */
const TOLERANCE_MWH = 1e-9;

interface Vector {
  name: string;
  thresholdMw: number;
  battery: {
    maxPowerMw: number;
    energyCapacityMwh: number;
    roundTripEfficiency: number;
    initialStateOfCharge: number;
  };
  plan: {
    batteryChargeMw: number[];
    batteryDischargeMw: number[];
    loadShiftUpMw: number[];
    loadShiftDownMw: number[];
  };
  realisationMwh: number[];
  expected: {
    baselineCurtailmentMwh: number;
    avoidedEnergyMwh: number;
    optimizedCurtailmentMwh: number;
    avoidability: number | null;
    storedAtHorizonEndMwh: number;
    roundTripLossMwh: number;
    dispatch: {
      hourLocal: number;
      batteryChargeMw: number;
      batteryDischargeMw: number;
      stateOfChargeMwh: number;
      absorbedMwh: number;
    }[];
  };
}

function vectors(): Vector[] {
  const files = readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .sort();
  // A directory that had gone missing would otherwise make a green run mean
  // nothing at all.
  expect(files.length).toBeGreaterThan(0);
  return files.map(
    (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Vector,
  );
}

test("no vector file is skipped", () => {
  // The listing above is flat, so this compares it against a *recursive* walk:
  // a vector filed under a subdirectory would be read by neither language, and
  // the non-emptiness guard cannot see one. `apps/ml/tests/
  // test_execution_rule_vectors.py` makes the same comparison on its side, so
  // adding a vector here is sufficient and neither language can skip one.
  const flat = readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const everywhere = readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  expect(everywhere).toEqual(flat);
});

function run(vector: Vector) {
  const battery: BatteryAsset = {
    assetType: "battery",
    maxPowerMw: vector.battery.maxPowerMw,
    energyCapacityMwh: vector.battery.energyCapacityMwh,
    roundTripEfficiency: vector.battery.roundTripEfficiency,
    initialStateOfCharge: vector.battery.initialStateOfCharge,
  };
  const plan: DispatchPlan = {
    batteryChargeMw: vector.plan.batteryChargeMw,
    batteryDischargeMw: vector.plan.batteryDischargeMw,
    // Never read: the trajectory is recomputed from the executed dispatch,
    // which is the correction this ticket exists for. Filled with a
    // deliberately absurd value so a version that started carrying the planned
    // state of charge again would fail here rather than merely look wrong.
    stateOfChargeMwh: vector.plan.batteryChargeMw.map(() => -1e9),
    loadShiftUpMw: vector.plan.loadShiftUpMw,
    loadShiftDownMw: vector.plan.loadShiftDownMw,
  };
  return evaluatePlan(plan, vector.realisationMwh, vector.thresholdMw, battery);
}

describe("the execution rule agrees with the Python implementation", () => {
  for (const vector of vectors()) {
    describe(vector.name, () => {
      test("the scalars match the vector", () => {
        const result = run(vector);
        const want = vector.expected;

        expect(result.baselineCurtailmentMwh).toBeCloseTo(want.baselineCurtailmentMwh, 9);
        expect(result.avoidedEnergyMwh).toBeCloseTo(want.avoidedEnergyMwh, 9);
        expect(result.optimizedCurtailmentMwh).toBeCloseTo(
          want.optimizedCurtailmentMwh,
          9,
        );
        expect(result.storedAtHorizonEndMwh).toBeCloseTo(want.storedAtHorizonEndMwh, 9);
        expect(result.roundTripLossMwh).toBeCloseTo(want.roundTripLossMwh, 9);

        if (want.avoidability === null) {
          // null, never 0. The distinction is the whole point of the field.
          expect(result.avoidability).toBeNull();
        } else {
          expect(result.avoidability).not.toBeNull();
          expect(result.avoidability ?? Number.NaN).toBeCloseTo(want.avoidability, 9);
        }
      });

      test("every hour matches the vector", () => {
        // Two rules can reach the same daily figure by different trajectories —
        // the prototype's bug did exactly that, reporting the right absorption
        // alongside the wrong state of charge — so the trajectory is compared
        // too, hour by hour.
        const result = run(vector);
        expect(result.dispatch).toHaveLength(vector.expected.dispatch.length);

        for (const [index, want] of vector.expected.dispatch.entries()) {
          const hour = result.dispatch[index];
          expect(hour.hourLocal).toBe(want.hourLocal);
          expect(Math.abs(hour.batteryChargeMw - want.batteryChargeMw)).toBeLessThan(
            TOLERANCE_MWH,
          );
          expect(
            Math.abs(hour.batteryDischargeMw - want.batteryDischargeMw),
          ).toBeLessThan(TOLERANCE_MWH);
          expect(Math.abs(hour.stateOfChargeMwh - want.stateOfChargeMwh)).toBeLessThan(
            TOLERANCE_MWH,
          );
          expect(Math.abs(hour.absorbedMwh - want.absorbedMwh)).toBeLessThan(
            TOLERANCE_MWH,
          );
        }
      });
    });
  }
});

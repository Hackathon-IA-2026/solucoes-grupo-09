/**
 * Mitigate's fixed inputs: the fleet the screen opens with, the ranges its
 * steppers move over, and the planning basis the product does not offer as a
 * choice.
 *
 * **Nothing here computes a plan any more.** `buildMitigationSteps`, the
 * `planDispatch` heuristic and the `evaluatePlan` execution rule it scored
 * against all lived in this directory; `docs/specs/api-surface.md` decision 6
 * deletes them rather than porting them, because
 * `docs/specs/flex-optimizer.md` requires exactly one implementation of the
 * execution rule in the repository and records that this one was wrong — it
 * clipped absorption but not the state of charge, so on a low realisation it
 * reported a battery filled with energy it never received. The Mitigate screen
 * calls `POST /v1/optimize` and `lib/optimization.ts` reads the answer;
 * `test/one-execution-rule.test.ts` walks the repository and keeps it deleted.
 */

import { REFERENCE_FLEET } from "@wattsteer/core";
import type { BatteryAsset, ShiftableLoadAsset } from "./types";

export const PLANNING_BASIS = "p50" as const;

/**
 * The default assets the screen opens with — the **published**
 * `REFERENCE_FLEET`, not a fixture of its own.
 *
 * ONS publishes no flexibility-asset registry, so a default fleet is a scenario
 * input rather than an inventory; but it is the same scenario input that floor
 * coverage, `Δ recovered_floor_mwh`, the featured-days list and the hot-swap
 * guardrail are all measured against, and those numbers only mean what they say
 * if every one of them used the same battery. So the sizes live once, in
 * `@wattsteer/core`, and this module spends them rather than restating them.
 *
 * A local copy stood here until this change, with a third set of sizes again
 * (70 MW of shift against 2,400 MWh/day) — valid, but not the fleet the
 * backtest scores against.
 */
export const DEFAULT_BATTERY: BatteryAsset = {
  assetType: "battery",
  maxPowerMw: REFERENCE_FLEET.battery.maxPowerMw,
  energyCapacityMwh: REFERENCE_FLEET.battery.energyCapacityMwh,
  roundTripEfficiency: REFERENCE_FLEET.battery.roundTripEfficiency,
  initialStateOfCharge: REFERENCE_FLEET.battery.initialStateOfCharge,
};

export const DEFAULT_LOAD: ShiftableLoadAsset = {
  assetType: "shiftable_load",
  maxPowerMw: REFERENCE_FLEET.shiftableLoad.maxPowerMw,
  maxShiftMw: REFERENCE_FLEET.shiftableLoad.maxShiftMw,
  shiftWindowHours: REFERENCE_FLEET.shiftableLoad.shiftWindowHours,
  dailyEnergyMwh: REFERENCE_FLEET.shiftableLoad.dailyEnergyMwh,
};

/**
 * Editable ranges for the asset parameter steppers.
 *
 * **The floors are the smallest *legal* value, not zero.** Every one of these
 * numbers now travels into a `Scenario` that `validateScenarioWire` refuses
 * rather than corrects, and the magnitude rule is the half-open `(0, cap]` —
 * so a stepper whose minimum is `0` is a stepper with a step that turns the
 * screen into a refusal. The ceilings stay well inside the published caps
 * (`MAX_POWER_MW`, `MAX_ENERGY_MWH`), because their job there is to bound a
 * public solver and their job here is to bound a demo.
 *
 * The cross-field rules — `SHIFT_EXCEEDS_CONNECTION` and
 * `SHIFT_EXCEEDS_BASELINE` — are deliberately *not* enforced by the ranges. A
 * stepper cannot express "at most the connection limit, which is another
 * stepper", and clamping to it silently would plan for a load the user did not
 * describe. Those two are reachable, and the screen renders the refusal.
 */
export const ASSET_LIMITS = {
  batteryPowerMw: { min: 25, max: 600, step: 25 },
  batteryEnergyMwh: { min: 50, max: 2400, step: 50 },
  roundTripEfficiency: { min: 0.7, max: 0.98, step: 0.02 },
  initialStateOfCharge: { min: 0.05, max: 0.95, step: 0.05 },
  loadConnectionMw: { min: 10, max: 400, step: 10 },
  loadShiftMw: { min: 10, max: 400, step: 10 },
  shiftWindowHours: { min: 1, max: 8, step: 1 },
  loadDailyEnergyMwh: { min: 100, max: 6000, step: 100 },
  brlPerMwh: { min: 20, max: 600, step: 10 },
} as const;

/**
 * The economic scenario. R$ appears only as a labelled scenario, with the
 * assumed R$/MWh visible on screen. No carbon claim is derivable from any of
 * this and none is offered.
 *
 * The rate itself is `BRL_PER_MWH` in `@wattsteer/core`, imported by the screen
 * directly. It used to be re-exported from here under a second name, which read
 * as a second assumption; it never was one, but the alias was worth removing
 * along with the real defect — the value lived in a package the optimizer,
 * which is Python, could not read.
 */

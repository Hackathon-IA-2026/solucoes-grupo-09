/**
 * Mitigate fixtures: the stepwise no-action → +battery → +flexible-load
 * reveal, computed from the day-ahead forecast and the user's asset
 * parameters through the prototype heuristic in `optimize.ts`.
 */

import { REFERENCE_FLEET } from "@wattsteer/core";
import { type DispatchPlan, evaluatePlan, planDispatch } from "./optimize";
import type {
  Band,
  BatteryAsset,
  CurtailmentBasis,
  MitigationStep,
  ShiftableLoadAsset,
  SubsystemDayForecast,
} from "./types";

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
  maxShiftMw: REFERENCE_FLEET.shiftableLoad.maxShiftMw,
  shiftWindowHours: REFERENCE_FLEET.shiftableLoad.shiftWindowHours,
  dailyEnergyMwh: REFERENCE_FLEET.shiftableLoad.dailyEnergyMwh,
};

/** Editable ranges for the asset parameter steppers. */
export const ASSET_LIMITS = {
  batteryPowerMw: { min: 0, max: 600, step: 25 },
  batteryEnergyMwh: { min: 0, max: 2400, step: 50 },
  roundTripEfficiency: { min: 0.7, max: 0.98, step: 0.02 },
  initialStateOfCharge: { min: 0, max: 1, step: 0.05 },
  loadShiftMw: { min: 0, max: 400, step: 10 },
  shiftWindowHours: { min: 1, max: 8, step: 1 },
  loadDailyEnergyMwh: { min: 0, max: 6000, step: 100 },
} as const;

function realisation(forecast: SubsystemDayForecast, key: keyof Band): number[] {
  return forecast.hours.map((h) => h.constrainedOff[key]);
}

function scoreAcrossBand(
  forecast: SubsystemDayForecast,
  plan: DispatchPlan,
  battery: BatteryAsset,
): { remaining: Band; recovered: Band; avoidability: Band | null } {
  const p10 = evaluatePlan(
    plan,
    realisation(forecast, "p10"),
    forecast.thresholdMw,
    battery,
  );
  const p50 = evaluatePlan(
    plan,
    realisation(forecast, "p50"),
    forecast.thresholdMw,
    battery,
  );
  const p90 = evaluatePlan(
    plan,
    realisation(forecast, "p90"),
    forecast.thresholdMw,
    battery,
  );
  const avoidable =
    p10.avoidability !== null && p50.avoidability !== null && p90.avoidability !== null;
  return {
    remaining: {
      p10: p10.optimizedCurtailmentMwh,
      p50: p50.optimizedCurtailmentMwh,
      p90: p90.optimizedCurtailmentMwh,
    },
    recovered: {
      p10: p10.avoidedEnergyMwh,
      p50: p50.avoidedEnergyMwh,
      p90: p90.avoidedEnergyMwh,
    },
    // The share avoided is *lowest* on the P90 realisation (a fixed fleet
    // covers less of a bigger event), so the band is inverted here on purpose.
    avoidability: avoidable
      ? {
          p10: p90.avoidability ?? 0,
          p50: p50.avoidability ?? 0,
          p90: p10.avoidability ?? 0,
        }
      : null,
  };
}

export interface MitigateInput {
  forecast: SubsystemDayForecast;
  battery: BatteryAsset;
  load: ShiftableLoadAsset;
  /** Which point of the band the plan is built against. */
  basis: CurtailmentBasis;
}

export function buildMitigationSteps(input: MitigateInput): MitigationStep[] {
  const { forecast, battery, load, basis } = input;
  const offered = realisation(forecast, basis);

  const nothing = planDispatch({
    offeredMwh: offered,
    battery: null,
    load: null,
    thresholdMw: forecast.thresholdMw,
  });
  const batteryOnly = planDispatch({
    offeredMwh: offered,
    battery,
    load: null,
    thresholdMw: forecast.thresholdMw,
  });
  const both = planDispatch({
    offeredMwh: offered,
    battery,
    load,
    thresholdMw: forecast.thresholdMw,
  });

  // Keys, not labels: the three steps are named in the dictionaries, so the
  // reveal reads "+ Bateria" or "+ Battery" without the fixture knowing which.
  const steps: { key: MitigationStep["key"]; plan: DispatchPlan }[] = [
    { key: "no_action", plan: nothing },
    { key: "battery", plan: batteryOnly },
    { key: "battery_and_load", plan: both },
  ];

  return steps.map(({ key, plan }) => {
    const scored = scoreAcrossBand(forecast, plan, battery);
    const onP50 = evaluatePlan(
      plan,
      realisation(forecast, "p50"),
      forecast.thresholdMw,
      battery,
    );
    return {
      key,
      remaining: scored.remaining,
      recovered: scored.recovered,
      avoidability: key === "no_action" ? null : scored.avoidability,
      dispatch: onP50.dispatch,
    };
  });
}

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

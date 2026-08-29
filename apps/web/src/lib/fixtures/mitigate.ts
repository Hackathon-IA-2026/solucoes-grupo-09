/**
 * Mitigate fixtures: the stepwise no-action → +battery → +flexible-load
 * reveal, computed from the day-ahead forecast and the user's asset
 * parameters through the prototype heuristic in `optimize.ts`.
 */

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
 * Default assets. ONS publishes no flexibility-asset registry, so these are
 * scenario inputs with defensible round numbers, not an inventory.
 */
export const DEFAULT_BATTERY: BatteryAsset = {
  assetType: "battery",
  label: "Battery",
  maxPowerMw: 100,
  energyCapacityMwh: 300,
  roundTripEfficiency: 0.92,
  initialStateOfCharge: 0.2,
};

/**
 * The reference flexible load.
 *
 * `dailyEnergyMwh` implies a baseline of `dailyEnergyMwh / 24`, and a load
 * cannot shed more than it was drawing — so `maxShiftMw` must not exceed it.
 * This fixture previously paired 70 MW of shift with 1,200 MWh/day, i.e. a
 * 50 MW baseline, which `docs/specs/flex-optimizer.md` rejects outright as
 * SHIFT_EXCEEDS_BASELINE. The demonstration wants the 70 MW, so the baseline
 * moves rather than the headline: 2,400 MWh/day is a 100 MW industrial load,
 * which is the size of thing that has 70 MW to move in the first place.
 */
export const DEFAULT_LOAD: ShiftableLoadAsset = {
  assetType: "shiftable_load",
  label: "Flexible load",
  maxShiftMw: 70,
  shiftWindowHours: 3,
  dailyEnergyMwh: 2400,
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

  const steps: { key: MitigationStep["key"]; label: string; plan: DispatchPlan }[] = [
    { key: "no_action", label: "No action", plan: nothing },
    { key: "battery", label: `+ ${battery.label}`, plan: batteryOnly },
    { key: "battery_and_load", label: `+ ${load.label}`, plan: both },
  ];

  return steps.map(({ key, label, plan }) => {
    const scored = scoreAcrossBand(forecast, plan, battery);
    const onP50 = evaluatePlan(
      plan,
      realisation(forecast, "p50"),
      forecast.thresholdMw,
      battery,
    );
    return {
      key,
      label,
      remaining: scored.remaining,
      recovered: scored.recovered,
      avoidability: key === "no_action" ? null : scored.avoidability,
      dispatch: onP50.dispatch,
    };
  });
}

/**
 * The economic scenario. R$ appears only here, labelled, with the assumed
 * R$/MWh visible on screen. No carbon claim is derivable from any of this and
 * none is offered.
 */
export { SCENARIO_BRL_PER_MWH as ECONOMIC_ASSUMPTION_BRL_PER_MWH } from "@/lib/economics";

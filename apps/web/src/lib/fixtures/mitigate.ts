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
  MitigationStep,
  ShiftableLoadAsset,
  SubsystemDayForecast,
} from "./types";

/**
 * **The optimizer plans against P50, and the user is never asked.**
 *
 * `docs/specs/flex-optimizer.md` settles it: planning on P10 collapses at a
 * hurdle forecaster — the hour-wise P10 is legitimately zero in any hour whose
 * occurrence is uncertain, (C5) then forbids charging in exactly the hours the
 * day turns out to be about, and the "conservative plan" is the do-nothing
 * plan. The conservatism belongs in the *claim* instead, which is what
 * `recoveredFloorMwh` is. The prototype used to take this as a parameter and
 * the screen used to offer it as a toggle; both are gone.
 */
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
    /**
     * **Keyed by realisation, not sorted into an interval.**
     *
     * `p10` here is the share avoided *on the P10 realisation*, and so on. It
     * used to be stored inverted — `p10` holding the P90 realisation's number —
     * on the argument that the share avoided is lowest at P90, which is true
     * and is the arithmetic the spec asks to make visible: a fixed fleet covers
     * a smaller share of a bigger event, so `avoidability(P90) < avoidability(P50)`.
     *
     * What that inversion assumed, and the reference profile disproves, is that
     * the three shares are *ordered*. They are not. The P10 realisation is
     * lower than both, for a different reason: a P50-built plan cannot absorb
     * energy that was never curtailed, so on the low edge the assets simply do
     * less — 34.6 MWh against 684.6, on a forecast whose P10 is zero in
     * nineteen hours of twenty-four. Stored as an ascending interval, that set
     * drew a strip whose median marker sat outside its own fill.
     *
     * So the shape carries the three realisations and the screen draws the span
     * between the smallest and the largest with the median marked, which is the
     * only reading of these three numbers that is not a lie about their order.
     */
    avoidability: avoidable
      ? {
          p10: p10.avoidability ?? 0,
          p50: p50.avoidability ?? 0,
          p90: p90.avoidability ?? 0,
        }
      : null,
  };
}

export interface MitigateInput {
  forecast: SubsystemDayForecast;
  battery: BatteryAsset;
  load: ShiftableLoadAsset;
}

export function buildMitigationSteps(input: MitigateInput): MitigationStep[] {
  const { forecast, battery, load } = input;
  const offered = realisation(forecast, PLANNING_BASIS);

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
    // The **scheduled** plan, on the planning envelope. Every top-level scalar
    // the contract carries is evaluated here and nowhere else; the promise is
    // the P10 column of `scored`, which is a different realisation of the same
    // plan rather than a different plan.
    const onPlanningEnvelope = evaluatePlan(
      plan,
      realisation(forecast, PLANNING_BASIS),
      forecast.thresholdMw,
      battery,
    );
    return {
      key,
      remaining: scored.remaining,
      recovered: scored.recovered,
      avoidability: key === "no_action" ? null : scored.avoidability,
      // `recovered_floor_mwh == scored.p10.recovered_mwh`, by construction and
      // not by coincidence — the contract states the identity and this is the
      // one place the prototype could break it.
      recoveredFloorMwh: scored.recovered.p10,
      storedAtHorizonEndMwh: onPlanningEnvelope.storedAtHorizonEndMwh,
      roundTripLossMwh: onPlanningEnvelope.roundTripLossMwh,
      dispatch: onPlanningEnvelope.dispatch,
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

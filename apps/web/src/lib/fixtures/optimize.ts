/**
 * A **prototype heuristic**, not the optimizer.
 *
 * The real Flex Optimizer is a MILP — one binary per battery per period for
 * charge/discharge mutual exclusion, Zerrahn & Schill's double-indexed
 * shiftable-load block, solved by SCIP through OR-Tools in ~3 ms inside the
 * HTTP request (`docs/research/optimizer-formulation.md`). None of that runs
 * in the browser, and this file does not pretend otherwise: it is a greedy
 * pass that respects the same physical limits so that editing an asset moves
 * the numbers in the right direction with the right magnitude. Every screen
 * that renders its output says so on the screen.
 *
 * Two properties of the real formulation are kept, because dropping them would
 * make the prototype *lie* rather than merely approximate:
 *
 *  - **Absorbed energy is the net increase in flexible demand**, so discharging
 *    is netted out. A version that counted charging alone would report
 *    absorbing more energy than the battery can physically hold.
 *  - **The assets may not import from the grid**: net demand increase is capped
 *    at the curtailment actually available in that hour, and is forbidden
 *    outright in hours with no curtailment.
 */

import type {
  BatteryAsset,
  HourlyDispatch,
  OptimizationResult,
  ShiftableLoadAsset,
} from "./types";

const SOC_FLOOR_FRACTION = 0.05;
const SOC_CEILING_FRACTION = 0.95;

export interface PlanInput {
  /** Curtailment offered per hour under the planning realisation, MWh. */
  offeredMwh: number[];
  battery: BatteryAsset | null;
  load: ShiftableLoadAsset | null;
  thresholdMw: number;
}

/** The plan: what the assets do, independent of which realisation occurs. */
export interface DispatchPlan {
  batteryChargeMw: number[];
  batteryDischargeMw: number[];
  stateOfChargeMwh: number[];
  loadShiftUpMw: number[];
  loadShiftDownMw: number[];
}

function zeros(n: number): number[] {
  return Array.from({ length: n }, () => 0);
}

/**
 * Greedy battery pass: charge into curtailment hours, and make room by
 * discharging in hours that have none, but only while curtailment remains
 * later in the day.
 */
function planBattery(offered: number[], battery: BatteryAsset | null): DispatchPlan {
  const n = offered.length;
  const plan: DispatchPlan = {
    batteryChargeMw: zeros(n),
    batteryDischargeMw: zeros(n),
    stateOfChargeMwh: zeros(n),
    loadShiftUpMw: zeros(n),
    loadShiftDownMw: zeros(n),
  };
  if (battery === null) {
    return plan;
  }

  const capacity = Math.max(0, battery.energyCapacityMwh);
  const floor = capacity * SOC_FLOOR_FRACTION;
  const ceiling = capacity * SOC_CEILING_FRACTION;
  // A single round-trip efficiency splits symmetrically; the loss enters the
  // balance asymmetrically (×ηc in, ÷ηd out), which is why it is split here.
  const eta = Math.sqrt(Math.max(0.01, Math.min(1, battery.roundTripEfficiency)));
  let soc = Math.min(
    ceiling,
    Math.max(floor, capacity * Math.max(0, Math.min(1, battery.initialStateOfCharge))),
  );

  // Remaining curtailment after each hour, so the battery only bothers making
  // room when there is something left to absorb.
  const remainingAfter = zeros(n);
  let acc = 0;
  for (let t = n - 1; t >= 0; t--) {
    remainingAfter[t] = acc;
    acc += offered[t];
  }

  for (let t = 0; t < n; t++) {
    if (offered[t] > 0) {
      const headroom = Math.max(0, ceiling - soc);
      const charge = Math.min(battery.maxPowerMw, offered[t], headroom / eta);
      plan.batteryChargeMw[t] = charge;
      soc += charge * eta;
    } else if (remainingAfter[t] > 0) {
      const available = Math.max(0, soc - floor);
      const discharge = Math.min(battery.maxPowerMw, available * eta);
      plan.batteryDischargeMw[t] = discharge;
      soc -= discharge / eta;
    }
    plan.stateOfChargeMwh[t] = soc;
  }
  return plan;
}

/**
 * Shiftable load: every up-shift must be compensated by down-shifts within
 * `shiftWindowHours`, which is what makes the daily energy conserved by
 * construction rather than by a separate constraint.
 */
function planLoad(
  offered: number[],
  load: ShiftableLoadAsset | null,
  plan: DispatchPlan,
): DispatchPlan {
  const n = offered.length;
  if (load === null) {
    return plan;
  }
  const window = Math.max(1, Math.round(load.shiftWindowHours));
  const maxShift = Math.max(0, load.maxShiftMw);
  // How much down-shift each hour can still take. The load's own baseline
  // consumption bounds it: it cannot give back more than it draws.
  const baseline = load.dailyEnergyMwh / n;
  const downCapacity = Array.from({ length: n }, () => Math.min(maxShift, baseline));

  // Biggest curtailment hours first — the greedy stand-in for the objective.
  const order = Array.from({ length: n }, (_, t) => t).sort(
    (a, b) => offered[b] - offered[a],
  );

  for (const t of order) {
    const alreadyAbsorbed = plan.batteryChargeMw[t] - plan.batteryDischargeMw[t];
    const room = Math.max(0, offered[t] - Math.max(0, alreadyAbsorbed));
    if (room <= 0) {
      continue;
    }
    let want = Math.min(maxShift, room);
    // Find compensating capacity inside the window, nearest hours first.
    const candidates: number[] = [];
    for (let d = 1; d <= window; d++) {
      for (const t2 of [t - d, t + d]) {
        if (t2 >= 0 && t2 < n && offered[t2] <= 0) {
          candidates.push(t2);
        }
      }
    }
    let shifted = 0;
    for (const t2 of candidates) {
      if (want <= 0) {
        break;
      }
      const take = Math.min(want, downCapacity[t2]);
      if (take <= 0) {
        continue;
      }
      downCapacity[t2] -= take;
      plan.loadShiftDownMw[t2] += take;
      want -= take;
      shifted += take;
    }
    plan.loadShiftUpMw[t] = shifted;
  }
  return plan;
}

export function planDispatch(input: PlanInput): DispatchPlan {
  const withBattery = planBattery(input.offeredMwh, input.battery);
  return planLoad(input.offeredMwh, input.load, withBattery);
}

/**
 * Score a plan against a realisation of the forecast.
 *
 * This is the whole reason the band survives to the headline number: the plan
 * is built once, against whichever point of the band the user pointed the
 * optimizer at, and then evaluated three times — against P10, P50 and P90 —
 * so "MWh recovered" arrives as an interval rather than as a single figure
 * that quietly assumes the median came true.
 */
export function evaluatePlan(
  plan: DispatchPlan,
  realisationMwh: number[],
  thresholdMw: number,
  battery?: BatteryAsset,
): OptimizationResult {
  const n = realisationMwh.length;
  const dispatch: HourlyDispatch[] = [];
  let baseline = 0;
  let absorbedTotal = 0;

  // The plan is made against a forecast; this evaluates it against a
  // realisation that may be smaller. The execution rule is: charge the
  // scheduled amount or what is actually curtailed, whichever is smaller.
  //
  // Reporting the *planned* state of charge alongside a clipped absorption
  // would show a battery filling on energy it never received — the chart and
  // the headline would disagree, and only the chart would be wrong. So the
  // trajectory is recomputed from what execution actually did.
  const capacity = battery ? Math.max(0, battery.energyCapacityMwh) : 0;
  const eta = battery
    ? Math.sqrt(Math.max(0.01, Math.min(1, battery.roundTripEfficiency)))
    : 1;
  let soc = battery
    ? capacity * Math.max(0, Math.min(1, battery.initialStateOfCharge))
    : 0;

  for (let t = 0; t < n; t++) {
    const offered = realisationMwh[t];
    baseline += offered;
    const netDemandIncrease =
      plan.batteryChargeMw[t] -
      plan.batteryDischargeMw[t] +
      plan.loadShiftUpMw[t] -
      plan.loadShiftDownMw[t];
    // No import from the grid: absorption is capped by what was curtailed.
    const absorbed = Math.max(0, Math.min(netDemandIncrease, offered));
    absorbedTotal += absorbed;

    // Scale the demand-increasing legs by however much of the plan the hour
    // could actually support. Both legs scale together, because the shortfall
    // is in the energy available, not in one asset's willingness.
    const executable =
      netDemandIncrease > 0 ? Math.min(1, offered / netDemandIncrease) : 1;
    const charge = plan.batteryChargeMw[t] * executable;
    const shiftUp = plan.loadShiftUpMw[t] * executable;
    const discharge = plan.batteryDischargeMw[t];

    if (battery) {
      soc = Math.max(0, Math.min(capacity, soc + charge * eta - discharge / eta));
    }

    dispatch.push({
      hourLocal: t,
      offeredMwh: offered,
      batteryChargeMw: charge,
      batteryDischargeMw: discharge,
      stateOfChargeMwh: battery ? soc : plan.stateOfChargeMwh[t],
      loadShiftUpMw: shiftUp,
      loadShiftDownMw: plan.loadShiftDownMw[t],
      absorbedMwh: absorbed,
    });
  }

  return {
    baselineCurtailmentMwh: baseline,
    optimizedCurtailmentMwh: baseline - absorbedTotal,
    avoidedEnergyMwh: absorbedTotal,
    // null, never 0, when there was nothing to avoid — a zero would read as
    // "nothing could be avoided".
    avoidability: baseline > 0 ? absorbedTotal / baseline : null,
    dispatch,
    thresholdMw,
  };
}

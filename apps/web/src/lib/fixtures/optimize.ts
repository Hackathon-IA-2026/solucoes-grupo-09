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
 *
 * The *planner* below is a heuristic and is allowed to be. The **scorer** is
 * not: `evaluatePlan` is the execution rule, and there is exactly one of those
 * in the repository per language — see its own doc comment, and
 * `apps/ml/tests/test_one_simulator.py`, which walks the repository to keep it
 * that way. Every KPI comes from it; nothing here reads a number off a plan.
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
 * **The execution rule.** One implementation, in this file, in this language —
 * and `apps/ml/src/wattsteer_ml/optimizer/simulator.py` is the other language's,
 * proved identical against the golden vectors in
 * `packages/core/fixtures/execution-rule/`. `apps/ml/tests/test_one_simulator.py`
 * walks the repository and fails if a third appears. That single shared code
 * path is what makes a backtest number comparable to a forecast number, and
 * `docs/specs/flex-optimizer.md` calls it the most important line it contains.
 *
 * > The plan is a schedule of *intended* dispatch. On the day, an asset charges
 * > the scheduled amount **or the amount actually being curtailed, whichever is
 * > smaller**, and discharges the scheduled amount or what its state of charge
 * > actually permits, whichever is smaller.
 *
 * ```
 * executedCharge    = min(plan.ch[t], headroom(soc), realisation[t])
 * executedDischarge = min(plan.dis[t], available(soc))
 * delta[t]          = executedCharge - executedDischarge + up[t] - down[t]
 * absorbed[t]       = max(0, min(delta[t], realisation[t]))
 * soc              += etaC * executedCharge - executedDischarge / etaD
 * ```
 *
 * This is the whole reason the band survives to the headline number: the plan
 * is built once, against whichever point of the band the optimizer was pointed
 * at, and evaluated three times — against P10, P50 and P90 — so "MWh recovered"
 * arrives as an interval rather than as a figure that quietly assumes the
 * median came true. And because the rule clips both legs against a state of
 * charge recomputed from the executed dispatch, a plan built for a big day and
 * executed against a small one absorbs *less* — never more, and never anything
 * it did not receive. Over-planning cannot overstate recovery, which is what
 * makes planning on P50 while promising the P10 edge coherent rather than
 * optimistic.
 *
 * Two things this used to get wrong, both of them flattering:
 *
 *  - it carried the **planned** state of charge alongside a clipped absorption,
 *    so on a realisation below the planning basis the chart showed a battery
 *    filling up on energy it never received — the headline fell and the
 *    trajectory did not, and only the trajectory was wrong;
 *  - it never clipped **discharge** to the available state of charge, so a plan
 *    could deliver energy the battery never stored.
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
  let roundTripLossMwh = 0;

  const capacity = battery ? Math.max(0, battery.energyCapacityMwh) : 0;
  const floor = capacity * SOC_FLOOR_FRACTION;
  const ceiling = capacity * SOC_CEILING_FRACTION;
  // A datasheet prints one round-trip number and the balance needs two, because
  // the loss enters asymmetrically: x etaC on the way in, / etaD on the way
  // out. Split sqrt(RTE), exactly as `Battery.fromRoundTrip` does on the Python
  // side, so the two never disagree about a 92 % battery.
  const eta = battery
    ? Math.sqrt(Math.max(0.01, Math.min(1, battery.roundTripEfficiency)))
    : 1;
  let soc = battery
    ? Math.min(
        ceiling,
        Math.max(
          floor,
          capacity * Math.max(0, Math.min(1, battery.initialStateOfCharge)),
        ),
      )
    : 0;

  for (let t = 0; t < n; t++) {
    const offered = realisationMwh[t];
    baseline += offered;

    // ...or the amount actually being curtailed, whichever is smaller.
    const headroom = Math.max(0, ceiling - soc);
    const charge = battery
      ? Math.min(plan.batteryChargeMw[t], headroom / eta, offered)
      : 0;
    // ...or what its state of charge actually permits, whichever is smaller.
    const stored = Math.max(0, soc - floor);
    const discharge = battery ? Math.min(plan.batteryDischargeMw[t], stored * eta) : 0;
    if (battery) {
      soc += eta * charge - discharge / eta;
      roundTripLossMwh += (1 - eta) * charge + (1 / eta - 1) * discharge;
    }

    // The net increase in flexible demand, which is what stops a discharge in
    // an oversupply hour being counted as absorption. The load's shift is
    // energy-conserving by construction and is not clipped by the realisation;
    // absorption is.
    const shiftUp = plan.loadShiftUpMw[t];
    const shiftDown = plan.loadShiftDownMw[t];
    const netDemandIncrease = charge - discharge + shiftUp - shiftDown;
    // No import from the grid, and no negative absorption.
    const absorbed = Math.max(0, Math.min(netDemandIncrease, offered));
    absorbedTotal += absorbed;

    dispatch.push({
      hourLocal: t,
      offeredMwh: offered,
      batteryChargeMw: charge,
      batteryDischargeMw: discharge,
      stateOfChargeMwh: soc,
      loadShiftUpMw: shiftUp,
      loadShiftDownMw: shiftDown,
      absorbedMwh: absorbed,
    });
  }

  // `thresholdMw` gates whether the ratio is *defined*; it never enters the
  // ratio. The baseline is the whole realisation, unfiltered, because the
  // threshold is a property of the CurtailmentHour label and has nothing to do
  // with what a battery can absorb - filtering the denominator by it would make
  // the Avoidability Score move when someone tuned an episode parameter.
  const hasCurtailmentHour = realisationMwh.some((mwh) => mwh >= thresholdMw);

  return {
    baselineCurtailmentMwh: baseline,
    optimizedCurtailmentMwh: baseline - absorbedTotal,
    avoidedEnergyMwh: absorbedTotal,
    // null, never 0, when there was nothing to avoid - a zero would read as
    // "nothing could be avoided". A day of noise fully absorbed is undefined
    // too, or it would render a triumphant 100 %.
    avoidability: hasCurtailmentHour && baseline > 0 ? absorbedTotal / baseline : null,
    dispatch,
    thresholdMw,
    storedAtHorizonEndMwh: soc,
    roundTripLossMwh,
  };
}

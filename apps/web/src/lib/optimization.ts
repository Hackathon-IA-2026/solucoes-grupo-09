/**
 * The Mitigate reveal, assembled from what the solver returned.
 *
 * **Nothing here computes a KPI.** Every number below is read off an
 * `OptimizationResult` that `POST /v1/optimize` produced, because
 * `docs/specs/flex-optimizer.md` requires exactly one implementation of the
 * execution rule in the repository and `docs/specs/api-surface.md` decision 6
 * spends the web app's copy rather than porting it:
 *
 * > `apps/web/src/lib/fixtures/optimize.ts`'s `evaluatePlan` and `planDispatch`
 * > are deleted, not ported. `replay.md` requires exactly one execution rule in
 * > the repository and `flex-optimizer.md` records that this copy is wrong.
 *
 * `test/one-execution-rule.test.ts` walks the repository in the default test
 * run and fails if a second one appears, in either language.
 *
 * **Two solves, three steps, and the third is not a solve.** The reveal is
 * "nothing → battery → battery and flexible load", and only the last two are
 * plans. "No action" is the *day*, not a dispatch: its remaining curtailment is
 * the baseline the solver already reports per realisation, its recovery is
 * zero by construction and its avoidability is `null` because nothing was
 * attempted. Asking the solver for it would mean sending a scenario with no
 * assets, which the refusal table rejects — correctly, since an empty fleet is
 * not a what-if.
 *
 * **Every step carries the threshold and the origin it was optimised
 * against.** They are properties of the answer, not of the screen: a figure
 * whose threshold is not on it cannot be compared with another one, and a
 * forecast origin is what makes a plan a record rather than a timestamp of when
 * somebody loaded the page.
 */

import type { OptimizationResult, Scenario } from "@wattsteer/core/api";
import type { Band, HourlyDispatch, MitigationStep } from "@/lib/fixtures";

/** The two configurations that are genuinely a plan, in reveal order. */
export const SOLVED_STEPS = ["battery", "battery_and_load"] as const;

export type SolvedStep = (typeof SOLVED_STEPS)[number];

/**
 * The scenario one step asks the solver about — the reader's scenario with
 * assets *removed*, never rebuilt.
 *
 * Spread over what arrived, so a link carrying an availability window, an
 * explicit efficiency pair or a pinned `forecast_origin` is solved as the link
 * describes it. The step is a subset of the fleet and nothing else.
 */
export function stepScenario(scenario: Scenario, step: SolvedStep): Scenario {
  if (step === "battery_and_load") {
    return scenario;
  }
  return {
    ...scenario,
    assets: scenario.assets.filter((asset) => asset.assetType === "battery"),
  };
}

function bandOf(
  result: OptimizationResult,
  read: (realisation: OptimizationResult["scored"]["p50"]) => number,
): Band {
  return {
    p10: read(result.scored.p10),
    p50: read(result.scored.p50),
    p90: read(result.scored.p90),
  };
}

/**
 * The three avoidability shares, **keyed by realisation and not sorted into an
 * interval** — `p10` is the share avoided on the P10 realisation. They are
 * genuinely unordered: a fixed fleet covers a smaller share of a bigger event,
 * and on the low realisation a median-built plan cannot absorb energy that was
 * never curtailed. `null` when any one of them is undefined, because a partial
 * band would be three numbers pretending to be a set.
 */
function avoidabilityOf(result: OptimizationResult): Band | null {
  const { p10, p50, p90 } = result.scored;
  if (
    p10.avoidability === null ||
    p50.avoidability === null ||
    p90.avoidability === null
  ) {
    return null;
  }
  return { p10: p10.avoidability, p50: p50.avoidability, p90: p90.avoidability };
}

/**
 * The wire's dispatch hour, with its optional fields defaulted for the chart.
 *
 * The schema makes every component optional because a scenario with no battery
 * has no battery leg to report; the chart draws a series and needs a number.
 * Defaulting is a rendering decision and lives here, once, rather than in six
 * places inside a chart.
 */
function dispatchOf(result: OptimizationResult): HourlyDispatch[] {
  return result.dispatch.map((hour) => ({
    hourLocal: hour.hourLocal,
    offeredMwh: hour.offeredMwh ?? 0,
    batteryChargeMw: hour.batteryChargeMw ?? 0,
    batteryDischargeMw: hour.batteryDischargeMw ?? 0,
    stateOfChargeMwh: hour.stateOfChargeMwh ?? 0,
    loadShiftUpMw: hour.loadShiftUpMw ?? 0,
    loadShiftDownMw: hour.loadShiftDownMw ?? 0,
    absorbedMwh: hour.absorbedMwh ?? 0,
  }));
}

/**
 * The reveal: no action, then each solved configuration in order.
 *
 * `results` is keyed by step so a caller cannot silently hand them over in the
 * wrong order — the difference between "+ Battery" and "+ Flexible load" is a
 * step delta the screen renders as a claim.
 */
export function mitigationSteps(
  results: Record<SolvedStep, OptimizationResult>,
): MitigationStep[] {
  // The baseline is a property of the day and every solve reports the same one;
  // read from the full fleet's answer, which is the one the screen opens on.
  const day = results.battery_and_load;
  const noAction: MitigationStep = {
    key: "no_action",
    remaining: bandOf(day, (realisation) => realisation.baselineMwh),
    recovered: { p10: 0, p50: 0, p90: 0 },
    // Nothing was attempted, so there is no share of anything. `null`, never 0.
    avoidability: null,
    recoveredFloorMwh: 0,
    storedAtHorizonEndMwh: 0,
    roundTripLossMwh: 0,
    dispatch: [],
    brl: null,
    thresholdMw: day.thresholdMw,
    forecastOrigin: day.forecastOrigin,
  };

  return [
    noAction,
    ...SOLVED_STEPS.map((step) => {
      const result = results[step];
      return {
        key: step,
        remaining: bandOf(result, (realisation) => realisation.remainingMwh),
        recovered: bandOf(result, (realisation) => realisation.recoveredMwh),
        avoidability: avoidabilityOf(result),
        // `recovered_floor_mwh == scored.p10.recovered_mwh` by contract. Read
        // from the field the contract names rather than from the band, so a
        // service that broke the identity is visible here rather than hidden.
        recoveredFloorMwh: result.recoveredFloorMwh,
        storedAtHorizonEndMwh: result.storedAtHorizonEndMwh,
        roundTripLossMwh: result.roundTripLossMwh,
        dispatch: dispatchOf(result),
        brl: result.economicScenario.brl,
        thresholdMw: result.thresholdMw,
        forecastOrigin: result.forecastOrigin,
      } satisfies MitigationStep;
    }),
  ];
}

/**
 * The Time Machine's reading of a `Replay`, and the only place one is read.
 *
 * **Nothing here computes a KPI, and nothing here scores a plan.** Every
 * number the screen shows is read off the object `GET /v1/replay` returned,
 * for the same reason `lib/optimization.ts` reads an `OptimizationResult`
 * rather than evaluating a plan in the browser:
 *
 * > `docs/specs/flex-optimizer.md` — the simulator that scores a live plan and
 * > the one that scores a replayed plan are the same function, imported, not
 * > reimplemented.
 *
 * `docs/specs/replay.md` calls that the one thing that should survive the spec
 * if only one thing does, and `test/one-execution-rule.test.ts` walks the whole
 * repository in the default test run to keep it true. So this module adapts
 * shapes and formats nothing else: it maps the contract's hours onto the shapes
 * the charts already draw, and it reads the day's figures out of the fields the
 * contract names them in.
 *
 * **Two fields of the contract are load-bearing here and are worth naming.**
 *
 *  - `forecast.day_total` is the day's energy as a **joint** band, drawn from
 *    the forecaster's path ensemble. It is read, never rebuilt: adding 24
 *    hourly P90s describes a day on which every hour lands at its own 90th
 *    percentile together, which is a far worse day than a 90th-percentile day.
 *    `test/no-summed-bands.test.ts` is the standing guard.
 *  - `actual.total_mwh` is the **denominator**, and it is the whole local day
 *    rather than the episode. An episode is the run of hours above
 *    `threshold_mw`, so scoring on episode hours would make "% avoided" move
 *    when the threshold moves — the reduction would look better simply for
 *    having drawn the episode more tightly.
 */

import type { Replay, ReplayForecastHour } from "@wattsteer/core/api";
import type {
  CurtailmentHourForecast,
  CurtailmentHourObservation,
  HourlyDispatch,
} from "@/lib/fixtures";

/*
  The lane a replay is pinned to used to be here, as
  `export { FIXTURE_LANE as REPLAY_LANE }`. It is read from `/v1/meta` now —
  `components/app/use-replay-lane.ts` carries the argument and the measurement
  that ended it. The gateway still never defaults a lane, and for the same
  reason: a post-go-live day has one candidate forecast per served lane and no
  rule yet says which one a replay is of.
*/

/**
 * The UTC instant an `America/Sao_Paulo` civil hour starts at.
 *
 * BRT is UTC−3 with no daylight saving since 2019, which is what makes this a
 * fixed offset rather than a zone lookup. The contract sends the actual as 24
 * ordered numbers and the forecast as 24 ordered hours — position **is** the
 * local hour, per the optimizer's horizon rule — so the instant is derived here
 * rather than sent, and the charts keep the `validTime` keys they already use.
 */
export function validTimeAt(targetDate: string, hourLocal: number): string {
  const [year, month, day] = targetDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hourLocal + 3, 0, 0)).toISOString();
}

/**
 * The forecast hours, as the fan chart draws them.
 *
 * No `split`: the replay contract carries none, the forecaster has one head per
 * subsystem, and a dominant-fleet ratio invented here would be a number no
 * model produced. The field is optional on the chart's shape for exactly this
 * case, and the readout omits the row rather than showing two zeroes.
 */
export function forecastHours(
  targetDate: string,
  hours: ReplayForecastHour[],
): CurtailmentHourForecast[] {
  return hours.map((hour, hourLocal) => ({
    validTime: validTimeAt(targetDate, hourLocal),
    hourLocal,
    constrainedOff: hour.constrainedOffMwh,
    // A sibling of the band, never its centre: the hourly model is a hurdle, so
    // the expectation exceeds the median whenever the hour is less than an even
    // chance to clear the threshold.
    expectedMwh: hour.expectedMwh,
    occurrenceProbability: hour.occurrenceProbability,
  }));
}

/** The settled profile, as the fan chart draws it. */
export function observedHours(
  targetDate: string,
  hours: number[],
): CurtailmentHourObservation[] {
  return hours.map((constrainedOffMwh, hourLocal) => ({
    validTime: validTimeAt(targetDate, hourLocal),
    hourLocal,
    constrainedOffMwh,
  }));
}

/**
 * One of the two dispatch series, with the contract's optional components
 * defaulted for a chart.
 *
 * The schema makes every component optional because a scenario with no battery
 * has no battery leg to report; a chart draws a series and needs a number.
 * Defaulting is a rendering decision and lives here, once — the same call
 * `lib/optimization.ts` makes for the live plan.
 */
export function dispatchSeries(hours: Replay["dispatch"]): HourlyDispatch[] {
  return hours.map((hour) => ({
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

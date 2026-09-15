/**
 * The Overview's reading of the gateway, and the only place one happens.
 *
 * The sibling of `lib/replay.ts` and `lib/optimization.ts`, with the same one
 * rule: **nothing here computes a figure.** Every number the screen shows is
 * read off a response, and this module's whole job is to put the contract's
 * fields under the names the charts already draw. A day total is not summed
 * from hours (`test/no-summed-bands.test.ts` is the standing guard, and the
 * reason is that quantiles do not add); a risk class is not derived from a
 * probability; an observed hour is not turned into a forecast one.
 *
 * **The risk class is read, not recomputed, and that is a change.** The map and
 * the rows used to call `riskClass(probability)` against `RISK_BINS` in
 * `lib/fixtures/grid.ts` — a local copy of the cut points. `GET
 * /v1/grid/outlook` carries both `risk_class` and the `risk_bins` it was cut
 * with, so recomputing one in the browser would be a second opinion about the
 * same number, held against a copy of the bins that nothing keeps in step. The
 * response's class travels to the components instead, which is why they take
 * {@link OutlookRow} rather than a whole forecast.
 *
 * **Observed and forecast stay apart.** `GET /v1/grid/now` and `GET
 * /v1/curtailment/hours` are settled megawatt-hours; `GET /v1/grid/outlook` and
 * `GET /v1/forecast/day-ahead` are a model's opinion about a day that has not
 * happened. With no artifact promoted the second pair refuses and the first
 * pair does not, so the two are mapped by different functions into different
 * shapes and no component takes both — the failure this splits the screen to
 * avoid is an observed total drawn in the place a forecast band was, under the
 * label the forecast band had.
 */

import type {
  Band,
  CurtailmentHour,
  CurtailmentHours,
  ForecastDayAhead,
  GridOutlook,
  RiskClass,
  SubsystemNow,
  SubsystemOutlook,
  TechnologySplit,
} from "@wattsteer/core/api";
import type {
  CurtailmentHourForecast,
  CurtailmentHourObservation,
  SubsystemCode,
} from "@/lib/fixtures";

/**
 * One subsystem on the map and in the rows.
 *
 * Narrower than a `SubsystemDayForecast` on purpose: the map and the rows never
 * had a use for `hours`, `forecastOrigin` or `targetDate`, and a shape that
 * demanded them forced `GET /v1/grid/outlook`'s four-subsystem answer — which
 * carries no hours at all — to be padded before it could be drawn. Padding a
 * response to fit a component is how an empty array becomes a flat line at
 * zero.
 *
 * `riskClass` is the wire's. See this module's header.
 */
export interface OutlookRow {
  readonly subsystem: SubsystemCode;
  readonly riskClass: RiskClass;
  readonly occurrenceProbability: number;
  readonly dailyEnergy: Band;
  readonly peakPower: Band;
  readonly dayExpectedMwh: number;
  readonly split: TechnologySplit;
}

/** The four subsystems of an outlook, in the order the gateway ranked them. */
export function outlookRows(outlook: GridOutlook): OutlookRow[] {
  return outlook.subsystems.map(rowOfOutlook);
}

function rowOfOutlook(each: SubsystemOutlook): OutlookRow {
  return {
    subsystem: each.subsystem,
    riskClass: each.riskClass,
    occurrenceProbability: each.dayOccurrenceProbability,
    dailyEnergy: each.dayEnergyMwh,
    peakPower: each.peakPowerMw,
    dayExpectedMwh: each.dayExpectedMwh,
    split: each.split,
  };
}

/**
 * The selected subsystem's own day, as a row.
 *
 * The day-ahead forecast and the outlook publish the same six day-grain figures
 * under the same names, so the deeper response reduces to the same row and the
 * screen does not have to know which call a figure came from.
 */
export function forecastRow(forecast: ForecastDayAhead): OutlookRow {
  return {
    subsystem: forecast.subsystem,
    riskClass: forecast.riskClass,
    occurrenceProbability: forecast.dayOccurrenceProbability,
    dailyEnergy: forecast.dayEnergyMwh,
    peakPower: forecast.peakPowerMw,
    dayExpectedMwh: forecast.dayExpectedMwh,
    split: forecast.split,
  };
}

/**
 * The forecast hours, as the fan chart draws them.
 *
 * One rename and nothing else: the wire says `constrained_off_mwh` for the band
 * and the chart's shape says `constrainedOff`. `expectedMwh` stays a sibling of
 * the band rather than being folded into it — the hourly model is a hurdle, so
 * the expectation exceeds the median whenever the hour is less than an even
 * chance to clear the threshold, and a fourth number inside the band would
 * invite exactly the reading the shape exists to prevent.
 */
export function forecastHours(forecast: ForecastDayAhead): CurtailmentHourForecast[] {
  return forecast.hours.map((hour) => ({
    validTime: hour.validTime,
    hourLocal: hour.hourLocal,
    constrainedOff: hour.constrainedOffMwh,
    expectedMwh: hour.expectedMwh,
    occurrenceProbability: hour.occurrenceProbability,
    split: hour.split,
  }));
}

/**
 * The Brasília civil day an instant falls in.
 *
 * BRT is UTC−3 with no daylight saving since 2019, which is what makes this a
 * subtraction rather than a zone lookup — the same arithmetic, in the same
 * direction, that `lib/replay.ts` does to build a `validTime` from a local
 * hour.
 */
function civilDayOf(validTime: string): string {
  return new Date(Date.parse(validTime) - 3 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * The settled profile for one **Brasília civil day**, as one series.
 *
 * Two things happen here and both are forced by the contract.
 *
 * **The technologies are added.** `GET /v1/curtailment/hours` returns rows at
 * (`Subsystem`, `Technology`, `valid_time`) grain — two rows per hour, wind and
 * solar — and the profile is one line per hour. Adding them is exact and is the
 * only arithmetic in this module: these are settled megawatt-hours at the same
 * grain over disjoint fleets, not quantiles, and the sum of what two fleets had
 * curtailed is what the subsystem had curtailed. It is the same addition that
 * lets `GET /v1/grid/now` publish a national total where
 * `GET /v1/grid/outlook` may not.
 *
 * **The civil day is cut here, because the route cannot cut it.** `from` and
 * `to` are civil *dates* resolved to UTC midnights, so the narrowest window the
 * route can be asked for is a UTC day — which in Brasília runs 21:00 the
 * evening before to 20:59. A panel headed "the last settled day" drawn from
 * that would be three hours of the previous day and twenty-one of this one,
 * under this one's date. So the caller asks for the two UTC days that contain
 * the civil day and the rows outside it are dropped, by their own `valid_time`.
 *
 * Hours the response does not carry are **absent**, not zero. An unsettled hour
 * and an hour that settled at zero are different facts, and a chart that draws
 * both as a point on the floor has published the first one as the second.
 */
export function observedHours(
  hours: CurtailmentHours,
  civilDate: string,
): CurtailmentHourObservation[] {
  const byHour = new Map<string, CurtailmentHourObservation>();
  for (const row of hours.rows) {
    if (civilDayOf(row.validTime) !== civilDate) {
      continue;
    }
    const found = byHour.get(row.validTime);
    byHour.set(row.validTime, {
      validTime: row.validTime,
      hourLocal: row.hourLocal,
      constrainedOffMwh: (found?.constrainedOffMwh ?? 0) + row.constrainedOffMwh,
    });
  }
  return [...byHour.values()].sort((a, b) => a.validTime.localeCompare(b.validTime));
}

/** The technologies a settled hour was curtailed across, summed. */
export function observedTotalMwh(rows: readonly CurtailmentHour[]): number {
  return rows.reduce((total, row) => total + row.constrainedOffMwh, 0);
}

/**
 * The four subsystems of `GET /v1/grid/now`, in the product's display order.
 *
 * The gateway returns them in whatever order the query settled on; the screen
 * shows N, NE, SE, S beside the same four names everywhere else. Ordering a
 * response is a rendering decision and this is where it is made.
 */
export function nowRows(
  subsystems: readonly SubsystemNow[],
  order: readonly SubsystemCode[],
): SubsystemNow[] {
  return order
    .map((code) => subsystems.find((each) => each.subsystem === code))
    .filter((each): each is SubsystemNow => each !== undefined);
}

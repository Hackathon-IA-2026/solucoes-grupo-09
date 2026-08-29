/**
 * Time Machine fixtures.
 *
 * A `Replay` is a read mode, not a table: a `Scenario` whose `target_date` is
 * in the past, evaluated with `AsOf(t)` pinned to the D−1 run's `published_at`
 * and then scored against the `Observation`s.
 *
 * The fixture deliberately contains days on both sides of two honesty lines,
 * because a screen that only ever shows the flattering case never has to prove
 * it can label the other one:
 *
 *  - **Ingestion go-live** splits `point_in_time` from `revision_optimistic`.
 *  - **The training window** splits a genuine out-of-sample counterfactual
 *    from an in-sample replay, which is a much weaker claim.
 */

import type {
  Band,
  CurtailmentHourForecast,
  CurtailmentHourObservation,
  ReplayDay,
} from "./types";

/** WattSteer began ingesting on this date; before it, vintage is unrecoverable. */
export const INGESTION_GO_LIVE = "2026-07-01";

/** The artifact on serving duty was trained on data up to this date. */
export const MODEL_TRAINED_THROUGH = "2026-05-31";

interface DaySpec {
  id: string;
  label: string;
  date: string;
  subsystem: ReplayDay["episode"]["subsystem"];
  technology: ReplayDay["episode"]["technology"];
  startHour: number;
  endHour: number;
  peakMw: number;
  /** Forecast bias: >1 means the model over-forecast the event. */
  bias: number;
  spread: number;
  recoveredShare: number;
  scenarioLabel: string;
}

const DAYS: DaySpec[] = [
  {
    id: "2025-09-14-ne-wind",
    label: "14 Sep 2025 · NORDESTE wind",
    date: "2025-09-14",
    subsystem: "NE",
    technology: "WIND",
    startHour: 0,
    endHour: 9,
    peakMw: 138,
    bias: 0.88,
    spread: 0.34,
    recoveredShare: 0.459,
    scenarioLabel: "100 MW / 300 MWh battery + 70 MW flexible load",
  },
  {
    id: "2026-03-22-ne-solar",
    label: "22 Mar 2026 · NORDESTE solar",
    date: "2026-03-22",
    subsystem: "NE",
    technology: "SOLAR",
    startHour: 9,
    endHour: 17,
    peakMw: 210,
    bias: 1.14,
    spread: 0.29,
    recoveredShare: 0.318,
    scenarioLabel: "100 MW / 300 MWh battery + 70 MW flexible load",
  },
  {
    id: "2026-08-11-ne-wind",
    label: "11 Aug 2026 · NORDESTE wind",
    date: "2026-08-11",
    subsystem: "NE",
    technology: "WIND",
    startHour: 1,
    endHour: 8,
    peakMw: 121,
    bias: 0.96,
    spread: 0.26,
    recoveredShare: 0.401,
    scenarioLabel: "100 MW / 300 MWh battery + 70 MW flexible load",
  },
];

function wobble(seed: number, hour: number): number {
  const x = Math.sin(seed * 4.117 + hour * 21.71) * 9137.13;
  return x - Math.floor(x);
}

function validTimeFor(date: string, hourLocal: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hourLocal + 3, 0, 0)).toISOString();
}

function buildDay(spec: DaySpec, index: number): ReplayDay {
  const observed: CurtailmentHourObservation[] = [];
  const forecast: CurtailmentHourForecast[] = [];
  let total = 0;
  let peak = 0;

  for (let hourLocal = 0; hourLocal < 24; hourLocal++) {
    const inside = hourLocal >= spec.startHour && hourLocal < spec.endHour;
    const span = Math.max(1, spec.endHour - spec.startHour);
    const phase = (hourLocal - spec.startHour) / span;
    const shape = inside ? Math.sin(Math.PI * phase) ** 0.8 : 0;
    const actual =
      Math.round(
        spec.peakMw * shape * (0.82 + 0.36 * wobble(index + 1, hourLocal)) * 10,
      ) / 10;
    observed.push({
      validTime: validTimeFor(spec.date, hourLocal),
      hourLocal,
      constrainedOffMwh: actual,
    });
    total += actual;
    peak = Math.max(peak, actual);

    const p50 =
      Math.round(actual * spec.bias * (0.9 + 0.2 * wobble(index + 9, hourLocal)) * 10) /
      10;
    const rel = spec.spread * (inside ? 1 : 1.8);
    forecast.push({
      validTime: validTimeFor(spec.date, hourLocal),
      hourLocal,
      constrainedOff: {
        p10: Math.round(Math.max(0, p50 * (1 - rel)) * 10) / 10,
        p50,
        p90: Math.round(p50 * (1 + rel * 1.3) * 10) / 10,
      },
      occurrenceProbability: inside ? 0.86 : 0.11,
    });
  }

  const isPointInTime = spec.date >= INGESTION_GO_LIVE;
  return {
    episode: {
      id: spec.id,
      subsystem: spec.subsystem,
      technology: spec.technology,
      startedAt: validTimeFor(spec.date, spec.startHour),
      endedAt: validTimeFor(spec.date, spec.endHour),
      durationHours: spec.endHour - spec.startHour,
      totalMwh: Math.round(total),
      peakMw: Math.round(peak),
      // The episode carries the threshold that produced it — an episode is a
      // read-time view of hours, never a stored row.
      thresholdMw: 5,
      maxGapHours: 0,
    },
    label: spec.label,
    observed,
    forecast,
    // Joint, not componentwise: the same sub-additive factor `grid.ts` uses,
    // so the two screens cannot disagree about what a day band means.
    forecastDayEnergy: jointDayBand(forecast),
    forecastOrigin: {
      producer: "wattsteer",
      runLabel: "hurdle-v0.4 · weather 12Z",
      publishedAt: `${spec.date}T13:35:00Z`,
    },
    recoveredMwh: Math.round(total * spec.recoveredShare),
    scenarioLabel: spec.scenarioLabel,
    vintageFidelity: isPointInTime ? "point_in_time" : "revision_optimistic",
    inTrainingWindow: spec.date <= MODEL_TRAINED_THROUGH,
    modelTrainedThrough: MODEL_TRAINED_THROUGH,
  };
}

export const REPLAY_DAYS: ReplayDay[] = DAYS.map(buildDay);

/**
 * The day total as a joint band.
 *
 * Adding the hourly bounds would assume every hour lands at its bound
 * together. The 0.62 factor is the same one `grid.ts` applies, kept identical
 * on purpose: two fixtures that shrink the interval differently would teach
 * the screens that a day band is whatever the file that built it decided.
 */
function jointDayBand(hours: CurtailmentHourForecast[]): Band {
  const sumP50 = hours.reduce((acc, h) => acc + h.constrainedOff.p50, 0);
  const sumP10 = hours.reduce((acc, h) => acc + h.constrainedOff.p10, 0);
  const sumP90 = hours.reduce((acc, h) => acc + h.constrainedOff.p90, 0);
  return {
    p10: Math.round(sumP50 - (sumP50 - sumP10) * 0.62),
    p50: Math.round(sumP50),
    p90: Math.round(sumP50 + (sumP90 - sumP50) * 0.62),
  };
}

export function replayDay(id: string): ReplayDay {
  return REPLAY_DAYS.find((d) => d.episode.id === id) ?? REPLAY_DAYS[0];
}

/**
 * Time Machine fixtures.
 *
 * A `Replay` is a read mode, not a table: a `Scenario` whose `target_date` is
 * in the past, evaluated with `AsOf(t)` pinned to the D−1 run's `published_at`
 * and then scored against the `Observation`s.
 *
 * The fixture carries days on both sides of the two honesty lines, because a
 * screen that only ever shows one case never has to prove it can label the
 * other:
 *
 *  - **Provenance** — a `fold_holdout` day was held out by a named walk-forward
 *    fold; a `served` day's forecast was published before the day happened.
 *  - **Vintage** — ingestion go-live splits `point_in_time` from
 *    `revision_optimistic`.
 *
 * The two axes coincide today: F6 opens on the same date ingestion goes live,
 * so every `fold_holdout` day here is also `revision_optimistic` and every
 * `served` day is `point_in_time`. `docs/specs/replay.md` says so explicitly,
 * and says in the same breath that this is exactly why a merged badge is
 * refused — the pair `fold_holdout` + `point_in_time` becomes populated the
 * moment F6 freezes, and a badge that had merged them would then be wrong with
 * no edit having been made.
 */

import { DATA_WINDOW, SUBSYSTEM_THRESHOLD_MW, weatherRunLabel } from "@wattsteer/core";
import {
  drawDayEnsemble,
  type HourLaw,
  hourBand,
  hourExpectation,
  round1,
} from "./ensemble";
import type {
  CurtailmentHourForecast,
  CurtailmentHourObservation,
  ReplayDay,
  ReplayIntegrityHeldOutBy,
} from "./types";

/**
 * WattSteer began ingesting on this date; before it, vintage is unrecoverable.
 *
 * The published constant, not a copy of it: `/v1/meta` returns the same date,
 * so a fixture that restated it could put the screen a quarter out of step
 * with the API without anything failing.
 */
export const INGESTION_GO_LIVE = DATA_WINDOW.ingestionGoLive;

/**
 * The walk-forward fold calendar, as much of it as this fixture replays.
 *
 * `apps/ml/src/wattsteer_ml/evaluation/fold_calendar.yaml` is the authority —
 * it is the stored artifact every fold result is keyed by, and
 * `apps/web/test/fixtures.test.ts` asserts these rows against it rather than
 * trusting that two files were edited together. The windows matter and are not
 * decoration: `docs/specs/replay.md` re-asserts the held-out property at read
 * time against **both** of an artifact's recorded windows, because the
 * calibration window is where the isotonic fit and the two conformal scalars
 * were fitted, and a day inside it has shaped the interval the replay promises
 * a floor from.
 */
export const FOLDS: readonly (ReplayIntegrityHeldOutBy & {
  testStart: string;
  testEnd: string;
})[] = [
  {
    fold: "F1",
    testStart: "2025-04-01",
    testEnd: "2025-06-30",
    artifactId: "dessem_free_v1__gate_late__thr5/2025-04-01T00:00:00Z",
    trainWindow: ["2024-04-01", "2025-03-31"],
    calibrationWindow: ["2025-01-01", "2025-03-31"],
  },
  {
    fold: "F2",
    testStart: "2025-07-01",
    testEnd: "2025-09-30",
    artifactId: "dessem_free_v1__gate_late__thr5/2025-07-01T00:00:00Z",
    trainWindow: ["2024-04-01", "2025-06-30"],
    calibrationWindow: ["2025-04-02", "2025-06-30"],
  },
  {
    fold: "F3",
    testStart: "2025-10-01",
    testEnd: "2025-12-31",
    artifactId: "dessem_free_v1__gate_late__thr5/2025-10-01T00:00:00Z",
    trainWindow: ["2024-04-01", "2025-09-30"],
    calibrationWindow: ["2025-07-03", "2025-09-30"],
  },
  {
    fold: "F4",
    testStart: "2026-01-01",
    testEnd: "2026-03-31",
    artifactId: "dessem_free_v1__gate_late__thr5/2026-01-01T00:00:00Z",
    trainWindow: ["2024-04-01", "2025-12-31"],
    calibrationWindow: ["2025-10-03", "2025-12-31"],
  },
  {
    fold: "F5",
    testStart: "2026-04-01",
    testEnd: "2026-06-30",
    artifactId: "dessem_free_v1__gate_late__thr5/2026-04-01T00:00:00Z",
    trainWindow: ["2024-04-01", "2026-03-31"],
    calibrationWindow: ["2026-01-01", "2026-03-31"],
  },
] as const;

/**
 * The artifact on serving duty, named on a `served` day.
 *
 * A version, not a sentence: `docs/specs/replay.md` writes `run_label` as the
 * artifact id, and the weather run it saw travels beside it.
 */
const SERVING_ARTIFACT = "hurdle-v0.4";

/**
 * The fold whose *test* window contains this date, or `null` when none does.
 *
 * `null` is the `served` case: the day sits past the last frozen fold, so no
 * backtest held it out — the forecast was simply published before the day it
 * describes, which is a stronger statement than being held out and needs no
 * fold id to make it.
 */
function heldOutBy(date: string): ReplayIntegrityHeldOutBy | null {
  const fold = FOLDS.find((f) => date >= f.testStart && date <= f.testEnd);
  if (fold === undefined) {
    return null;
  }
  const { testStart: _s, testEnd: _e, ...heldOut } = fold;
  return heldOut;
}

/**
 * What a `revision_optimistic` replay's caveat actually touches, and what it
 * does not — `integrity.vintage_affects` / `integrity.vintage_exempt` on the
 * wire.
 *
 * Two lists rather than one sentence, because the caveat is *proportionate*: a
 * weather row carries the run initialisation as its `published_at`, so the D−1
 * 12Z run the replay planned against is that run on both sides of go-live, and
 * DESSEM and the ONS programming are cut the same way. What is affected is the
 * label the day is scored against and the lagged-actual features — the right
 * hours with possibly the wrong values.
 *
 * They are the response's, not the screen's. `packages/core/fixtures/spec-
 * examples/12-replay.json` is the published example and the fixture test
 * asserts these against it, so a list edited in one place fails rather than
 * leaving the screen naming parts the service does not.
 */
export const VINTAGE_AFFECTS = ["settled_actuals", "lagged_actual_features"] as const;
export const VINTAGE_EXEMPT = ["weather_run", "dessem", "ons_programming"] as const;

interface DaySpec {
  id: string;
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
}

/**
 * The scenario every replayed day is scored against.
 *
 * Parameters rather than the sentence they used to be stored as: "100 MW /
 * 300 MWh battery + 70 MW flexible load" is copy in one language, and the same
 * three numbers read perfectly well in both.
 */
const REFERENCE_SCENARIO = {
  batteryPowerMw: 100,
  batteryEnergyMwh: 300,
  loadShiftMw: 70,
};

const DAYS: DaySpec[] = [
  {
    id: "2025-09-14-ne-wind",
    date: "2025-09-14",
    subsystem: "NE",
    technology: "WIND",
    startHour: 0,
    endHour: 9,
    peakMw: 138,
    bias: 0.88,
    spread: 0.34,
    recoveredShare: 0.459,
  },
  {
    id: "2026-03-22-ne-solar",
    date: "2026-03-22",
    subsystem: "NE",
    technology: "SOLAR",
    startHour: 9,
    endHour: 17,
    peakMw: 210,
    bias: 1.14,
    spread: 0.29,
    recoveredShare: 0.318,
  },
  {
    // The day the two honesty axes disagree, and the reason they are two
    // fields. It postdates the serving model's training cut, so the D−1
    // forecast is genuinely out of sample — and it predates ingestion go-live,
    // so the actual it is scored against is ONS's later restatement. A merged
    // badge would have to call this day one thing or the other, and both
    // answers would be wrong.
    id: "2026-06-18-ne-wind",
    date: "2026-06-18",
    subsystem: "NE",
    technology: "WIND",
    startHour: 2,
    endHour: 10,
    peakMw: 164,
    bias: 1.05,
    spread: 0.31,
    recoveredShare: 0.372,
  },
  {
    id: "2026-08-11-ne-wind",
    date: "2026-08-11",
    subsystem: "NE",
    technology: "WIND",
    startHour: 1,
    endHour: 8,
    peakMw: 121,
    bias: 0.96,
    spread: 0.26,
    recoveredShare: 0.401,
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
  const laws: HourLaw[] = [];
  let total = 0;
  let peak = 0;

  for (let hourLocal = 0; hourLocal < 24; hourLocal++) {
    const inside = hourLocal >= spec.startHour && hourLocal < spec.endHour;
    const span = Math.max(1, spec.endHour - spec.startHour);
    const phase = (hourLocal - spec.startHour) / span;
    const shape = inside ? Math.sin(Math.PI * phase) ** 0.8 : 0;
    const actual = round1(
      spec.peakMw * shape * (0.82 + 0.36 * wobble(index + 1, hourLocal)),
    );
    observed.push({
      validTime: validTimeFor(spec.date, hourLocal),
      hourLocal,
      constrainedOffMwh: actual,
    });
    total += actual;
    peak = Math.max(peak, actual);

    // The hour as a *law* rather than as three finished numbers, which is what
    // lets the day total below be drawn instead of summed. A hurdle: mass at
    // exactly zero for the hours that do not clear the threshold, and a
    // right-skewed magnitude above it.
    const median = actual * spec.bias * (0.9 + 0.2 * wobble(index + 9, hourLocal));
    const rel = spec.spread * (inside ? 1 : 1.8);
    laws.push({
      occurrence: inside ? 0.95 : 0.11,
      conditional: {
        low: Math.max(0, median * (1 - rel)),
        median,
        high: median * (1 + rel * 1.3),
      },
    });
  }

  const forecast: CurtailmentHourForecast[] = laws.map((law, hourLocal) => {
    // `E[Y]` for the hour, and the two scalars it divides into. A sibling of
    // the band, never inside it: the hurdle puts mass at zero, so the
    // expectation and the median are different numbers and the shape says so.
    //
    // The episode names a technology because an *observed* episode genuinely
    // has one; the forecast underneath it does not, so the split is a
    // dominant-fleet division of one subsystem expectation rather than two
    // forecasts laid side by side.
    const expectedMwh = round1(hourExpectation(law));
    const dominant = round1(expectedMwh * 0.82);
    const other = round1(expectedMwh - dominant);
    return {
      validTime: validTimeFor(spec.date, hourLocal),
      hourLocal,
      constrainedOff: hourBand(law),
      expectedMwh: round1(dominant + other),
      occurrenceProbability: law.occurrence,
      split:
        spec.technology === "WIND"
          ? { windMwh: dominant, solarMwh: other }
          : { windMwh: other, solarMwh: dominant },
    };
  });

  const isPointInTime = spec.date >= INGESTION_GO_LIVE;
  const fold = heldOutBy(spec.date);
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
      // read-time view of hours, never a stored row. The published constant,
      // not a literal: the same 5 MW the gateway stamps on every response.
      thresholdMw: SUBSYSTEM_THRESHOLD_MW,
      maxGapHours: 0,
    },
    date: spec.date,
    observed,
    forecast,
    // `forecast.day_total` — drawn, not summed, and drawn by the same shared
    // ensemble `grid.ts` uses so the two screens cannot disagree about what a
    // day band is. It used to be the componentwise sum of the hourly quantiles
    // shrunk by a hand-picked 0.62, which is a sum with an apology attached.
    forecastDayTotal: drawDayEnsemble(laws, index + 1, SUBSYSTEM_THRESHOLD_MW).dayEnergy,
    // Two artifacts, two fields. `run_label` is the WattSteer artifact that
    // produced the forecast — the fold's own artifact on a held-out day, which
    // is what makes the provenance claim checkable — and the weather run it
    // consumed is a second fact under `weather_run_label`, derived from the
    // gate table rather than glued onto the run label as " · weather 12Z".
    forecastOrigin: {
      producer: "wattsteer",
      runLabel: fold === null ? SERVING_ARTIFACT : fold.artifactId,
      publishedAt: `${spec.date}T13:35:00Z`,
      weatherRunLabel: weatherRunLabel("gate_late"),
    },
    recoveredMwh: Math.round(total * spec.recoveredShare),
    scenario: REFERENCE_SCENARIO,
    vintageFidelity: isPointInTime ? "point_in_time" : "revision_optimistic",
    vintageAffects: VINTAGE_AFFECTS,
    vintageExempt: VINTAGE_EXEMPT,
    // `null`, on every day, and it is not an oversight: the premium is a mean
    // over post-go-live days held in two vintages, and ONS has not yet restated
    // one of those. The screen renders it as **unmeasured** rather than as a
    // small number, which is what the whole field exists to keep possible.
    revisionPremiumRecoveredMwh: null,
    // The two honesty axes, and neither is derived from the other. A day held
    // out by a frozen fold is `fold_holdout` and names the fold; a day past
    // the last frozen fold was forecast by the promoted artifact before it
    // happened, which is `served`.
    provenance: fold === null ? "served" : "fold_holdout",
    heldOutBy: fold,
  };
}

export const REPLAY_DAYS: ReplayDay[] = DAYS.map(buildDay);

export function replayDay(id: string): ReplayDay {
  return REPLAY_DAYS.find((d) => d.episode.id === id) ?? REPLAY_DAYS[0];
}

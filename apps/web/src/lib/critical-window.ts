/**
 * The hours a day's curtailment is expected in — "10h–15h", said rather than
 * drawn.
 *
 * ## Why this exists
 *
 * The fan chart has carried this information since the screen was built, and a
 * reader has always been able to find it by looking at where the band lifts off
 * the axis. The operator brief asks for something else: an answer to "quando?"
 * in under thirty seconds, which is a sentence and not a curve. Reading a shape
 * is work, and the work is the same every morning.
 *
 * ## What counts as inside the window
 *
 * **The occurrence probability, not the band.** The hurdle model puts real mass
 * at zero, so an hour that is unlikely to curtail at all still has a positive
 * expectation — its `p90` can be well above the threshold while the hour is a
 * one-in-ten shot. A window drawn from the band would therefore stretch across
 * most of the day and say nothing. `occurrenceProbability` is the number that
 * means "this hour is more likely than not to clear the threshold", and that is
 * the question a window answers.
 *
 * ## Why one window and not several
 *
 * Curtailment clusters: it is the solar middle of the day, or the wind night,
 * and a day with two genuinely separate runs is rare. Reporting every run would
 * turn a sentence back into a list, so this returns the **longest** run and
 * says how many hours the day has in total — a reader who sees "10h–15h" over a
 * day with nine qualifying hours knows to look at the chart. That count is the
 * honest way to admit the summary is a summary.
 */

/** An hour with the two fields a window is decided from. */
export interface WindowHour {
  hourLocal: number;
  occurrenceProbability: number;
  expectedMwh: number;
}

export interface CriticalWindow {
  /** First hour of the longest qualifying run, local. */
  fromHour: number;
  /** Last hour of that run, local. Equal to `fromHour` for a single hour. */
  toHour: number;
  /** The hour with the largest expectation inside the run. */
  peakHour: number;
  /** That hour's expectation, in MWh. */
  peakMwh: number;
  /** Qualifying hours across the whole day, which may exceed the run's length. */
  hoursInDay: number;
}

/**
 * More likely than not to clear the threshold.
 *
 * A half is the only defensible cut here: it is the point at which "will this
 * hour curtail?" stops being a no. Anything lower turns the window into a
 * watchlist, and the brief asked for the hours to act in.
 */
const LIKELY = 0.5;

export function criticalWindow(hours: readonly WindowHour[]): CriticalWindow | null {
  const qualifying = hours.filter((hour) => hour.occurrenceProbability >= LIKELY);
  if (qualifying.length === 0) {
    // No window, and that is an answer: a day nobody expects to curtail has no
    // hours to act in. The caller says so in words rather than drawing 0h–0h.
    return null;
  }

  // Runs of consecutive local hours, in the order the day gives them.
  const ordered = [...qualifying].sort((a, b) => a.hourLocal - b.hourLocal);
  let best: WindowHour[] = [];
  let run: WindowHour[] = [];
  for (const hour of ordered) {
    const previous = run.at(-1);
    if (previous !== undefined && hour.hourLocal !== previous.hourLocal + 1) {
      run = [];
    }
    run.push(hour);
    if (run.length > best.length) {
      best = [...run];
    }
  }

  const peak = best.reduce((a, b) => (b.expectedMwh > a.expectedMwh ? b : a));
  return {
    fromHour: (best[0] as WindowHour).hourLocal,
    toHour: (best.at(-1) as WindowHour).hourLocal,
    peakHour: peak.hourLocal,
    peakMwh: peak.expectedMwh,
    hoursInDay: qualifying.length,
  };
}

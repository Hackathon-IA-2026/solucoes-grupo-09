/**
 * The Overview's reads, against the **real** gateway.
 *
 * The sibling of `use-optimization.ts` and `use-replay.ts`, and the third
 * screen to stop computing its own numbers. What is different here, and what
 * shapes every decision below, is that this screen's reads **do not all fail
 * together**: half of them need a promoted model and half of them need nothing
 * but a settled hour in Postgres.
 *
 * **The state the product is actually in.** `GET /v1/meta`, production,
 * 2026-09-15: both serving lanes report `present_unpromoted`, the hot-swap gate
 * having refused the only artifact on each — the late lane on
 * `coverage_p10_in_band` at 0.8114 against [0.85, 0.97] — and the retrain that
 * may fix it has not run. `forecast.latest_published` is empty. So
 * `/v1/grid/outlook` and `/v1/forecast/day-ahead` refuse today, in production,
 * and will keep refusing until an artifact is promoted and a publication runs.
 * That is the normal state this hook is built for. Meanwhile `/v1/grid/now`,
 * `/v1/curtailment/hours` and `/v1/curtailment/episodes` answer 200 with real
 * megawatt-hours, and `apps/api/src/api/curtailment.ts` says so in as many
 * words: with `apps/ml` returning 503 for everything, all three still answer.
 *
 * **Four states and no fifth**, and — exactly as in `use-replay.ts` — the
 * fourth is not a failure:
 *
 *  - `reading` — in flight. An absence, never a skeleton of numbers that are
 *    not there yet.
 *  - `read` — the day is forecast *and* the grid is settled. Every panel the
 *    screen has.
 *  - `observedOnly` — the forecast half refused and the observed half did not.
 *    The same name `use-replay.ts` gives its own fourth state, for the same
 *    reason: a refusal with a view behind it. There the refused thing is a
 *    counterfactual for a day inside the training block; here it is a forecast
 *    no artifact was promoted to make. In both cases the screen states which
 *    clause refused, from the typed code, and then renders the thing the
 *    refusal points at — which needs no model and is therefore still true.
 *  - `refused` — the **observed** half refused too. There is nothing honest
 *    left to draw, so nothing is drawn but the sentence.
 *
 * **Why there is no fifth.** The candidate was a "stale" state, for
 * `api-surface.md`'s third no-forecast case — rows from an earlier gate. It is
 * not a state: a stale forecast is a **200** carrying `forecast_origin.age_hours`,
 * and the screen is obliged to name its origin anyway. Making staleness a
 * status would mean a reader could not see a real forecast because it was six
 * hours old, which is the opposite of what the spec asks for. The origin stamp
 * carries it, where it already lived.
 *
 * **One `refused` and not one per read.** The three observed calls are a group:
 * the screen's observed half is only honest whole, and a panel drawn while its
 * neighbour's request failed is a page that looks complete and is not. They
 * succeed together or the screen says so.
 *
 * **Keyed on the question, not the object.** The effect re-runs when the
 * subsystem, the target date or the gate changes — the three things that change
 * what the gateway is being asked — and on nothing else. A re-render with the
 * same three is the same question and must not re-request it.
 */

import type { ErrorCode } from "@wattsteer/core";
import type {
  CurtailmentEpisodes,
  ForecastDayAhead,
  GateProfile,
  GridNow,
  GridOutlook,
  TechnologySplit,
} from "@wattsteer/core/api";
import { useEffect, useState } from "react";
import { refusalOf } from "@/lib/absence";
import { api } from "@/lib/api";
import type { CurtailmentHourObservation } from "@/lib/fixtures";
import { observedHours, observedSplit } from "@/lib/network";

/** The settled grid — every part of it available with nothing promoted. */
export interface ObservedNetwork {
  readonly now: GridNow;
  /** The selected subsystem's settled day, one series, technologies summed. */
  readonly hours: CurtailmentHourObservation[];
  /** The local day `hours` covers — the most recent one that has settled. */
  readonly hoursDate: string;
  /**
   * That day's settled wind and solar, as ONS published them.
   *
   * Kept here rather than derived in the screen because `hours` has already had
   * its technology dimension collapsed by `observedHours` — the profile draws
   * one line — and re-requesting the route to get it back would be a second
   * read of the same bytes. It is the observed counterpart of the forecast's
   * split, and the difference between them is the point: this one is two
   * settlements, that one is a division of a single modelled expectation.
   */
  readonly daySplit: TechnologySplit;
  readonly episodes: CurtailmentEpisodes;
}

/** The day being forecast — present only when one was. */
export interface ForecastNetwork {
  readonly outlook: GridOutlook;
  readonly forecast: ForecastDayAhead;
}

export type NetworkState =
  | { readonly status: "reading" }
  | {
      readonly status: "read";
      readonly observed: ObservedNetwork;
      readonly forecast: ForecastNetwork;
    }
  | {
      readonly status: "observedOnly";
      readonly observed: ObservedNetwork;
      /** The clause that refused the forecast, from the closed enum. */
      readonly code: ErrorCode;
    }
  | { readonly status: "refused"; readonly code: ErrorCode };

/**
 * How far back the episode list looks.
 *
 * Fourteen days rather than the route's 400-day cap: the panel is "what this
 * subsystem has been doing lately", and a fortnight is the window in which an
 * episode is still something a reader remembers. The cap exists to stop a link
 * asking for a decade, not to suggest a screen should.
 */
export const EPISODE_WINDOW_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** The `YYYY-MM-DD` `days` after `date`. Negative goes back. */
function daysFrom(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * What the Overview is asking about.
 *
 * `targetDate` is the day being **forecast** — tomorrow, in Brasília. The
 * observed reads are about a different day and derive it here rather than
 * taking a second parameter: settled data lags ONS's publication by hours, so
 * the most recent day that can have settled is the one before today, which is
 * two before the target. Asking `/v1/curtailment/hours` about tomorrow would
 * return an empty array, and an empty array drawn as a profile is a day
 * published as quiet that has not happened.
 */
export interface NetworkQuery {
  readonly subsystem: string;
  readonly targetDate: string;
  readonly gateProfile: GateProfile;
}

export function useNetwork(query: NetworkQuery): NetworkState {
  const { subsystem, targetDate, gateProfile } = query;
  const [state, setState] = useState<NetworkState>({ status: "reading" });

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    setState({ status: "reading" });

    const settled = daysFrom(targetDate, -2);
    const from = daysFrom(settled, -EPISODE_WINDOW_DAYS);
    // Two UTC days, not one, and `to` is exclusive: the narrowest window this
    // route accepts is a UTC day, and a Brasília civil day straddles two of
    // them. `observedHours` cuts the civil day out of what comes back. Asking
    // for `from === to` is an empty range and the gateway refuses it with
    // `BAD_INPUT` — measured against the deployed service, which is how this
    // was found.
    const hoursTo = daysFrom(settled, 2);

    // The observed half. None of these three loads a model, and
    // `apps/api/src/api/curtailment.ts` says so: with `apps/ml` returning 503
    // for everything and no promoted artifact in any lane, all of them answer
    // 200 with real numbers. The lanes' condition is not asked for here — it is
    // one answer for the whole of `/app`, read by `use-serving.ts`, so the
    // chrome badge and this screen's honesty note cannot disagree.
    const observed = Promise.all([
      api.gridNow(signal),
      api.curtailmentHours({ subsystem, from: settled, to: hoursTo }, signal),
      api.curtailmentEpisodes({ subsystem, from, to: settled }, signal),
    ]).then(
      ([now, hours, episodes]): ObservedNetwork => ({
        now,
        hours: observedHours(hours, settled),
        hoursDate: settled,
        daySplit: observedSplit(hours, settled),
        episodes,
      }),
    );

    // The forecast half. Two calls because the screen asks two questions — all
    // four subsystems for the map and the rows, one subsystem in depth for the
    // profile — and they are one promise because the screen has no state in
    // which half a forecast is drawn.
    const forecast = Promise.all([
      api.gridOutlook({ targetDate, gateProfile }, signal),
      api.forecastDayAhead({ subsystem, targetDate, gateProfile }, signal),
    ]).then(([outlook, dayAhead]): ForecastNetwork => ({ outlook, forecast: dayAhead }));

    // Settled first: a forecast refusal is only worth rendering beside the
    // observed grid, and an observed refusal makes the forecast's irrelevant.
    observed
      .then(async (settledGrid) => {
        let forecastNetwork: ForecastNetwork;
        try {
          forecastNetwork = await forecast;
        } catch (cause: unknown) {
          if (!signal.aborted) {
            setState({
              status: "observedOnly",
              observed: settledGrid,
              code: refusalOf(cause),
            });
          }
          return;
        }
        if (!signal.aborted) {
          setState({ status: "read", observed: settledGrid, forecast: forecastNetwork });
        }
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) {
          setState({ status: "refused", code: refusalOf(cause) });
        }
      });

    // Both halves are awaited, so neither can reject unobserved — but the
    // forecast's rejection is handled inside the `observed` chain and Node and
    // the browser both count a promise as unhandled at the tick it settles, not
    // at the tick somebody gets round to it. Attaching a no-op keeps a refused
    // forecast — which is every load today — from logging as an unhandled
    // rejection in a console a reader may have open.
    forecast.catch(() => undefined);

    return () => controller.abort();
  }, [subsystem, targetDate, gateProfile]);

  return state;
}

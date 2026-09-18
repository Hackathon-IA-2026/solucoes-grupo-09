/**
 * Which of the candidate days the Time Machine can actually show.
 *
 * ## The defect this exists for
 *
 * `REPLAY_DAYS` is four dates chosen to cover four *kinds* of day — inside the
 * training block, inside a held-out fold, held out and pre-go-live, and
 * published after go-live. That is the right list of things to want. It is not
 * a claim that the deployment can answer any of them, and measured against
 * production on 2026-09-17 it could answer exactly one:
 *
 * | Day          | What the gateway says                      | Shows |
 * |--------------|--------------------------------------------|-------|
 * | `2024-11-05` | 422 `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW`    | yes, observed-only |
 * | `2025-09-14` | 404 `REPLAY_FORECAST_UNAVAILABLE`          | no |
 * | `2026-06-18` | 404 `REPLAY_FORECAST_UNAVAILABLE`          | no |
 * | `2026-08-11` | 404 `REPLAY_FORECAST_UNAVAILABLE`          | no |
 *
 * So the picker was offering four days and three of them were dead ends: press,
 * wait, read a refusal. A control that cannot move anything is the one
 * dishonesty this product cannot afford — `wired-screens.test.ts` says so about
 * the D−1 run pills, and the rule is not different here.
 *
 * ## Why it is probed and not listed
 *
 * The obvious fix is to delete three entries. That would be a hard-coded claim
 * about a *deployment* living in the client: `REPLAY_FORECAST_UNAVAILABLE` means
 * nobody has published a forecast for that day yet, and a backfill would make it
 * answerable without anything here changing. The list would then be wrong in the
 * other direction, silently, and nothing would fail.
 *
 * `GET /v1/replay/days` is the endpoint that should answer this, and it is why
 * this hook is not it: against production it answers 503 `OPTIMIZER_TIMEOUT` —
 * the modelling service does not reply in time. When it does, this hook should
 * be replaced by that one call, and the table above becomes its test.
 *
 * ## What it costs, honestly
 *
 * One request per candidate, in parallel, on mount — four today, and up to
 * eight, because a pre-holdout day needs a second call: its refusal *is* the
 * route to its observed-only view.
 *
 * It is **not** free and it does not warm anything. The probe sends
 * `defaultScenario(...)` while the screen sends the reader's scenario from the
 * URL — different bodies, different cache keys — so a reader who has edited a
 * battery pays for both. And `use-replay.ts` records that the MILP and the
 * simulator run per request, so these are optimizer runs whose results are
 * discarded.
 *
 * That is the price of not lying about which days exist, and it is only worth
 * paying until `GET /v1/replay/days` answers: one call, no scenario, no solver.
 */

import { canonicalScenarioJson, type ErrorCode, encodeScenario } from "@wattsteer/core";
import { useEffect, useState } from "react";
import { defaultScenario } from "@/components/app/scenario";
import { refusalOf } from "@/lib/absence";
import { api } from "@/lib/api";
import { REPLAY_DAYS, type ReplayCandidateDay } from "@/lib/fixtures";
import { REPLAY_LANE } from "@/lib/replay";

/**
 * The clause whose refusal has a view behind it.
 *
 * Named here as it is in `use-replay.ts`, and for the same reason: a day inside
 * every artifact's training block is refused *as a replay* — that is the spec's
 * central decision — and what it is owed instead is an observed-only view. A
 * day that reaches that view is a day the picker may offer.
 */
const PRE_HOLDOUT: ErrorCode = "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW";

export type ReplayDaysState =
  | { readonly status: "probing" }
  | {
      readonly status: "known";
      /** In `REPLAY_DAYS` order, so the list does not reshuffle. */
      readonly viewable: readonly ReplayCandidateDay[];
    };

/** Whether the gateway can show this day, either way round. */
async function viewable(day: ReplayCandidateDay, signal: AbortSignal): Promise<boolean> {
  const scenario = defaultScenario(day.subsystem, day.date);
  try {
    await api.replay(
      { d: day.date, s: encodeScenario(scenario), lane: REPLAY_LANE },
      signal,
    );
    return true;
  } catch (cause: unknown) {
    if (refusalOf(cause) !== PRE_HOLDOUT) {
      return false;
    }
    try {
      await api.replayObservedOnly(
        canonicalScenarioJson(scenario),
        { lane: REPLAY_LANE },
        signal,
      );
      return true;
    } catch {
      return false;
    }
  }
}

export function useReplayDays(): ReplayDaysState {
  const [state, setState] = useState<ReplayDaysState>({ status: "probing" });

  useEffect(() => {
    const controller = new AbortController();
    Promise.all(
      REPLAY_DAYS.map((day) =>
        viewable(day, controller.signal).then((ok) => (ok ? day : null)),
      ),
    )
      .then((results) => {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          status: "known",
          viewable: results.filter((day): day is ReplayCandidateDay => day !== null),
        });
      })
      .catch(() => {
        if (controller.signal.aborted) {
          // Torn down by a navigation. Reporting anything would be reporting
          // about a screen nobody is looking at.
          return;
        }
        /*
          `viewable` catches its own rejections, so reaching here means something
          outside it threw — and the honest answer to that is the same as the
          answer to "none of them work": an empty list, which the picker states
          in words. Leaving the state on `probing` was worse: the picker showed
          one pill forever and never said why, which is a blank standing in for
          a refusal.
        */
        setState({ status: "known", viewable: [] });
      });
    return () => controller.abort();
  }, []);

  return state;
}

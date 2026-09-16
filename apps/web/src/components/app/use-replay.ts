/**
 * One past day, replayed by the **real** replay endpoint.
 *
 * The sibling of `use-optimization.ts`, and for the same reason: there is
 * exactly one implementation of the execution rule in this repository and it is
 * not in a browser. `docs/specs/replay.md` splits the work at the seam that
 * matters — the forecast is a **pinned row** written at backtest time, and the
 * MILP and the simulator run per request — so this hook sends a scenario and
 * receives a scored day. Two product behaviours fall out of that split and both
 * are the point:
 *
 *  1. **Changing the fleet re-plans and never re-forecasts.** The asset
 *     controls behave exactly like Mitigate's, and no interaction on this
 *     screen can change what the model said at D−1, because nothing in the
 *     request path loads a model. That is the property that makes a replay a
 *     replay.
 *  2. **A shared link survives a retrain.** The response echoes the *pinned*
 *     `forecast_origin`, so the numbers behind a link do not silently re-mean
 *     themselves when a later backtest writes a newer holdout vintage.
 *
 * **Four states and no fifth**, and the fourth is not a failure:
 *
 *  - `replaying` — in flight. An absence, never a skeleton of numbers that are
 *    not there yet.
 *  - `replayed` — the day was held out by a named artifact and is scored.
 *  - `observedOnly` — the day sits in the pre-F1 training block, where every
 *    artifact was fitted, so no honest counterfactual exists. The endpoint
 *    refuses it with `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW` and this hook asks the
 *    view that day is genuinely owed: the settled profile, its episodes and the
 *    perfect-foresight bound, which needs no forecast and therefore no model.
 *    The refusal is carried on the answer, so the screen states which clause
 *    failed rather than implying the day was uninteresting.
 *  - `refused` — any other code, from the closed enum, rendered as
 *    `copy.error[code]` in the reader's locale.
 *
 * **The one branch on a code, and why it is a branch rather than a screen.**
 * `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW` is the only refusal with a view behind
 * it: the others — no held-out forecast, an unsettled day, a date outside the
 * window, a failed held-out assertion — are a missing read or a WattSteer bug,
 * and the honest answer to all four is the sentence and no figures. The spec is
 * explicit that the pre-F1 case is *refused rather than labelled*; asking for
 * the observed-only view is not softening that refusal, it is rendering the
 * thing the refusal points at.
 *
 * **The key is the canonical scenario, not the object.** React rebuilds the
 * scenario on every keystroke of a stepper; the canonical bytes are what the
 * endpoint answers and what its cache is keyed on, so an object rebuilt with
 * identical contents is the same question and must not re-request.
 */

import { canonicalScenarioJson, type ErrorCode, encodeScenario } from "@wattsteer/core";
import type { Replay, ReplayObservedOnly, Scenario } from "@wattsteer/core/api";
import { useEffect, useState } from "react";
import { refusalOf } from "@/lib/absence";
import { api } from "@/lib/api";
import { REPLAY_LANE } from "@/lib/replay";
import { useLatest } from "@/lib/use-latest";

export type ReplayState =
  | { readonly status: "replaying" }
  | { readonly status: "replayed"; readonly replay: Replay }
  | { readonly status: "observedOnly"; readonly view: ReplayObservedOnly }
  | { readonly status: "refused"; readonly code: ErrorCode };

/**
 * The clause whose refusal has a view behind it. One code, named once: the
 * other four are answered with their sentence and no numbers.
 */
const PRE_HOLDOUT: ErrorCode = "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW";

/**
 * `null` is "the link was refused", not "no scenario": the screen renders that
 * refusal itself and this hook stays parked, because React will not let it be
 * called conditionally and a replay nobody accepted is a request with no
 * reader.
 */
export function useReplay(scenario: Scenario | null): ReplayState {
  // Throws only for a scenario too large to be a link, which `useScenario` has
  // already refused before this hook is reached.
  const key = scenario === null ? null : encodeScenario(scenario);
  const [state, setState] = useState<ReplayState>({ status: "replaying" });

  // Read through a ref for the reason `use-optimization.ts` does: the scenario
  // is an input to the effect, not a trigger for it. The bytes are the trigger.
  const latest = useLatest(scenario);

  // The `setState` after the await is guarded by `controller.signal.aborted`
  // on every branch below — which is the check this rule is asking for, made
  // against the abort the effect's own teardown fires.
  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect
  useEffect(() => {
    const asked = latest.current;
    if (key === null || asked === null) {
      return;
    }
    const controller = new AbortController();
    // The opening statement of a fetch effect — see `use-explain.ts`.
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    setState({ status: "replaying" });
    api
      .replay({ d: asked.targetDate, s: key, lane: REPLAY_LANE }, controller.signal)
      .then((replay) => {
        if (!controller.signal.aborted) {
          setState({ status: "replayed", replay });
        }
      })
      .catch(async (cause: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        const code = refusalOf(cause);
        if (code !== PRE_HOLDOUT) {
          setState({ status: "refused", code });
          return;
        }
        // The pre-F1 block. The day is refused as a replay — that is the
        // spec's central decision and it is not softened here — and what it is
        // owed instead is asked for by name.
        try {
          const view = await api.replayObservedOnly(
            canonicalScenarioJson(asked),
            { lane: REPLAY_LANE },
            controller.signal,
          );
          if (!controller.signal.aborted) {
            setState({ status: "observedOnly", view });
          }
        } catch (second: unknown) {
          if (!controller.signal.aborted) {
            setState({ status: "refused", code: refusalOf(second) });
          }
        }
      });
    return () => controller.abort();
    // Same rule as `use-optimization.ts`: the bytes are the trigger, the
    // scenario is an input, and `useLatest` keeps the two apart.
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [key]);

  return state;
}

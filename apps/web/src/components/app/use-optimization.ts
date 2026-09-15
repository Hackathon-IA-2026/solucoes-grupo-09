/**
 * The Mitigate screen's plan, solved by the **real** optimizer.
 *
 * `docs/specs/api-surface.md` decision 6: the web app's `evaluatePlan` and
 * `planDispatch` are deleted rather than ported, so Mitigate has nothing left
 * to compute against and calls `POST /v1/optimize` instead. The two changes are
 * one change, and this hook is the seam between them.
 *
 * **Three states and no fourth.** Solving, solved, or refused with a code from
 * the closed enum — which the screen renders as `copy.error[code]` in the
 * reader's locale, exactly as it already does for a link the refusal table
 * rejected. There is no "stale plan" state: a scenario that changed and a plan
 * that has not caught up would be a number labelled with the wrong fleet, and
 * that is the failure class this whole surface exists to refuse.
 *
 * **Two solves, in parallel, aborted together.** The reveal shows what the
 * battery does and then what the battery and the flexible load do; those are
 * two fleets and therefore two MILPs. The solver answers in single-digit
 * milliseconds by design — `docs/specs/flex-optimizer.md` measured 3.15 ms at
 * real size — so a slider still moves the chart. An edit that lands mid-flight
 * aborts both, because a half-updated reveal would draw one step against the
 * old fleet and one against the new.
 *
 * **The key is the canonical scenario, not the object.** React re-creates the
 * scenario object on every keystroke of a stepper; the canonical bytes are what
 * the solver actually answers, so keying on them is what stops an identical
 * scenario re-solving on every render.
 */

import { type ErrorCode, encodeScenario } from "@wattsteer/core";
import type { Scenario } from "@wattsteer/core/api";
import { useEffect, useRef, useState } from "react";
import { refusalOf } from "@/lib/absence";
import { api } from "@/lib/api";
import type { MitigationStep } from "@/lib/fixtures";
import { mitigationSteps, SOLVED_STEPS, stepScenario } from "@/lib/optimization";

export type OptimizationState =
  | { readonly status: "solving" }
  | { readonly status: "solved"; readonly steps: MitigationStep[] }
  | { readonly status: "refused"; readonly code: ErrorCode };

/**
 * `null` is "the link was refused", not "no scenario": the screen renders that
 * refusal itself and this hook stays parked, because React will not let it be
 * called conditionally and a solve for a scenario nobody accepted is a request
 * with no reader.
 */
export function useOptimization(scenario: Scenario | null): OptimizationState {
  // Throws only for a scenario too large to be a link, which `useScenario` has
  // already refused before this hook is reached.
  const key = scenario === null ? null : encodeScenario(scenario);
  const [state, setState] = useState<OptimizationState>({ status: "solving" });

  // Keyed on the canonical bytes and on nothing else: React rebuilds the
  // scenario object on every keystroke of a stepper, and those bytes are what
  // the solver actually answers, so an object rebuilt with identical contents
  // is the same question and must not re-solve. The scenario is read through a
  // ref for that reason — it is an input to the effect, not a trigger for it.
  const latest = useRef(scenario);
  latest.current = scenario;

  useEffect(() => {
    const asked = latest.current;
    if (key === null || asked === null) {
      return;
    }
    const controller = new AbortController();
    setState({ status: "solving" });
    Promise.all(
      SOLVED_STEPS.map((step) =>
        api.optimize(stepScenario(asked, step), controller.signal),
      ),
    )
      .then(([battery, batteryAndLoad]) => {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          status: "solved",
          steps: mitigationSteps({
            battery,
            battery_and_load: batteryAndLoad,
          }),
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setState({ status: "refused", code: refusalOf(cause) });
      });
    return () => controller.abort();
  }, [key]);

  return state;
}

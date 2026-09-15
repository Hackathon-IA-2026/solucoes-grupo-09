/**
 * What this deployment can actually serve — read once, for the whole of `/app`.
 *
 * **Why this is a provider when nothing else in `/app` is.** The selection
 * lives in the URL precisely so no provider has to hold it. The serving state
 * is the opposite kind of fact: it is not a property of a screen or of a link,
 * it is a property of the deployment, and **two readers of it must never
 * disagree**. The chrome badge says whether a model is promoted; a screen's
 * honesty note says why its forecast is missing. If those came from two
 * requests they could be answered a second apart by a gateway mid-promotion,
 * and the page would carry a badge saying "no model promoted" above a panel
 * showing a forecast. One read, one answer, both renderings.
 *
 * It is also the read `docs/specs/api-surface.md` calls "the precondition every
 * screen reads first", and `/v1/meta` is `no-store` by design — so reading it
 * once per mount rather than once per panel is the difference between one
 * uncached request and four.
 *
 * **Three states, and the third is not an error.**
 *
 *  - `reading` — in flight. The badge renders its unconditional half and
 *    nothing else: a chrome that guesses is a chrome that flickers from a
 *    wrong claim to a right one.
 *  - `known` — `/v1/meta` answered. It answers 200 even when the modelling
 *    service is unreachable, in which case `lanes` is empty and
 *    `modelReachable` is false — which is a *known* state and not a failure of
 *    this read.
 *  - `unknown` — `/v1/meta` itself did not answer. The gateway is down or the
 *    origin is misconfigured. The chrome says nothing about the model, because
 *    it knows nothing about the model; the screens' own reads will have failed
 *    too and they say so where a reader is looking.
 *
 * There is deliberately no polling. A promotion takes effect on the next load,
 * and a badge that quietly changed under a reader mid-sentence would be worse
 * than one that is a few minutes stale.
 */

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { anyLaneServing, type Lane, lanesOf } from "@/lib/absence";
import { api } from "@/lib/api";

export type ServingState =
  | { readonly status: "reading" }
  | {
      readonly status: "known";
      readonly lanes: readonly Lane[];
      /** False when the gateway could not reach `apps/ml` at all. */
      readonly modelReachable: boolean;
      /** Whether any lane is promoted and loadable. */
      readonly serving: boolean;
      /**
       * Whether this instance can mint a voice session at all.
       *
       * Read here rather than discovered by pressing the control. The dock is
       * designed to be *absent* rather than broken where no key is set, and the
       * only way to learn that was to call `/v1/voice/session` — which mints a
       * credential. So the trigger rendered, a reader pressed it, a request went
       * out, and nothing visible happened: a dead control that spent a
       * rate-limit token to stay dead.
       */
      readonly voiceConfigured: boolean;
    }
  | { readonly status: "unknown" };

const ServingContext = createContext<ServingState>({ status: "reading" });

/**
 * The one `/v1/meta` read in `/app`.
 *
 * Not exported: everything reads it through {@link useServing}, so there is no
 * way to acquire a second copy of this answer.
 */
function useServingRead(): ServingState {
  const [state, setState] = useState<ServingState>({ status: "reading" });

  useEffect(() => {
    const controller = new AbortController();
    api
      .meta(controller.signal)
      .then((meta) => {
        if (controller.signal.aborted) {
          return;
        }
        const lanes = lanesOf(meta);
        setState({
          status: "known",
          lanes,
          modelReachable: meta.model.reachable,
          voiceConfigured: meta.voice.configured,
          serving: anyLaneServing(lanes),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ status: "unknown" });
        }
      });
    return () => controller.abort();
  }, []);

  return state;
}

/** Wraps `/app`. One read, and every reader of it sees the same answer. */
export function ServingProvider({ children }: { children: ReactNode }) {
  return createElement(ServingContext.Provider, { value: useServingRead() }, children);
}

/**
 * What this deployment can serve.
 *
 * Outside a {@link ServingProvider} this is `reading` for ever, which is the
 * right default for a component that renders nothing until it knows: a test
 * that mounts a panel on its own gets a chrome that claims nothing rather than
 * one that claims a model is promoted.
 */
export function useServing(): ServingState {
  return useContext(ServingContext);
}

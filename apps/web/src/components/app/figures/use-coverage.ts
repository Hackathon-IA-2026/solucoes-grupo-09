/**
 * The band's measured coverage, for the gate the screen is reading.
 *
 * ## This is the "accuracy" number, and it is the only honest one
 *
 * The dashboard brief asks for an accuracy percentage. A forecast that publishes
 * an interval does not have one in the usual sense: there is no single value to
 * be right or wrong about. What it has is **coverage** — the fraction of settled
 * days whose total landed inside the published P10–P90 — measured by the gate
 * over a held-out fold, against a stated target of 0.90.
 *
 * That is a real statistic, it is already computed, and the gate refuses to
 * promote an artifact whose coverage falls outside the guardrail. Reading it
 * here costs one request and closes the brief's item without any arithmetic
 * happening in a browser. `replay-accuracy.test.ts` forbids the alternative —
 * dividing one day's error by one day's forecast — and this is what it forbids
 * it *in favour of*.
 *
 * ## Why the absence is a state and not an error
 *
 * `day_grain` is nullable on the wire, with `day_grain_absent_reason` beside it:
 * a fold too short to measure coverage on says so rather than reporting zero.
 * The panel renders the absence. It never renders a number the card withheld.
 */

import type { GateProfile } from "@wattsteer/core/api";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useServing } from "../use-serving";

export interface Coverage {
  /** Fraction of settled days whose total fell inside the band, 0..1. */
  readonly dayTotal: number;
  /** What the band was calibrated to reach. */
  readonly target: number;
  /** How many complete settled days it was measured over. */
  readonly days: number;
}

export type CoverageState =
  | { readonly status: "reading" }
  /** No promoted lane for this gate, or the card withheld the group. */
  | { readonly status: "absent" }
  | { readonly status: "read"; readonly coverage: Coverage };

export function useCoverage(gateProfile: GateProfile): CoverageState {
  const serving = useServing();
  const [state, setState] = useState<CoverageState>({ status: "reading" });

  /*
    The lane is found rather than composed. Lane names carry the model family,
    the gate and the threshold — `dessem_free_v1__gate_early__thr5` — and only
    `/v1/meta` knows which families and thresholds are deployed. Building the
    string here would be a second, silently drifting source of it.
  */
  const lane =
    serving.status === "known"
      ? serving.lanes.find(
          (entry) =>
            entry.name.includes(gateProfile) &&
            entry.condition === "promoted" &&
            entry.usable !== false,
        )?.name
      : undefined;

  useEffect(() => {
    if (serving.status !== "known") {
      return;
    }
    if (lane === undefined) {
      setState({ status: "absent" });
      return;
    }
    const controller = new AbortController();
    api
      .modelCard({ lane }, controller.signal)
      .then((card) => {
        if (controller.signal.aborted) {
          return;
        }
        const grain = card.ensemble.dayGrain;
        setState(
          grain === null
            ? { status: "absent" }
            : {
                status: "read",
                coverage: {
                  dayTotal: grain.dayTotalCoverage,
                  target: grain.target,
                  days: grain.days,
                },
              },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // A card that will not answer is an absent measurement, not a broken
          // screen: nothing else on the console depends on it.
          setState({ status: "absent" });
        }
      });
    return () => controller.abort();
  }, [lane, serving.status]);

  return state;
}

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
import { useModelCard } from "./use-model-card";

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
  /*
    The card is read through `use-model-card.ts`, memoised per lane, so this
    hook and `useLadder` — which are mounted on the same screen and measured on
    the same document — cost one request between them rather than one each. The
    lane-finding and the refusal handling moved there with it; what is left here
    is the one thing this hook is about, which is the day-grain group.
  */
  const card = useModelCard(gateProfile);
  if (card.status !== "read") {
    return card.status === "reading" ? { status: "reading" } : { status: "absent" };
  }
  const grain = card.card.ensemble.dayGrain;
  return grain === null
    ? { status: "absent" }
    : {
        status: "read",
        coverage: {
          dayTotal: grain.dayTotalCoverage,
          target: grain.target,
          days: grain.days,
        },
      };
}

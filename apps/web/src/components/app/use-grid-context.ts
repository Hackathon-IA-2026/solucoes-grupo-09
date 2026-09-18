/**
 * ONS's plan for the day, beside what the grid did.
 *
 * The one read on these screens where **both** series are ONS's. Everything
 * else here is a WattSteer number with a settled one beside it; this is the
 * official day-ahead programme against the official settlement, and the product
 * appears in it only as the subtraction — which is a subtraction between two
 * series of one unit at one grain, and therefore the one piece of arithmetic
 * that is safe to do on somebody else's numbers.
 *
 * ## Three states, and the third is the common one
 *
 * `reading`, `read`, and `refused`. What `read` does *not* promise is that
 * either series exists: the programme lands on D−1 and the settlement lands
 * hours after the fact, so a day is usually half-covered and often not covered
 * at all. That is not a refusal and the gateway does not answer one — the day's
 * `deviationUnavailableReason` names which side is missing, and the panel says
 * it in words.
 *
 * A refusal here is the gateway or the database being unreachable, which is the
 * only thing a reader could act on.
 */

import type { ErrorCode } from "@wattsteer/core";
import type { GridContext } from "@wattsteer/core/api";
import { useEffect, useState } from "react";
import { refusalOf } from "@/lib/absence";
import { api } from "@/lib/api";
import type { SubsystemCode } from "@/lib/fixtures";

export type GridContextState =
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly context: GridContext }
  | { readonly status: "refused"; readonly code: ErrorCode };

export function useGridContext(subsystem: SubsystemCode, date: string): GridContextState {
  const [state, setState] = useState<GridContextState>({ status: "reading" });

  useEffect(() => {
    const controller = new AbortController();
    api
      .gridContext({ subsystem, date }, controller.signal)
      .then((context) => {
        if (!controller.signal.aborted) {
          setState({ status: "read", context });
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setState({ status: "refused", code: refusalOf(cause) });
        }
      });
    return () => controller.abort();
  }, [subsystem, date]);

  return state;
}

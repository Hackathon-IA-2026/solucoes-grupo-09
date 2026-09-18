/**
 * The past days that looked most like this one.
 *
 * ## Why the screen shows it, and what it must never do with it
 *
 * A band is a claim a reader has to take on trust. A **date** is not: a reader
 * who was on shift that day remembers it, and one who was not can look it up in
 * ONS's archive without any access to this product. That is what the analogue
 * is for — evidence of a different kind from an attribution, and the only
 * evidence on these screens that does not depend on the model being right.
 *
 * So the neighbours' settled totals sit *beside* the forecast and are never
 * combined with it. No average of the three, no "adjusted" band, no blend. The
 * moment a neighbour's outcome enters a number the product publishes, this
 * stops being evidence and becomes a second, unpromoted model.
 *
 * ## Absences, of which there are several and none is a zero
 *
 * No promoted lane, a pool with no spread to measure a distance against, a
 * target day whose day-ahead programme is incomplete, a gateway that will not
 * answer. Each is `absent`; the panel says so in words and shows no dates.
 */

import type { GateProfile, SimilarDays } from "@wattsteer/core/api";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SubsystemCode } from "@/lib/fixtures";
import { useServing } from "../use-serving";
import { usePromotedLane } from "./use-model-card";

export type SimilarDaysState =
  | { readonly status: "reading" }
  | { readonly status: "absent" }
  | { readonly status: "read"; readonly days: SimilarDays };

export function useSimilarDays(
  subsystem: SubsystemCode,
  date: string,
  gateProfile: GateProfile,
): SimilarDaysState {
  const serving = useServing();
  const lane = usePromotedLane(gateProfile);
  const [state, setState] = useState<SimilarDaysState>({ status: "reading" });

  useEffect(() => {
    /*
      `lane` is `undefined` in two different states and they are owed two
      different answers: `/v1/meta` still in flight, and no lane promoted. The
      second is settled — the search runs in a lane's feature set, so without
      one there is nothing to run — and reporting it as pending would leave the
      panel spinning on the deployment state this product is in most of the
      time. The first is genuinely unknown and stays so.
    */
    if (serving.status !== "known") {
      return;
    }
    if (lane === undefined) {
      setState({ status: "absent" });
      return;
    }
    const controller = new AbortController();
    api
      .similarDays({ subsystem, lane, targetDate: date, k: 3 }, controller.signal)
      .then((days) => {
        if (controller.signal.aborted) {
          return;
        }
        // An empty list is an absence with a reason the panel states, not a
        // finding that no day was similar.
        setState(
          days.neighbours.length === 0 ? { status: "absent" } : { status: "read", days },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ status: "absent" });
        }
      });
    return () => controller.abort();
  }, [subsystem, date, lane, serving.status]);

  return state;
}

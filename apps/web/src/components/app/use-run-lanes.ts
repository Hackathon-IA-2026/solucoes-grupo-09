/**
 * Which D−1 runs can actually answer, and keeping the selection on one of them.
 *
 * ## Why this is not in `app-shell.tsx` any more
 *
 * It was, beside the pills it dims — which was the right place while the
 * selection bar was on every screen. The console replaced that bar with its own
 * controls, and the moment it did, two things that had been one became separate:
 * the *styling* of a run pill, which belongs to whoever draws it, and the rule
 * that **the product must not sit on a gate whose lane cannot serve**, which
 * belongs to the product. Left in the shell, hiding the bar would also have
 * quietly disabled the correction, and the console would have opened on a
 * refusal again with nothing to explain it.
 *
 * ## The rule
 *
 * `run` defaults to `12Z`, which is right whenever both lanes are promoted: the
 * late gate sees the newer weather run, so it is the better forecast to land on.
 * It is wrong in exactly the state the product has been in for weeks —
 * `gate_late` refused by its serving smoke, `gate_early` promoted and publishing
 * — because then every forecast panel on every screen answers
 * `FORECAST_NOT_YET_PUBLISHED` while a live gate sits unused beside it.
 *
 * Nothing here invents a forecast. It is the same `/v1/meta` lane table the
 * pills are already drawn from, applied to the selection as well as to the
 * styling, and only ever *towards* a lane that is promoted and usable. If every
 * lane is down, the refusal is the truth and the reader should see it.
 */

import { useEffect } from "react";
import { RUN_LABELS, type RunLabel } from "@/lib/fixtures";
import { gateProfileOf, useAppParams } from "./use-app-params";
import { useServing } from "./use-serving";

export interface RunLanes {
  /**
   * Whether this run's gate cannot serve a forecast at all.
   *
   * `usable` is tri-state and `undefined` means the modelling service is too old
   * to report it: read as unknown and never rounded down to a refusal, which is
   * the rule `absence.ts` states where the field is defined.
   *
   * Note what this deliberately does *not* cover: a lane that is promoted but
   * has published nothing for the day in question. That run is live — tomorrow
   * morning's gate will fill it — and the absence of today's forecast is stated
   * by the screen, where the reason belongs.
   */
  readonly inertFor: (run: RunLabel) => boolean;
}

export function useRunLanes(): RunLanes {
  const params = useAppParams();
  const serving = useServing();

  const inertFor = (run: RunLabel): boolean => {
    if (serving.status !== "known") {
      // While `/v1/meta` is in flight the pills stay live, for the same reason
      // the chrome badge stays blank: guessing produces a control that dims and
      // then brightens, which is worse than one that was briefly honest about
      // nothing.
      return false;
    }
    const profile = gateProfileOf(run);
    const lane = serving.lanes.find((entry) => entry.name.includes(profile));
    return lane !== undefined && (lane.condition !== "promoted" || lane.usable === false);
  };

  useEffect(() => {
    if (serving.status !== "known" || !inertFor(params.run)) {
      return;
    }
    const live = RUN_LABELS.find((run) => !inertFor(run as RunLabel)) as
      | RunLabel
      | undefined;
    if (live !== undefined) {
      params.setParams({ run: live });
    }
    /*
      Deliberately **not** guarded on "the reader has not chosen": an inert run
      cannot be chosen, because every control that offers one disables it.
      Anything inert in `params` therefore arrived from the default or from a
      stale link, and both should move.
    */
  }, [serving, params.run]);

  return { inertFor };
}

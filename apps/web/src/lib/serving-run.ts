/**
 * Which weather run `/app` should open on, when the address bar names none.
 *
 * ## Why this is not a constant
 *
 * `params.ts` defaulted `run` to `12Z` — `gate_late` — and that lane has never
 * promoted on this deployment. So a visitor landing on `/app` met four stated
 * absences while a complete forecast sat one pill away on `00Z`, and every
 * request the page made for the default lane came back a refusal:
 * `/v1/grid/outlook`, `/v1/forecast/day-ahead`, `/v1/diagnosis/day-ahead` and
 * `/v1/model/card` all 404 or 503 together. Measured on production, 21/09.
 *
 * `honesty.md` already forbids the shape of that bug in as many words — *never
 * state the deployment's condition from a constant; `/v1/meta` is the one read
 * that knows*. The default run is a claim about the deployment, so it comes
 * from the lane table.
 *
 * ## Why "promoted and usable" is not enough on its own
 *
 * A lane can be promoted, loadable, and still have published nothing for the
 * day being looked at: `gate_late` publishes at 19:00 BRT, so between a
 * successful retrain in the morning and 19:00 it is promoted **and** has no
 * forecast for tomorrow. Choosing it then would swap one empty screen for
 * another. The gate's own schedule is the third condition, and it costs no
 * request — `GATES` is published in `@wattsteer/core` and the instant is
 * arithmetic.
 *
 * ## Why the later gate wins a tie
 *
 * `gate_late` sees the 12Z weather run against `gate_early`'s 00Z and publishes
 * ten hours later. It is the better forecast, and it is the reason the two
 * gates exist. Defaulting to the earlier one whenever both can answer would pin
 * every first impression to the weaker of two available views.
 *
 * The order below is therefore freshest-first, and the filter is "can this lane
 * actually answer for this day", not "does this lane exist".
 */

import type { GateProfile } from "@wattsteer/core/api";
import { GATES, gateAt } from "@wattsteer/core/schedule";
import type { RunLabel } from "@/lib/fixtures";
import type { Lane } from "@/lib/lanes";
import { serves } from "@/lib/lanes";

/** Freshest gate first: 12Z publishes at 19:00, 00Z at 09:00. */
const BY_FRESHNESS: readonly GateProfile[] = ["gate_late", "gate_early"];

/**
 * The gate profile to open on, or `undefined` when none can answer yet.
 *
 * `undefined` rather than a guess: the caller keeps whatever default it had, so
 * a lane table that has not arrived — or a morning before either gate has
 * published — changes nothing, and the screen's own absence copy does the
 * explaining it already does well.
 */
export function servingGate(
  lanes: readonly Lane[],
  targetDate: string,
  now: Date,
): GateProfile | undefined {
  return BY_FRESHNESS.find((profile) => {
    const lane = lanes.find((entry) => entry.name.includes(profile));
    if (lane === undefined || !serves(lane)) {
      return false;
    }
    return gateAt(targetDate, profile).getTime() <= now.getTime();
  });
}

/** The run label a gate profile is shown as. The inverse of `gateProfileOf`. */
export function runOf(profile: GateProfile): RunLabel {
  const gate = GATES.find((entry) => entry.profile === profile);
  if (gate === undefined) {
    throw new RangeError(`No published gate has the profile "${profile}"`);
  }
  return gate.weatherRun as RunLabel;
}

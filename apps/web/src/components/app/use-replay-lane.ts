/**
 * The lane a replay is pinned to, read from the deployment rather than written
 * down.
 *
 * **Why this replaces a constant.** `REPLAY_LANE` was
 * `dessem_free_v1__gate_late__thr5`, spelled in `lib/fixtures/model-card.ts`
 * and exported through `lib/replay.ts`. On 22/09/2026 that lane was
 * `present_unpromoted` with `usable: false` — the gate had refused all seven of
 * its artifacts on `serving_smoke` — while `dessem_free_v1__gate_early__thr5`
 * was promoted and serving. Measured against production on the same window and
 * subsystem:
 *
 *     lane        days  replayable
 *     gate_early   120           5
 *     gate_late    120           0
 *
 * So every screen that pinned the constant asked for the one lane that could
 * not answer, and the Time Machine was empty by construction rather than for
 * any reason about the days. `honesty.md` names this defect twice already —
 * "never build a lane name in a client; `/v1/meta` knows which exist" — and
 * both prior instances were the same shape: a hard-coded lane reporting its own
 * refusal as the deployment's.
 *
 * **Why the first serving lane and not a named gate.** Nothing in
 * `docs/specs/replay.md` says which lane a post-go-live day's replay is *of*,
 * and `wattsteer_ml/replay/calendar.py` takes the lane as a required argument
 * precisely so that nobody picks one inside a keyword argument. This hook makes
 * the same choice the old constant's docstring described — pin the lane the
 * screen's other numbers come from — except that "the lane serving" is now read
 * where it is known instead of asserted where it is not.
 *
 * **`null` is a state, not a failure — and there are two of them.** While
 * `/v1/meta` is in flight there is no lane *yet*; where it answered with no
 * serving lane, or did not answer at all, there is no lane *at all*. A caller
 * that cannot tell those apart has only one move left, and it is the wrong one
 * either way: a skeleton that never resolves, which `honesty.md` rules out in
 * the same sentence as a bare dash. So {@link ReplayLane} carries `resolved`,
 * and a caller waits on the first and states an absence on the second.
 */

import type { GateProfile } from "@wattsteer/core/api";
import { useServing } from "@/components/app/use-serving";
import { serves } from "@/lib/lanes";

/**
 * The gate profile a lane name carries.
 *
 * Read out of the name `/v1/meta` gave us rather than composed — the opposite
 * direction from the constant this file replaced, and the same direction
 * `servingLaneFor` already matches in.
 */
const GATE_PROFILES: readonly GateProfile[] = ["gate_early", "gate_late"];

export interface ReplayLane {
  /** The lane to pin, or `null` when there is none to pin. */
  readonly lane: string | null;
  /**
   * Whether `/v1/meta` has answered. `false` means "not yet"; `true` with a
   * `null` lane means "nothing is serving", which is a sentence a screen owes
   * its reader rather than a state it may sit in.
   */
  readonly resolved: boolean;
  /**
   * That lane's gate profile, for the panels that take a profile instead of a
   * lane. `gate_late` was written at those call sites too, and it is the
   * profile with no usable lane behind it.
   */
  readonly gateProfile: GateProfile | null;
}

export function useReplayLane(): ReplayLane {
  const serving = useServing();
  if (serving.status === "reading") {
    return { lane: null, gateProfile: null, resolved: false };
  }
  /*
    `unknown` — `/v1/meta` itself did not answer — resolves to "no lane" rather
    than to "still reading": the deployment's condition is unknowable from
    here, every other read on the screen has failed too, and a picker spinning
    forever would be the one surface claiming the question is still open.
  */
  if (serving.status !== "known") {
    return { lane: null, gateProfile: null, resolved: true };
  }
  const name = serving.lanes.find(serves)?.name ?? null;
  return {
    resolved: true,
    lane: name,
    gateProfile:
      name === null ? null : (GATE_PROFILES.find((p) => name.includes(p)) ?? null),
  };
}

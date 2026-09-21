/**
 * The lane table, and the one question every screen asks it.
 *
 * ## Why this is a module and not three predicates
 *
 * "Does this lane serve?" is a conjunction of three facts — the name carries
 * the gate profile, the condition is `promoted`, and `usable` is not `false` —
 * and it was written three times, in three files, each behind a different React
 * hook:
 *
 * | where | what it spelled |
 * | --- | --- |
 * | `absence.ts` | `lanes.some(l => l.condition === "promoted" && l.usable !== false)` |
 * | `figures/use-model-card.ts` | the same, plus `entry.name.includes(gateProfile)` |
 * | `use-run-lanes.ts` | `find(e => e.name.includes(profile))`, then the negation |
 *
 * Three spellings of one rule are three answers to one question, and the cost
 * was visible in the suite rather than in the product: three assertions pinned
 * the rule **as source text** — `wired-screens.test.ts` quoted
 * `'lanes.some((lane) => lane.condition === "promoted" && lane.usable !== false)'`
 * and `'serving.lanes.find((entry) => entry.name.includes(profile))'` verbatim,
 * and `observed-overview.test.ts` quoted two more fragments. Renaming a loop
 * variable broke the suite; changing the rule in two of the three places broke
 * nothing.
 *
 * `.claude/rules/testing.md` licenses a source-text guard where a rule lives in
 * *how* something is called. This rule does not: it is a pure function of
 * `readonly Lane[]`, so it is reachable as a value, and the assertions are
 * values now.
 *
 * ## The two lookups are not the same lookup
 *
 * Worth stating because collapsing them would be the obvious mistake:
 *
 * - {@link servingLaneFor} wants a lane that **serves** this gate, so it
 *   filters on all three facts. A lane matching the name but refused is not an
 *   answer.
 * - {@link gateIsInert} asks whether the gate the reader is *on* cannot serve.
 *   It finds by **name alone** and then asks whether that lane serves, because
 *   a gate with no lane at all is not inert — it is unknown, and the pills stay
 *   live rather than dimming on an absence.
 *
 * The negation is exact: `!serves(lane)` is
 * `condition !== "promoted" || usable === false`, which is what
 * `use-run-lanes.ts` spelled by hand.
 *
 * ## `undefined` is not `false`
 *
 * `usable` is tri-state. `undefined` means the modelling service is too old to
 * report it, and a promoted lane is given the benefit of that doubt rather than
 * being called broken on a field that was never sent. That rule is now in one
 * place, and {@link serves} is where it is.
 */

import type { Meta, MetaLane } from "@wattsteer/core/api";

/**
 * `MetaLane.state` is the modelling service's vocabulary and it has four
 * members, not three — `apps/api/src/api/meta.ts` keeps `unresolvable` apart
 * from `no_artifact` on the grounds that mapping one onto the other would
 * report a damaged volume as an untrained lane. The distinction survives here
 * for the same reason: the repair is different in every case, and the reader of
 * this product is often the person who has to make it.
 */
export type LaneCondition = MetaLane["state"];

/** One lane, as the chrome and the honesty notes render it. */
export interface Lane {
  /** The lane directory name — data, never translated. */
  readonly name: string;
  readonly condition: LaneCondition;
  /**
   * Whether this lane can answer a forecast right now: promoted **and**
   * loadable. `undefined` when the modelling service is too old to report it,
   * which is not the same as `false` — so it is read as "unknown" and never
   * rounded down to a claim.
   */
  readonly usable: boolean | undefined;
}

/** Every serving lane `/v1/meta` knows about, in the order it published them. */
export function lanesOf(meta: Meta): readonly Lane[] {
  return meta.model.lanes.map((lane) => ({
    name: lane.lane,
    condition: lane.state,
    usable: lane.usable,
  }));
}

/**
 * Whether this one lane can answer a forecast.
 *
 * Promoted *and* not reported unusable. An artifact the hot-swap gate marked
 * invalid against the live feature contract is promoted and still serves
 * nothing, which is why `condition` alone is not the test.
 */
export function serves(lane: Lane): boolean {
  return lane.condition === "promoted" && lane.usable !== false;
}

/**
 * Whether any lane could serve — the one question the chrome asks.
 *
 * `false` when the modelling service is unreachable, because `lanes` is empty
 * then, which is correct: nothing can be served, and the reason is on the
 * `model.reachable` flag for whoever needs it.
 */
export function anyServing(lanes: readonly Lane[]): boolean {
  return lanes.some(serves);
}

/**
 * The lane serving this gate profile, or `undefined`.
 *
 * The gate profile is matched as a **substring of the lane name**, because
 * `dessem_free_v1__gate_early__thr5` carries the family, the gate and the
 * threshold in one identifier and only `/v1/meta` knows which are deployed.
 * Composing the name here would be a second source of it that drifts.
 */
export function servingLaneFor(
  lanes: readonly Lane[],
  gateProfile: string,
): Lane | undefined {
  return lanes.find((lane) => lane.name.includes(gateProfile) && serves(lane));
}

/**
 * Whether the gate the reader is on has a lane that cannot serve.
 *
 * Found by name alone, deliberately: a gate profile with **no** lane at all is
 * not inert, it is unknown, and a control that dims on an absence is a control
 * claiming something the lane table never said.
 */
export function gateIsInert(lanes: readonly Lane[], gateProfile: string): boolean {
  const lane = lanes.find((entry) => entry.name.includes(gateProfile));
  return lane !== undefined && !serves(lane);
}

/**
 * Which run `/app` opens on, which is a claim about the deployment.
 *
 * `lib/serving-run.ts` exists because `params.ts` defaulted the run to `12Z`
 * and that lane had never promoted: a visitor met four stated absences while a
 * complete forecast sat one pill away on `00Z`. `honesty.md` forbids exactly
 * that shape — *never state the deployment's condition from a constant* — and
 * this module is the fix.
 *
 * The fix had no test. Its three conditions interact, and each one can be
 * removed without any other suite noticing: drop the `serves` filter and the
 * screen opens on a refused lane again; drop the gate instant and it opens on a
 * lane that is promoted but has published nothing yet; reorder `BY_FRESHNESS`
 * and every first impression pins to the weaker of two available views. So each
 * is pinned separately here, against the gate table the module actually reads.
 *
 * **The instants.** `gateAt(D, profile)` is D−1 at the gate's local hour in
 * Brasília (UTC−3). For a target date of 2026-09-25 that is 2026-09-24, so
 * `gate_late` publishes at 19:00 BRT = 22:00Z and `gate_early` at 09:00 BRT =
 * 12:00Z. The `now` values below are written in UTC and chosen to sit either
 * side of those two instants.
 */

import { describe, expect, it } from "bun:test";
import type { Lane } from "../src/lib/lanes";
import { runOf, servingGate } from "../src/lib/serving-run";

const TARGET = "2026-09-25";
/** After 22:00Z: both gates for `TARGET` have published. */
const AFTER_BOTH = new Date("2026-09-24T23:00:00Z");
/** Between 12:00Z and 22:00Z: only the early gate has published. */
const AFTER_EARLY = new Date("2026-09-24T13:00:00Z");
/** Before 12:00Z: neither has. */
const BEFORE_EITHER = new Date("2026-09-24T11:00:00Z");

/** A lane as `/v1/meta` publishes it, named the way the deployment names them. */
function lane(profile: string, condition: Lane["condition"], usable?: boolean): Lane {
  return { name: `dessem_free_v1__${profile}__thr5`, condition, usable };
}

const BOTH_SERVING: readonly Lane[] = [
  lane("gate_early", "promoted", true),
  lane("gate_late", "promoted", true),
];

describe("the run the screen opens on", () => {
  it("prefers the later gate when both can answer", () => {
    // `gate_late` sees 12Z against `gate_early`'s 00Z and publishes ten hours
    // later: it is the better forecast and the reason two gates exist. A
    // reordered `BY_FRESHNESS` fails here and nowhere else.
    expect(servingGate(BOTH_SERVING, TARGET, AFTER_BOTH)).toBe("gate_late");
  });

  it("falls back to the earlier gate before the later one has published", () => {
    // The morning case, and the one that made the third condition necessary: a
    // lane can be promoted and loadable and still have published nothing for
    // the day being looked at.
    expect(servingGate(BOTH_SERVING, TARGET, AFTER_EARLY)).toBe("gate_early");
  });

  it("offers nothing before either gate has published", () => {
    // `undefined` rather than a guess. The caller keeps its own default and the
    // screen's absence copy does the explaining.
    expect(servingGate(BOTH_SERVING, TARGET, BEFORE_EITHER)).toBeUndefined();
  });
});

describe("a lane that cannot answer is not offered", () => {
  it("skips the gate whose lane the gate refused", () => {
    // The production state this module was written for: the late lane present
    // and unpromoted, the early one serving.
    const lanes = [
      lane("gate_early", "promoted", true),
      lane("gate_late", "present_unpromoted", false),
    ];
    expect(servingGate(lanes, TARGET, AFTER_BOTH)).toBe("gate_early");
  });

  it("skips a promoted lane the hot-swap gate marked unusable", () => {
    // Promoted is not enough. An artifact invalid against the live feature
    // contract is promoted and serves nothing, which is why `serves` reads both
    // fields — see `lib/lanes.ts`.
    const lanes = [
      lane("gate_early", "promoted", true),
      lane("gate_late", "promoted", false),
    ];
    expect(servingGate(lanes, TARGET, AFTER_BOTH)).toBe("gate_early");
  });

  it("treats an unreported `usable` as usable, never rounding it down", () => {
    // `undefined` is "the modelling service is too old to say", which is not
    // `false`. Rounding it down would hide a serving lane behind a version.
    const lanes = [lane("gate_late", "promoted", undefined)];
    expect(servingGate(lanes, TARGET, AFTER_BOTH)).toBe("gate_late");
  });

  it("offers nothing when no lane serves", () => {
    const lanes = [
      lane("gate_early", "present_unpromoted", false),
      lane("gate_late", "present_unpromoted", false),
    ];
    expect(servingGate(lanes, TARGET, AFTER_BOTH)).toBeUndefined();
  });

  it("offers nothing when the lane table is empty", () => {
    // The unreachable-modelling-service case: `lanes` is empty, and the honest
    // answer is that nothing can be opened on rather than a default.
    expect(servingGate([], TARGET, AFTER_BOTH)).toBeUndefined();
  });

  it("matches the gate by name and does not invent one", () => {
    // A lane whose name carries neither profile answers for neither. The
    // profile is matched as a substring because the lane name carries family,
    // gate and threshold in one identifier.
    const lanes = [lane("gate_middle", "promoted", true)];
    expect(servingGate(lanes, TARGET, AFTER_BOTH)).toBeUndefined();
  });
});

describe("the run label a gate is shown as", () => {
  it("reads both labels off the published gate table", () => {
    // Not typed in here: these come from `GATES`, which is also what the gate
    // instants above are computed from, so the two cannot drift apart.
    expect(runOf("gate_late")).toBe("12Z");
    expect(runOf("gate_early")).toBe("00Z");
  });

  it("refuses a profile no gate publishes, rather than guessing a label", () => {
    // A guessed label would put the wrong weather run under a real forecast.
    expect(() => runOf("gate_middle" as Parameters<typeof runOf>[0])).toThrow(RangeError);
  });
});

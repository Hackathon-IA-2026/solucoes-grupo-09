import { describe, expect, it } from "bun:test";
import {
  BAND_UNAVAILABLE_DECLINES,
  DECLINE_KINDS,
  GATEWAY_DECLINED_FIGURES,
} from "../src/declines.js";
import { readSchemas } from "../src/schema.js";
import type { DeclinedFigure as WireDeclinedFigure } from "../src/types.generated.js";

/**
 * The gateway's half of the census of figures WattSteer declines to state.
 *
 * Forecaster 25 asks for one surface listing every named absence, **assembled
 * and never transcribed**. Seven of the eight are declared in `apps/ml` and
 * assembled by walking that package; `wattsteer_ml/declined.py` and
 * `apps/ml/tests/test_declined_figures.py` hold that half. The eighth is
 * `band_unavailable_reason`, which this repository's *gateway* produces — the
 * modelling service publishes `Publication.national = None` and never spells
 * the identity — so it is declared here, beside the schema enum that owns it.
 *
 * **What makes this half derived rather than a list.** The table is a
 * `Record<BandUnavailableReason, …>`, and `BandUnavailableReason` is the
 * schema's enum. A second member added to `common.schema.json` is therefore
 * a *compile error* in `declines.ts` until it has an entry — the reason keying by
 * a closed union was chosen over an array, and the same mechanism
 * `copy.band.noBand` already uses to make a null band unrenderable without a
 * sentence. The assertions below are the runtime half of that claim, because a
 * regenerated type and a hand-edited schema can be one commit apart:
 *
 *  - the enum, read from the schema file, has an entry each way; and
 *  - the enum is not empty, so neither direction can pass vacuously.
 */

const enumMembers = (): readonly string[] => {
  const common = readSchemas().get("common.schema.json");
  const defs = (common as { $defs?: Record<string, { enum?: unknown }> } | undefined)
    ?.$defs;
  const members = defs?.band_unavailable_reason?.enum;
  return Array.isArray(members) ? members.map(String) : [];
};

describe("the gateway's declined figures are the schema's enum, both ways", () => {
  it("finds the enum at all", () => {
    // The guard on the guard. An enum this test could not read would make both
    // directions below vacuously true, which is how a derived set stops being
    // derived. `cache-policy.test.ts` guards its parse of the spec's caching
    // table the same way and for the same reason.
    expect(enumMembers().length).toBeGreaterThan(0);
  });

  it("has one entry per member, and no entry without a member", () => {
    // Both halves fail. A member with no entry is an absence a caller meets on
    // `/v1/grid/outlook` and cannot find on `/v1/meta`; an entry with no member
    // is a sentence about a state that no longer exists.
    expect(Object.keys(BAND_UNAVAILABLE_DECLINES).sort()).toEqual(
      [...enumMembers()].sort(),
    );
  });

  it("publishes the table's values and never a second list beside it", () => {
    expect(GATEWAY_DECLINED_FIGURES).toEqual(Object.values(BAND_UNAVAILABLE_DECLINES));
  });
});

describe("every entry carries what a reader needs to act on it", () => {
  it("names the figure, the reason, where it is met and where it is declared", () => {
    for (const entry of GATEWAY_DECLINED_FIGURES) {
      expect(entry.name).not.toBe("");
      expect(entry.figure).not.toBe("");
      expect(entry.surface).not.toBe("");
      expect(entry.declaredIn.endsWith(".ts")).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(60);
    }
  });

  it("says whether each is unrunnable or merely unrun", () => {
    // The distinction forecaster 16, 18 and 24 spent three tickets creating: a
    // figure that *cannot* be produced and one nobody has produced yet are two
    // different statements about this system, and a single "unavailable" bucket
    // would delete the difference.
    expect([...DECLINE_KINDS].sort()).toEqual(["unrun", "unrunnable"]);
    for (const entry of GATEWAY_DECLINED_FIGURES) {
      expect(DECLINE_KINDS).toContain(entry.kind);
    }
  });

  it("calls the national band unrunnable, because a joint draw is what is missing", () => {
    // Not "unrun". `api-surface.md`'s table is explicit: a national band is not
    // additive across subsystems and needs a joint distribution. Where no
    // national row was published there is no ensemble to read a quantile off,
    // and the absence is never filled by adding the four.
    expect(BAND_UNAVAILABLE_DECLINES.no_joint_ensemble.kind).toBe("unrunnable");
  });

  it("carries no number anywhere", () => {
    // The rule that produced these reasons in the first place, applied to the
    // census of them: a list of withheld measurements is the last surface that
    // could afford a figure a reader might take for one. Every field is prose.
    for (const entry of GATEWAY_DECLINED_FIGURES) {
      for (const value of Object.values(entry)) {
        expect(typeof value).toBe("string");
      }
    }
  });
});

describe("the hand-written entry and the generated wire shape are one shape", () => {
  it("is assignable to the wire's DeclinedFigure, checked by the compiler", () => {
    // `Band` in `domain.ts` and `Band` in `types.generated.ts` share a name and
    // are asserted to share a shape, because two definitions of a domain type
    // is not duplication to be tidied later. Same here, and the direction is
    // the one that matters: this table is what the gateway forwards, so it has
    // to satisfy the schema's own view of the row. The wire's `kind` admits a
    // third value this table's never carries — `unresolvable` is the gateway
    // refusing to guess about a *reported* kind, not a kind anything declares.
    for (const entry of GATEWAY_DECLINED_FIGURES) {
      const wire: WireDeclinedFigure = entry;
      expect(wire.name).toBe(entry.name);
    }
  });
});

import { describe, expect, it } from "bun:test";
import { SUBSYSTEM_DISPLAY_ORDER, subsystemMeta } from "../src/constants.js";
import { GATES, weatherRunLabel } from "../src/schedule.js";
import { shapeOf } from "../src/wire.js";

/**
 * The three lookups that throw rather than default, and the reason they do.
 *
 * Each of these takes a member of a closed enum and finds the row for it, and
 * each one ends with a branch its own comment calls unreachable. They are not
 * dead code and they are not defensive noise — they are a decision, stated
 * twice in the source: **a default here would be a plausible wrong answer.**
 *
 * `weatherRunLabel` says it plainest. *"A label invented for a gate that does
 * not exist would be a run name on a payload whose whole job is to say which
 * run produced the numbers."* The same is true of a subsystem's display name
 * and of a wire shape: the caller cannot tell an invented answer from a real
 * one, and every one of these feeds something a reader sees or a service
 * decodes.
 *
 * Unreachable through the type system is not unreachable through a generated
 * file, a migration, or a hand-built payload, which are the three ways a new
 * enum member actually arrives. So the branch is held here — reached by a cast,
 * which is the only way to reach it and is the point.
 *
 * This is the same argument `schema.ts`'s `validatorFor` test makes: a failure
 * path that has never run is a failure path that fails twice, once for the
 * defect and once for itself.
 */

describe("a subsystem that is not one", () => {
  it("resolves every code the enum does contain", () => {
    // Non-vacuity first: a lookup that threw on everything would pass the test
    // below and break the whole product.
    for (const code of SUBSYSTEM_DISPLAY_ORDER) {
      expect(subsystemMeta(code).onsDisplayName.length).toBeGreaterThan(0);
    }
    expect(SUBSYSTEM_DISPLAY_ORDER.length).toBe(4);
  });

  it("throws, naming the code, rather than returning a nameless row", () => {
    // `SUDESTE` is the realistic wrong value: it is what a model hallucinates
    // for `SE`, and `voice-execute.test.ts` holds the same string on the agent
    // side of the product.
    expect(() => subsystemMeta("SUDESTE" as never)).toThrow(RangeError);
    expect(() => subsystemMeta("SUDESTE" as never)).toThrow(/SUDESTE/);
  });
});

describe("a gate profile that is not one", () => {
  it("labels every profile the table does contain", () => {
    for (const gate of GATES) {
      expect(weatherRunLabel(gate.profile)).toContain("D−1");
      expect(weatherRunLabel(gate.profile)).toContain(gate.weatherRun);
    }
    expect(GATES.length).toBeGreaterThan(0);
  });

  it("throws rather than inventing a run name", () => {
    expect(() => weatherRunLabel("gate_noon" as never)).toThrow(RangeError);
    expect(() => weatherRunLabel("gate_noon" as never)).toThrow(/gate_noon/);
  });

  it("two profiles do not share a label", () => {
    // Non-vacuity for the loop above: a label that ignored its gate would
    // satisfy every assertion there and put the wrong run on every payload.
    const labels = GATES.map((gate) => weatherRunLabel(gate.profile));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("a wire shape by name", () => {
  it("hands back the descriptor the table holds", () => {
    const band = shapeOf("Band");
    expect(Object.keys(band).sort()).toEqual(["p10", "p50", "p90"]);
    expect(band.p10?.wire).toBe("p10");
  });

  it("is the same object the table holds, not a copy", () => {
    // `convert` keys off this on every decode; a per-call copy would be a
    // rebuild of the table on every field of every response.
    expect(shapeOf("Band")).toBe(shapeOf("Band"));
  });
});

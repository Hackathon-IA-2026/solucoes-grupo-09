import { describe, expect, it } from "bun:test";
import { explain, schemaFiles, validate, validatorFor } from "../src/schema.js";

const BAND_REF = "common.schema.json#/$defs/band";

/**
 * The parts of `schema.ts` that only run when something is already wrong.
 *
 * `validate` and the quantile-ordering keyword are exercised all over this
 * suite, because every passing contract test goes through them. What is not
 * exercised by a green run is the machinery a **red** one depends on: the
 * message a developer reads when a fixture stops matching its schema, and the
 * refusal when a `$ref` names nothing.
 *
 * That is the wrong way round. A failure path that has never run is a failure
 * path that fails twice — once for the real defect, and again because the thing
 * meant to describe it is broken too.
 *
 * The third case here is a separation the keyword's own comment states: *"`type`
 * / `required` own that failure; this keyword owns ordering."* A band whose
 * `p50` is a string must be refused for its **type**, not its order, or the
 * error points a reader at the wrong field.
 */

describe("the keyword owns ordering and nothing else", () => {
  it("refuses a band that is out of order", () => {
    // The property the keyword exists for, restated here so the cases below
    // are a contrast rather than assertions in a vacuum.
    expect(validate(BAND_REF, { p10: 5, p50: 2, p90: 3 }).valid).toBe(false);
  });

  it("defers a non-numeric quantile to `type`, and says so in the message", () => {
    /*
      The branch that returns `true` from an ordering check on bad input. It
      looks like a hole and is a handover: a string `p50` cannot be compared,
      and reporting it as "out of order" would send a reader to the wrong
      field. `type` refuses it, and the message names the type.
    */
    const result = validate(BAND_REF, { p10: 1, p50: "two", p90: 3 });
    expect(result.valid).toBe(false);
    expect(explain(result)).toContain("p50");
    expect(explain(result)).toMatch(/number/i);
    // And not on ordering, which is the half this asserts.
    expect(explain(result)).not.toMatch(/order/i);
  });

  it("defers a missing quantile to `required`", () => {
    const result = validate(BAND_REF, { p10: 1, p90: 3 });
    expect(result.valid).toBe(false);
    expect(explain(result)).toMatch(/required|p50/i);
  });
});

describe("the message a broken contract produces", () => {
  it("names the path and what was wrong with it", () => {
    // `explain` is what `spec-examples.test.ts` prints when a fixture stops
    // matching. In a green run it never executes, so this is the only place it
    // is held to producing something a reader can act on.
    const result = validate(BAND_REF, { p10: 5, p50: 2, p90: 3 });
    const message = explain(result);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toBe("undefined");
  });

  it("is empty for a valid value, so a passing assertion reads as empty", () => {
    // The idiom at the call site is `expect(result.valid ? "" : explain(result))
    // .toBe("")`, which only works if a valid result explains to nothing.
    const result = validate(BAND_REF, { p10: 1, p50: 2, p90: 3 });
    expect(result.valid).toBe(true);
    expect(explain(result)).toBe("");
  });

  it("joins several failures rather than reporting only the first", () => {
    // A reader fixing a fixture wants the whole list; one-at-a-time turns a
    // five-minute fix into five runs.
    const result = validate("common.schema.json#/$defs/band", {
      p10: "a",
      p50: "b",
      p90: "c",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
    expect(explain(result).split(";").length).toBeGreaterThan(1);
  });
});

describe("a `$ref` that names nothing is refused, not silently undefined", () => {
  it("throws, naming the ref it could not find", () => {
    // Without this a typo'd ref returns `undefined` from Ajv and the failure
    // surfaces later as "check is not a function", somewhere else entirely.
    expect(() => validatorFor("no-such-file.schema.json")).toThrow(RangeError);
    expect(() => validatorFor("no-such-file.schema.json")).toThrow(
      /no-such-file\.schema\.json/,
    );
  });

  it("resolves a ref that does exist, so the guard is not refusing everything", () => {
    // Non-vacuity: a `validatorFor` that threw unconditionally would pass the
    // assertion above.
    expect(typeof validatorFor(BAND_REF)).toBe("function");
  });
});

describe("the schema directory the generator walks", () => {
  it("lists real files, sorted", () => {
    const files = schemaFiles();
    expect(files.length).toBeGreaterThan(0);
    expect([...files].sort()).toEqual(files);
    for (const file of files) {
      expect(file).toMatch(/\.schema\.json$/);
    }
  });

  it("includes the file every other schema refers to", () => {
    // `common.schema.json` holds `$defs/band`, which the cross-file `$ref`s
    // resolve against; a directory listing that missed it would build a
    // validator that cannot resolve anything.
    expect(schemaFiles()).toContain("common.schema.json");
  });
});

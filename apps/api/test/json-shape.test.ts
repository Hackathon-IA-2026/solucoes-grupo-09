import { describe, expect, it } from "bun:test";
import { asNumber, asOneOf, asString, isRecord } from "../src/json/shape.js";

/**
 * The shape readers, which decide nothing — see the module's own header for
 * why that is the point rather than an omission.
 *
 * These were six identical copies of `isRecord` and a scatter of inline
 * `typeof` guards. What is worth testing is the handful of cases where the
 * obvious implementation is wrong: the two values `typeof` calls an object,
 * the two numbers JSON cannot carry but a transform can, and the closed set
 * that must refuse rather than round.
 */

describe("isRecord separates an object from the two things typeof calls one", () => {
  it("accepts a plain object, including an empty one", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("rejects null and arrays, which `typeof` reports as `object`", () => {
    // The whole reason the function exists. `typeof null === "object"` and
    // `typeof [] === "object"`, so the naive guard admits both — and an array
    // indexed by a string key yields `undefined` on every read, which looks
    // exactly like a body with every field missing.
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
  });

  it("rejects the primitives", () => {
    for (const value of ["", "text", 0, 1, true, false, undefined]) {
      expect({ value, record: isRecord(value) }).toEqual({ value, record: false });
    }
  });
});

describe("asNumber refuses the two numbers JSON cannot carry", () => {
  it("accepts finite numbers, including zero and negatives", () => {
    expect(asNumber(0)).toBe(0);
    expect(asNumber(-12.5)).toBe(-12.5);
  });

  it("refuses NaN and the infinities", () => {
    // JSON has no literal for these, but a body that has been through a lossy
    // transform can carry them — and a `NaN` reaching a chart is an axis with
    // no scale rather than a visible error.
    expect(asNumber(Number.NaN)).toBeUndefined();
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asNumber(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  it("refuses a numeric string, which is a different fact", () => {
    expect(asNumber("42")).toBeUndefined();
  });

  it("refuses null, so a caller can tell absent from zero", () => {
    // The distinction the whole domain rests on: an unsettled hour and an hour
    // that settled at zero are different facts.
    expect(asNumber(null)).toBeUndefined();
    expect(asNumber(0)).toBe(0);
  });
});

describe("asString treats empty as absent", () => {
  it("accepts a non-empty string", () => {
    expect(asString("12Z")).toBe("12Z");
  });

  it("refuses the empty string — an empty run label is not a run", () => {
    expect(asString("")).toBeUndefined();
  });

  it("refuses non-strings, including numbers that would stringify", () => {
    expect(asString(12)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString({})).toBeUndefined();
  });
});

describe("asOneOf refuses rather than rounding to the nearest member", () => {
  const FIDELITY = ["point_in_time", "revision_optimistic"] as const;

  it("accepts an exact member", () => {
    expect(asOneOf("point_in_time", FIDELITY)).toBe("point_in_time");
  });

  it("refuses an unknown member instead of picking one", () => {
    // The defect this prevents by construction: a third fidelity rounded down
    // to `revision_optimistic` is a metric filed under a caveat it was never
    // measured with.
    expect(asOneOf("fold_holdout", FIDELITY)).toBeUndefined();
  });

  it("refuses a near-miss — case and whitespace are not the same value", () => {
    expect(asOneOf("POINT_IN_TIME", FIDELITY)).toBeUndefined();
    expect(asOneOf(" point_in_time", FIDELITY)).toBeUndefined();
  });

  it("refuses an empty string and a non-string", () => {
    expect(asOneOf("", FIDELITY)).toBeUndefined();
    expect(asOneOf(null, FIDELITY)).toBeUndefined();
  });
});

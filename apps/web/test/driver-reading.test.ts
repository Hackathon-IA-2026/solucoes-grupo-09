import { describe, expect, it } from "bun:test";
import { type Copy, en } from "../src/i18n/copy.en";
import { formatContribution, formatReading } from "../src/i18n/drivers";
import { formattersFor } from "../src/i18n/format";

/**
 * How a driver's reading becomes a line — including the reading that must not.
 *
 * The module's header states the rule this is written against: `null` for a
 * `none` reading, "and the caller omits the line rather than printing an empty
 * pair: a group with no reading at serve time has nothing to show, which is not
 * the same as having read zero." That is the domain's central distinction
 * showing up in a formatter, and a formatter that returned `""` instead would
 * satisfy every type in the program while publishing an absence as a
 * measurement.
 */

const f = formattersFor("en");
const copy = en as Copy;

describe("a reading that does not exist produces no line", () => {
  it("`none` is null, not an empty string", () => {
    // `""` would render as a blank value beside a label — a group that read
    // nothing, shown as a group that read nothing *in particular*.
    expect(formatReading({ kind: "none" } as never, copy, f)).toBeNull();
  });

  it("zero is a line, because zero is a measurement", () => {
    const line = formatReading({ kind: "value", value: 0, unit: "MW" } as never, copy, f);
    expect(line).not.toBeNull();
    expect(line).toContain("0");
  });
});

describe("a value carries its unit, its sign and its precision", () => {
  it("appends the unit when there is one, and omits it when there is not", () => {
    expect(
      formatReading({ kind: "value", value: 12, unit: "MW" } as never, copy, f),
    ).toBe("12 MW");
    expect(formatReading({ kind: "value", value: 12 } as never, copy, f)).toBe("12");
  });

  it("signs a positive value only when asked", () => {
    // `signed` exists for readings where the direction is the point — a driver
    // that pushed curtailment *up* reads differently from one that did not.
    expect(
      formatReading({ kind: "value", value: 12, signed: true } as never, copy, f),
    ).toBe("+12");
    expect(formatReading({ kind: "value", value: 12 } as never, copy, f)).toBe("12");
  });

  it("never writes `+0` or `+-5`", () => {
    // The sign is for positives only. `+0` claims a direction zero does not
    // have, and a doubled sign is just wrong.
    expect(
      formatReading({ kind: "value", value: 0, signed: true } as never, copy, f),
    ).toBe("0");
    const negative = formatReading(
      { kind: "value", value: -5, signed: true } as never,
      copy,
      f,
    );
    expect(negative).not.toContain("+");
    expect(negative).toContain("5");
  });

  it("honours the requested decimals, defaulting to none", () => {
    expect(
      formatReading({ kind: "value", value: 12.34, decimals: 1 } as never, copy, f),
    ).toBe("12.3");
    expect(formatReading({ kind: "value", value: 12.34 } as never, copy, f)).toBe("12");
  });
});

describe("a term reading is a word from the dictionary, not a number", () => {
  it("reads the term out of the copy table", () => {
    const [term] = Object.keys(copy.app.drivers.terms);
    const line = formatReading({ kind: "term", term } as never, copy, f);
    expect(line).toBe(
      copy.app.drivers.terms[term as keyof typeof copy.app.drivers.terms],
    );
    expect(line).not.toBe("");
  });

  it("every term in the dictionary formats to something non-empty", () => {
    for (const term of Object.keys(copy.app.drivers.terms)) {
      const line = formatReading({ kind: "term", term } as never, copy, f);
      expect({ term, empty: line === null || line.trim() === "" }).toEqual({
        term,
        empty: false,
      });
    }
  });
});

describe("a contribution always writes its sign, with a real minus", () => {
  it("signs both directions — the arrow is not the only claim", () => {
    // The docstring's argument: "a bare '128,0 MWh' under a downward arrow
    // makes two claims about direction and leaves only one of them
    // checkable." So the sign is written for positives too.
    expect(formatContribution(128, f).startsWith("+")).toBe(true);
    expect(formatContribution(-128, f).startsWith("+")).toBe(false);
  });

  it("uses U+2212 MINUS, not a hyphen", () => {
    // A hyphen-minus is a different character and renders narrower and lower
    // beside tabular figures — the column stops lining up, which is the whole
    // reason these are set in `tabular-nums`.
    const negative = formatContribution(-128, f);
    expect(negative.charCodeAt(0)).toBe(0x22_12);
    expect(negative).not.toContain("-");
  });

  it("zero reads as positive rather than as a signless figure", () => {
    // Not a judgement about zero — a consequence of `< 0`, pinned so that a
    // later change to `<= 0` is a visible decision rather than a silent one.
    expect(formatContribution(0, f).startsWith("+")).toBe(true);
  });

  it("one decimal, on the magnitude, with the sign outside it", () => {
    expect(formatContribution(-128.04, f)).toBe("−128.0");
    expect(formatContribution(128.04, f)).toBe("+128.0");
  });
});

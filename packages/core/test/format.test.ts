import { describe, expect, it } from "bun:test";
import { formatCompact, formatDate } from "../src/format";

describe("formatCompact", () => {
  it("leaves values below 1000 alone", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(950)).toBe("950");
  });

  it("abbreviates with one decimal below 10, none above", () => {
    expect(formatCompact(1400)).toBe("1.4K");
    expect(formatCompact(14_000)).toBe("14K");
    expect(formatCompact(2_100_000)).toBe("2.1M");
  });

  it("drops a trailing .0", () => {
    expect(formatCompact(1000)).toBe("1K");
  });

  it("survives non-finite input", () => {
    expect(formatCompact(Number.NaN)).toBe("0");
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatDate", () => {
  it("formats an ISO instant", () => {
    expect(formatDate("2026-03-04T12:00:00Z")).toBe("Mar 4, 2026");
  });

  it("treats a date-only string as local, not UTC midnight", () => {
    // The bug this guards: UTC midnight renders as the previous day west of UTC.
    expect(formatDate("2010-10-06")).toBe("Oct 6, 2010");
  });

  it("returns the input unchanged when it is not a date", () => {
    expect(formatDate("not a date")).toBe("not a date");
  });
});

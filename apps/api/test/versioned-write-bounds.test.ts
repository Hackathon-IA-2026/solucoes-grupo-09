import { describe, expect, it } from "bun:test";
import { validTimeBounds } from "../src/ingest/versioned-write.js";

describe("the valid-time range of a write batch", () => {
  const start = Date.parse("2026-08-01T03:00:00.000Z");
  // A month of the plant-level wind detail is this order of rows.
  const rows = Array.from({ length: 1_000_000 }, (_, i) => ({
    at: new Date(start + (i % 744) * 3_600_000),
  }));

  it("survives a batch too large to spread into Math.min", () => {
    const times = rows.map((row) => row.at.getTime());
    // Non-vacuous: the shape it replaces does fail at this size.
    expect(() => Math.min(...times)).toThrow(RangeError);
    const { from, to } = validTimeBounds(rows, (row) => row.at);
    expect(from.toISOString()).toBe("2026-08-01T03:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-01T02:00:00.000Z");
  });

  it("is the one row's time when there is one row", () => {
    const { from, to } = validTimeBounds([{ at: new Date(start) }], (row) => row.at);
    expect(from.getTime()).toBe(start);
    expect(to.getTime()).toBe(start);
  });
});

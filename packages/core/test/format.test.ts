import { describe, expect, test } from "bun:test";
import {
  averageRating,
  formatCompact,
  formatDate,
  formatRating,
  ratingDistribution,
} from "../src/format";
import type { Review } from "../src/types";

function review(rating: number): Review {
  return {
    store: "apple",
    id: String(Math.trunc(rating * 100)),
    userName: "u",
    title: "",
    body: "",
    rating,
    date: "2026-01-01T00:00:00Z",
    developerResponse: null,
    appId: "42",
    country: "us",
  };
}

describe("formatCompact", () => {
  test("small numbers pass through", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(950)).toBe("950");
  });
  test("thousands / millions / billions", () => {
    expect(formatCompact(1_400)).toBe("1.4K");
    expect(formatCompact(14_000)).toBe("14K");
    expect(formatCompact(2_100_000)).toBe("2.1M");
    expect(formatCompact(3_000_000_000)).toBe("3B");
  });
  test("drops the pointless .0", () => {
    expect(formatCompact(2_000)).toBe("2K");
  });
  test("negative and non-finite inputs are safe", () => {
    expect(formatCompact(-1_500)).toBe("-1.5K");
    expect(formatCompact(Number.NaN)).toBe("0");
  });
});

describe("formatRating", () => {
  test("one decimal always", () => {
    expect(formatRating(4.6666)).toBe("4.7");
    expect(formatRating(5)).toBe("5.0");
  });
});

describe("formatDate", () => {
  test("renders a friendly date", () => {
    expect(formatDate("2026-03-04T12:00:00Z")).toBe("Mar 4, 2026");
  });
  test("falls back to the raw string on garbage", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });

  test("date-only strings render the SAME calendar day in every timezone", () => {
    // "2010-10-06" parsed as UTC midnight shows Oct 5 in UTC-negative zones.
    expect(formatDate("2010-10-06")).toBe("Oct 6, 2010");
  });
});

describe("ratingDistribution", () => {
  test("buckets 1..5 and ignores 0 (missing upstream)", () => {
    const dist = ratingDistribution([
      review(5),
      review(5),
      review(4),
      review(1),
      review(0),
    ]);
    expect(dist).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 2 });
  });
});

describe("averageRating", () => {
  test("mean of rated reviews only", () => {
    expect(averageRating([review(5), review(4), review(0)])).toBe(4.5);
  });
  test("0 when nothing is rated", () => {
    expect(averageRating([])).toBe(0);
    expect(averageRating([review(0)])).toBe(0);
  });
});

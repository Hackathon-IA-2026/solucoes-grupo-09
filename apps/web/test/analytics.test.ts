import { describe, expect, test } from "bun:test";
import type { Review } from "@noviq/core";
import {
  distributionPct,
  initials,
  keywords,
  responseRate,
  reviewTone,
  sentimentMix,
  timeline,
  versionStats,
} from "../src/lib/analytics";

function review(overrides: Partial<Review>): Review {
  return {
    store: "google",
    id: Math.random().toString(36).slice(2),
    userName: "user",
    title: "",
    body: "",
    rating: 5,
    date: "2026-06-01T00:00:00Z",
    developerResponse: null,
    appId: "com.x.y",
    country: "us",
    ...overrides,
  };
}

describe("sentimentMix", () => {
  test("buckets by rating and sums to 100", () => {
    const mix = sentimentMix([
      review({ rating: 5 }),
      review({ rating: 4 }),
      review({ rating: 3 }),
      review({ rating: 1 }),
    ]);
    expect(mix.positive).toBe(50);
    expect(mix.negative).toBe(25);
    expect(mix.positive + mix.neutral + mix.negative).toBe(100);
  });

  test("empty input is all zeroes", () => {
    expect(sentimentMix([])).toEqual({ positive: 0, neutral: 0, negative: 0 });
  });
});

describe("distributionPct", () => {
  test("percentages by star, index 0 = 1★", () => {
    const dist = distributionPct([
      review({ rating: 5 }),
      review({ rating: 5 }),
      review({ rating: 1 }),
      review({ rating: 0 }), // unrated upstream — excluded
    ]);
    expect(dist[4]).toBeCloseTo(66.67, 1);
    expect(dist[0]).toBeCloseTo(33.33, 1);
    expect(dist[1]).toBe(0);
  });
});

describe("timeline", () => {
  test("groups by month oldest→newest with avg rating", () => {
    const points = timeline([
      review({ date: "2026-05-10T00:00:00Z", rating: 4 }),
      review({ date: "2026-05-20T00:00:00Z", rating: 2 }),
      review({ date: "2026-06-01T00:00:00Z", rating: 5 }),
    ]);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ month: "May", count: 2, avg: 3 });
    expect(points[1]).toMatchObject({ month: "Jun", count: 1, avg: 5 });
  });

  test("caps at 12 buckets and skips invalid dates", () => {
    const reviews = Array.from({ length: 14 }, (_, i) =>
      review({ date: new Date(Date.UTC(2025, i, 5)).toISOString() }),
    );
    reviews.push(review({ date: "garbage" }));
    expect(timeline(reviews)).toHaveLength(12);
  });
});

describe("keywords", () => {
  test("counts repeated meaningful words with rating tone", () => {
    const words = keywords([
      review({ body: "The offline mode is fantastic", rating: 5 }),
      review({ body: "offline playback keeps crashing", rating: 1 }),
      review({ body: "crashing constantly since the update", rating: 1 }),
    ]);
    const offline = words.find((w) => w.word === "offline");
    const crashing = words.find((w) => w.word === "crashing");
    expect(offline?.count).toBe(2);
    expect(crashing).toMatchObject({ count: 2, tone: "negative" });
  });

  test("ignores stopwords and short words", () => {
    const words = keywords([
      review({ body: "the app is so good and i love it" }),
      review({ body: "the app is so good and i love it" }),
    ]);
    expect(words.find((w) => w.word === "the")).toBeUndefined();
    expect(words.find((w) => w.word === "good")).toBeUndefined(); // stopword
  });
});

describe("versionStats", () => {
  test("averages per version, most-reviewed first", () => {
    const stats = versionStats([
      review({ appVersion: "2.0", rating: 5 }),
      review({ appVersion: "2.0", rating: 3 }),
      review({ appVersion: "1.9", rating: 2 }),
      review({}), // no version — excluded
    ]);
    expect(stats[0]).toMatchObject({ version: "2.0", rating: 4, reviews: 2 });
    expect(stats[1]).toMatchObject({ version: "1.9", reviews: 1 });
  });
});

describe("responseRate / tone / initials", () => {
  test("responseRate is the replied percentage", () => {
    expect(
      responseRate([
        review({ developerResponse: { body: "hi", modified: "2026-01-01" } }),
        review({}),
      ]),
    ).toBe(50);
    expect(responseRate([])).toBe(0);
  });

  test("reviewTone maps ratings to tones", () => {
    expect(reviewTone(review({ rating: 5 }))).toBe("positive");
    expect(reviewTone(review({ rating: 3 }))).toBe("neutral");
    expect(reviewTone(review({ rating: 1 }))).toBe("negative");
  });

  test("initials from names", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("madonna")).toBe("M");
    expect(initials("  ")).toBe("?");
  });
});

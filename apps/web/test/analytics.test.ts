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
  test("averages per version, most-reviewed first (direct, Google)", () => {
    const { stats, approximate } = versionStats([
      review({ appVersion: "2.0", rating: 5 }),
      review({ appVersion: "2.0", rating: 3 }),
      review({ appVersion: "1.9", rating: 2 }),
      review({}), // no version — excluded
    ]);
    expect(approximate).toBe(false);
    expect(stats[0]).toMatchObject({ version: "2.0", rating: 4, reviews: 2 });
    expect(stats[1]).toMatchObject({ version: "1.9", reviews: 1 });
  });

  test("approximates from release windows when reviews lack versions (Apple)", () => {
    const history = [
      { version: "3.0", released: "2026-06-01T00:00:00Z", notes: null },
      { version: "2.9", released: "2026-05-01T00:00:00Z", notes: null },
    ];
    const { stats, approximate } = versionStats(
      [
        review({ date: "2026-06-10T00:00:00Z", rating: 2 }), // 3.0 window
        review({ date: "2026-06-20T00:00:00Z", rating: 4 }), // 3.0 window
        review({ date: "2026-05-15T00:00:00Z", rating: 5 }), // 2.9 window
        review({ date: "2026-04-01T00:00:00Z", rating: 1 }), // pre-history: dropped
      ],
      history,
    );
    expect(approximate).toBe(true);
    expect(stats).toEqual([
      { version: "3.0", rating: 3, reviews: 2 },
      { version: "2.9", rating: 5, reviews: 1 },
    ]);
  });

  test("counts (not hides) reviews that predate the known releases", () => {
    const history = [{ version: "3.0", released: "2026-06-01T00:00:00Z", notes: null }];
    const breakdown = versionStats(
      [
        review({ date: "2026-06-10T00:00:00Z" }),
        review({ date: "2026-01-01T00:00:00Z" }),
        review({ date: "2025-12-01T00:00:00Z" }),
      ],
      history,
    );
    expect(breakdown.excluded).toBe(2);
    expect(breakdown.stats[0].reviews).toBe(1);
  });

  test("empty without versions or history", () => {
    expect(versionStats([review({})])).toEqual({
      approximate: false,
      excluded: 0,
      stats: [],
    });
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

describe("heatmap", () => {
  const at = (day: number, hour: number, rating = 5) =>
    review({
      // 2026-06-07 is a Sunday; add days/hours from there (UTC parsing shifts
      // by local TZ, so build via local-time constructor instead).
      date: new Date(2026, 5, 7 + day, hour, 30).toISOString(),
      rating,
    });
  // Import lazily to keep the existing import block untouched.
  const { heatmap } =
    require("../src/lib/analytics") as typeof import("../src/lib/analytics");

  test("7×7 grid from real timestamps, busiest hours as rows", () => {
    const reviews = [
      ...Array.from({ length: 6 }, () => at(0, 14)), // Sun 2pm ×6
      ...Array.from({ length: 3 }, () => at(3, 14)), // Wed 2pm ×3
      at(1, 9),
      at(2, 10),
      at(4, 11),
      at(5, 12),
      at(6, 13),
      at(0, 8),
    ];
    const data = heatmap(reviews, "reviews");
    expect(data).not.toBeNull();
    expect(data?.levels).toHaveLength(7);
    expect(data?.levels[0]).toHaveLength(7);
    expect(data?.days[0]).toBe("Sun");
    // 2pm is the busiest hour → a row label "2pm" exists.
    expect(data?.hours).toContain("2pm");
    // The Sun 2pm cell is the hottest (level 4); empty cells are 0.
    const row2pm = data?.hours.indexOf("2pm") ?? -1;
    expect(data?.levels[row2pm][0]).toBe(4);
    expect(data?.legend).toHaveLength(4);
  });

  test("ratings dimension maps averages to bands", () => {
    const data = heatmap([at(0, 14, 5), at(0, 14, 5), at(1, 14, 1)], "ratings");
    const row = data?.hours.indexOf("2pm") ?? -1;
    expect(data?.levels[row][0]).toBe(4); // avg 5 → top band
    expect(data?.levels[row][1]).toBe(1); // avg 1 → bottom band
    expect(data?.levels[row][2]).toBe(0); // no reviews
  });

  test("null when no valid dates", () => {
    expect(heatmap([review({ date: "garbage" })], "reviews")).toBeNull();
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Canned in-page responses, mirroring the pipeline test's cloakbrowser mock.
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
let server: (url: string, init?: FetchInit) => { status: number; body: string };
let jsonLd: string[] = [];

function makePage() {
  return {
    async goto() {
      return { status: () => 200 };
    },
    mouse: { async wheel() {} },
    async evaluate(_fn: unknown, arg?: { url: string; init?: FetchInit }) {
      if (arg === undefined) return jsonLd;
      return server(arg.url, arg.init);
    },
  };
}
function makeContext() {
  return {
    async newPage() {
      return makePage();
    },
    async close() {},
  };
}
mock.module("cloakbrowser", () => ({
  launch: async () => ({
    async newContext() {
      return makeContext();
    },
    async close() {},
  }),
  launchPersistentContext: async () => makeContext(),
}));

// Import AFTER the mock so the engine binds to it. DATABASE_URL is unset in the
// test env, so the repository is null and persistence is a no-op (best-effort).
const { ReviewService } = await import("../src/api/reviews/service.js");

const APP_LD = JSON.stringify({
  "@type": "SoftwareApplication",
  name: "Mock App",
  author: { name: "Mock Dev" },
  aggregateRating: { ratingValue: "4.5", ratingCount: "10" },
  offers: { price: "0", priceCurrency: "USD" },
});

/** Apple offset-paginated review server with `total` reviews. */
function appleServer(total: number) {
  return (url: string) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    if (offset >= total) return { status: 404, body: "" };
    const data = [];
    for (let i = offset; i < Math.min(offset + 20, total); i++) {
      data.push({
        id: String(1000 + i),
        attributes: { rating: 4, date: "2025-01-01T00:00:00Z" },
      });
    }
    const next = offset + 20 < total ? `/r?offset=${offset + 20}` : undefined;
    return { status: 200, body: JSON.stringify({ data, next }) };
  };
}

const FAST = { store: "apple" as const, stealth: "fast" as const };

describe("ReviewService.scrape", () => {
  beforeEach(() => {
    server = appleServer(5);
    jsonLd = [APP_LD];
  });

  test("returns reviews + captured appInfo with partial=false", async () => {
    const res = await ReviewService.scrape({ appId: "1", ...FAST });
    expect(res).toMatchObject({
      store: "apple",
      appId: "1",
      country: "us",
      partial: false,
    });
    expect(res.count).toBe(5);
    expect(res.reviews).toHaveLength(5);
    expect(res.appInfo).toMatchObject({
      name: "Mock App",
      developer: "Mock Dev",
      averageRating: 4.5,
    });
  });

  test("lowercases the country and honors an explicit store", async () => {
    const res = await ReviewService.scrape({
      appId: "1",
      store: "apple",
      country: "GB",
      stealth: "fast",
    });
    expect(res.country).toBe("gb");
  });

  test("appInfo is null when the landing page exposes no structured data", async () => {
    jsonLd = [];
    const res = await ReviewService.scrape({ appId: "1", ...FAST });
    expect(res.count).toBe(5);
    expect(res.appInfo).toBeNull();
  });

  test("rejects invalid input before scraping (BadInputError → 400)", async () => {
    await expect(ReviewService.scrape({ appId: "not-an-app" })).rejects.toThrow();
  });
});

describe("ReviewService.appInfo (metadata only)", () => {
  beforeEach(() => {
    // Reviews would be served, but appInfo() must not paginate them.
    server = appleServer(100);
    jsonLd = [APP_LD];
  });

  test("returns just the metadata envelope", async () => {
    const res = await ReviewService.appInfo({ appId: "1", ...FAST });
    expect(res).toMatchObject({ store: "apple", appId: "1", country: "us" });
    expect(res.appInfo).toMatchObject({ name: "Mock App", averageRating: 4.5, price: 0 });
  });

  test("appInfo is null when no structured data is present", async () => {
    jsonLd = [];
    const res = await ReviewService.appInfo({ appId: "1", ...FAST });
    expect(res.appInfo).toBeNull();
  });
});

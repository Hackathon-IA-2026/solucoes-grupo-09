import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Review } from "../src/types.js";

// A canned "server": maps an in-page fetch (url, init) to an HTTP-ish response.
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
type Server = (url: string, init?: FetchInit) => { status: number; body: string };
let server: Server;

// JSON-LD that readJsonLdScripts() returns from the (arg-less) page.evaluate.
// Tests set these to exercise app-metadata extraction.
let jsonLd: string[] = [];
let jsonLdThrows = false;
let jsonLdReads = 0; // how many times the page's JSON-LD was read
let gotoStatus = 200; // HTTP status the landing-page navigation returns
let gotoAttempts = 0; // how many times goto() was called (navigation retries)

// --- mock cloakbrowser so runScraper exercises the real pipeline, no network ---
function makePage() {
  return {
    async goto() {
      gotoAttempts++;
      return { status: () => gotoStatus };
    },
    mouse: { async wheel() {} },
    // pageFetch calls page.evaluate(fn, { url, init }); readJsonLdScripts calls
    // page.evaluate(fn) with no arg. We ignore fn and dispatch on the arg shape.
    async evaluate(_fn: unknown, arg?: { url: string; init?: FetchInit }) {
      if (arg === undefined) {
        jsonLdReads++;
        if (jsonLdThrows) throw new Error("evaluate failed");
        return jsonLd;
      }
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

// Import AFTER the mock is registered so browser.ts binds to it.
const {
  streamReviews,
  getReviews,
  getAppInfo,
  streamAppleReviews,
  getAppleReviews,
  streamGoogleReviews,
  getGoogleReviews,
} = await import("../src/scrape.js");
const { BadInputError, UpstreamError } = await import("../src/errors.js");

const APP_LD = JSON.stringify({
  "@type": "SoftwareApplication",
  name: "Test App",
  author: { name: "Test Dev" },
  applicationCategory: "Utilities",
  aggregateRating: { ratingValue: "4.2", ratingCount: "999" },
  offers: { price: "0", priceCurrency: "USD" },
});

// --- fake store backends ---
function appleServer(total: number): Server {
  return (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    if (offset >= total) return { status: 404, body: "" };
    const data: unknown[] = [];
    for (let i = offset; i < Math.min(offset + 20, total); i++) {
      data.push({
        id: String(1000 + i),
        attributes: {
          userName: `u${i}`,
          title: `t${i}`,
          review: `b${i}`,
          rating: (i % 5) + 1,
          date: new Date(Date.UTC(2025, 0, 1) - i * 86_400_000).toISOString(),
          isEdited: false,
        },
      });
    }
    const nextOff = offset + 20;
    const next =
      nextOff < total ? `/v1/catalog/us/apps/1/reviews?offset=${nextOff}` : undefined;
    return { status: 200, body: JSON.stringify({ data, next }) };
  };
}

function googleServer(pages: string[][]): Server {
  return (_url, init) => {
    const outer = JSON.parse(
      decodeURIComponent(String(init?.body ?? "").slice("f.req=".length)),
    );
    const inner = JSON.parse(outer[0][0][1]);
    const token = inner[2][2][2]; // null on first page, else "T<idx>"
    const idx = token == null ? 0 : Number(String(token).slice(1));
    const rows = (pages[idx] ?? []).map((id, k) => {
      const r: unknown[] = [];
      r[0] = id;
      r[1] = [`user${id}`];
      r[2] = ((idx + k) % 5) + 1;
      r[4] = `body${id}`;
      r[5] = [1_700_000_000 - (idx * 100 + k) * 86_400, 0];
      r[6] = 0;
      r[7] = null;
      r[10] = "1.0";
      return r;
    });
    const nextToken = idx + 1 < pages.length ? `T${idx + 1}` : null;
    const payload = JSON.stringify([rows, nextToken ? [null, nextToken] : []]);
    const env = JSON.stringify([
      ["wrb.fr", "UsvDTd", payload, null, null, null, "generic"],
    ]);
    return { status: 200, body: `)]}'\n\n${env.length}\n${env}\n` };
  };
}

const FAST = { stealth: "fast" as const };

describe("pipeline · apple (offset pagination)", () => {
  test("collects every review across pages, de-duplicated", async () => {
    server = appleServer(45);
    const reviews = await getReviews({ appId: "1", store: "apple", ...FAST });
    expect(reviews.length).toBe(45);
    expect(new Set(reviews.map((r) => r.id)).size).toBe(45);
    expect(reviews.every((r) => r.store === "apple")).toBe(true);
  });

  test("honors limit", async () => {
    server = appleServer(200);
    const reviews = await getReviews({ appId: "1", store: "apple", limit: 25, ...FAST });
    expect(reviews.length).toBe(25);
  });

  test("stops at `since` cutoff", async () => {
    server = appleServer(200);
    // dates decrease as index grows; cut off at index 9.
    const since = new Date(Date.UTC(2025, 0, 1) - 9 * 86_400_000).toISOString();
    const reviews = await getReviews({ appId: "1", store: "apple", since, ...FAST });
    expect(reviews.length).toBe(10); // indices 0..9
  });

  test("de-duplicates repeated ids and stops on dry pages", async () => {
    // Every page returns the same 5 ids but keeps offering a next offset.
    server = (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const data = Array.from({ length: 5 }, (_, i) => ({
        id: `dup${i}`,
        attributes: { rating: 3, date: "2025-01-01T00:00:00Z" },
      }));
      const next = offset < 200 ? `/r?offset=${offset + 20}` : undefined;
      return { status: 200, body: JSON.stringify({ data, next }) };
    };
    const reviews = await getReviews({ appId: "1", store: "apple", ...FAST });
    expect(reviews.length).toBe(5); // deduped; dry-page guard prevents a loop
  });

  test("does not fetch an extra page when limit lands on a page boundary", async () => {
    let pagesFetched = 0;
    const backend = appleServer(200);
    server = (url, init) => {
      pagesFetched++;
      return backend(url, init);
    };
    const reviews = await getReviews({ appId: "1", store: "apple", limit: 20, ...FAST });
    expect(reviews.length).toBe(20); // exactly one page of 20
    expect(pagesFetched).toBe(1);
  });

  test("retries on HTTP 429 then succeeds", async () => {
    let hit = 0;
    server = (url) => {
      if (hit++ === 0) return { status: 429, body: "" };
      const offset = Number(new URL(url).searchParams.get("offset"));
      if (offset >= 5) return { status: 404, body: "" };
      const data = Array.from({ length: 5 }, (_, i) => ({
        id: `r${i}`,
        attributes: { rating: 4, date: "2025-01-01T00:00:00Z" },
      }));
      return { status: 200, body: JSON.stringify({ data }) };
    };
    const reviews = await getReviews({ appId: "1", store: "apple", ...FAST });
    expect(reviews.length).toBe(5);
    expect(hit).toBeGreaterThan(1); // proves a retry happened
  }, 15_000);
});

describe("pipeline · google (token pagination)", () => {
  test("chains continuation tokens across pages", async () => {
    server = googleServer([["1", "2", "3"], ["4", "5"], ["6"]]);
    const reviews = await getReviews({ appId: "com.x.y", store: "google", ...FAST });
    expect(reviews.map((r) => r.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(reviews.every((r) => r.store === "google")).toBe(true);
  });

  test("honors limit mid-stream", async () => {
    server = googleServer([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
    const reviews = await getReviews({
      appId: "com.x.y",
      store: "google",
      limit: 4,
      ...FAST,
    });
    expect(reviews.length).toBe(4);
  });

  test("ends cleanly when a page is empty", async () => {
    server = googleServer([["1", "2"], []]);
    const reviews = await getReviews({ appId: "com.x.y", store: "google", ...FAST });
    expect(reviews.map((r) => r.id)).toEqual(["1", "2"]);
  });
});

describe("pipeline · streaming + callbacks", () => {
  beforeEach(() => {
    server = appleServer(30);
  });

  test("streamReviews yields incrementally", async () => {
    const ids: string[] = [];
    for await (const r of streamReviews({ appId: "1", store: "apple", ...FAST })) {
      ids.push(r.id);
    }
    expect(ids.length).toBe(30);
  });

  test("onReview fires once per emitted review with its index", async () => {
    const seen: Array<[string, number]> = [];
    await getReviews({
      appId: "1",
      store: "apple",
      ...FAST,
      onReview: (r: Review, i: number) => seen.push([r.id, i]),
    });
    expect(seen.length).toBe(30);
    expect(seen[0][1]).toBe(0);
    expect(seen[29][1]).toBe(29);
  });

  test("abort interrupts the 429 backoff sleep instead of waiting it out", async () => {
    // Every fetch is throttled; with the fast preset the backoff sleeps alone
    // are 3s+6s+9s — an abort must cut through them, not wait them out.
    server = () => ({ status: 429, body: "" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const started = performance.now();
    const reviews = await getReviews({
      appId: "1",
      store: "apple",
      ...FAST,
      signal: ac.signal,
    });
    expect(reviews.length).toBe(0);
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  test("stops early and closes when the abort signal fires (timeout/cancel)", async () => {
    server = appleServer(200);
    const ac = new AbortController();
    const ids: string[] = [];
    for await (const r of streamReviews({
      appId: "1",
      store: "apple",
      ...FAST,
      signal: ac.signal,
    })) {
      ids.push(r.id);
      if (ids.length === 20) ac.abort(); // abort after the first page
    }
    // Engine checks the signal at the page boundary → no further pages fetched.
    expect(ids.length).toBe(20);
  });
});

describe("pipeline · app metadata", () => {
  beforeEach(() => {
    server = appleServer(10);
    jsonLd = [APP_LD];
    jsonLdThrows = false;
    jsonLdReads = 0;
  });

  test("onAppInfo fires once with parsed metadata; reviews still complete", async () => {
    const seen: Array<unknown> = [];
    const reviews = await getReviews({
      appId: "1",
      store: "apple",
      ...FAST,
      onAppInfo: (info) => seen.push(info),
    });
    expect(reviews.length).toBe(10); // reviews unaffected
    expect(seen.length).toBe(1); // called exactly once
    expect(seen[0]).toMatchObject({
      store: "apple",
      appId: "1",
      name: "Test App",
      developer: "Test Dev",
      averageRating: 4.2,
      ratingCount: 999,
      price: 0,
    });
  });

  test("without onAppInfo, extraction is skipped (the page is never read)", async () => {
    const reviews = await getReviews({ appId: "1", store: "apple", ...FAST });
    expect(reviews.length).toBe(10);
    expect(jsonLdReads).toBe(0); // no callback → no JSON-LD read at all
  });

  test("a page with no structured data yields onAppInfo(null)", async () => {
    jsonLd = [];
    const seen: Array<unknown> = [];
    const reviews = await getReviews({
      appId: "1",
      store: "apple",
      ...FAST,
      onAppInfo: (info) => seen.push(info),
    });
    expect(reviews.length).toBe(10);
    expect(seen).toEqual([null]);
  });

  test("an extraction failure is non-fatal — onAppInfo(null), reviews intact", async () => {
    jsonLdThrows = true;
    const seen: Array<unknown> = [];
    const reviews = await getReviews({
      appId: "1",
      store: "apple",
      ...FAST,
      onAppInfo: (info) => seen.push(info),
    });
    expect(reviews.length).toBe(10);
    expect(seen).toEqual([null]);
  });

  test("getAppInfo fetches metadata only (no reviews pulled)", async () => {
    // appleServer would serve reviews, but getAppInfo must never call fetchBatch.
    const hits: string[] = [];
    const backend = appleServer(10);
    server = (url, init) => {
      hits.push(url);
      return backend(url, init);
    };
    const info = await getAppInfo({ appId: "1", store: "apple", ...FAST });
    expect(info?.name).toBe("Test App");
    // One page fetch is allowed: the catalog app resource (metadata extras).
    // The reviews endpoint must never be hit.
    expect(hits.every((url) => !url.includes("/reviews"))).toBe(true);
    expect(hits.filter((url) => url.includes("/api/apps/v1/catalog/"))).toHaveLength(
      hits.length,
    );
    expect(jsonLdReads).toBe(1); // metadata read exactly once
  });

  test("getAppInfo works for Google and infers the store from the appId", async () => {
    const gInfo = await getAppInfo({
      appId: "com.x.y",
      store: "google",
      stealth: "fast",
    });
    expect(gInfo?.name).toBe("Test App");
    const inferred = await getAppInfo({ appId: "284882215", stealth: "fast" }); // → apple
    expect(inferred?.store).toBe("apple");
  });
});

describe("pipeline · landing-page navigation errors", () => {
  beforeEach(() => {
    server = appleServer(5);
    jsonLd = [];
    gotoStatus = 200;
    gotoAttempts = 0;
  });
  afterEach(() => {
    gotoStatus = 200; // don't leak into other suites
  });

  test("a 4xx landing page → BadInputError, not retried", async () => {
    gotoStatus = 404;
    await expect(getReviews({ appId: "1", store: "apple", ...FAST })).rejects.toThrow(
      BadInputError,
    );
    expect(gotoAttempts).toBe(1); // 4xx is a hard error — no retry
  });

  test("a 5xx landing page → UpstreamError after bounded retries", async () => {
    gotoStatus = 503;
    await expect(getReviews({ appId: "1", store: "apple", ...FAST })).rejects.toThrow(
      UpstreamError,
    );
    expect(gotoAttempts).toBeGreaterThan(1); // retried, then gave up
  });
});

describe("pipeline · convenience wrappers", () => {
  beforeEach(() => {
    jsonLd = [];
  });

  test("getAppleReviews / streamAppleReviews fix the store to apple", async () => {
    server = appleServer(5);
    const reviews = await getAppleReviews({ appId: "1", ...FAST });
    expect(reviews.length).toBe(5);
    expect(reviews.every((r) => r.store === "apple")).toBe(true);

    const ids: string[] = [];
    for await (const r of streamAppleReviews({ appId: "1", ...FAST })) ids.push(r.id);
    expect(ids.length).toBe(5);
  });

  test("getGoogleReviews / streamGoogleReviews fix the store to google", async () => {
    server = googleServer([["1", "2", "3"]]);
    const reviews = await getGoogleReviews({ appId: "com.x.y", ...FAST });
    expect(reviews.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(reviews.every((r) => r.store === "google")).toBe(true);

    server = googleServer([["9"]]);
    const ids: string[] = [];
    for await (const r of streamGoogleReviews({ appId: "com.x.y", ...FAST }))
      ids.push(r.id);
    expect(ids).toEqual(["9"]);
  });
});

describe("pipeline · max-stealth warm-up", () => {
  test("the warm-up scroll path runs (stealth=max) and still extracts metadata", async () => {
    server = appleServer(1);
    jsonLd = [APP_LD];
    // stealth "max" is the only preset with warmupScroll — exercise that branch.
    const info = await getAppInfo({ appId: "1", store: "apple", stealth: "max" });
    expect(info?.name).toBe("Test App");
  }, 15_000);
});

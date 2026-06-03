import { describe, expect, test } from "bun:test";
import { nextOffset, normalizeAppleReview, reviewsUrl } from "../src/apple.js";
import { buildBody, normalizeGoogleReview, parseBatch } from "../src/google.js";
import { CSV_HEADER, csvCell, csvRow } from "../src/output.js";
import { inferStore } from "../src/scrape.js";
import type { Review, ScrapeOptions } from "../src/types.js";

describe("inferStore", () => {
  test("numeric id → apple", () => {
    expect(inferStore("284882215")).toBe("apple");
  });
  test("package name → google", () => {
    expect(inferStore("com.facebook.katana")).toBe("google");
    expect(inferStore("com.spotify.music")).toBe("google");
  });
  test("ambiguous input throws", () => {
    expect(() => inferStore("instagram")).toThrow();
  });
});

describe("apple: reviewsUrl", () => {
  const base: ScrapeOptions = { appId: "284882215", country: "US" };

  test("builds the same-origin proxy URL with offset and defaults", () => {
    const url = new URL(reviewsUrl(base, 40));
    expect(url.host).toBe("apps.apple.com");
    expect(url.pathname).toBe("/api/apps/v1/catalog/us/apps/284882215/reviews");
    expect(url.searchParams.get("offset")).toBe("40");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("l")).toBe("en-US");
    expect(url.searchParams.get("sort")).toBe("mostRecent");
    expect(url.searchParams.get("platform")).toBe("web");
  });

  test("maps sort, including rating → mostRecent (Apple has no rating sort)", () => {
    expect(
      new URL(reviewsUrl({ ...base, sort: "mostHelpful" }, 0)).searchParams.get("sort"),
    ).toBe("mostHelpful");
    expect(
      new URL(reviewsUrl({ ...base, sort: "rating" }, 0)).searchParams.get("sort"),
    ).toBe("mostRecent");
  });

  test("honors lang override", () => {
    expect(new URL(reviewsUrl({ ...base, lang: "fr-FR" }, 0)).searchParams.get("l")).toBe(
      "fr-FR",
    );
  });
});

describe("apple: nextOffset", () => {
  test("extracts offset from the next link", () => {
    expect(nextOffset("/v1/catalog/us/apps/1/reviews?l=en-US&offset=60")).toBe(60);
  });
  test("returns null when there is no next link", () => {
    expect(nextOffset(undefined)).toBeNull();
    expect(nextOffset("")).toBeNull();
  });
});

describe("apple: normalizeAppleReview", () => {
  const opts: ScrapeOptions = { appId: "284882215", country: "US" };

  test("maps attributes into the unified shape", () => {
    const r = normalizeAppleReview(
      {
        id: 123,
        attributes: {
          userName: "Bob",
          title: "Hi",
          review: "the body",
          rating: 5,
          date: "2025-01-01T00:00:00Z",
          isEdited: true,
          developerResponse: { body: "reply", modified: "2025-02-01T00:00:00Z" },
        },
      },
      opts,
    );
    expect(r).toEqual({
      store: "apple",
      id: "123",
      userName: "Bob",
      title: "Hi",
      body: "the body",
      rating: 5,
      date: "2025-01-01T00:00:00Z",
      isEdited: true,
      developerResponse: { body: "reply", modified: "2025-02-01T00:00:00Z" },
      appId: "284882215",
      country: "us",
    });
  });

  test("developerResponse is null when absent", () => {
    const r = normalizeAppleReview({ id: 1, attributes: { rating: 3, date: "x" } }, opts);
    expect(r?.developerResponse).toBeNull();
  });

  test("returns null for malformed input", () => {
    expect(normalizeAppleReview({ id: 1 }, opts)).toBeNull();
    expect(normalizeAppleReview(null, opts)).toBeNull();
  });
});

describe("google: buildBody", () => {
  const opts: ScrapeOptions = { appId: "com.x.y", country: "US" };

  function decodeFreq(body: string) {
    expect(body.startsWith("f.req=")).toBe(true);
    const outer = JSON.parse(decodeURIComponent(body.slice("f.req=".length)));
    const rpc = outer[0][0];
    return { rpcId: rpc[0], inner: JSON.parse(rpc[1]) };
  }

  test("encodes the UsvDTd RPC with appId and page size", () => {
    const { rpcId, inner } = decodeFreq(buildBody(opts, null));
    expect(rpcId).toBe("UsvDTd");
    expect(inner[3]).toEqual(["com.x.y", 7]);
    expect(inner[2][2][0]).toBe(100); // PAGE_SIZE
    expect(inner[2][2][2]).toBeNull(); // no token on first page
    expect(inner[2][1]).toBe(2); // mostRecent → NEWEST
  });

  test("places the continuation token", () => {
    const { inner } = decodeFreq(buildBody(opts, "TOKEN123"));
    expect(inner[2][2][2]).toBe("TOKEN123");
  });

  test("maps sort codes", () => {
    expect(
      decodeFreq(buildBody({ ...opts, sort: "mostHelpful" }, null)).inner[2][1],
    ).toBe(1);
    expect(decodeFreq(buildBody({ ...opts, sort: "rating" }, null)).inner[2][1]).toBe(3);
  });
});

describe("google: parseBatch", () => {
  function envelope(rows: unknown[], token: string | null): string {
    const payload = JSON.stringify([rows, token ? [null, token] : []]);
    const env = JSON.stringify([
      ["wrb.fr", "UsvDTd", payload, null, null, null, "generic"],
    ]);
    return `)]}'\n\n${env.length}\n${env}\n`;
  }

  test("unwraps the chunked envelope and pulls rows + token", () => {
    const rows = [["a"], ["b"]];
    const out = parseBatch(envelope(rows, "NEXT"));
    expect(out.rows).toEqual(rows);
    expect(out.token).toBe("NEXT");
  });

  test("returns null token when feed is exhausted", () => {
    const out = parseBatch(envelope([["a"]], null));
    expect(out.token).toBeNull();
  });

  test("tolerates a junk body", () => {
    const out = parseBatch(")]}'\n\ngarbage");
    expect(out.rows).toEqual([]);
    expect(out.token).toBeNull();
  });
});

describe("google: normalizeGoogleReview", () => {
  const opts: ScrapeOptions = { appId: "com.x.y", country: "US" };

  test("maps the review tuple into the unified shape", () => {
    const r: unknown[] = [];
    r[0] = "abc";
    r[1] = ["Alice"];
    r[2] = 4;
    r[4] = "Great app";
    r[5] = [1700000000, 0];
    r[6] = 12;
    r[7] = ["", "Thanks!", [1700100000, 0]];
    r[10] = "9.1.0";
    const out = normalizeGoogleReview(r, opts);
    expect(out).toEqual({
      store: "google",
      id: "abc",
      userName: "Alice",
      title: "",
      body: "Great app",
      rating: 4,
      date: new Date(1700000000 * 1000).toISOString(),
      thumbsUp: 12,
      appVersion: "9.1.0",
      developerResponse: {
        body: "Thanks!",
        modified: new Date(1700100000 * 1000).toISOString(),
      },
      appId: "com.x.y",
      country: "us",
    });
  });

  test("null reply → developerResponse null", () => {
    const r: unknown[] = ["id", ["U"], 5, null, "body", [1700000000, 0], 0, null];
    expect(normalizeGoogleReview(r, opts)?.developerResponse).toBeNull();
  });

  test("returns null for malformed tuple", () => {
    expect(normalizeGoogleReview(null, opts)).toBeNull();
    expect(normalizeGoogleReview([null], opts)).toBeNull();
  });
});

describe("csv serialization", () => {
  test("csvCell quotes commas, quotes and newlines", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(5)).toBe("5");
  });

  test("csvRow follows the header column order and flattens dev response", () => {
    const review: Review = {
      store: "google",
      id: "1",
      userName: "Joe",
      title: "",
      body: "nice, really",
      rating: 5,
      date: "2025-01-01T00:00:00.000Z",
      thumbsUp: 3,
      appVersion: "1.0",
      developerResponse: { body: "ty", modified: "2025-01-02T00:00:00.000Z" },
      appId: "com.x.y",
      country: "us",
    };
    const cols = CSV_HEADER.split(",");
    const cells = csvRow(review).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/); // split on unquoted commas
    expect(cols[0]).toBe("store");
    expect(cells[cols.indexOf("store")]).toBe("google");
    expect(cells[cols.indexOf("rating")]).toBe("5");
    expect(cells[cols.indexOf("body")]).toBe('"nice, really"');
    expect(cells[cols.indexOf("developerResponseBody")]).toBe("ty");
    expect(cells[cols.indexOf("appVersion")]).toBe("1.0");
  });
});

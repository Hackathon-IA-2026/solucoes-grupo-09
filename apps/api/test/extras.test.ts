import { describe, expect, it } from "bun:test";
import { parseAppleExtras } from "../src/apple.js";
import { mergeAppInfo } from "../src/engine.js";
import { normalizeGoogleReview, parseGoogleExtras } from "../src/google.js";
import appleFixture from "./fixtures/apple-app-resource.json";
import googleDs5 from "./fixtures/google-ds5.json";
import googleRows from "./fixtures/google-review-rows.json";

// Fixtures captured live on 2026-07-06 (Instagram / Spotify) — real payloads.

describe("apple · parseAppleExtras", () => {
  const extras = parseAppleExtras(JSON.stringify(appleFixture));

  it("reads the store-wide histogram (index 0 = 1★)", () => {
    expect(extras.histogram).toEqual([
      1_214_659, 271_878, 691_924, 1_989_144, 25_070_201,
    ]);
    // 5★-heavy for a 4.7 app — sanity check the star order.
    expect(extras.histogram?.[4]).toBeGreaterThan(extras.histogram?.[0] ?? 0);
  });

  it("reads rating aggregate, release date and version history", () => {
    expect(extras.averageRating).toBe(4.7);
    expect(extras.ratingCount).toBe(29_237_806);
    expect(extras.released).toBe("2010-10-06");
    expect(extras.versionHistory?.[0]).toEqual({
      version: "437.1",
      released: "2026-07-05T16:28:19Z",
      notes: expect.stringContaining("Performance optimizations"),
    });
    expect(extras.updated).toBe("2026-07-05T16:28:19Z");
  });

  it("reads core identity (name, developer) from the catalog resource", () => {
    // The App Store landing page's JSON-LD omits these, so the catalog
    // resource must supply them or the app shows its id with no name.
    expect(extras.name).toBe("Instagram");
    expect(extras.developer).toBe("Instagram, Inc.");
  });

  it("degrades to empty on junk", () => {
    expect(parseAppleExtras("not json")).toEqual({});
    expect(parseAppleExtras("{}")).toEqual({});
    expect(
      parseAppleExtras(
        '{"data":[{"attributes":{"userRating":{"ratingCountList":[1,2,3]}}}]}',
      ),
    ).toEqual({});
  });
});

describe("google · parseGoogleExtras", () => {
  const extras = parseGoogleExtras(JSON.stringify(googleDs5));

  it("reads histogram, installs, dates", () => {
    expect(extras.histogram).toEqual([
      3_714_863, 1_083_164, 1_331_088, 3_061_651, 26_692_025,
    ]);
    expect(extras.installs).toBe(3_032_313_142);
    expect(extras.installsText).toBe("1,000,000,000+");
    expect(extras.averageRating).toBe(4.34);
    expect(extras.ratingCount).toBe(35_882_813);
    expect(extras.updated).toMatch(/^2026-07-06T/);
    expect(extras.released).toMatch(/^2014-05-27T/);
  });

  it("degrades to empty on junk", () => {
    expect(parseGoogleExtras("nope")).toEqual({});
    expect(parseGoogleExtras("[]")).toEqual({});
  });

  it("never publishes the bucket floor as the real install count", () => {
    // [13] with only [text, bucketFloor] — no exact count at [2].
    const scaffold: unknown[] = [];
    const mid: unknown[] = [];
    const root: unknown[] = [];
    root[13] = ["1,000,000,000+", 1_000_000_000];
    mid[2] = root;
    scaffold[1] = mid;
    const extras = parseGoogleExtras(JSON.stringify(scaffold));
    expect(extras.installs).toBeUndefined();
    expect(extras.installsText).toBe("1,000,000,000+");
  });
});

describe("google · reviewer avatar", () => {
  it("extracts the avatar URL from the raw tuple", () => {
    const review = normalizeGoogleReview(googleRows[0], { appId: "com.spotify.music" });
    expect(review?.avatar).toMatch(/^https:\/\/play-lh\.googleusercontent\.com\//);
  });

  it("omits the field when absent", () => {
    const bare = [...(googleRows[0] as unknown[])];
    bare[1] = ["Someone"];
    const review = normalizeGoogleReview(bare, { appId: "x.y" });
    expect(review?.avatar).toBeUndefined();
    expect("avatar" in (review ?? {})).toBe(false);
  });
});

describe("engine · mergeAppInfo", () => {
  const prov = { store: "apple" as const, appId: "1", country: "us" };

  it("fills extras over a base, keeps base fields", () => {
    const base = { ...emptyish(), name: "App", averageRating: 4.5 };
    const merged = mergeAppInfo(base, { histogram: [1, 2, 3, 4, 5] }, prov);
    expect(merged?.name).toBe("App");
    expect(merged?.histogram).toEqual([1, 2, 3, 4, 5]);
    expect(merged?.averageRating).toBe(4.5);
  });

  it("builds a record from extras when JSON-LD found nothing", () => {
    const merged = mergeAppInfo(null, { installs: 10 }, prov);
    expect(merged?.installs).toBe(10);
    expect(merged?.name).toBeNull();
  });

  it("stays null when both sides are empty", () => {
    expect(mergeAppInfo(null, {}, prov)).toBeNull();
  });

  function emptyish() {
    return {
      store: "apple" as const,
      appId: "1",
      country: "us",
      name: null,
      developer: null,
      category: null,
      description: null,
      averageRating: null,
      ratingCount: null,
      price: null,
      currency: null,
      version: null,
      contentRating: null,
      operatingSystem: null,
      icon: null,
      url: null,
      histogram: null,
      installs: null,
      installsText: null,
      released: null,
      updated: null,
      versionHistory: null,
    };
  }
});

import { describe, expect, it } from "bun:test";
import { Paginator } from "../src/pagination.js";
import { dedupe, limit, notOlderThan, ReviewPipeline } from "../src/pipeline.js";
import { type Resolver, resolveTarget } from "../src/resolve.js";
import type { Review } from "../src/types.js";

const review = (over: Partial<Review> = {}): Review => ({
  store: "apple",
  id: "1",
  userName: "u",
  title: "",
  body: "b",
  rating: 5,
  date: "2025-01-01T00:00:00.000Z",
  developerResponse: null,
  appId: "1",
  country: "us",
  ...over,
});

describe("Chain of Responsibility · resolveTarget", () => {
  it("maps a numeric id to Apple", () => {
    expect(resolveTarget("284882215")).toEqual({ store: "apple", appId: "284882215" });
  });
  it("maps a package name to Google", () => {
    expect(resolveTarget("com.spotify.music")).toEqual({
      store: "google",
      appId: "com.spotify.music",
    });
  });
  it("extracts the id and country from an App Store URL", () => {
    expect(resolveTarget("https://apps.apple.com/us/app/instagram/id389801252")).toEqual({
      store: "apple",
      appId: "389801252",
      country: "us",
    });
  });
  it("reads a non-US App Store country instead of silently defaulting to US", () => {
    expect(resolveTarget("https://apps.apple.com/gb/app/whatsapp/id310633997")).toEqual({
      store: "apple",
      appId: "310633997",
      country: "gb",
    });
  });
  it("extracts the package from a Play Store URL (hl is language, not country)", () => {
    expect(
      resolveTarget("https://play.google.com/store/apps/details?id=com.x.y&hl=en"),
    ).toEqual({ store: "google", appId: "com.x.y" });
  });
  it("reads the Play storefront country from the gl param", () => {
    expect(
      resolveTarget("https://play.google.com/store/apps/details?id=com.x.y&hl=en&gl=br"),
    ).toEqual({ store: "google", appId: "com.x.y", country: "br" });
  });
  it("omits country for a bare id (caller's default applies)", () => {
    expect(resolveTarget("284882215").country).toBeUndefined();
    expect(resolveTarget("com.spotify.music").country).toBeUndefined();
  });
  it("throws on unrecognized input (e.g. 'undefined')", () => {
    expect(() => resolveTarget("undefined")).toThrow();
    expect(() => resolveTarget("instagram")).toThrow();
  });
  it("is extensible — a custom link can claim new input", () => {
    const fromColon: Resolver = (s) => {
      const [store, appId] = s.split(":");
      return store === "apple" || store === "google" ? { store, appId } : null;
    };
    expect(resolveTarget("google:com.a.b", [fromColon])).toEqual({
      store: "google",
      appId: "com.a.b",
    });
  });
});

describe("Pipeline + Chain of Responsibility · ReviewPipeline", () => {
  it("dedupe drops repeated ids", () => {
    const stage = dedupe();
    expect(stage(review({ id: "a" }))).toBe("accept");
    expect(stage(review({ id: "a" }))).toBe("drop");
    expect(stage(review({ id: "b" }))).toBe("accept");
  });

  it("notOlderThan stops at the cutoff, accepts newer/equal", () => {
    const cutoff = new Date("2025-01-10T00:00:00.000Z");
    const stage = notOlderThan(cutoff);
    expect(stage(review({ date: "2025-01-20T00:00:00.000Z" }))).toBe("accept");
    expect(stage(review({ date: "2025-01-10T00:00:00.000Z" }))).toBe("accept");
    expect(stage(review({ date: "2025-01-01T00:00:00.000Z" }))).toBe("stop");
  });

  it("notOlderThan(null) is a pass-through", () => {
    const stage = notOlderThan(null);
    expect(stage(review({ date: "1999-01-01T00:00:00.000Z" }))).toBe("accept");
  });

  it("limit emits exactly n then stops", () => {
    const stage = limit(2);
    expect(stage(review())).toBe("accept");
    expect(stage(review())).toBe("accept");
    expect(stage(review())).toBe("stop");
  });

  it("limit(0) / undefined is unlimited", () => {
    const stage = limit(undefined);
    for (let i = 0; i < 5; i++) {
      expect(stage(review())).toBe("accept");
    }
  });

  it("short-circuits on the first non-accept verdict (order matters)", () => {
    const pipeline = new ReviewPipeline([dedupe(), limit(1)]);
    expect(pipeline.run(review({ id: "x" }))).toBe("accept"); // 1st emitted
    expect(pipeline.run(review({ id: "x" }))).toBe("drop"); // dupe before limit
    expect(pipeline.run(review({ id: "y" }))).toBe("stop"); // limit reached
  });
});

describe("State Machine · Paginator", () => {
  it("advances the cursor while the store has more", () => {
    const p = new Paginator<number>(0);
    p.advance({ added: 20, next: 20, halted: false });
    expect(p.state).toBe("fetch");
    expect(p.cursor).toBe(20);
  });

  it("stops when the store reports no next cursor", () => {
    const p = new Paginator<number>(0);
    p.advance({ added: 20, next: null, halted: false });
    expect(p.state).toBe("done");
  });

  it("stops immediately when a stage halts the scrape", () => {
    const p = new Paginator<number>(0);
    p.advance({ added: 20, next: 40, halted: true });
    expect(p.state).toBe("done");
  });

  it("stops after two consecutive dry (all-duplicate) pages", () => {
    const p = new Paginator<number>(0);
    p.advance({ added: 0, next: 20, halted: false });
    expect(p.state).toBe("fetch"); // one dry page tolerated
    p.advance({ added: 0, next: 40, halted: false });
    expect(p.state).toBe("done"); // second dry page → stop
  });

  it("resets the dry counter when a page adds reviews", () => {
    const p = new Paginator<number>(0);
    p.advance({ added: 0, next: 20, halted: false });
    p.advance({ added: 5, next: 40, halted: false }); // resets
    p.advance({ added: 0, next: 60, halted: false });
    expect(p.state).toBe("fetch"); // only one dry page since reset
  });
});

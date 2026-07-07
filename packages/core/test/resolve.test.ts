import { describe, expect, test } from "bun:test";
// The backend's resolver — imported straight from the API workspace so the two
// implementations are exercised over the SAME fixtures and can never drift.
import { resolveTarget as apiResolve } from "../../../apps/api/src/resolve.js";
import type { Target } from "../src/resolve";
import { resolveTarget, storeLabel, storeUrl, validateInput } from "../src/resolve";

/** Inputs both resolvers must agree on (the API contract). */
const PARITY_FIXTURES: Array<{ input: string; expected: Target }> = [
  { input: "284882215", expected: { store: "apple", appId: "284882215" } },
  {
    input: "https://apps.apple.com/us/app/instagram/id389801252",
    expected: { store: "apple", appId: "389801252", country: "us" },
  },
  {
    input: "https://apps.apple.com/GB/app/instagram/id389801252",
    expected: { store: "apple", appId: "389801252", country: "gb" },
  },
  {
    input: "https://apps.apple.com/app/id123456?see-all=reviews",
    expected: { store: "apple", appId: "123456" },
  },
  {
    input: "com.spotify.music",
    expected: { store: "google", appId: "com.spotify.music" },
  },
  {
    input: "https://play.google.com/store/apps/details?id=com.spotify.music",
    expected: { store: "google", appId: "com.spotify.music" },
  },
  {
    input: "https://play.google.com/store/apps/details?id=com.spotify.music&gl=BR",
    expected: { store: "google", appId: "com.spotify.music", country: "br" },
  },
  {
    input:
      "https://play.google.com/store/apps/details?hl=en&id=com.facebook.katana&gl=de#reviews",
    expected: { store: "google", appId: "com.facebook.katana", country: "de" },
  },
  { input: "  284882215  ", expected: { store: "apple", appId: "284882215" } },
];

describe("resolver parity with the API", () => {
  for (const { input, expected } of PARITY_FIXTURES) {
    test(`both resolvers agree on ${JSON.stringify(input)}`, () => {
      expect(resolveTarget(input)).toEqual(expected);
      expect(apiResolve(input)).toEqual(expected);
    });
  }
});

describe("resolveTarget — client-side liberal extras (Postel)", () => {
  test("legacy itunes.apple.com URLs", () => {
    expect(resolveTarget("https://itunes.apple.com/de/app/spotify/id324684580")).toEqual({
      store: "apple",
      appId: "324684580",
      country: "de",
    });
  });

  test("scheme-less store URLs", () => {
    expect(resolveTarget("apps.apple.com/fr/app/id12345")).toEqual({
      store: "apple",
      appId: "12345",
      country: "fr",
    });
    expect(resolveTarget("play.google.com/store/apps/details?id=com.x.y")).toEqual({
      store: "google",
      appId: "com.x.y",
    });
  });

  test("android market:// deep links", () => {
    expect(resolveTarget("market://details?id=com.whatsapp")).toEqual({
      store: "google",
      appId: "com.whatsapp",
    });
  });

  test("rejects unrecognizable input", () => {
    expect(resolveTarget("")).toBeNull();
    expect(resolveTarget("   ")).toBeNull();
    expect(resolveTarget("hello world")).toBeNull();
    expect(resolveTarget("https://example.com/whatever")).toBeNull();
  });
});

describe("validateInput", () => {
  test("valid input yields the target", () => {
    const result = validateInput("https://apps.apple.com/us/app/x/id42");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ store: "apple", appId: "42", country: "us" });
    }
  });

  test("empty input", () => {
    const result = validateInput("   ");
    expect(result).toMatchObject({ ok: false, reason: "empty" });
  });

  test("apple URL missing the id gets a targeted message", () => {
    const result = validateInput("https://apps.apple.com/us/app/instagram");
    expect(result).toMatchObject({ ok: false, reason: "apple-no-id" });
    if (!result.ok) {
      expect(result.message).toContain("id123456789");
    }
  });

  test("play URL missing ?id= gets a targeted message", () => {
    const result = validateInput("https://play.google.com/store/apps");
    expect(result).toMatchObject({ ok: false, reason: "google-no-id" });
  });

  test("random text gets the generic guidance", () => {
    const result = validateInput("not a url at all");
    expect(result).toMatchObject({ ok: false, reason: "not-a-store-url" });
  });
});

describe("store helpers", () => {
  test("labels", () => {
    expect(storeLabel("apple")).toBe("App Store");
    expect(storeLabel("google")).toBe("Google Play");
  });

  test("canonical store URLs", () => {
    expect(storeUrl({ store: "apple", appId: "42", country: "gb" })).toBe(
      "https://apps.apple.com/gb/app/id42",
    );
    expect(storeUrl({ store: "apple", appId: "42" })).toBe(
      "https://apps.apple.com/us/app/id42",
    );
    expect(storeUrl({ store: "google", appId: "com.x.y", country: "br" })).toBe(
      "https://play.google.com/store/apps/details?id=com.x.y&gl=br",
    );
    expect(storeUrl({ store: "google", appId: "com.x.y" })).toBe(
      "https://play.google.com/store/apps/details?id=com.x.y",
    );
  });
});

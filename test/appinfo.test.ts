import { describe, expect, test } from "bun:test";
import { parseAppInfo } from "../src/appinfo.js";

const PROV = { store: "apple" as const, appId: "284882215", country: "us" };

/** Wrap an object as the text of one <script type="application/ld+json">. */
const ld = (obj: unknown): string => JSON.stringify(obj);

describe("appinfo · parseAppInfo", () => {
  test("maps an App Store-style SoftwareApplication node", () => {
    const info = parseAppInfo(
      [
        ld({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "Instagram",
          author: { "@type": "Organization", name: "Instagram, Inc." },
          applicationCategory: "Photo & Video",
          description: "Connect with friends.",
          softwareVersion: "302.0",
          contentRating: "12+",
          operatingSystem: "iOS",
          image: "https://is1.example/icon.png",
          url: "https://apps.apple.com/us/app/instagram/id389801252",
          aggregateRating: { ratingValue: "4.7", ratingCount: "12345678" },
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        }),
      ],
      PROV,
    );
    expect(info).toEqual({
      store: "apple",
      appId: "284882215",
      country: "us",
      name: "Instagram",
      developer: "Instagram, Inc.",
      category: "Photo & Video",
      description: "Connect with friends.",
      averageRating: 4.7,
      ratingCount: 12345678,
      price: 0,
      currency: "USD",
      version: "302.0",
      contentRating: "12+",
      operatingSystem: "iOS",
      icon: "https://is1.example/icon.png",
      url: "https://apps.apple.com/us/app/instagram/id389801252",
    });
  });

  test("picks the app node out of a multi-node array, ignoring others", () => {
    const info = parseAppInfo(
      [
        ld([
          { "@type": "Organization", name: "Spotify AB" },
          {
            "@type": ["SoftwareApplication", "MobileApplication"],
            name: "Spotify",
            author: "Spotify AB", // author as a bare string
            applicationCategory: "MUSIC_AND_AUDIO",
            operatingSystem: "Android",
            aggregateRating: { ratingValue: 4.3, reviewCount: 30000000 },
            offers: [{ price: 0, priceCurrency: "USD" }], // offers as an array
            image: { url: "https://play.example/spotify.png" },
          },
        ]),
      ],
      { store: "google", appId: "com.spotify.music", country: "br" },
    );
    expect(info?.name).toBe("Spotify");
    expect(info?.developer).toBe("Spotify AB");
    expect(info?.category).toBe("MUSIC_AND_AUDIO");
    expect(info?.operatingSystem).toBe("Android");
    expect(info?.averageRating).toBe(4.3);
    expect(info?.ratingCount).toBe(30000000); // falls back to reviewCount
    expect(info?.price).toBe(0);
    expect(info?.icon).toBe("https://play.example/spotify.png");
    expect(info?.store).toBe("google");
    expect(info?.country).toBe("br");
  });

  test("unwraps a JSON-LD @graph", () => {
    const info = parseAppInfo(
      [
        ld({
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "WebSite", name: "App Store" },
            { "@type": "SoftwareApplication", name: "Graphed App" },
          ],
        }),
      ],
      PROV,
    );
    expect(info?.name).toBe("Graphed App");
  });

  test("skips a malformed script and still finds a valid one", () => {
    const info = parseAppInfo(
      ["{ not valid json", ld({ "@type": "SoftwareApplication", name: "Survivor" })],
      PROV,
    );
    expect(info?.name).toBe("Survivor");
  });

  test("finds an app node structurally even when @type is unexpected", () => {
    // Some pages omit/rename @type but the node is clearly an app.
    const info = parseAppInfo(
      [ld({ "@type": "Thing", name: "Heuristic", applicationCategory: "Games" })],
      PROV,
    );
    expect(info?.name).toBe("Heuristic");
    expect(info?.category).toBe("Games");
  });

  test("leaves absent fields null without throwing", () => {
    const info = parseAppInfo(
      [ld({ "@type": "SoftwareApplication", name: "Bare" })],
      PROV,
    );
    expect(info).toEqual({
      store: "apple",
      appId: "284882215",
      country: "us",
      name: "Bare",
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
    });
  });

  test("coerces a non-numeric price (e.g. 'Free') to null but keeps 0", () => {
    const free = parseAppInfo(
      [ld({ "@type": "SoftwareApplication", name: "A", offers: { price: "Free" } })],
      PROV,
    );
    expect(free?.price).toBeNull();
    const zero = parseAppInfo(
      [ld({ "@type": "SoftwareApplication", name: "A", offers: { price: 0 } })],
      PROV,
    );
    expect(zero?.price).toBe(0);
  });

  test("rounds a high-precision averageRating to 2 decimals", () => {
    const info = parseAppInfo(
      [
        ld({
          "@type": "SoftwareApplication",
          name: "A",
          aggregateRating: { ratingValue: 4.334024429321289 },
        }),
      ],
      PROV,
    );
    expect(info?.averageRating).toBe(4.33);
  });

  test("rounds a fractional ratingCount to an integer", () => {
    const info = parseAppInfo(
      [
        ld({
          "@type": "SoftwareApplication",
          name: "A",
          aggregateRating: { ratingValue: 4.55, ratingCount: 100.6 },
        }),
      ],
      PROV,
    );
    expect(info?.averageRating).toBe(4.55);
    expect(info?.ratingCount).toBe(101);
  });

  test("treats an app node with no usable fields as not-found (null)", () => {
    expect(parseAppInfo([ld({ "@type": "SoftwareApplication" })], PROV)).toBeNull();
  });

  test("returns null when no app node is present", () => {
    expect(
      parseAppInfo([ld({ "@type": "Organization", name: "ACME" })], PROV),
    ).toBeNull();
    expect(parseAppInfo([], PROV)).toBeNull();
    expect(parseAppInfo(["totally not json"], PROV)).toBeNull();
  });
});

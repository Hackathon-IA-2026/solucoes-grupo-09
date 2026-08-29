import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALES,
  LOCALIZED_PATHS,
  languageTag,
  localePath,
  matchLocale,
  swapLocale,
} from "../src/i18n/locale";

const PUBLIC = join(import.meta.dir, "..", "public");
const read = (name: string) => readFileSync(join(PUBLIC, name), "utf8");

describe("locale routing", () => {
  test("a locale root keeps its trailing slash, a page does not", () => {
    // One canonical form per page. `/pt` and `/pt/` indexed as two URLs is
    // the cheapest possible way to split a page's own ranking signal.
    expect(localePath("pt")).toBe("/pt/");
    expect(localePath("en", "/privacy")).toBe("/en/privacy");
  });

  test("switching locale keeps the page", () => {
    expect(swapLocale("/en/privacy", "pt")).toBe("/pt/privacy");
    expect(swapLocale("/pt/", "en")).toBe("/en/");
    expect(swapLocale("/pt", "en")).toBe("/en/");
  });

  test("a path with no locale prefix gets one rather than being rewritten", () => {
    // `/app` is not locale-prefixed. Treating its first segment as a locale
    // would silently turn a switch into a 404.
    expect(swapLocale("/app", "pt")).toBe("/pt/app");
    expect(swapLocale("/", "en")).toBe("/en/");
  });

  test("only pt and en are locales", () => {
    expect(isLocale("pt")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  test("browser tags match on the primary subtag", () => {
    // The site has one Portuguese; pt-PT asks for it just as pt-BR does.
    expect(matchLocale(["pt-PT"])).toBe("pt");
    expect(matchLocale(["en-GB", "pt-BR"])).toBe("en");
    expect(matchLocale(["de-DE", "fr"])).toBeNull();
    expect(matchLocale([])).toBeNull();
  });
});

describe("static SEO artifacts agree with the route tree", () => {
  const sitemap = read("sitemap.xml");
  const expected = LOCALES.flatMap((locale) =>
    LOCALIZED_PATHS.map((path) => `https://wattsteer.com${localePath(locale, path)}`),
  );

  test("sitemap lists exactly the six real pages", () => {
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.sort()).toEqual([...expected].sort());
  });

  test("sitemap does not list the gate, the app, or the 404", () => {
    // The gate is noindex,follow and /app declares its own noindex. Listing a
    // noindexed URL in a sitemap is a contradiction, not a hint.
    expect(sitemap).not.toContain("<loc>https://wattsteer.com/</loc>");
    expect(sitemap).not.toContain("/app<");
  });

  test("every sitemap entry carries both alternates and x-default", () => {
    const entries = sitemap.split("<url>").slice(1);
    expect(entries).toHaveLength(expected.length);
    for (const entry of entries) {
      for (const locale of LOCALES) {
        expect(entry).toContain(`hreflang="${languageTag(locale)}"`);
      }
      expect(entry).toContain('hreflang="x-default"');
      // x-default is Portuguese: Brazil is the primary market, so a crawler
      // with no stated preference gets pt-BR.
      expect(entry).toMatch(
        new RegExp(`hreflang="x-default" href="[^"]*/${DEFAULT_LOCALE}/`),
      );
    }
  });

  test("robots.txt still allows the gate", () => {
    // Pairing Disallow with the gate's noindex would mean the noindex is
    // never crawled and therefore never obeyed.
    const robots = read("robots.txt");
    expect(robots).toContain("Allow: /");
    expect(robots).not.toMatch(/^Disallow:/m);
  });

  test("each locale has a manifest naming itself", () => {
    for (const locale of LOCALES) {
      const manifest = JSON.parse(read(`manifest.${locale}.webmanifest`));
      expect(manifest.lang).toBe(languageTag(locale));
      expect(manifest.start_url).toBe(localePath(locale));
      expect(manifest.description.length).toBeGreaterThan(20);
    }
    const pt = JSON.parse(read("manifest.pt.webmanifest"));
    const en = JSON.parse(read("manifest.en.webmanifest"));
    expect(pt.description).not.toBe(en.description);
    expect(pt.name).not.toBe(en.name);
  });

  test("llms.txt names both locale entry points", () => {
    const llms = read("llms.txt");
    for (const locale of LOCALES) {
      expect(llms).toContain(`https://wattsteer.com/${locale}/`);
    }
    expect(llms).toContain("x-default");
  });
});

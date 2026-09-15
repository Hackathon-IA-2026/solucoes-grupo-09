import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppParams, sharedParams } from "@/components/app/params";
import { RUN_LABELS, SUBSYSTEM_DISPLAY_ORDER } from "@/lib/fixtures";
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
  it("a locale root keeps its trailing slash, a page does not", () => {
    // One canonical form per page. `/pt` and `/pt/` indexed as two URLs is
    // the cheapest possible way to split a page's own ranking signal.
    expect(localePath("pt")).toBe("/pt/");
    expect(localePath("en", "/privacy")).toBe("/en/privacy");
  });

  it("switching locale keeps the page", () => {
    expect(swapLocale("/en/privacy", "pt")).toBe("/pt/privacy");
    expect(swapLocale("/pt/", "en")).toBe("/en/");
    expect(swapLocale("/pt", "en")).toBe("/en/");
  });

  it("a path with no locale prefix gets one rather than being rewritten", () => {
    // `/app` is not locale-prefixed. Treating its first segment as a locale
    // would silently turn a switch into a 404.
    expect(swapLocale("/app", "pt")).toBe("/pt/app");
    expect(swapLocale("/", "en")).toBe("/en/");
  });

  it("only pt and en are locales", () => {
    expect(isLocale("pt")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it("browser tags match on the primary subtag", () => {
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

  it("sitemap lists exactly the six real pages", () => {
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.sort()).toEqual([...expected].sort());
  });

  it("sitemap does not list /, the app, or the 404", () => {
    // `/` is the loading screen — noindex,follow — and /app declares its own
    // noindex. Listing a noindexed URL in a sitemap is a contradiction, not a
    // hint.
    expect(sitemap).not.toContain("<loc>https://wattsteer.com/</loc>");
    expect(sitemap).not.toContain("/app<");
  });

  it("every sitemap entry carries both alternates and x-default", () => {
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

  it("robots.txt still allows /", () => {
    // Pairing Disallow with the loading screen's noindex would mean the
    // noindex is never crawled and therefore never obeyed.
    const robots = read("robots.txt");
    expect(robots).toContain("Allow: /");
    expect(robots).not.toMatch(/^Disallow:/m);
  });

  it("each locale has a manifest naming itself", () => {
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

  it("llms.txt names both locale entry points", () => {
    const llms = read("llms.txt");
    for (const locale of LOCALES) {
      expect(llms).toContain(`https://wattsteer.com/${locale}/`);
    }
    expect(llms).toContain("x-default");
  });
});

describe("the selection survives a tab press", () => {
  const AT = new Date("2026-09-15T12:00:00Z");

  it("round-trips every technology, which SOLAR did not", () => {
    // The defect: `sharedParams` emitted the domain spelling `SOLAR` and
    // `parseAppParams` reads only the URL spelling, so selecting Solar and
    // pressing another tab silently landed back on Wind. A fallback doing its
    // job on a value this module wrote itself.
    for (const spelling of ["wind", "solar"]) {
      const selected = parseAppParams({ technology: spelling }, AT);
      const back = parseAppParams(sharedParams(selected), AT);
      expect(back.technology).toBe(selected.technology);
    }
  });

  it("round-trips the whole shared selection, not just the technology", () => {
    // Stated as a property rather than as examples, because the defect above
    // was in the one field nobody had written an example for. Every
    // combination the URL can hold must survive the crossing.
    for (const subsystem of SUBSYSTEM_DISPLAY_ORDER) {
      for (const technology of ["wind", "solar"]) {
        for (const run of RUN_LABELS) {
          const selected = parseAppParams({ subsystem, technology, run }, AT);
          const back = parseAppParams(sharedParams(selected), AT);
          expect(back.subsystem).toBe(selected.subsystem);
          expect(back.technology).toBe(selected.technology);
          expect(back.run).toBe(selected.run);
        }
      }
    }
  });

  it("emits the URL spelling, which is what the address bar shows a reader", () => {
    // Non-vacuity: a `sharedParams` that emitted the domain spelling and a
    // `parseAppParams` that accepted *both* would round-trip and still put
    // `technology=SOLAR` in a shareable URL, against a module docstring that
    // says the transport owns its own spelling.
    const solar = parseAppParams({ technology: "solar" }, AT);
    expect(sharedParams(solar).technology).toBe("solar");
  });
});

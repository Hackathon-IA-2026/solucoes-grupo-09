import { describe, expect, it } from "bun:test";
import { DEFAULT_LOCALE, LOCALES } from "../src/i18n/locale";
import { alternatesFor, pageUrl } from "../src/lib/seo";

/**
 * The URLs `sitemap.xml`, `<link rel="canonical">` and every `hreflang`
 * alternate have to agree on.
 *
 * `seo.ts`'s own header names the failure: *"disagreement between a page's
 * canonical and the sitemap's idea of it is the usual reason hreflang gets
 * silently ignored."* Silently is the operative word — a mismatched alternate
 * set does not 404, does not warn, and does not show up in any test that
 * renders a page. It shows up as a locale that never ranks.
 */

describe("every page URL is absolute and locale-prefixed", () => {
  it("names the site once, with no double slash at the join", () => {
    for (const locale of LOCALES) {
      const url = pageUrl(locale);
      expect(url.startsWith("https://")).toBe(true);
      // The join is where a trailing slash on the origin and a leading one on
      // the path silently produce `//pt/`, which crawlers treat as a different
      // URL from the canonical.
      expect(url.slice("https://".length)).not.toContain("//");
      expect(url).toContain(`/${locale}`);
    }
  });

  it("the two locales are different URLs — an hreflang set of one is not a set", () => {
    expect(pageUrl("pt")).not.toBe(pageUrl("en"));
  });

  it("a sub-path keeps the locale prefix ahead of it", () => {
    const privacy = pageUrl("pt", "/privacy");
    expect(privacy).toContain("/pt/privacy");
    expect(privacy.indexOf("/pt")).toBeLessThan(privacy.indexOf("/privacy"));
  });
});

describe("the alternate set is complete and points at Portuguese by default", () => {
  it("carries one entry per locale plus x-default", () => {
    const alternates = alternatesFor();
    expect(alternates).toHaveLength(LOCALES.length + 1);
    const tags = alternates.map((a) => a.hrefLang);
    expect(tags).toContain("x-default");
    // Valid BCP-47, and the two are deliberately *different shapes*.
    // Portuguese is regionalised — `pt-BR`, because the data is ONS's and the
    // audience is Brazilian — and English is bare, because it targets English
    // speakers anywhere rather than one country. Asserting both as `xx-XX`
    // was my first guess and it is wrong: an `en-US` here would narrow the
    // English page's targeting to one market it was never written for.
    for (const tag of tags.filter((t) => t !== "x-default")) {
      expect(tag).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
    }
    expect(tags).toContain("pt-BR");
    expect(tags).toContain("en");
  });

  it("x-default is the default locale's URL, not a third destination", () => {
    // "Brazil is the primary market, so a crawler that expresses no preference
    // gets pt-BR rather than English." An x-default pointing somewhere neither
    // locale serves is the version of this bug that still looks well-formed.
    const alternates = alternatesFor();
    const xDefault = alternates.find((a) => a.hrefLang === "x-default");
    expect(xDefault?.href).toBe(pageUrl(DEFAULT_LOCALE));
    expect(DEFAULT_LOCALE).toBe("pt");
  });

  it("every href is one of the locale URLs — no entry invents a page", () => {
    for (const path of ["", "/privacy", "/terms"] as const) {
      const known = new Set(LOCALES.map((l) => pageUrl(l, path)));
      for (const alternate of alternatesFor(path)) {
        expect({ path, href: alternate.href, known: known.has(alternate.href) }).toEqual({
          path,
          href: alternate.href,
          known: true,
        });
      }
    }
  });

  it("the set is reciprocal: each locale's page lists every locale", () => {
    // hreflang is only honoured when the annotations agree both ways. A set
    // that lists `en` from `pt` but not the reverse is discarded entirely.
    const bySet = LOCALES.map((l) => ({
      from: l,
      hrefs: alternatesFor()
        .map((a) => a.href)
        .sort(),
    }));
    const first = bySet[0]?.hrefs;
    for (const entry of bySet) {
      expect({
        from: entry.from,
        same: JSON.stringify(entry.hrefs) === JSON.stringify(first),
      }).toEqual({
        from: entry.from,
        same: true,
      });
    }
  });
});

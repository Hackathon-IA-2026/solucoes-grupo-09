import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { en } from "../src/i18n/copy.en";
import { pt } from "../src/i18n/copy.pt";
import { PITCH_PATH, PITCH_PDF_PATH } from "../src/lib/pitch";

/**
 * The `/pitch` route and the file it exists to show.
 *
 * The failure this suite is built around is that **the page cannot tell you
 * the deck is missing**. An `<iframe src="/wattsteer-pitch.pdf">` pointed at
 * nothing renders a blank rectangle: no exception, no import to fail, no
 * console error the screen could catch. A test that only asserted the route
 * renders would therefore pass over exactly the defect worth catching, so the
 * assertions below are about the bytes on disk, the path that addresses them,
 * and the two build steps that carry the file from `public/` to the browser.
 *
 * Structural greps, in the style of `replay-screen.test.ts`, do the rest:
 * several of this route's obligations are about what it does *not* do — it
 * does not emit a locale canonical, it does not route the PDF through
 * expo-router, it does not appear in the sitemap — and an absence is not
 * renderable.
 */

const WEB = join(import.meta.dir, "..");
const PUBLIC = join(WEB, "public");
const SCREEN = join(WEB, "src", "app", "pitch.tsx");

/** The deck, resolved through the same constant the screen renders. */
const DECK = join(PUBLIC, PITCH_PDF_PATH.replace(/^\//, ""));

const source = (path: string) => readFileSync(path, "utf8");

/**
 * The screen with its comments blanked, so prose *about* a thing is never
 * mistaken for the thing — this file's header explains at length why `SeoHead`
 * is wrong here, and a test asserting `SeoHead` is absent would otherwise fail
 * on the explanation. Newlines are kept so a failure still points at a line.
 *
 * Line comments first, then blocks: the reverse order is silently wrong on a
 * `//` comment that contains `/*`, which is the ordering bug
 * `test/i18n-hardcoded-copy.test.ts` documents having measured.
 */
function code(path: string): string {
  return source(path)
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

describe("the pitch deck asset", () => {
  it("the file the screen points at exists and is a real PDF", () => {
    // Not `existsSync` alone: a zero-byte or truncated placeholder would
    // satisfy that and still render a blank frame, which is the whole defect.
    const bytes = readFileSync(DECK);
    expect(bytes.byteLength).toBeGreaterThan(100_000);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // A PDF's trailer is the last thing written; a half-copied file has none.
    expect(bytes.subarray(-2048).toString("latin1")).toContain("%%EOF");
  });

  it("it is addressed from one constant, not a literal in the screen", () => {
    // The screen, the fallback link and this test all read the same string.
    // A path spelled out twice is a path that can be renamed once.
    const screen = code(SCREEN);
    expect(screen).toContain("PITCH_PDF_PATH");
    expect(screen).not.toContain('"/wattsteer-pitch.pdf"');
    expect(PITCH_PDF_PATH.startsWith("/")).toBe(true);
    expect(PITCH_PATH).toBe("/pitch");
  });

  it("it is served from public/, which both build steps carry", () => {
    // `public/` is copied verbatim into `dist/` by `expo export` and into the
    // build stage by the Dockerfile. The Dockerfile copies a hand-written list
    // of paths rather than the whole app — `metro.config.js` was once left off
    // it and the image died on export — so the line that carries this file is
    // worth asserting rather than assuming.
    expect(statSync(join(PUBLIC, "robots.txt")).isFile()).toBe(true);
    expect(source(join(WEB, "Dockerfile"))).toContain("COPY apps/web/public");
  });

  it("the server answers the deck uncompressed", () => {
    // `server.ts` gzips by content type. A PDF is already deflate-compressed
    // internally, and gzipping it would cost CPU on every request for nothing;
    // the regex must therefore not match `application/pdf`. Asserted against
    // the pattern the server actually uses, read out of its source, so a change
    // there is a change here.
    const server = source(join(WEB, "server.ts"));
    const declared = server.match(/const COMPRESSIBLE =\s*\/([\s\S]*?)\/;\n/)?.[1];
    // A pattern this could not find would make every assertion below vacuous.
    expect(declared).toBeTruthy();
    const compressible = new RegExp(declared as string);
    expect(compressible.test("application/pdf")).toBe(false);
    expect(compressible.test("text/html")).toBe(true);
  });
});

describe("the /pitch route", () => {
  const screen = code(SCREEN);

  it("the route file is where expo-router will find `/pitch`", () => {
    // File-based routing: `src/app/pitch.tsx` is the route, and a default
    // export is what the router mounts.
    expect(statSync(SCREEN).isFile()).toBe(true);
    expect(screen).toMatch(/export default function Pitch\(/);
  });

  it("the embed is web-only and has an accessible name", () => {
    // `<iframe>` has no React Native counterpart, so it sits behind the same
    // Platform guard the rest of the app uses for web-only rendering.
    expect(screen).toContain("<iframe");
    expect(screen).toMatch(/Platform\.OS !== "web"[\s\S]{0,80}return null/);
    // The title is copy, so it comes from the dictionaries; a literal here
    // would be an English name read aloud over a Portuguese page.
    expect(screen).toMatch(/title=\{title\}/);
  });

  it("the way to the file is a plain anchor, not a router Link", () => {
    // The deck is a static asset, not a route. `Link` would resolve
    // `/wattsteer-pitch.pdf` against the route tree and land on the 404.
    expect(screen).toMatch(/<a\s+href=\{PITCH_PDF_PATH\}/);
    expect(screen).toContain('rel="noreferrer"');
    // `<Link …>` specifically, not the substring: `Linking.openURL` on the
    // native branch legitimately carries the same constant.
    expect(screen).not.toMatch(/<Link[^>]*PITCH_PDF_PATH/);
    // Non-vacuous: the same pattern does find the shape it forbids.
    expect("<Link href={PITCH_PDF_PATH}>").toMatch(/<Link[^>]*PITCH_PDF_PATH/);
  });

  it("the fallback link is not conditional on the embed failing", () => {
    // A browser set to download PDFs shows an empty frame and no error, so
    // there is nothing to fall back *from*. The link is unconditional; only
    // the iframe is guarded.
    const guards = screen.match(/Platform\.OS !== "web"/g) ?? [];
    expect(guards).toHaveLength(2);
    expect(screen).toMatch(/<PitchPdfLink label=\{copy\.pitch\.openLabel\}/);
  });

  it("it declares noindex and emits no locale canonical", () => {
    // One PDF, one URL. `SeoHead` would assert a canonical per locale and an
    // hreflang pair between two pages whose indexable content is identical.
    expect(screen).toContain('content="noindex,follow"');
    expect(screen).not.toContain("SeoHead");
    expect(screen).not.toContain("alternatesFor");
  });

  it("the sitemap leaves it out, consistently with that", () => {
    // Listing a noindexed URL in a sitemap is a contradiction, not a hint —
    // the same rule that keeps the gate and /app out of it.
    const sitemap = source(join(PUBLIC, "sitemap.xml"));
    expect(sitemap).not.toContain(PITCH_PATH);
    expect(sitemap).not.toContain(PITCH_PDF_PATH);
    // And robots.txt still lets a crawler reach it, which is what makes
    // `follow` mean anything.
    expect(source(join(PUBLIC, "robots.txt"))).not.toMatch(/^Disallow:/m);
  });

  it("the export is required to produce it, once and outside the locale tree", () => {
    // `localize-export.ts` is the last point in the build that can still see
    // the difference between a page that shipped and a page that did not, and
    // it exits non-zero rather than shipping a gap. The deck's two artifacts
    // are on that list: the framing page, and the PDF itself — which is in the
    // module graph of nothing and would otherwise fail silently at runtime.
    const localize = source(join(WEB, "scripts", "localize-export.ts"));
    expect(localize).toContain('"pitch.html"');
    expect(localize).toContain(`"${PITCH_PDF_PATH.replace(/^\//, "")}"`);
    // Once, not once per locale: `/pt/pitch` is a path that should not exist,
    // so the page must not be inside the `LOCALES.flatMap` block.
    const perLocale = localize.match(/LOCALES\.flatMap\([\s\S]*?\n\s*\]\),/)?.[0];
    expect(perLocale).toBeTruthy();
    expect(perLocale).not.toContain("pitch");
    // And presence alone is not the check there — a zero-byte copy would pass
    // `isFile()` and still render a blank frame.
    expect(localize).toMatch(/\.size === 0/);
  });
});

describe("the pitch copy", () => {
  const KEYS = [
    "metaTitle",
    "metaDescription",
    "badge",
    "title",
    "lede",
    "embedTitle",
    "fallback",
    "openLabel",
    // Not rendered by the screen — these are the links *to* it, and the
    // landing page's section about it. In this list because the assertion
    // below is that the block holds exactly these keys, which is what catches
    // one added to a single locale.
    "footerLink",
    "navLink",
    "sectionCta",
    "slideAlt",
  ] as const;

  it("every string the screen renders resolves in both locales", () => {
    // `Copy` already makes a *missing* key a compile error. What it cannot see
    // is a key that resolves to nothing, which renders as a gap on the page.
    for (const key of KEYS) {
      expect(pt.pitch[key].trim().length).toBeGreaterThan(0);
      expect(en.pitch[key].trim().length).toBeGreaterThan(0);
    }
    expect(Object.keys(pt.pitch).sort()).toEqual([...KEYS].sort());
    expect(Object.keys(en.pitch).sort()).toEqual([...KEYS].sort());
  });

  it("Portuguese is written, not copied from English", () => {
    // The repo-wide version of this lives in `i18n.test.ts`; asserted here too
    // because a new screen is exactly where an untranslated placeholder gets
    // in, and the global check only inspects strings over 24 characters.
    for (const key of KEYS) {
      expect(pt.pitch[key]).not.toBe(en.pitch[key]);
    }
  });

  it("something renders every one of them", () => {
    /*
      A key nothing renders is copy a translator maintains for nobody. Most are
      the screen's; `footerLink` is the *footer's* link to the screen, `navLink`
      the nav's, and the landing page's deck section renders four — `title` and
      `lede` shared with the screen, plus the two it adds. The rule is kept and
      the renderer is named per key rather than the key being quietly exempted.
    */
    const screen = code(SCREEN);
    const footer = code(join(WEB, "src", "components", "site-footer.tsx"));
    const nav = code(join(WEB, "src", "components", "landing", "landing-nav.tsx"));
    const deck = code(join(WEB, "src", "components", "landing", "deck.tsx"));
    const RENDERER: Partial<Record<(typeof KEYS)[number], string>> = {
      footerLink: footer,
      navLink: nav,
      sectionCta: deck,
      slideAlt: deck,
    };
    for (const key of KEYS) {
      const rendered = RENDERER[key] ?? screen;
      expect([key, rendered.includes(`copy.pitch.${key}`)]).toEqual([key, true]);
    }
  });
});

describe("the deck section on the landing page", () => {
  const SECTION = join(WEB, "src", "components", "landing", "deck.tsx");
  const SLIDE = join(WEB, "assets", "images", "pitch-slide-1.webp");
  const HOME = join(WEB, "src", "app", "[locale]", "index.tsx");

  it("the landing page renders it, with a section id the nav can reach", () => {
    // Without an `id` the section is not addressable by a fragment, which is
    // the whole reason it is a `Section` rather than a bare `View`.
    const home = code(HOME);
    expect(home).toContain("<Deck wide={wide} />");
    expect(home).toMatch(/id="deck"[\s\S]{0,120}onSectionLayout=\{onSectionLayout\}/);
  });

  it("it does not embed the PDF", () => {
    /*
      The three measured reasons are in `deck.tsx`'s header: a wheel over a PDF
      iframe scrolls the PDF rather than the page, which is a scroll trap in the
      middle of a document; the file is 706,193 bytes and this page is the one a
      link drops a visitor on; and `/pitch` is `noindex` while this page is the
      one that is indexed.

      None of that is visible in a render, and all of it is one `<iframe>` away
      from being undone, so it is asserted here. `PITCH_PDF_PATH` is forbidden
      too, not just the tag: an `<object>`, an `<embed>` or a `fetch` of the
      same 706 KB would cost the same bytes by another spelling.
    */
    const deck = code(SECTION);
    expect(deck).not.toContain("<iframe");
    expect(deck).not.toContain("PITCH_PDF_PATH");
    // Non-vacuous: the same checks do find both shapes on the page that is
    // *supposed* to carry them.
    const screen = code(SCREEN);
    expect(screen).toContain("<iframe");
    expect(screen).toContain("PITCH_PDF_PATH");
  });

  it("the action is a real anchor to the route, not a button", () => {
    // `CtaLink` is the site's pill-that-is-an-`<a>`; `PillButton` renders a
    // `<div role="button">` with no href, which a crawler cannot follow and a
    // reader cannot middle-click. `PITCH_PATH` rather than a literal, for the
    // same reason the footer uses it: `/pt/pitch` would 404.
    const deck = code(SECTION);
    expect(deck).toContain("<CtaLink");
    expect(deck).toContain("href={PITCH_PATH}");
    expect(deck).not.toMatch(/href="\/pitch"/);
  });

  it("the slide preview is a bundled asset, and a small one", () => {
    /*
      The point of previewing slide one rather than embedding the deck is that
      it costs a fraction of it. Measured: 34,266 bytes of WebP against 706,193
      of PDF and 93,830 for the same frame as a PNG. The cap is a budget with
      room to re-encode, not a transcription of today's number — but it is well
      under a tenth of the deck, which is the claim `deck.tsx` makes.
    */
    const bytes = statSync(SLIDE).size;
    expect(bytes).toBeGreaterThan(1000);
    expect(bytes).toBeLessThan(60_000);
    expect(bytes * 10).toBeLessThan(statSync(DECK).size);
    // `require`d, so a missing file is a build error rather than a blank box —
    // which is exactly what the PDF in `public/` cannot be, and why that one
    // needs `localize-export.ts` to notice.
    expect(code(SECTION)).toContain(
      'require("../../../assets/images/pitch-slide-1.webp")',
    );
  });
});

describe("the deck is reachable without knowing its URL", () => {
  it("the footer links to it", () => {
    /*
      The route shipped with nothing pointing at it: reachable only to someone
      already holding the URL. It sits in the footer's link row beside the
      legal pages, which is where a document belongs.
    */
    const footer = source(join(WEB, "src", "components", "site-footer.tsx"));
    expect(footer).toContain('from "@/lib/pitch"');
    expect(footer).toContain("href={PITCH_PATH}");
    expect(footer).toContain("copy.pitch.footerLink");
    // `PITCH_PATH`, not a literal: `/pitch` is outside the locale tree, and a
    // hand-written `/pt/pitch` would 404 while still looking right here.
    expect(footer).not.toMatch(/href="\/pitch"/);
  });
});

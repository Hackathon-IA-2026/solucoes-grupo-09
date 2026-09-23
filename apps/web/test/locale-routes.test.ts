import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AppParams,
  parseAppParams,
  sharedParams,
  writeParams,
} from "@/components/app/params";
import {
  REPLAY_DAYS,
  RUN_LABELS,
  SUBSYSTEM_DISPLAY_ORDER,
  type Technology,
} from "@/lib/fixtures";
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

  it("sitemap lists exactly the real pages", () => {
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

/**
 * The shape of guard that caught the `sharedParams` defect, turned on every
 * control instead of on one caller.
 *
 * `sharedParams` was fixed and its sibling survived: the `Tecnologia` chip
 * wrote through `useAppParams().setParams`, which cast a domain value into the
 * query string, so pressing Solar put `technology=SOLAR` in the address bar and
 * `parseAppParams` — reading only `solar` — answered `WIND`. An example test per
 * control would have missed it the same way the first one did, because the
 * field nobody writes an example for is the field that breaks. So the statement
 * is a property: **whatever the app writes must parse back to what it meant.**
 */
describe("every control the app can write parses back to what it meant", () => {
  const AT = new Date("2026-09-15T12:00:00Z");

  /*
    Total over the writable selection by type, so a new field added to
    `AppParams` is a compile error here before it is a silent hole in
    `writeParams`.

    Three exclusions, all because no control writes them: `date` is derived from
    the clock, and `subsystemFromUrl` says where `subsystem` came from rather
    than what it is — writing it into a URL would make it true of every link
    made from that page onwards. `episodeFromUrl` is its sibling for the Time
    Machine's day, excluded for the same reason.
  */
  const CONTROLS: {
    [K in keyof Omit<
      AppParams,
      "date" | "subsystemFromUrl" | "episodeFromUrl"
    >]: readonly AppParams[K][];
  } = {
    subsystem: SUBSYSTEM_DISPLAY_ORDER,
    technology: ["WIND", "SOLAR"] satisfies readonly Technology[],
    run: RUN_LABELS,
    episode: REPLAY_DAYS.map((day) => day.id),
  };

  const FIELDS = Object.keys(CONTROLS) as (keyof typeof CONTROLS)[];

  it("round-trips every value of every control, one press at a time", () => {
    // One field at a time, because that is what a press does: `setParams`
    // merges, so the URL a chip writes names its field and nothing else.
    for (const field of FIELDS) {
      const values = CONTROLS[field];
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        const written = writeParams({ [field]: value } as Partial<AppParams>);
        // Non-vacuity: a `writeParams` that dropped the field would leave the
        // parse on its default and pass for whichever value the default is.
        expect(Object.keys(written)).toEqual([field]);
        expect(parseAppParams(written, AT)[field]).toBe(value);
      }
    }
  });

  it("round-trips a whole selection written at once", () => {
    for (const subsystem of CONTROLS.subsystem) {
      for (const technology of CONTROLS.technology) {
        for (const run of CONTROLS.run) {
          for (const episode of CONTROLS.episode) {
            const meant = { subsystem, technology, run, episode };
            const back = parseAppParams(writeParams(meant), AT);
            expect(back.subsystem).toBe(subsystem);
            expect(back.technology).toBe(technology);
            expect(back.run).toBe(run);
            expect(back.episode).toBe(episode);
          }
        }
      }
    }
  });

  it("writes the URL spelling, not the domain one, for a reader to read", () => {
    // The address bar is a surface. A round-trip alone would also be satisfied
    // by a parser that accepted both spellings, which is the vacuous fix: it
    // would leave `technology=SOLAR` in every shared link.
    expect(writeParams({ technology: "SOLAR" }).technology).toBe("solar");
    expect(writeParams({ technology: "WIND" }).technology).toBe("wind");
  });
});

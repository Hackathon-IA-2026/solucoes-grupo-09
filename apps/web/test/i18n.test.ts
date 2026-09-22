import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DRIVERS } from "../src/components/landing/fixtures";
import { en } from "../src/i18n/copy.en";
import { pt } from "../src/i18n/copy.pt";
import { DEFAULT_LOCALE, LOCALES } from "../src/i18n/locale";

/**
 * The `Copy` type already guarantees that a locale cannot omit or invent a
 * key — that is a compile error. What it cannot check is whether a string was
 * left empty, or accidentally shipped still in English, or whether Portuguese
 * is actually the default. Those are the failures a reader would see.
 */

type Node = string | readonly Node[] | { readonly [k: string]: Node };

function walk(node: Node, path: string[], out: Map<string, string>): void {
  if (typeof node === "string") {
    out.set(path.join("."), node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      walk(child as Node, [...path, String(i)], out);
    });
    return;
  }
  for (const [key, child] of Object.entries(node as Record<string, Node>)) {
    walk(child, [...path, key], out);
  }
}

const flat = (dict: unknown): Map<string, string> => {
  const out = new Map<string, string>();
  walk(dict as Node, [], out);
  return out;
};

const PT = flat(pt);
const EN = flat(en);

describe("i18n", () => {
  it("Portuguese is the default locale", () => {
    // A product decision, not a fallback: the audience is Brazilian.
    expect(DEFAULT_LOCALE).toBe("pt");
    expect(LOCALES[0]).toBe("pt");
  });

  it("both locales carry exactly the same keys", () => {
    expect([...PT.keys()].sort()).toEqual([...EN.keys()].sort());
  });

  it("no string is empty or whitespace in either locale", () => {
    const empty = [...PT, ...EN].filter(([, value]) => value.trim() === "");
    expect(empty.map(([key]) => key)).toEqual([]);
  });

  it("the section targets are identical — they are ids, not copy", () => {
    // `nav.links[].target` addresses a scroll anchor. Translating one would
    // break navigation in that locale only, which is the kind of bug that
    // hides until someone switches language.
    const targets = (dict: Map<string, string>) =>
      [...dict].filter(([k]) => k.endsWith(".target")).map(([, v]) => v);
    expect(targets(PT)).toEqual(targets(EN));
  });

  it("Portuguese is not just the English strings copied over", () => {
    // A locale that silently duplicates English would satisfy every other
    // check here. Prose must actually differ; notation legitimately does not.
    const NOTATION = new Set([
      "band.rangeLabel",
      "band.medianLabel",
      // Quantile notation and placeholders, with no prose between them: both
      // locales genuinely say "P10 {p10}, P50 {p50}, P90 {p90}" and
      // "{date} · {subsystem} {technology}". Translating either would mean
      // translating `P50`, which is not a word.
      "app.band.strip",
      "app.replay.dayLabel",
      // ONS's own name for the grid, plus the D−1 marker. The product leaves
      // ONS proper nouns untranslated everywhere — `subsystemMeta` keeps
      // `NORDESTE` in both locales for the same reason — and "Sistema
      // Interligado Nacional" is the operator's name for the thing, not a
      // description of it.
      "app.grid.eyebrow",
      // The names of Brazilian norms on the references page. A norm is cited
      // by its official title in any language, as ONS proper nouns are above.
      "legal.references.norms.rows.1.0",
      "legal.references.norms.rows.2.0",
      "legal.references.norms.rows.3.0",
    ]);
    const prose = [...PT].filter(
      ([key, value]) =>
        !(NOTATION.has(key) || key.endsWith(".target")) && value.length > 24,
    );
    const identical = prose.filter(([key, value]) => EN.get(key) === value);
    expect(identical.map(([key]) => key)).toEqual([]);
    expect(prose.length).toBeGreaterThan(20);
  });

  it("quantile notation stays verbatim in both locales", () => {
    expect(PT.get("band.rangeLabel")).toBe("P10–P90");
    expect(EN.get("band.rangeLabel")).toBe("P10–P90");
  });
});

/**
 * Claims the site makes, made checkable.
 *
 * These three are not style checks. Each was an actual defect measured on this
 * branch, and each is the kind that hides: a string nobody renders, a set of
 * bars drawn at a grain no model reports, and a button whose label contradicts
 * the badge on the page it opens.
 */

/** Every source file that could render copy. */
const SOURCE = (() => {
  const files: string[] = [];
  const walkDir = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walkDir(path);
      } else if (/\.tsx?$/.test(path) && !path.includes("i18n/copy.")) {
        files.push(path);
      }
    }
  };
  walkDir(join(import.meta.dir, "..", "src"));
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
})();

/**
 * Copy that exists for a state nothing can currently reach, each with why.
 *
 * Every entry is a *stated absence or a refusal* the shipped endpoints
 * produce and the fixtures cannot, so the string has to exist before the wire
 * does. The exemption is per key rather than per subtree so that adding a
 * fifth `noForecast` state fails here instead of arriving unrendered.
 */
const UNRENDERED: ReadonlyMap<string, string> = new Map([
  ["noForecast.notYetPublished", "needs a /v1/forecast read; Overview is fixture-only"],
  ["noForecast.noPromotedArtifact", "same — and it is this deployment's own state"],
  ["noForecast.stale", "same"],
  ["noForecast.unavailable", "same"],
  ["app.explain.narrationSourceModel", "`narration.source`; Explain is on fixtures"],
  ["app.explain.narrationSourceTemplate", "same"],
]);

describe("every string in the dictionaries reaches a screen", () => {
  it("no key is written and never rendered", () => {
    // A leaf is rendered if its own path is referenced, or if any ancestor is
    // referenced *as a whole value* — `copy.provenance.sources.map(…)` renders
    // every leaf under it. Distinguishing the two is the whole difficulty:
    // `copy.nav.home` also contains the text `copy.nav`, and treating that as
    // a value reference would excuse every unused sibling. So a match counts
    // as a value reference only when what follows is not one of that node's
    // own keys — `.map` is not a key of `sources`, `.home` is a key of `nav`.
    const keysAt = (path: readonly string[]): Set<string> => {
      let node: unknown = en;
      for (const segment of path) {
        node = (node as Record<string, unknown>)[segment];
      }
      return new Set(Object.keys(node as object));
    };
    const referenced = (path: readonly string[]) => {
      const escaped = path
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\.");
      const own = keysAt(path);
      const pattern = new RegExp(`copy\\.${escaped}(?![\\w$])`, "g");
      for (const match of SOURCE.matchAll(pattern)) {
        const after = SOURCE.slice(match.index + match[0].length);
        // A computed read — `copy.error[code]` — addresses the node as a whole.
        if (after.startsWith("[")) {
          return true;
        }
        const deeper = /^\.([A-Za-z_$][\w$]*)/.exec(after);
        if (deeper === null || !own.has(deeper[1] as string)) {
          return true;
        }
      }
      return false;
    };
    const dead = [...EN.keys()].filter((key) => {
      if (UNRENDERED.has(key)) {
        return false;
      }
      // An array index is never written out at a call site: the array itself
      // is what a component receives.
      const path = key.split(".");
      const firstIndex = path.findIndex((segment) => /^\d+$/.test(segment));
      const addressable = firstIndex === -1 ? path : path.slice(0, firstIndex);
      return !addressable.some((_, i) => referenced(addressable.slice(0, i + 1)));
    });
    expect(dead).toEqual([]);
  });

  it("nothing is exempted that the source does render", () => {
    // The exemption list is the part of this test that rots. A key that has
    // since been wired up must leave the list, or the list stops meaning
    // "these are the strings no screen can reach".
    const stale = [...UNRENDERED.keys()].filter((key) =>
      new RegExp(`copy\\.${key.replace(/\./g, "\\.")}(?![\\w$.])`).test(SOURCE),
    );
    expect(stale).toEqual([]);
  });
});

describe("the landing page claims the product's own grain", () => {
  it("every driver it draws is one the Diagnosis engine reports", () => {
    // The eight groups are the players in the Shapley game; `other` is the
    // client's merged remainder. A feature name here would be a bar for an
    // attribution no model produces — which is what this panel used to draw.
    const groups = Object.keys(en.app.drivers.groups);
    const drawable = new Set([...groups, "other"]);
    expect(DRIVERS.map((driver) => driver.code).filter((c) => !drawable.has(c))).toEqual(
      [],
    );
    expect(groups).toHaveLength(8);
  });

  it("there is one dictionary of driver words, not two", () => {
    // The landing page carried its own `showcase.explain.drivers` map. Two
    // dictionaries for one set is how the two surfaces drifted apart in the
    // first place, and a renamed group would only have reached one of them.
    const driverDictionaries = [...EN.keys()].filter((key) =>
      /(^|\.)drivers\.(groups|merged)?/.test(key),
    );
    for (const key of driverDictionaries) {
      expect(key.startsWith("app.drivers.")).toBe(true);
    }
  });
});

describe("no call to action promises more than /app serves", () => {
  it("the product links do not describe fixtures as live data", () => {
    // `APP_HREF` is `/app`, whose chrome stamps `PROTOTYPE · FIXTURE DATA`:
    // Grid Overview and Explain build every figure from `@/lib/fixtures` and
    // issue no request. A button reading "Open the live grid" contradicted the
    // badge on the page it opened.
    const LIVE_WORDS = [/\blive\b/i, /ao vivo/i, /\bagora\b/i, /\breal[- ]time\b/i];
    // The buttons, and the two lines that describe what the buttons open.
    //
    // `showcase.sub` was missed the first time round and said the landing
    // panels carry "the same bands as the live screens" — in `pt`, "das telas
    // ao vivo". Those screens are `/app`, which stamps `PROTOTYPE · FIXTURE
    // DATA` and, on Overview and Explain, issues no request at all. Fixing the
    // buttons and leaving the sentence that introduces the product would have
    // moved the claim one paragraph rather than removed it.
    //
    // Scoped to these five keys rather than to the whole dictionary on
    // purpose: `engines.status` says "ingestion and the data platform are live
    // and reading ONS", which is true, is the page's own admission of what is
    // *not* live beside it, and must not be caught here.
    const ctas = [
      "hero.primaryCta",
      "footerCta.button",
      "hero.secondaryCta",
      "showcase.sub",
      "showcase.badge",
    ];
    for (const key of ctas) {
      for (const dict of [EN, PT]) {
        const label = dict.get(key);
        expect(label).toBeDefined();
        for (const word of LIVE_WORDS) {
          expect([key, word.source, word.test(label ?? "")]).toEqual([
            key,
            word.source,
            false,
          ]);
        }
      }
    }
  });
});

/**
 * The hero's two lines of copy, after they were cut to the deck's register.
 *
 * Both budgets are read off the exported build at 400px rather than chosen:
 * the failure each guards against is a sentence that renders correctly and is
 * simply too long, which nothing else in this suite can see.
 */
describe("the hero says it in the deck's voice", () => {
  /**
   * The eyebrow's character budget.
   *
   * At 400px the pill's label has ~314px: 400 less the 20px page gutters
   * either side, less the pill's 24px of horizontal padding, less the 14px
   * mark and the 8px gap beside it. The label is 12px/500 in the system
   * stack, ~6.2px a character on this copy, so ~50 characters reach the edge.
   * 46 is that with air. The string this replaced was 60 in `pt` and wrapped
   * the pill into a rounded two-line paragraph at that width.
   */
  const EYEBROW_BUDGET = 46;

  /**
   * The subtitle's.
   *
   * The version this replaced ran 411 characters in `pt` — nine lines at
   * 400px, which pushed both calls to action out of the first screenful that
   * `hero-metrics.ts` exists to guarantee. At 200 the longest of the two
   * locales renders five lines at 400px and two at 1280px, measured on the
   * export, and both buttons sit above the fold at either width.
   */
  const SUB_BUDGET = 200;

  for (const [name, dict] of [
    ["pt", PT],
    ["en", EN],
  ] as const) {
    it(`${name}: the eyebrow fits the pill on one line at 400px`, () => {
      const eyebrow = dict.get("hero.eyebrow") ?? "";
      expect([name, eyebrow.length, eyebrow.length <= EYEBROW_BUDGET]).toEqual([
        name,
        eyebrow.length,
        true,
      ]);
    });

    it(`${name}: the subtitle is a subtitle, not the page's argument`, () => {
      const sub = dict.get("hero.sub") ?? "";
      expect([name, sub.length, sub.length <= SUB_BUDGET]).toEqual([
        name,
        sub.length,
        true,
      ]);
    });
  }

  it("the hero never promises a forecast this deployment can serve", () => {
    // No artifact is promoted, so every forecasting surface answers `pending`
    // or a named refusal. The hero may say what the product is; it may not
    // tell a visitor that a forecast is waiting for them. A present-tense
    // verb of delivery with the product as its subject is the form that claim
    // takes, and the old subtitle carried one — "WattSteer forecasts those
    // hours a day ahead" — while the deployment forecast nothing.
    //
    // Every pattern closes on a Unicode letter lookahead rather than on `\b`.
    // `\b` is ASCII-only in JavaScript, so `/prevê\b/` never matches "prevê o
    // corte" — the boundary is looked for *after* a character the engine does
    // not consider a word character, and there is none. The Portuguese half of
    // this guard was vacuous for exactly that reason until a planted "O
    // WattSteer prevê o corte de amanhã" walked straight through it.
    const PROMISES = [
      /\bwattsteer (forecasts|predicts|tells you|shows you)(?!\p{L})/iu,
      /\bo wattsteer (prev[êe]|mostra|avisa)(?!\p{L})/iu,
      /\bsee (tomorrow|the forecast)(?!\p{L})/iu,
      /\bveja (a previsão|amanhã)(?!\p{L})/iu,
    ];
    for (const dict of [EN, PT]) {
      const line = `${dict.get("hero.eyebrow") ?? ""} ${dict.get("hero.sub") ?? ""}`;
      for (const promise of PROMISES) {
        expect([promise.source, promise.test(line)]).toEqual([promise.source, false]);
      }
    }
  });
});
describe("the two dictionaries say the same thing about the product", () => {
  it("the technology badge claims emphasis, not visibility", () => {
    // en said "shown", so the badge read "Wind · shown" — which says the solar
    // number is not shown. That is a filter, and the product does not filter:
    // there is one head per subsystem, so the split is a division of one
    // expectation and picking a technology emphasises one half of it. pt has
    // always said "em destaque". It was the only place the dictionaries made
    // different claims about what the product does.
    const visibility = /\b(shown|hidden|visible|displayed|oculto|escondido)\b/i;
    expect(en.app.split.emphasised).not.toMatch(visibility);
    expect(pt.app.split.emphasised).not.toMatch(visibility);
    // The paragraph the two used to be checked against is gone — it was the
    // rail's footnote and the rail no longer carries one — so the word is held
    // against the claim directly rather than against its own prose.
    expect(en.app.split.emphasised).toContain("emphasis");
    expect(pt.app.split.emphasised).toContain("destaque");
  });
});

describe("a computed read does not excuse an unused sibling", () => {
  /*
    **The one hole the guard above cannot see, closed where it opens.**

    `app.shell.screens` is read as `copy.app.shell.screens[screen.key]`, and
    the rule that lets `copy.provenance.sources.map(…)` vouch for every leaf
    under it lets that bracket vouch for every screen name — whether or not any
    row asks for it. It was true twice: `explain` and `mitigate` sat in that
    node unrendered after the nav row dropped to two, and the suite was green
    both times.

    So the node states its own contract instead. Every name under `screens` is
    a row in `SCREENS`, and every row in `SCREENS` has a name — which is the
    property the bracket read actually depends on, asserted rather than assumed.
  */
  it("every nav name is a nav row, and every row is named", () => {
    const shell = readFileSync(
      join(import.meta.dir, "..", "src", "components", "app", "app-shell.tsx"),
      "utf8",
    );
    const block = shell.slice(
      shell.indexOf("const SCREENS: ScreenDef[] = ["),
      shell.indexOf("];", shell.indexOf("const SCREENS: ScreenDef[] = [")),
    );
    const rows = [...block.matchAll(/key: "([a-z]+)"/g)].map((match) => match[1]).sort();
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(en.app.shell.screens).sort()).toEqual(rows);
    expect(Object.keys(pt.app.shell.screens).sort()).toEqual(rows);
  });
});

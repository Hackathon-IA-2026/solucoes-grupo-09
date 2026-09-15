import { describe, expect, test } from "bun:test";
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
  test("Portuguese is the default locale", () => {
    // A product decision, not a fallback: the audience is Brazilian.
    expect(DEFAULT_LOCALE).toBe("pt");
    expect(LOCALES[0]).toBe("pt");
  });

  test("both locales carry exactly the same keys", () => {
    expect([...PT.keys()].sort()).toEqual([...EN.keys()].sort());
  });

  test("no string is empty or whitespace in either locale", () => {
    const empty = [...PT, ...EN].filter(([, value]) => value.trim() === "");
    expect(empty.map(([key]) => key)).toEqual([]);
  });

  test("the section targets are identical — they are ids, not copy", () => {
    // `nav.links[].target` addresses a scroll anchor. Translating one would
    // break navigation in that locale only, which is the kind of bug that
    // hides until someone switches language.
    const targets = (dict: Map<string, string>) =>
      [...dict].filter(([k]) => k.endsWith(".target")).map(([, v]) => v);
    expect(targets(PT)).toEqual(targets(EN));
  });

  test("Portuguese is not just the English strings copied over", () => {
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
    ]);
    const prose = [...PT].filter(
      ([key, value]) =>
        !(NOTATION.has(key) || key.endsWith(".target")) && value.length > 24,
    );
    const identical = prose.filter(([key, value]) => EN.get(key) === value);
    expect(identical.map(([key]) => key)).toEqual([]);
    expect(prose.length).toBeGreaterThan(20);
  });

  test("quantile notation stays verbatim in both locales", () => {
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
  ["app.explain.narrationWithheld", "a withhold rule; no fixture withholds"],
  ["app.explain.narrationSourceModel", "`narration.source`; Explain is on fixtures"],
  ["app.explain.narrationSourceTemplate", "same"],
]);

describe("every string in the dictionaries reaches a screen", () => {
  test("no key is written and never rendered", () => {
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

  test("nothing is exempted that the source does render", () => {
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
  test("every driver it draws is one the Diagnosis engine reports", () => {
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

  test("there is one dictionary of driver words, not two", () => {
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
  test("the product links do not describe fixtures as live data", () => {
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

import { describe, expect, test } from "bun:test";
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
    const NOTATION = new Set(["band.rangeLabel", "band.medianLabel"]);
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

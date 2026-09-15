import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Straight from the token module rather than from the package index: the
// index pulls in React Native, which `bun test` cannot parse, and the two
// values needed here are plain numbers.
import { layout, space } from "../../../packages/ui/src/tokens";

/**
 * Two properties of the landing page below the hero, both of them defects that
 * were measured on the exported build rather than opinions about taste.
 *
 * 1. **Spacing comes off the 4-pt scale.** `space` is the scale; a literal is
 *    a number somebody picked. The page carried eleven of them — `gap: 6`,
 *    `gap: 2`, `padding: 12`, `padding: 16`, `padding: 20`, a `10` in the
 *    footer's brand row — and the ones that were on the scale by accident
 *    (`8`, `12`, `16`) were indistinguishable from the ones that were not.
 * 2. **Prose is capped at the system's own measure.** `layout.prose` is 680.
 *    `engines.status`, the most important caveat on the site, was set across
 *    the full 1,248 px content column at 12 px — 196 characters a line. The
 *    ODbL notice and the fifth "will not claim" item had the same problem.
 *
 * Neither is checkable by rendering: `bun test` has no DOM here, and the
 * failure is a number in a style object rather than a thrown error. So both
 * are read off the source, in the shape `test/i18n-hardcoded-copy.test.ts`
 * already established for this repository.
 */

const LANDING = join(import.meta.dir, "..", "src", "components", "landing");
const FOOTER = join(import.meta.dir, "..", "src", "components", "site-footer.tsx");

/**
 * Files this cycle does not own, each with why.
 *
 * The hero and the primary call to action are being rebuilt in parallel by
 * another agent, and `fan-chart.tsx` and `band-figure.tsx`'s `FigureCard` are
 * rendered by the hero and nowhere else. Every one of them still carries
 * literals this check would flag, which is the point of listing them here
 * rather than widening the scale: when the hero work lands, these entries come
 * off and the numbers come onto the scale with them.
 */
const EXEMPT: { file: string; reason: string }[] = [
  {
    file: "hero.tsx",
    reason:
      "The hero is owned by a parallel agent this cycle and is explicitly out of this ticket's scope; its literals move when that work merges.",
  },
  {
    file: "cta-link.tsx",
    reason:
      "The primary call to action, same parallel owner. Its padding is the button's geometry and changing it would move the thing being redesigned.",
  },
  {
    file: "fan-chart.tsx",
    reason:
      "The hero's hour-by-hour chart, rendered by hero.tsx and by nothing else; its paddings are the tooltip's and the legend's geometry.",
  },
  {
    file: "band-figure.tsx",
    reason:
      "The one literal here is `FigureCard`'s padding of 20, which matches `Panel`'s own padding so a figure card and a panel line up; `FigureCard` is a hero-only component.",
  },
];

const SPACING =
  /\b(gap|rowGap|columnGap|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|paddingVertical|paddingHorizontal|margin|marginTop|marginBottom|marginLeft|marginRight|marginVertical|marginHorizontal)\s*:\s*(\d+)\b/g;

/** A prose cap is a cap wide enough to be one: a measure, not a display line. */
const PROSE_CAP = /\bmaxWidth\s*:\s*(\d{3,})\b/g;

const SCALE = new Set<number>(Object.values(space));

interface Finding {
  file: string;
  line: number;
  text: string;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** Comments are prose about numbers, not numbers — `// 24 px, not 22` is not a style. */
function strip(source: string): string {
  return source.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function scan(file: string, source: string, pattern: RegExp): Finding[] {
  const body = strip(source);
  const found: Finding[] = [];
  for (const match of body.matchAll(new RegExp(pattern.source, "g"))) {
    found.push({
      file,
      line: lineOf(body, match.index ?? 0),
      text: match[0],
    });
  }
  return found;
}

function offScale(file: string, source: string): Finding[] {
  return scan(file, source, SPACING).filter(
    (found) => !SCALE.has(Number(/(\d+)\s*$/.exec(found.text)?.[1] ?? "-1")),
  );
}

function overWideCap(file: string, source: string): Finding[] {
  return scan(file, source, PROSE_CAP).filter(
    // 600 is the line: `footerCta`'s headline is capped at 560, which is a
    // display measure for a 28 px line and not a paragraph. Anything at or
    // above 600 is a body measure and belongs to `layout.prose`.
    (found) => Number(/(\d+)\s*$/.exec(found.text)?.[1] ?? "0") >= 600,
  );
}

const OWNED = (): { file: string; source: string }[] => {
  const exempt = new Set(EXEMPT.map((one) => one.file));
  const files = readdirSync(LANDING)
    .filter((name) => name.endsWith(".tsx") && !exempt.has(name))
    .map((name) => ({ file: name, source: readFileSync(join(LANDING, name), "utf8") }));
  files.push({ file: "site-footer.tsx", source: readFileSync(FOOTER, "utf8") });
  return files;
};

describe("the landing page below the hero keeps to the design system", () => {
  it("every spacing value is on the 4-pt scale", () => {
    const offenders = OWNED().flatMap(({ file, source }) =>
      offScale(file, source).map((found) => `${found.file}:${found.line}: ${found.text}`),
    );
    expect(offenders).toEqual([]);
  });

  it("no prose is capped at a number instead of at `layout.prose`", () => {
    const offenders = OWNED().flatMap(({ file, source }) =>
      overWideCap(file, source).map(
        (found) => `${found.file}:${found.line}: ${found.text}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("the blocks that ran too wide are still capped", () => {
    /*
      Measured on the exported build at 1280: `engines.status` ran 1,248 px at
      12 px (196 characters a line) and the section lede was capped at a bare
      620. Deleting a cap has to fail here, because nothing else in the suite
      can see it.

      `provenance.tsx` was the third, for its ODbL notice — which has since been
      removed from the landing page. The licence obligation it carried is not
      gone: the Terms page's `attribution` section states the ODbL v1.0
      share-alike and names `GET /v1/plants` for §4.6. With the notice gone the
      file has no 12 px prose left to cap, so asserting a cap in it would be
      asserting against nothing.
    */
    for (const file of ["section.tsx", "engines.tsx"]) {
      const source = readFileSync(join(LANDING, file), "utf8");
      expect([file, source.includes("layout.prose")]).toEqual([file, true]);
    }
    expect(layout.prose).toBe(680);
  });

  it("it scans the files it says it does, and the exemptions have not rotted", () => {
    // A scope that walks nothing passes forever.
    const owned = OWNED();
    expect(owned.length).toBeGreaterThan(6);

    for (const entry of EXEMPT) {
      // The file is still there and still in the scanned directory.
      const source = readFileSync(join(LANDING, entry.file), "utf8");
      // And it still contains something this check would have flagged. An
      // exemption for a file with nothing to exempt is a permission nobody
      // needs, and deleting it costs one line.
      expect([entry.file, offScale(entry.file, source).length > 0]).toEqual([
        entry.file,
        true,
      ]);
      expect(entry.reason.split(/\s+/).length).toBeGreaterThan(8);
    }
  });

  it("it still catches an off-scale value and still passes a scale one", () => {
    // The check has to fail on the thing it exists for.
    expect(offScale("probe.tsx", "const s = { gap: 10, padding: 20 };")).toHaveLength(2);
    expect(offScale("probe.tsx", "const s = { gap: space.sm, padding: 16 };")).toEqual(
      [],
    );
    // A comment about a number is not a number.
    expect(offScale("probe.tsx", "// 24 px, not the 22 it was\nconst x = 1;")).toEqual(
      [],
    );
    // And the measure check fires on a bare prose cap but not on a display one.
    expect(overWideCap("probe.tsx", "{ maxWidth: 620 }")).toHaveLength(1);
    expect(overWideCap("probe.tsx", "{ maxWidth: 560 }")).toEqual([]);
    expect(overWideCap("probe.tsx", "{ maxWidth: layout.prose }")).toEqual([]);
  });
});

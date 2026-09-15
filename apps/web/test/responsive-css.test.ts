import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The document shell's stylesheet and the components it steers must agree.
 *
 * `src/app/+html.tsx` carries a handful of rules that decide, at first paint,
 * what a component would otherwise decide after measuring itself — the legal
 * TOC's placement, the footer's column count, the hero headline's size. They
 * exist because `onLayout` cannot fire before the bundle has been fetched and
 * evaluated, so the static export paints the narrow branch of every measured
 * layout and then rearranges it; that rearrangement is what Lighthouse counts
 * as layout shift, and it was costing the legal pages and `/pitch` nine points
 * of Performance each.
 *
 * That arrangement has one weakness, and this file is the answer to it: the
 * CSS and the component are joined by a string and a number, neither of which
 * any compiler checks. It had already failed once — a rule selecting
 * `[data-hero-headline]` at `min-width: 960px` survived in the shell after the
 * attribute stopped being emitted and the breakpoint moved to 900, so the one
 * rule written to prevent layout shift was matching nothing at all. Nothing
 * failed, and the page shifted.
 *
 * So two properties, both read off the source because there is no DOM here:
 *
 * 1. **Every `data-` attribute the stylesheet selects is emitted by some
 *    component.** This is the dead-rule check.
 * 2. **Every breakpoint in the stylesheet is a constant a component exports.**
 *    A CSS breakpoint that has drifted from the `width >=` beside it is worse
 *    than none: web and native would then disagree about where the layout
 *    changes, and only one of them is being looked at.
 */

const WEB = join(import.meta.dir, "..");
const SHELL = join(WEB, "src", "app", "+html.tsx");
const SRC = join(WEB, "src");

const shell = readFileSync(SHELL, "utf8");

/** Every `.tsx`/`.ts` under `src/`, so a marker can live anywhere. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sources(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const ALL_SOURCE = sources(SRC)
  .filter((file) => file !== SHELL)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

/** `data-hero-headline` is what `dataSet: { heroHeadline: "" }` renders as. */
function camel(attribute: string): string {
  return attribute.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

describe("the shell's stylesheet and the components it steers agree", () => {
  test("every `data-` attribute the stylesheet selects is emitted somewhere", () => {
    const selected = [...shell.matchAll(/\[data-([a-z0-9-]+)\]/g)].map((m) => m[1]);
    expect(selected.length).toBeGreaterThan(0);

    const dead = [...new Set(selected)].filter((attribute) => {
      const key = camel(attribute);
      // Either written inline (`dataSet: { noscriptOnly: "" }`) or through the
      // `marker("heroHeadline")` helper the components share.
      return !(
        new RegExp(`dataSet:\\s*\\{\\s*${key}\\b`).test(ALL_SOURCE) ||
        new RegExp(`marker\\("${key}"\\)`).test(ALL_SOURCE)
      );
    });

    expect(dead).toEqual([]);
  });

  test("every breakpoint in the stylesheet is a breakpoint a component exports", () => {
    const breakpoints = [
      ...shell.matchAll(/@(?:media|container)[^{]*\(min-width:\s*(\d+)px\)/g),
    ].map((m) => Number(m[1]));
    expect(breakpoints.length).toBeGreaterThan(0);

    // The constants the rules mirror, each read from the file that owns it so
    // the pair cannot be edited apart.
    const owned = new Map<number, string>([
      [read("components/legal-screen.tsx", "LEGAL_WIDE"), "LEGAL_WIDE"],
      [read("components/site-footer.tsx", "FOOTER_WIDE"), "FOOTER_WIDE"],
      [read("components/landing/hero.tsx", "HERO_WIDE"), "HERO_WIDE"],
      [read("app/pitch.tsx", "PITCH_WIDE"), "PITCH_WIDE"],
    ]);

    const unowned = [...new Set(breakpoints)].filter((px) => !owned.has(px));
    expect(unowned).toEqual([]);
  });
});

/** The value of an exported numeric constant, read off the source. */
function read(relative: string, name: string): number {
  const source = readFileSync(join(SRC, relative), "utf8");
  const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(source);
  if (match === null) {
    throw new Error(`${relative} no longer exports \`${name}\``);
  }
  return Number(match[1]);
}

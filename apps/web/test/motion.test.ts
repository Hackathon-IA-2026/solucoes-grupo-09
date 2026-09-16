import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every CSS transition in the product goes through one helper, and carries a
 * curve.
 *
 * The durations here were always right — 150ms on a press, nothing over 300.
 * The easing was simply absent: five call sites wrote `transitionProperty` and
 * `transitionDuration` by hand and set no timing function at all, so all of
 * them ran on the CSS default. That default is weak on purpose, having been
 * picked to be inoffensive everywhere, which makes it read as nothing in
 * particular. A press that scales without a curve behind it feels like the
 * interface catching up rather than answering.
 *
 * Two properties, both read off the source because there is no DOM here:
 *
 * 1. **No file sets `transitionProperty` inline.** `webTransition` is the only
 *    way to open a transition, which is what makes the curve unskippable — the
 *    five hand-written sites were how the curve went missing in the first
 *    place, and each of them had also duplicated the duration.
 * 2. **`webTransition` always emits a timing function.** The parameter has a
 *    default, so a caller cannot forget it; this holds the default in place.
 *
 * Suppressing a transition is a third thing and says so: `webNoTransition`
 * exists for the one place where `Animated` drives a property and the browser
 * must keep its hands off it.
 *
 * Which curve is a judgement each call site makes and `motion.ease` documents:
 * ease-out for movement and presses, plain `ease` for colour. That judgement is
 * deliberately not asserted here — it is taste, and a test that pinned it would
 * be pinning one reading of every future transition.
 */

const WEB = join(import.meta.dir, "..");
const UI = join(WEB, "..", "..", "packages", "ui", "src");

function sources(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules") {
      continue;
    }
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sources(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments stripped: these rules quote the property names they ban. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const FILES = [...sources(join(WEB, "src")), ...sources(UI)];

describe("transitions are opened in one place", () => {
  it("no component writes `transitionProperty` by hand", () => {
    // `focus-ring.ts` is where both helpers live, so it is the one file that
    // may name the property. Everything else goes through them.
    const offenders = FILES.filter(
      (file) =>
        code(readFileSync(file, "utf8")).includes("transitionProperty") &&
        !file.endsWith(join("lib", "focus-ring.ts")),
    ).map((file) => file.slice(file.indexOf("/src/") + 1));
    expect(offenders).toEqual([]);
  });

  it("`webTransition` emits a timing function, with a default a caller keeps", () => {
    const helper = readFileSync(join(UI, "lib", "focus-ring.ts"), "utf8");
    expect(helper).toContain("easing: string = motion.ease.out");
    expect(helper).toContain("transitionTimingFunction: easing");
  });

  it("the curves are real cubic-beziers, and `ease-in` is not among them", () => {
    const tokens = code(readFileSync(join(UI, "tokens.ts"), "utf8"));
    expect(tokens).toContain('out: "cubic-bezier(0.23, 1, 0.32, 1)"');
    expect(tokens).toContain('inOut: "cubic-bezier(0.77, 0, 0.175, 1)"');
    // `ease-in` starts slow, which delays the movement exactly where the
    // reader is looking hardest. It is never the right curve for UI.
    expect(tokens).not.toContain('ease-in"');
  });
});

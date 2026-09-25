/**
 * The ordering rule `lib/use-latest.ts` states, held against its call sites.
 *
 * The module's whole argument is a lifecycle one: effects run in the order
 * their hooks were called, so a `useLatest` declared **above** the effect that
 * reads it has committed this render's value before the consumer runs, and one
 * declared below it has not. Every call site is written that way and the header
 * says so — but nothing checked, and the failure is silent. The callback still
 * runs, still gets a value, and the value is one render stale. In the voice
 * case the header notes that this is invisible: every intent would still be a
 * valid URL, just the wrong one.
 *
 * This is a source-level guard for the reason `testing.md` admits them: the
 * property lives in *how* the hook is called rather than in a value it returns,
 * and the unit suite has no renderer to observe hook order with. Adding one
 * would mean adding a rendering library to assert something a reader can see by
 * looking — and the thing that goes wrong is the position of a line.
 *
 * It is keyed per ref rather than per file: `const x = useLatest(...)` and every
 * `x.current` after it. A positional check over the whole file would also fire
 * on refs that have nothing to do with this hook, which `use-voice-session.ts`
 * has twenty-seven of.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "src");

/** Every file that calls the hook. Listed, so a new caller is a visible edit. */
const CALLERS = [
  join("components", "app", "use-replay.ts"),
  join("components", "app", "use-optimization.ts"),
  join("components", "app", "use-replay-review.ts"),
  join("components", "voice", "use-voice-session.ts"),
  join("components", "voice", "voice-provider.tsx"),
];

/**
 * Source with comments blanked and the newlines kept.
 *
 * Blanked rather than removed so every offset below is still the offset in the
 * real file — the assertions compare positions, and deleting text would move
 * them. The prose in these files discusses `.current` at length, and reading it
 * as code would make the guard fire on its own documentation.
 */
function code(path: string): string {
  return readFileSync(join(WEB, path), "utf8").replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => match.replace(/[^\n]/g, " "),
  );
}

interface Ref {
  readonly file: string;
  readonly name: string;
  readonly declaredAt: number;
}

function refsOf(file: string, source: string): Ref[] {
  return [...source.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*useLatest\(/g)].map(
    (match) => ({
      file,
      name: match[1] as string,
      declaredAt: match.index,
    }),
  );
}

const REFS = CALLERS.flatMap((file) => refsOf(file, code(file)));

describe("a latest-value ref is declared above everything that reads it", () => {
  it("every read of every ref comes after its declaration", () => {
    const early: string[] = [];
    for (const ref of REFS) {
      const source = code(ref.file);
      for (const read of source.matchAll(
        new RegExp(String.raw`\b${ref.name}\.current\b`, "g"),
      )) {
        if (read.index < ref.declaredAt) {
          early.push(`${ref.file}: ${ref.name}.current at ${read.index}`);
        }
      }
    }
    expect(early).toEqual([]);
  });

  it("found the refs and the reads, so the check above means something", () => {
    /*
      The assertion above is `toEqual([])` over a walk, which reads green when
      the walk finds nothing — the shape this repository has been caught by
      before. A renamed hook, a moved file or a regex that stopped matching
      would empty `REFS` and leave the guard reporting every call site correct
      at the moment it stopped reading any of them.
    */
    expect(REFS.length).toBeGreaterThanOrEqual(6);
    const reads = REFS.reduce((total, ref) => {
      const source = code(ref.file);
      return (
        total +
        [...source.matchAll(new RegExp(String.raw`\b${ref.name}\.current\b`, "g"))].length
      );
    }, 0);
    expect(reads).toBeGreaterThanOrEqual(REFS.length);
    // And the hook really is imported where it is said to be called.
    for (const file of CALLERS) {
      expect(code(file)).toContain("@/lib/use-latest");
    }
  });
});

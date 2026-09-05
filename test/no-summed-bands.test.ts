import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Quantiles do not add, and no web code path may add them.
 *
 * This is the invariant three specs converged on independently.
 * `docs/specs/replay.md` caught the Time Machine building its day band by
 * summing 24 hourly P10s, P50s and P90s; `docs/specs/api-surface.md` caught
 * the landing hero building a national band out of four subsystem bands; and
 * `docs/specs/forecaster.md` draws whole rows of a PIT matrix precisely so
 * that a joint total exists and nothing downstream has to invent one.
 *
 * The arithmetic is wrong in a specific, quantifiable direction. Summing 24
 * P90s describes a day on which every hour independently lands at its own 90th
 * percentile *together*, which is far worse than a 90th-percentile day; and
 * the median of a sum is the sum of the medians only when the components are
 * comonotone. Both errors are invisible in the output — the result is a
 * plausible-looking band — which is why the guard is structural rather than a
 * numeric assertion on one fixture.
 *
 * ### Where it applies, and where it deliberately does not
 *
 * Only `apps/web/src`. The tests under `apps/web/test` *do* sum bands, on
 * purpose: that is how they assert a day band is strictly narrower than the
 * componentwise sum it must not be. A guard that forbade the comparison would
 * forbid checking the property.
 *
 * Expectations are exempt because they are not quantiles: `E[Y]` adds exactly
 * and across grains, with no assumption whatever about dependence. So
 * `hours.reduce((acc, h) => acc + h.expectedMwh, 0)` is correct and is not
 * matched — the rule is keyed on the quantile members `p10`, `p50` and `p90`.
 *
 * ### This is a heuristic, and says so
 *
 * A regex cannot type-check, so it looks for the three shapes that account for
 * every real occurrence found so far:
 *
 *  A. two quantile reads added together — `a.p50 + b.p50`;
 *  B. a `reduce` that accumulates a quantile read — the Σ-over-hours shape;
 *  C. a `+=` whose right-hand side reads a quantile — the same shape as a loop.
 *
 * A *difference* of two quantiles is not matched. The ticket's invariant is
 * about summing bands into a band, and `apps/web/src/app/app/mitigate.tsx`
 * subtracts one step's P50 from the previous step's to print a delta between
 * two scenarios of the same day — a scalar for display, not a constructed
 * band. It is left to a ticket that owns that screen rather than silently
 * widened into scope here.
 */

const ROOT = join(import.meta.dir, "..");
const SCOPE = join("apps", "web", "src");

/** `p10`, `p50`, `p90` — read as a member, never as a bare identifier. */
const QUANTILE = /\.p(?:10|50|90)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(path)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Comments blanked, newlines kept.
 *
 * Every file that has ever been caught by this rule now carries a comment
 * explaining why it no longer sums, and those comments quote the arithmetic
 * they replaced. Reading them as code would make the guard fire on its own
 * documentation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/** The text of the call that starts at `open`, parens balanced. */
function callText(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") {
      depth++;
    } else if (source[i] === ")") {
      depth--;
      if (depth === 0) {
        return source.slice(open, i + 1);
      }
    }
  }
  return source.slice(open);
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function summedBands(file: string, source: string): Hit[] {
  const code = withoutComments(source);
  const hits: Hit[] = [];
  const record = (index: number, text: string) => {
    hits.push({ file, line: lineOf(code, index), text: text.replace(/\s+/g, " ") });
  };

  // A. `a.p50 + b.p50` — two quantile reads on either side of a `+`.
  const pair = /\.p(?:10|50|90)\b[^;\n]{0,80}?\+[^;\n]{0,80}?\.p(?:10|50|90)\b/g;
  for (let m = pair.exec(code); m !== null; m = pair.exec(code)) {
    record(m.index, m[0]);
  }

  // B. a `reduce` whose callback accumulates a quantile read.
  for (
    let at = code.indexOf(".reduce(");
    at !== -1;
    at = code.indexOf(".reduce(", at + 1)
  ) {
    const call = callText(code, at + ".reduce".length);
    if (QUANTILE.test(call) && call.includes("+")) {
      record(at, call);
    }
  }

  // C. `total += hour.constrainedOff.p90` — the same sum, written as a loop.
  const accumulate = /\+=[^;\n]{0,80}?\.p(?:10|50|90)\b/g;
  for (let m = accumulate.exec(code); m !== null; m = accumulate.exec(code)) {
    record(m.index, m[0]);
  }

  return hits;
}

describe("no web code path sums two bands componentwise", () => {
  it("finds no quantile arithmetic anywhere under apps/web/src", () => {
    const hits = sourceFiles(join(ROOT, SCOPE)).flatMap((path) =>
      summedBands(relative(ROOT, path), readFileSync(path, "utf8")),
    );
    expect(hits.map((h) => `${h.file}:${h.line} — ${h.text}`)).toEqual([]);
  });

  it("recognises the shapes it exists to catch", () => {
    // The guard has to be able to fail, and these are the three forms the
    // specs actually found in this repo, reduced to one line each.
    const caught = (snippet: string) => summedBands("probe.ts", snippet).length;
    expect(caught("const band = { p50: a.p50 + b.p50 };")).toBeGreaterThan(0);
    expect(caught("hours.reduce((acc, h) => acc + h.constrainedOff.p90, 0);")).toBe(1);
    expect(caught("for (const h of hours) { total += h.constrainedOff.p10; }")).toBe(1);
    // And it has to leave the two legitimate shapes alone.
    expect(caught("hours.reduce((acc, h) => acc + h.expectedMwh, 0);")).toBe(0);
    expect(
      caught("points.reduce((best, p, i) => (p.p50 > points[best].p50 ? i : best), 0);"),
    ).toBe(0);
    expect(caught("// summing p10 + p10 in a comment is not code\n")).toBe(0);
  });
});

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * **Every axis a response varies on belongs in its validator**, and a required
 * query parameter is always such an axis.
 *
 * This is a structural guard rather than another example, because the failure
 * it prevents is silent, confident and about the product's headline number.
 *
 * `/v1/forecast/day-ahead` keyed its ETag on `[artifactId, publishedAt,
 * dataVersion]` and **not** on `subsystem`. One retrain mints one artifact id
 * across every subsystem, and `publishedAt` is `gate_at(target_date,
 * gate_profile)` — the same instant for all four. So all three components were
 * identical across subsystems on a given day and gate: a client holding the
 * Northeast's validator could send it with `subsystem=S`, be answered `304 Not
 * Modified` with no body, and render the Northeast's band as the South's.
 * Nothing on the screen would disagree.
 *
 * `/v1/model/card` had the same shape with `lane`, and `jobs/retrain.ts` states
 * the premise outright — the run id "is the artifact stem in both lanes" — so
 * the late gate's reliability curve could be served as the early gate's, on two
 * gates that see different weather runs and whose calibration is not
 * interchangeable.
 *
 * Both are fixed. This exists so the third one cannot happen: the routes next
 * door (`plants.ts` appends its filters, `curtailment.ts` its range) already had
 * it right, which is what made those two an inconsistency rather than a policy
 * anyone had argued for.
 */

const API = join(import.meta.dir, "../src/api");

/** Source with comments stripped, so the rule cannot match its own explanation. */
function codeOf(name: string): string {
  return readFileSync(join(API, name), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function routeFiles(): string[] {
  return readdirSync(API).filter((name) => name.endsWith(".ts"));
}

/**
 * Every `applyCachePolicy(..., [ ... ])` provenance in a file, as source text.
 *
 * Text rather than evaluation, because what is being asserted is that the
 * *author named the axis* — a provenance that happens to contain the right
 * value at runtime through some other binding is still a route whose next
 * editor cannot see the rule.
 */
function provenances(source: string): string[] {
  const found: string[] = [];
  const marker = "applyCachePolicy(";
  let at = source.indexOf(marker);
  while (at !== -1) {
    const open = source.indexOf("[", at);
    const close = source.indexOf("]", open);
    if (open !== -1 && close !== -1 && open < at + 200) {
      found.push(source.slice(open, close));
    }
    at = source.indexOf(marker, at + marker.length);
  }
  return found;
}

describe("a cache validator names every axis its response varies on", () => {
  it("finds cached routes at all", () => {
    // Non-vacuity for everything below: if the matcher stopped matching, the
    // assertions would pass against an empty set.
    const all = routeFiles().flatMap((name) => provenances(codeOf(name)));
    expect(all.length).toBeGreaterThan(5);
  });

  it("puts `subsystem` in the forecast validator", () => {
    // The concrete bug: without it, one subsystem's band is served as another's
    // through `If-None-Match`.
    for (const provenance of provenances(codeOf("forecast.ts"))) {
      expect(provenance).toContain("subsystem");
    }
  });

  it("puts `lane` in both model-card validators", () => {
    // An artifact id is unique *within* a lane. The shaped card and the raw one
    // both key on it, so both need the lane.
    const found = provenances(codeOf("model-card.ts"));
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const provenance of found) {
      expect(provenance).toContain("lane");
    }
  });

  it("keeps the routes that already had it right", () => {
    // These are the precedent the two fixes were measured against, and a
    // regression in them would be the same bug in a new place.
    for (const provenance of provenances(codeOf("plants.ts"))) {
      expect(provenance).toContain("format");
    }
    for (const provenance of provenances(codeOf("curtailment.ts"))) {
      // The observed range is what those responses vary on.
      expect(/from|range|subsystem/.test(provenance)).toBe(true);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { explain, validate } from "../src/schema.js";
import { allExamples, exampleKey, nonElidedDisagreements } from "./spec-examples.js";

/**
 * Every example in the API-surface spec and its four upstream specs validates
 * against the schema.
 *
 * This is one of ticket 04's acceptance boxes, and it is worth more than it
 * looks: an example in a spec is what the next four tickets will copy when they
 * build a route, so an example that the schema rejects is a defect that
 * propagates by hand. It also runs the other way — three of the failures this
 * suite found on its first run were the *schema* being wrong, not the spec.
 *
 * The enumeration is the point. Both halves fail:
 *
 *  - a fenced JSON document in any spec with no manifest entry, so a new
 *    example cannot be added without being validated; and
 *  - a manifest entry naming a document that no longer exists, so the manifest
 *    cannot outlive the prose.
 *
 * See `packages/core/fixtures/spec-examples/README.md` for why each block has a
 * fixture beside it rather than being validated in place.
 */

const FIXTURES = join(import.meta.dir, "..", "fixtures", "spec-examples");

interface ManifestEntry {
  key: string;
  schema: string;
  fixture: string;
  completes: string[];
  note: string;
}

const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as {
  examples: ManifestEntry[];
};

const examples = allExamples();
const byKey = new Map(examples.map((example) => [exampleKey(example), example]));
const entries = new Map(manifest.examples.map((entry) => [entry.key, entry]));

describe("the specs' examples are all accounted for", () => {
  test("every JSON document in every spec has a manifest entry", () => {
    // The half that stops an example being added without being validated.
    const unlisted = [...byKey.keys()].filter((key) => !entries.has(key));
    expect(unlisted).toEqual([]);
  });

  test("every manifest entry names a document that still exists", () => {
    // The half that stops the manifest describing prose that has moved. Line
    // numbers are part of the key on purpose: an example that moves has to be
    // re-pointed, which is a moment somebody looks at it again.
    const missing = [...entries.keys()].filter((key) => !byKey.has(key));
    expect(missing).toEqual([]);
  });

  test("there is at least one example from each of the five specs", () => {
    // A guard on the guard: a regex that stopped matching fences would make
    // every assertion above vacuously true.
    const specs = new Set(examples.map((example) => example.spec));
    for (const spec of [
      "api-surface.md",
      "diagnosis.md",
      "flex-optimizer.md",
      "replay.md",
    ]) {
      expect([...specs]).toContain(spec);
    }
    expect(examples.length).toBeGreaterThanOrEqual(12);
  });
});

for (const entry of manifest.examples) {
  describe(entry.key, () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES, entry.fixture), "utf8"),
    ) as unknown;

    test(`validates against ${entry.schema}`, () => {
      const result = validate(entry.schema, fixture);
      expect(result.valid ? "" : explain(result)).toBe("");
    });

    test("reproduces every part of the spec block that the spec stated", () => {
      const example = byKey.get(entry.key);
      expect(example).toBeDefined();
      const disagreements = nonElidedDisagreements(example?.value, fixture).filter(
        (path) => !entry.completes.includes(path),
      );
      // A disagreement here is either a spec that changed or a fixture that
      // drifted, and both want a human. Adding the path to `completes` is
      // possible and costs a written reason, which is the intended friction.
      expect(disagreements).toEqual([]);
    });

    test("every completed path is justified in writing", () => {
      if (entry.completes.length > 0) {
        expect(entry.note.length).toBeGreaterThan(40);
      }
    });
  });
}

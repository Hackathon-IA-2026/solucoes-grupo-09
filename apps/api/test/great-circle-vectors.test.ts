import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { haversineKm } from "../src/features/capacity-weights.js";

/**
 * The great-circle distance, asserted from the TypeScript side of the parity.
 *
 * `packages/core/fixtures/great-circle/` is the shared table and its `README.md`
 * carries the reasoning. `apps/ml/tests/test_great_circle_vectors.py` is the
 * other half of the same claim and adds the SQL one, against a real Postgres.
 *
 * **Nothing here is compared against the SQL.** Every assertion is against
 * `expected_km`, which was written by neither implementation —
 * `packages/core/scripts/build-great-circle-vectors.py` reaches it a third way,
 * with Vincenty's formula specialised to a sphere — so a shared
 * misunderstanding has nothing to cancel out against.
 *
 * **Why this file exists rather than one more assertion in the database
 * suite.** `database-features.test.ts` already compares the whole weighting
 * computed both ways and it is still the more complete test, but it compares
 * the two implementations *with each other*: it is silent about a formula both
 * sides get wrong identically, it needs a Postgres to say anything at all, and
 * it is a single `it(...)` inside eight hundred lines. Data-platform ticket 18
 * asked for the parity to be made "explicit and hard to delete" instead of
 * left as an ordinary assertion, and a named fixture directory that three
 * things address by path is what that looks like here.
 *
 * It needs no network and no database. It reads files and calls a pure
 * function.
 */

/** `apps/api/test/` → the repository root → the vectors. */
const FIXTURES = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "core",
  "fixtures",
  "great-circle",
);

interface Vector {
  name: string;
  why: string;
  from: { latitude: number; longitude: number };
  to: { latitude: number; longitude: number };
  expected_km: number;
}

/**
 * Every `.json` in the directory, discovered rather than listed.
 *
 * An empty directory is a failure and not a pass: a suite that asserted nothing
 * because the fixtures were deleted would report the parity as holding at the
 * exact moment it stopped being checked. This is also what makes adding a
 * vector sufficient — neither language can skip one it was not told about.
 */
const VECTORS: Vector[] = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(FIXTURES, file), "utf-8")) as Vector);

describe("the great-circle distance, against the shared vectors", () => {
  it("has vectors to assert", () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(10);
  });

  for (const vector of VECTORS) {
    it(`${vector.name}: ${vector.why.split(".")[0]}`, () => {
      const km = haversineKm(vector.from, vector.to);
      // Relative, because the vectors span a millimetre to half the planet and
      // one absolute tolerance cannot be meaningful at both ends. The measured
      // worst disagreement between the haversine and Vincenty across this set
      // is 5e-15 relative; 1e-12 leaves three orders of headroom and is still
      // far tighter than any error a wrong formula would produce.
      const tolerance = Math.max(1e-12 * vector.expected_km, 1e-9);
      expect(Math.abs(km - vector.expected_km)).toBeLessThanOrEqual(tolerance);
    });
  }

  it("is symmetric in its arguments", () => {
    // Not in the vectors, because it is a property rather than a value: the
    // vectors would have to carry every pair twice to state it.
    for (const vector of VECTORS) {
      expect(haversineKm(vector.to, vector.from)).toBeCloseTo(
        haversineKm(vector.from, vector.to),
        9,
      );
    }
  });
});

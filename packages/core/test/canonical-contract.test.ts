import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// The API's implementation, imported straight from the other workspace so the
// vectors exercise the shipping code and not a copy of it. This is the
// template's resolver-parity move (`packages/core/test/resolve.test.ts`, before
// `9b8a1fc`), and it is why `apps/api/src/contract/{manifest,vintage}.ts` are
// dependency-free: a module that pulled Drizzle in could not be imported here.
import {
  CANONICAL_BASE_PATH,
  CANONICAL_READS,
} from "../../../apps/api/src/contract/manifest.js";
import {
  combineFidelity,
  combineGoLive,
  type VintageSource,
  vintageFidelity,
} from "../../../apps/api/src/contract/vintage.js";

/**
 * Parity of the canonical read contract with `apps/ml`.
 *
 * `apps/ml/tests/test_canonical_contract.py` reads the **same** directory and
 * asserts the **same** `expected` values against the Python implementation. The
 * two sides never compare against each other, only against the vectors, so a
 * shared misunderstanding cannot cancel out — see
 * `packages/core/fixtures/canonical-contract/README.md`.
 */

const FIXTURES = join(import.meta.dir, "..", "fixtures", "canonical-contract");

const cases = <T>(subdirectory: string): Array<{ file: string; body: T }> =>
  readdirSync(join(FIXTURES, subdirectory))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      body: JSON.parse(readFileSync(join(FIXTURES, subdirectory, file), "utf8")) as T,
    }));

interface ManifestFixture {
  base_path: string;
  reads: Array<{
    name: string;
    kind: string;
    producer: string | null;
    grain: string;
    key: string[];
    carries_restriction_cause: boolean;
    fidelity_axis: string;
  }>;
}

const manifest = JSON.parse(
  readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
) as ManifestFixture;

describe("the canonical read manifest matches the shared vector", () => {
  test("the base path is the one both languages build URLs from", () => {
    expect(CANONICAL_BASE_PATH).toBe(manifest.base_path);
  });

  test("the contract exposes exactly the reads the vector names, in order", () => {
    expect(CANONICAL_READS.map((read) => String(read.name))).toEqual(
      manifest.reads.map((read) => read.name),
    );
  });

  for (const expected of manifest.reads) {
    test(`${expected.name} is described identically`, () => {
      const actual = CANONICAL_READS.find((read) => read.name === expected.name);
      expect(actual).toBeDefined();
      // Widened to the vector's own types on purpose: the assertion is about
      // the *values* agreeing across a language boundary, and the Python side
      // has no union type to compare against.
      expect({
        name: String(actual?.name),
        kind: String(actual?.kind),
        producer: actual?.producer === null ? null : String(actual?.producer),
        grain: String(actual?.grain),
        key: [...(actual?.key ?? [])],
        carries_restriction_cause: actual?.carriesRestrictionCause,
        fidelity_axis: String(actual?.fidelityAxis),
      }).toEqual(expected);
    });
  }
});

describe("the vocabulary rules the manifest is supposed to encode", () => {
  test("a restriction cause is reachable from exactly one read", () => {
    // `docs/domain-model.md` §3: a reason is a property of a ReportingEntity,
    // and there is no path in the type system from a Plant to one. A second
    // `true` here would mean that path had been opened.
    const carrying = CANONICAL_READS.filter((read) => read.carriesRestrictionCause);
    expect(carrying.map((read) => read.name)).toEqual([
      "curtailment-by-reporting-entity",
    ]);
  });

  test("a forecast read names its producer and an observation read cannot", () => {
    for (const read of CANONICAL_READS) {
      if (read.kind === "forecast") {
        expect(read.producer).not.toBeNull();
      } else {
        expect(read.producer).toBeNull();
      }
    }
  });

  test("no read name carries source vocabulary", () => {
    // The acceptance criterion, made checkable. `conjunto` is the one sanctioned
    // survival (`docs/domain-model.md` naming rule 2) and is not in this list.
    const SOURCE_WORDS = [
      "ons",
      "dessem",
      "aneel",
      "siga",
      "balanco",
      "carga",
      "usina",
      "geracao",
      "restricao",
      "patamar",
      "meteo",
      "ckan",
      "sin",
    ];
    for (const read of CANONICAL_READS) {
      for (const word of SOURCE_WORDS) {
        expect(read.name.split("-")).not.toContain(word);
      }
    }
  });
});

interface FidelityFixture {
  name: string;
  window_start: string;
  go_live_at: string | null;
  expected: string;
}

describe("VintageFidelity — the rule, vector by vector", () => {
  const vectors = cases<FidelityFixture>("vintage-fidelity");

  test("the directory is not empty, so a passing run means something", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const { file, body } of vectors) {
    test(`${file}: ${body.name}`, () => {
      const goLiveAt = body.go_live_at === null ? null : new Date(body.go_live_at);
      expect(vintageFidelity(new Date(body.window_start), goLiveAt)).toBe(
        body.expected as VintageSource["vintageFidelity"],
      );
    });
  }

  test("composing a single source is that source, so the two cannot disagree", () => {
    // The property that keeps `combineFidelity` and `vintageFidelity` honest
    // about each other without either being defined in terms of the other.
    for (const { body } of vectors) {
      const goLiveAt = body.go_live_at === null ? null : new Date(body.go_live_at);
      const only: VintageSource = {
        read: "curtailment-by-reporting-entity",
        vintageFidelity: vintageFidelity(new Date(body.window_start), goLiveAt),
        goLiveAt,
      };
      expect(combineFidelity([only])).toBe(only.vintageFidelity);
    }
  });
});

interface CombineFixture {
  name: string;
  sources: Array<{ read: string; vintage_fidelity: string; go_live_at: string | null }>;
  expected_vintage_fidelity: string;
  expected_go_live_at: string | null;
}

describe("composing several sources into one receipt", () => {
  const vectors = cases<CombineFixture>("combine-fidelity");

  test("the directory is not empty, so a passing run means something", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const { file, body } of vectors) {
    test(`${file}: ${body.name}`, () => {
      const sources: VintageSource[] = body.sources.map((entry) => ({
        read: entry.read,
        vintageFidelity: entry.vintage_fidelity as VintageSource["vintageFidelity"],
        goLiveAt: entry.go_live_at === null ? null : new Date(entry.go_live_at),
      }));
      expect(combineFidelity(sources)).toBe(
        body.expected_vintage_fidelity as VintageSource["vintageFidelity"],
      );
      const goLive = combineGoLive(sources);
      expect(goLive === null ? null : goLive.toISOString()).toBe(
        body.expected_go_live_at,
      );
    });
  }
});

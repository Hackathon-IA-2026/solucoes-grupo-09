import { describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorCode } from "../src/errors.js";
import {
  canonicalJson,
  canonicalScenarioJson,
  decodeScenarioBody,
  decodeScenarioParam,
  encodeScenario,
  fromBase64Url,
  hashCanonicalBytes,
  type JsonValue,
  MAX_SCENARIO_BLOB_BYTES,
  ScenarioTransportError,
  scenarioHash,
  toBase64Url,
} from "../src/scenario.js";
import { sha256Hex } from "../src/sha256.js";
import type { FlexibilityAsset, Scenario } from "../src/types.generated.js";
import { decodeWire } from "../src/wire.js";

/**
 * The canonical scenario transport, against the shared vectors.
 *
 * `apps/ml/tests/test_scenario_canonical.py` reads the **same** directory and
 * asserts the **same** expected values against the Python implementation.
 * Neither side is asserted against the other, and both fail on a file they did
 * not enumerate — see `packages/core/fixtures/scenario-canonical/README.md`.
 *
 * The property under test is worth restating, because it is not "the encoder
 * works". It is that the sha256 of the canonical bytes is *the same number* in
 * two languages for the same scenario, whatever spelling it arrived in. That
 * number is a Redis cache key and the `scenario_hash` on every answer, so a
 * disagreement is a cache that silently never hits and a reproducibility claim
 * that cannot be reproduced.
 */

const FIXTURES = join(import.meta.dir, "..", "fixtures", "scenario-canonical");

interface Vector<T> {
  file: string;
  body: T;
}

function vectors<T>(subdirectory: string): Vector<T>[] {
  return readdirSync(join(FIXTURES, subdirectory))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      body: JSON.parse(readFileSync(join(FIXTURES, subdirectory, file), "utf8")) as T,
    }));
}

const utf8 = new TextEncoder();

// --- the number rule ---------------------------------------------------------

interface NumberCase {
  name: string;
  input: number;
  expected: string;
}

describe("a number has one canonical spelling", () => {
  const cases = (
    JSON.parse(readFileSync(join(FIXTURES, "numbers.json"), "utf8")) as {
      cases: NumberCase[];
    }
  ).cases;

  it("the vector file is not empty, so a passing run means something", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(canonicalJson(input)).toBe(expected);
    });
  }

  it("a non-finite number has no canonical form and is refused", () => {
    // Not reachable through `JSON.parse` — JSON has no `Infinity` — but very
    // reachable through a screen that divided by zero and posted the result.
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => canonicalJson(value)).toThrow(ScenarioTransportError);
    }
  });
});

// --- the whole scenarios -----------------------------------------------------

interface ScenarioVector {
  name: string;
  scenario: Record<string, JsonValue>;
  canonical: string;
  blob: string;
  hash: string;
}

describe("a scenario, canonically encoded", () => {
  const cases = vectors<ScenarioVector>("scenarios");

  it("the directory is not empty, so a passing run means something", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const { file, body } of cases) {
    describe(`${file}: ${body.name}`, () => {
      const app = decodeWire("Scenario", body.scenario) as Scenario;

      it("the app's camelCase view re-encodes to the vector's canonical bytes", () => {
        expect(canonicalScenarioJson(app)).toBe(body.canonical);
      });

      it("the blob is the base64url of those bytes", () => {
        expect(encodeScenario(app)).toBe(body.blob);
      });

      it("the hash is the sha256 of those bytes", () => {
        expect(scenarioHash(app)).toBe(body.hash);
      });

      it("the blob round-trips byte-identically", () => {
        const decoded = decodeScenarioParam(body.blob);
        expect(decoded.canonical).toBe(body.canonical);
        expect(encodeScenario(decoded.scenario)).toBe(body.blob);
      });

      it("GET ?s= and POST decode to the identical canonical bytes", () => {
        // The acceptance criterion, stated as an equality between the two
        // transports rather than as two assertions against the same constant.
        const fromParam = decodeScenarioParam(body.blob);
        const fromBody = decodeScenarioBody(body.scenario);
        expect([...fromParam.bytes]).toEqual([...fromBody.bytes]);
        expect(fromParam.hash).toBe(fromBody.hash);
        expect(fromParam.canonical).toBe(body.canonical);
      });

      it("the canonical text is what the hash was taken over", () => {
        expect(hashCanonicalBytes(utf8.encode(body.canonical))).toBe(body.hash);
      });
    });
  }
});

// --- the equivalences --------------------------------------------------------

interface EquivalenceVector {
  name: string;
  variants: Record<string, JsonValue>[];
  canonical: string;
  blob: string;
  hash: string;
}

describe("different documents, one scenario, one hash", () => {
  const cases = vectors<EquivalenceVector>("equivalences");

  it("the directory is not empty, so a passing run means something", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const { file, body } of cases) {
    it(`${file}: ${body.name}`, () => {
      expect(body.variants.length).toBeGreaterThan(1);
      for (const variant of body.variants) {
        const decoded = decodeScenarioBody(variant);
        expect(decoded.canonical).toBe(body.canonical);
        expect(decoded.hash).toBe(body.hash);
        expect(toBase64Url(decoded.bytes)).toBe(body.blob);
      }
    });
  }

  it("the test of the test: a trailing zero in a vector fails", () => {
    // `fixtures/.../README.md` and api-surface ticket 21 both ask for this —
    // a deliberately broken vector must fail, or the suite proves nothing.
    const broken = { ...JSON.parse('{"round_trip_efficiency":0.92}') } as JsonValue;
    expect(canonicalJson(broken)).not.toBe('{"round_trip_efficiency":0.920}');
    expect(canonicalJson(broken)).toBe('{"round_trip_efficiency":0.92}');
  });
});

// --- the refusals ------------------------------------------------------------

interface RefusalVector {
  name: string;
  scenario?: Record<string, JsonValue>;
  blob?: string;
  expected_code: ErrorCode;
}

function refusalCode(run: () => unknown): ErrorCode | null {
  try {
    run();
  } catch (error) {
    if (error instanceof ScenarioTransportError) {
      return error.code;
    }
    throw error;
  }
  return null;
}

describe("the blobs this build refuses to read", () => {
  const cases = vectors<RefusalVector>("refusals");

  it("the directory is not empty, so a passing run means something", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const { file, body } of cases) {
    it(`${file}: ${body.name}`, () => {
      // Every refusal names one path; a vector carrying a blob is exercised
      // through the query transport, one carrying a scenario through the body.
      const run =
        body.blob === undefined
          ? () => decodeScenarioBody(body.scenario as JsonValue)
          : () => decodeScenarioParam(body.blob as string);
      expect(refusalCode(run)).toBe(body.expected_code);
    });
  }

  it("every refusal answers with the status its code is published under", () => {
    for (const { body } of cases) {
      const run =
        body.blob === undefined
          ? () => decodeScenarioBody(body.scenario as JsonValue)
          : () => decodeScenarioParam(body.blob as string);
      try {
        run();
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(ScenarioTransportError);
        expect((error as ScenarioTransportError).status).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("a 5 KB blob is refused before anything parses it", () => {
    // The spec's own number, and the reason the cap is on the *encoded* form:
    // this is what arrives in a query string from an unauthenticated caller.
    const blob = "A".repeat(5 * 1024);
    expect(blob.length).toBeGreaterThan(MAX_SCENARIO_BLOB_BYTES);
    expect(refusalCode(() => decodeScenarioParam(blob))).toBe("SCENARIO_TOO_LARGE");
  });

  it("a blob at exactly the cap is not refused for its size", () => {
    // The boundary, from the other side: 4096 is admitted, so the cap is `>`
    // and not `>=`. It is not valid base64url content, so the refusal that does
    // arrive is about the bytes rather than the length.
    const blob = "A".repeat(MAX_SCENARIO_BLOB_BYTES);
    expect(refusalCode(() => decodeScenarioParam(blob))).not.toBe("SCENARIO_TOO_LARGE");
  });

  it("a scenario too large to share is refused on the way out too", () => {
    // A share button that produced a link the API would reject is a worse
    // failure than one that says the scenario is too big to share.
    const oversized = JSON.parse(
      readFileSync(join(FIXTURES, "refusals", "05-a-blob-over-the-cap.json"), "utf8"),
    ) as RefusalVector;
    const app = decodeWire("Scenario", oversized.scenario) as Scenario;
    expect(refusalCode(() => encodeScenario(app))).toBe("SCENARIO_TOO_LARGE");
  });
});

// --- the sum type ------------------------------------------------------------

describe("a battery carrying max_shift_mw", () => {
  it("does not typecheck", () => {
    // The compile half of the acceptance criterion. `additionalProperties:
    // false` on each variant generates an interface the field is not on, so the
    // excess property is an error — and `@ts-expect-error` makes it a *failing
    // typecheck* if that ever stops being true, which is the only way a
    // compile-time property can be asserted at all.
    const asset: FlexibilityAsset = {
      assetType: "battery",
      label: "Battery",
      subsystem: "NE",
      maxPowerMw: 100,
      energyCapacityMwh: 300,
      initialStateOfCharge: 0.2,
      // @ts-expect-error max_shift_mw is not a field of the battery variant
      maxShiftMw: 50,
    };
    expect(asset.assetType).toBe("battery");
  });

  it("does not parse", () => {
    expect(
      refusalCode(() =>
        decodeScenarioBody({
          v: 1,
          subsystem: "NE",
          target_date: "2026-08-29",
          assets: [
            {
              asset_type: "battery",
              label: "Battery",
              subsystem: "NE",
              max_power_mw: 100,
              energy_capacity_mwh: 300,
              initial_state_of_charge: 0.2,
              max_shift_mw: 50,
            },
          ],
        }),
      ),
    ).toBe("FIELD_NOT_ON_VARIANT");
  });

  it("and neither does a shiftable load carrying energy_capacity_mwh", () => {
    // The same rule in the other direction, so the check is about the variant
    // rather than about one field somebody remembered.
    expect(
      refusalCode(() =>
        decodeScenarioBody({
          v: 1,
          subsystem: "NE",
          target_date: "2026-08-29",
          assets: [
            {
              asset_type: "shiftable_load",
              label: "Flexible load",
              subsystem: "NE",
              max_power_mw: 70,
              max_shift_mw: 50,
              shift_window_hours: 3,
              daily_energy_mwh: 1700,
              energy_capacity_mwh: 300,
            },
          ],
        }),
      ),
    ).toBe("FIELD_NOT_ON_VARIANT");
  });
});

// --- base64url ---------------------------------------------------------------

describe("base64url, unpadded", () => {
  it("round-trips every byte length up to four blocks", () => {
    for (let length = 0; length < 16; length += 1) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37 + 11) % 256);
      expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
    }
  });

  it("agrees with Node's own encoder, minus the padding and the alphabet", () => {
    for (let trial = 0; trial < 64; trial += 1) {
      const bytes = new Uint8Array(randomBytes(trial));
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("the alphabet is base64url's, not base64's", () => {
    // 0xFB 0xFF exercises both characters the two alphabets disagree about.
    expect(toBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
  });
});

// --- sha256 ------------------------------------------------------------------

describe("the digest", () => {
  it("agrees with node:crypto over the padding boundaries", () => {
    // `packages/core` cannot import `node:crypto` — it is bundled into an Expo
    // app — so the digest is written out in `src/sha256.ts`. This is the test
    // that keeps the hand-written one honest, and the lengths are the ones a
    // padding bug hides in: empty, 55/56 (the length field crosses a block) and
    // 63/64/65.
    for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const bytes = new Uint8Array(randomBytes(length));
      expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("is prefixed, because ScenarioHash is `sha256:` and 64 hex characters", () => {
    const hash = hashCanonicalBytes(utf8.encode("{}"));
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash).toBe(`sha256:${createHash("sha256").update("{}").digest("hex")}`);
  });
});

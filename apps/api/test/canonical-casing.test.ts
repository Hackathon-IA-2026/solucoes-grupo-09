import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WIRE_SHAPES } from "@wattsteer/core/api";
import { snakeKey, toWire } from "../src/contract/wire.js";

/**
 * The canonical layer's serialiser and the generated wire table agree, and
 * where they cannot, nothing reaches the disagreement.
 *
 * `packages/core/src/wire.ts` says in its header that the obvious
 * implementation — insert an underscore before every upper-case letter — is
 * "nearly right, and exactly the shape of bug this package exists to prevent",
 * because it is not invertible across a digit boundary. (Written in words
 * rather than as the regular expression it is, because
 * `packages/core/test/one-translator.test.ts` greps for that literal and would
 * be right to flag this file for carrying it.) `apps/api/src/contract/wire.ts` is that
 * implementation, and it exists for a reason the table cannot cover: the
 * canonical reads are composed in `src/contract/reads.ts` and named there, so
 * `WIRE_SHAPES` has no entry to look them up in and `encodeWire(name, …)` has
 * no name to be called with.
 *
 * So it stays, and the agreement stops being an assumption. Measured when this
 * file was written: of 685 generated fields, **five** disagree, and all five
 * are the digit boundary the core header names —
 * `last_24h_constrained_off_mwh` and the three `pinball_NN` metrics. None is
 * on a canonical read, and the test below is what keeps that true rather than
 * true-today.
 *
 * `packages/core/test/one-translator.test.ts` sanctions the module and carries
 * the same argument from the other side.
 */

const CONTRACT = join(import.meta.dir, "..", "src", "contract");

/** Every field the generated table names, as `[camel, wire]`. */
const GENERATED: [string, string][] = Object.values(
  WIRE_SHAPES as Record<string, Record<string, { wire: string }>>,
).flatMap((shape) =>
  Object.entries(shape).map(([camel, f]): [string, string] => [camel, f.wire]),
);

/**
 * The names the canonical reads publish.
 *
 * Read off the source, because the alternative is to call every read against a
 * database this suite does not have. Scoped to the two modules the canonical
 * router's rows come from — `reads.ts` composes every `CANONICAL_READS` entry
 * and `types.ts` declares what each returns — rather than to the whole of
 * `src/contract/`, which also holds readouts served by other routes through
 * other encoders. `grid-now.ts` is the one that matters and it is asserted
 * separately below, because it carries a divergent field *and* must never
 * reach this serialiser.
 */
const CANONICAL_SOURCES = ["reads.ts", "types.ts"];

function canonicalFieldNames(): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(CONTRACT)) {
    if (!CANONICAL_SOURCES.includes(entry)) {
      continue;
    }
    const source = readFileSync(join(CONTRACT, entry), "utf8");
    // A property key in an object literal or an interface is what `toWire`
    // will be handed. Over-collecting is safe: every extra name only makes the
    // agreement assertion below stricter.
    for (const match of source.matchAll(/^\s{2,}([a-z][A-Za-z0-9]*)\s*[:?]/gm)) {
      names.add(match[1] as string);
    }
  }
  return names;
}

describe("the two translators disagree only where nothing travels", () => {
  it("the generated table was read, so an empty disagreement means something", () => {
    // The walk-read-anything guard. A `WIRE_SHAPES` that failed to import
    // would make every assertion below pass over nothing.
    expect(GENERATED.length).toBeGreaterThan(400);
  });

  it("the disagreement is exactly the digit boundary, and it is five fields", () => {
    // Named rather than counted, so a sixth is a failure with a name on it
    // rather than a number that moved. If the schema is changed to spell one
    // of these the way `snakeKey` would, the right response is to delete it
    // from this list — not to widen it.
    const disagree = GENERATED.filter(([camel, wire]) => snakeKey(camel) !== wire).map(
      ([camel]) => camel,
    );
    expect([...new Set(disagree)].sort()).toEqual([
      "last24hConstrainedOffMwh",
      "pinball10",
      "pinball50",
      "pinball90",
    ]);
    for (const camel of disagree) {
      // Every one of them is a digit run the rule cannot put a boundary back
      // into, which is the core header's argument stated as a test.
      expect(camel).toMatch(/\d/);
    }
  });

  it("no field the canonical layer publishes is one of them", () => {
    // The property that makes the second translator safe. `/v1/canonical/*` is
    // the only caller of `toWire`, so a canonical read that started returning
    // one of these names would publish a key the Python side decodes into
    // nothing — silently, because the contract schemas do not describe these
    // rows and no validator is watching.
    const published = canonicalFieldNames();
    expect(published.size).toBeGreaterThan(50);
    const clashes = GENERATED.filter(
      ([camel, wire]) => snakeKey(camel) !== wire && published.has(camel),
    ).map(([camel]) => camel);
    expect(clashes).toEqual([]);
  });

  it("the digit fields the canonical layer DOES publish are spelled the schema's way", () => {
    // Non-vacuity for the test above: the weather read is full of digit
    // boundaries — `windSpeed120mKmh`, `temperature2mC` — and they agree,
    // which is why the rule is "insert `_` before an upper-case letter" and
    // not "give up on digits". The check is worth something because these
    // exist and pass it.
    const published = canonicalFieldNames();
    const withDigits = [...published].filter((name) => /\d/.test(name));
    expect(withDigits.length).toBeGreaterThan(3);
    for (const name of withDigits) {
      const generated = GENERATED.find(([camel]) => camel === name);
      if (generated) {
        expect({ name, wire: snakeKey(name) }).toEqual({ name, wire: generated[1] });
      }
    }
  });
});

describe("the one readout carrying a divergent field never reaches this serialiser", () => {
  it("`last24hConstrainedOffMwh` lives in grid-now, and grid-now is encoded by the table", () => {
    /*
      The live hazard, pinned. `src/api/grid.ts` says in its header that it
      builds its body through `@wattsteer/core`'s generated encoder "not by
      this file, and not by `contract/wire.ts`", precisely because the rule is
      lossy on the field this payload leads with. That is an argument in a
      comment; this is the same argument as a failing test if the route is ever
      rewired.
    */
    const gridNow = readFileSync(join(CONTRACT, "grid-now.ts"), "utf8");
    expect(gridNow).toContain("last24hConstrainedOffMwh");
    // Asserted on the import rather than on the word: `grid.ts`'s own header
    // names `contract/wire.ts` in prose, to explain why it does not use it.
    // `toWire` has exactly one caller, which is the whole statement rather
    // than a sample of it.
    const callers = readdirSync(join(import.meta.dir, "..", "src", "api"))
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) =>
        readFileSync(join(import.meta.dir, "..", "src", "api", entry), "utf8").includes(
          "contract/wire.js",
        ),
      );
    expect(callers).toEqual(["canonical.ts"]);
  });
});

describe("what the canonical serialiser converts, and what it leaves alone", () => {
  it("a Date becomes one ISO-8601 instant, so Python parses one format", () => {
    expect(toWire(new Date("2026-09-14T03:10:00.000Z"))).toBe("2026-09-14T03:10:00.000Z");
  });

  it("null stays null — an absence is never a zero", () => {
    expect(toWire({ bandUnavailableReason: null })).toEqual({
      band_unavailable_reason: null,
    });
  });

  it("it renames keys and never touches values", () => {
    // A value that looks like a key is still a value. `attribution` is keyed by
    // source identifier, and a serialiser that snake-cased its keys would be
    // rewriting data rather than field names.
    expect(toWire({ vintageFidelity: "revisionOptimistic" })).toEqual({
      vintage_fidelity: "revisionOptimistic",
    });
  });
});

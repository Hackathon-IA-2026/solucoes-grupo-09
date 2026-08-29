import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { toCamelKey } from "../src/casing.js";
import { readSchemas } from "../src/schema.js";
import { WIRE_SHAPES, type WireShapeName } from "../src/types.generated.js";
import { decodeWire, encodeWire } from "../src/wire.js";

/**
 * The wire converts to the app's casing in **exactly one place**, and this is
 * the grep that says so.
 *
 * `docs/specs/api-surface.md` is explicit: not in each screen, not in a fetch
 * wrapper per feature, not in the gateway. The reason is not tidiness. Four
 * conversion sites are four opinions about what `last_24h_constrained_off_mwh`
 * is called, and the moment two of them disagree a chart renders `undefined`
 * with nothing failing anywhere.
 *
 * A repository-level test rather than a module test, in the family of
 * `test/repo-hygiene.test.ts`: every other test here runs against code that
 * exists, and this one asserts a property of the repository, so a future
 * session adding a screen cannot quietly bring a second translator with it.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * The two modules allowed to know the convention, and why there are two.
 *
 * `src/casing.ts` holds the convention as one function; `src/wire.ts` holds the
 * generated table and does the renaming. They are separate only because the
 * generator has to build the table without importing its own output — see the
 * comment at the top of `casing.ts`. The generator is allowed for the same
 * reason.
 */
const SANCTIONED = new Set([
  join("packages", "core", "src", "casing.ts"),
  join("packages", "core", "src", "wire.ts"),
  join("packages", "core", "src", "types.generated.ts"),
  join("packages", "core", "scripts", "generate-types.ts"),
  join("packages", "core", "test", "one-translator.test.ts"),
  // Not a translator: it turns a Postgres view name into the Drizzle binding
  // identifier that declares it, inside a test that asserts the two agree.
  // No field on any wire passes through it.
  join("apps", "api", "test", "contract.test.ts"),
]);

/**
 * What a second translator looks like in source.
 *
 * Deliberately broad: it catches the one-line regex people reach for, the
 * hand-rolled helper, and a lodash-style import. It cannot catch a translator
 * written some entirely novel way, which is the honest limit of a grep — the
 * generated table is what makes writing one pointless, and this test is what
 * makes writing one visible.
 */
const PATTERNS: [RegExp, string][] = [
  [/replace\(\s*\/_\(\[a-z\]\)/, "a snake→camel regular expression"],
  [/replace\(\s*\/\[A-Z\]\/g/, "a camel→snake regular expression"],
  [
    /\b(toCamelCase|snakeToCamel|camelToSnake|camelize|decamelize|snakeCase|camelCase)\s*\(/,
    "a casing helper",
  ],
  [/from\s+["']camelcase-keys["']/, "a casing package"],
];

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".expo",
  "reference",
  "test-results",
  "playwright-report",
  ".scratch",
  ".wayfinder",
]);

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe("exactly one module translates between the wire and the app", () => {
  test("no unsanctioned file converts a key's casing", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const path = relative(ROOT, file);
      if (SANCTIONED.has(path)) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      for (const [pattern, what] of PATTERNS) {
        if (pattern.test(source)) {
          offenders.push(`${path.split(sep).join("/")}: ${what}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the one that does is the one that ships the table", () => {
    // A guard on the guard: if `wire.ts` stopped doing the renaming the test
    // above would pass vacuously.
    const source = readFileSync(join(ROOT, "packages", "core", "src", "wire.ts"), "utf8");
    expect(source).toContain("WIRE_SHAPES");
    expect(source).toContain("decodeWire");
    expect(source).toContain("encodeWire");
  });
});

describe("the generated table is the schema's field names, spelled the one way", () => {
  test("every wire name in the table came from a schema property", () => {
    const declared = new Set<string>();
    for (const schema of readSchemas().values()) {
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (typeof node !== "object" || node === null) {
          return;
        }
        const record = node as Record<string, unknown>;
        const properties = record.properties as Record<string, unknown> | undefined;
        for (const key of Object.keys(properties ?? {})) {
          declared.add(key);
        }
        Object.values(record).forEach(walk);
      };
      walk(schema);
    }
    const invented: string[] = [];
    for (const [name, shape] of Object.entries(WIRE_SHAPES)) {
      for (const field of Object.values(shape)) {
        if (!declared.has(field.wire)) {
          invented.push(`${name}.${field.wire}`);
        }
      }
    }
    expect(invented).toEqual([]);
  });

  test("every camel name in the table is the convention applied to its wire name", () => {
    const wrong: string[] = [];
    for (const [name, shape] of Object.entries(WIRE_SHAPES)) {
      for (const [camel, field] of Object.entries(shape)) {
        if (toCamelKey(field.wire) !== camel) {
          wrong.push(`${name}.${field.wire} → ${camel}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("the convention keeps a digit attached to the segment it was written with", () => {
    // The reason the table is generated rather than computed at runtime: this
    // mapping is not invertible, so the reverse direction has to be a lookup.
    expect(toCamelKey("last_24h_constrained_off_mwh")).toBe("last24hConstrainedOffMwh");
    expect(toCamelKey("p10")).toBe("p10");
    expect(toCamelKey("v")).toBe("v");
    expect(toCamelKey("as_of")).toBe("asOf");
  });
});

describe("the codec round-trips every checked-in example", () => {
  const cases: [WireShapeName, string][] = [
    ["Meta", "01-meta.json"],
    ["GridOutlook", "02-grid-outlook.json"],
    ["GridNow", "03-grid-now.json"],
    ["ForecastDayAhead", "04-forecast-day-ahead.json"],
    ["DiagnosisDayAhead", "05-diagnosis-day-ahead.json"],
    ["ErrorEnvelope", "06-error-envelope.json"],
    ["Scenario", "10-scenario.json"],
    ["OptimizationResult", "11-optimization-result.json"],
    ["Replay", "12-replay.json"],
  ];

  for (const [shape, file] of cases) {
    test(`${file} survives decode then encode unchanged`, () => {
      const wire = JSON.parse(
        readFileSync(
          join(import.meta.dir, "..", "fixtures", "spec-examples", file),
          "utf8",
        ),
      ) as unknown;
      const app = decodeWire(shape, wire);
      // Round-tripping is the property a `POST` body depends on. If it does not
      // hold, a scenario re-encoded from the app's own state hashes to a
      // different cache key and the cache silently never hits.
      expect(encodeWire(shape, app)).toEqual(wire);
    });
  }

  test("decoding actually renames, rather than passing the body through", () => {
    const wire = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "fixtures", "spec-examples", "03-grid-now.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const app = decodeWire("GridNow", wire) as Record<string, unknown>;
    expect(app.asOf).toBe(wire.as_of as string);
    expect(app.as_of).toBeUndefined();
    const first = (app.subsystems as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    expect(first.last24hConstrainedOffMwh).toBeGreaterThan(0);
    expect(first.onsDisplayName).toBe("NORDESTE");
  });

  test("a map whose keys are data is not renamed", () => {
    // `/v1/meta`'s attribution block and `error.details` are dictionaries. A
    // codec that camel-cased their keys would rewrite values, not field names.
    const wire = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "fixtures", "spec-examples", "01-meta.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const app = decodeWire("Meta", wire) as Record<string, unknown>;
    expect(Object.keys(app.attribution as object)).toEqual([
      "ons",
      "aneel_siga",
      "open_meteo",
    ]);
  });
});

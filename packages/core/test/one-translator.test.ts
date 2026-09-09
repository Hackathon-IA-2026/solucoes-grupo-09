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

  test("the walk read the repository, so the empty offender list means something", () => {
    // The other half of the same worry, and the one that was missing: the test
    // above pins that `wire.ts` still translates, but nothing pinned that the
    // *scan* still reads anything. Measured: narrowing the extension filter to
    // a suffix no file carries left all 21 tests in this file green, with the
    // offender list empty because there was nothing to look at.
    const files = sourceFiles(ROOT).map((file) => relative(ROOT, file));
    expect(files.length).toBeGreaterThan(200);
    // The sanctioned module has to be among what was read, or the exemption
    // above is excusing a file the walk never reaches.
    for (const path of SANCTIONED) {
      expect(files.map((file) => file.split(sep).join("/"))).toContain(path);
    }
    // And the three trees a second translator would most likely appear in.
    for (const tree of [
      join("apps", "web", "src"),
      join("apps", "api", "src"),
      join("packages", "core", "src"),
    ]) {
      expect({
        tree,
        reached: files.some((file) => file.startsWith(tree + sep)),
      }).toEqual({ tree, reached: true });
    }
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

/**
 * The half of "a map is data" that was wrong, and is the reason this block
 * exists.
 *
 * A map's **keys** are data. Its **values** are objects like any other, and
 * `derivative_database` is as much a field name as `as_of` is. The codec used
 * to carry the whole map through unrenamed, and the defect was invisible by
 * construction: `attribution` is `additionalProperties`-typed, so
 * `{"derivativeDatabase": true}` validated against the schema exactly as
 * `{"derivative_database": true}` did. Nothing failed; the wire was simply
 * wrong.
 *
 * So these assert on a **multi-word field name specifically**. A test written
 * over `name`, `licence` and `url` — the three fields the block was once
 * narrowed to — passes whether the fix is present or not, which is precisely
 * how the defect survived being tested for a whole ticket.
 */
describe("a map's values are renamed even though its keys are not", () => {
  const APP = {
    name: "ANEEL SIGA",
    licence: "ODbL-1.0",
    url: "https://dadosabertos.aneel.gov.br/",
    derivativeDatabase: true,
    machineReadableAt: "/v1/plants",
  };
  const WIRE = {
    name: "ANEEL SIGA",
    licence: "ODbL-1.0",
    url: "https://dadosabertos.aneel.gov.br/",
    derivative_database: true,
    machine_readable_at: "/v1/plants",
  };

  test("encoding renames a multi-word field inside a map value", () => {
    const encoded = encodeWire("Meta", { attribution: { aneel_siga: APP } }) as {
      attribution: Record<string, Record<string, unknown>>;
    };
    expect(encoded.attribution.aneel_siga).toEqual(WIRE);
    // The key is data and survives: `aneelSiga` would be a renamed *value*.
    expect(Object.keys(encoded.attribution)).toEqual(["aneel_siga"]);
    // Stated separately from the `toEqual` above, because this is the exact key
    // that used to reach the wire in the wrong casing and validate anyway.
    expect(encoded.attribution.aneel_siga?.derivative_database).toBe(true);
    expect(encoded.attribution.aneel_siga?.derivativeDatabase).toBeUndefined();
  });

  test("decoding renames it back, on both endpoints that carry the block", () => {
    for (const shape of ["Meta", "PlantRegistry"] as const) {
      const decoded = decodeWire(shape, { attribution: { aneel_siga: WIRE } }) as {
        attribution: Record<string, Record<string, unknown>>;
      };
      expect(decoded.attribution.aneel_siga).toEqual(APP);
      expect(decoded.attribution.aneel_siga?.derivative_database).toBeUndefined();
    }
  });

  test("the round trip is exact, which is what the map branch has to preserve", () => {
    const app = decodeWire("Meta", { attribution: { ons: WIRE } });
    expect(encodeWire("Meta", app)).toEqual({ attribution: { ons: WIRE } });
  });

  test("a map whose values are scalars is still carried through whole", () => {
    // `error.details` — the distinction the map branch has to keep making. Its
    // values have no shape to recurse into, so a key that happens to look like
    // a field name is still data and is not touched.
    const details = { field_path: "assets[0].max_shift_mw", limit_mw: 50 };
    const encoded = encodeWire("ErrorEnvelope", {
      error: { code: "SHIFT_EXCEEDS_CONNECTION", message: "no", details },
    }) as { error: { details: Record<string, unknown> } };
    expect(encoded.error.details).toEqual(details);
  });

  test("the table says which fields are maps, and only those", () => {
    // A guard on the mechanism rather than on one payload: the generator marks
    // a map value's shape, and the two attribution blocks are the only maps in
    // the whole contract whose values have one. A third appearing here is a
    // field worth a second look, not a failure to route around.
    const maps: string[] = [];
    for (const [name, shape] of Object.entries(WIRE_SHAPES)) {
      for (const [camel, field] of Object.entries(shape)) {
        if (field.map === true) {
          maps.push(`${name}.${camel} -> ${field.shape}`);
        }
      }
    }
    expect(maps.sort()).toEqual([
      "Meta.attribution -> SourceAttribution",
      "PlantRegistry.attribution -> SourceAttribution",
    ]);
  });
});

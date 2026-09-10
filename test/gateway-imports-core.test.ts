import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core/constants";
import { TECHNOLOGIES } from "@wattsteer/core/domain";

/**
 * The gateway holds no second opinion about the vocabulary.
 *
 * `api-surface 03` promoted `Subsystem` and `Technology` into
 * `packages/core/src/domain.ts` and left the gateway's copies in place, because
 * `apps/api` had no dependency on `@wattsteer/core` and its Dockerfile copied
 * only `apps/api/src` — a naive import would have type-checked on a laptop and
 * killed the container on first request. `api-surface 04` added the dependency
 * and the `COPY packages/core/src` line; this file is what stops both halves
 * regressing, because *each half alone is silent*:
 *
 *  - Drop the import and restate the enum, and every check stays green while
 *    the four codes drift from the wire the web app and Python agree on.
 *  - Drop the `COPY`, and `typecheck`, `lint` and 1,743 tests stay green while
 *    the image dies on `Cannot find module "@wattsteer/core/domain"`.
 *
 * The first is asserted by scanning the source for a *definition* of either
 * vocabulary, not for a use of it: `row.technology === "WIND"` is a comparison
 * against the published value and is fine; `type T = "WIND" | "SOLAR"` is a
 * second definition and is not.
 */
const ROOT = join(import.meta.dir, "..");
const API_SRC = join(ROOT, "apps/api/src");

/**
 * The restatements that are allowed, each with the reason it is not a drift
 * risk. Keyed by path so a *new* one in the same file is still caught.
 *
 * **api-surface 28 removed the interesting one.** Both entries used to be here
 * because they needed the vocabulary in the `SubsystemCode` union's declaration
 * order, `N, NE, S, SE`, while the only published array was
 * `SUBSYSTEM_DISPLAY_ORDER`'s north-to-south `N, NE, SE, S`. That order now has
 * a name of its own — `SUBSYSTEM_DECLARATION_ORDER` in
 * `@wattsteer/core/domain` — so both the `subsystem_code` `pgEnum` and
 * `interchange.ts`'s `SUBSYSTEM_ORDER` read it instead of spelling it out, and
 * `test/subsystem-order.test.ts` pins it to the union, to the `CREATE TYPE`
 * that created the Postgres enum, and to who may import it.
 *
 * What is left is the **`technology`** `pgEnum` alone. `TECHNOLOGIES` is typed
 * `readonly Technology[]` and `pgEnum` wants a `[T, ...T[]]` tuple; narrowing
 * `TECHNOLOGIES` to a tuple to suit the schema breaks `.includes()` at its
 * other call sites. A two-member vocabulary whose single order already matches
 * its migration has no conflation hazard to fix, so this stays literal rather
 * than being paid for with a type change elsewhere.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "database/schema.ts":
    "the technology pgEnum only; TECHNOLOGIES is not a tuple and pgEnum needs one. The subsystem_code enum is derived from SUBSYSTEM_DECLARATION_ORDER and pinned by test/subsystem-order.test.ts",
};

/** Every `.ts` file under `apps/api/src`, as repo-relative-ish paths. */
function apiSources(): string[] {
  const glob = new Bun.Glob("**/*.ts");
  return [...glob.scanSync({ cwd: API_SRC })].sort();
}

/**
 * A definition-shaped restatement: a literal union or a literal array that
 * enumerates the whole of one closed vocabulary.
 */
function restatements(text: string): string[] {
  const hits: string[] = [];
  // The negative lookahead is what keeps `WeightBasis = "WIND" | "SOLAR" |
  // "VRE"` out of this: a union with a third member is a different type that
  // happens to name these two, not a restatement of the two-member enum.
  const technologyUnion = /"(?:WIND|SOLAR)"\s*\|\s*"(?:WIND|SOLAR)"(?!\s*\|\s*")/g;
  const technologyArray = /\[\s*"(?:WIND|SOLAR)"\s*,\s*"(?:WIND|SOLAR)"\s*\]/g;
  const subsystemUnion = /"(?:N|NE|S|SE)"(?:\s*\|\s*"(?:N|NE|S|SE)"){3}/g;
  const subsystemArray = /\[\s*"(?:N|NE|S|SE)"(?:\s*,\s*"(?:N|NE|S|SE)"){3}\s*\]/g;
  for (const pattern of [
    technologyUnion,
    technologyArray,
    subsystemUnion,
    subsystemArray,
  ]) {
    for (const match of text.matchAll(pattern)) {
      hits.push(match[0]);
    }
  }
  return hits;
}

describe("the gateway imports the vocabulary rather than restating it", () => {
  it("scanned a real tree, so a clean result means something", () => {
    const files = apiSources();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("ingest/normalise.ts");
    expect(files).toContain("api/canonical.ts");
    expect(files).toContain("ingest/types.ts");
  });

  it("defines neither closed vocabulary a second time", () => {
    const offenders: string[] = [];
    for (const file of apiSources()) {
      if (file in ALLOWED) {
        continue;
      }
      const hits = restatements(readFileSync(join(API_SRC, file), "utf8"));
      for (const hit of hits) {
        offenders.push(`apps/api/src/${file}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("can fail: the pattern catches a restatement in either vocabulary", () => {
    expect(restatements('export type T = "WIND" | "SOLAR";')).not.toEqual([]);
    expect(restatements('const T = ["SOLAR", "WIND"];')).not.toEqual([]);
    expect(restatements('type S = "N" | "NE" | "S" | "SE";')).not.toEqual([]);
    expect(restatements('new Set(["N", "NE", "S", "SE"])')).not.toEqual([]);
    // The exact line api-surface 10 wrote into `jobs/diagnosis-publication.ts`
    // on 2026-09-09, in declaration order, by an agent that did not know there
    // were two orders. `c8e0063` substituted the published constant after this
    // guard caught it on the merge; it is kept here as the regression case.
    expect(
      restatements(
        'const SUBSYSTEMS: readonly SubsystemCode[] = ["N", "NE", "S", "SE"];',
      ),
    ).not.toEqual([]);
    // And the same line in the *other* order, which is the shape a reader who
    // copied the display order would produce.
    expect(
      restatements(
        'const SUBSYSTEMS: readonly SubsystemCode[] = ["N", "NE", "SE", "S"];',
      ),
    ).not.toEqual([]);
    // And does not fire on a *use* of a published value.
    expect(restatements('row.technology === "WIND" ? a : b')).toEqual([]);
    expect(restatements('if (code === "SE") return null;')).toEqual([]);
    // A three-member union that merely names both is a different type.
    expect(restatements('type WeightBasis = "WIND" | "SOLAR" | "VRE";')).toEqual([]);
  });

  it("reads the four codes and the two technologies through the package", () => {
    // The import at the top of this file is the assertion; these pin the
    // contents so a silent emptying of either export is caught here too.
    expect([...SUBSYSTEM_DISPLAY_ORDER].sort()).toEqual(["N", "NE", "S", "SE"]);
    expect(SUBSYSTEM_DISPLAY_ORDER).not.toContain("SIN");
    expect([...TECHNOLOGIES]).toEqual(["WIND", "SOLAR"]);
  });

  it("the two files the ticket named take their definitions from core", () => {
    const canonical = readFileSync(join(API_SRC, "api/canonical.ts"), "utf8");
    expect(canonical).toContain('from "@wattsteer/core/constants"');
    expect(canonical).toContain('from "@wattsteer/core/domain"');
    const ingestTypes = readFileSync(join(API_SRC, "ingest/types.ts"), "utf8");
    expect(ingestTypes).toContain('from "@wattsteer/core/domain"');
    // And the module every ONS adapter learns the vocabulary from.
    const normalise = readFileSync(join(API_SRC, "ingest/normalise.ts"), "utf8");
    expect(normalise).toContain('from "@wattsteer/core/domain"');
    expect(normalise).toContain('from "@wattsteer/core/constants"');
  });

  it("and so do the two that used to be allowed to restate it", () => {
    // api-surface 28. Both now read `SUBSYSTEM_DECLARATION_ORDER`; only the
    // technology enum in `schema.ts` is still spelled out, which is why that
    // one path keeps its allow-list entry.
    const schema = readFileSync(join(API_SRC, "database/schema.ts"), "utf8");
    expect(schema).toContain(
      'pgEnum("subsystem_code", [...SUBSYSTEM_DECLARATION_ORDER])',
    );
    // …and not a literal list of codes in its place.
    expect(schema).not.toMatch(/pgEnum\("subsystem_code",\s*\[\s*"/);
    const interchange = readFileSync(join(API_SRC, "ingest/ons/interchange.ts"), "utf8");
    expect(interchange).toContain(
      "const SUBSYSTEM_ORDER: readonly SubsystemCode[] = SUBSYSTEM_DECLARATION_ORDER;",
    );
  });
});

describe("the container has what those imports need", () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "apps/api/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };

  it("declares the workspace dependency", () => {
    expect(manifest.dependencies?.["@wattsteer/core"]).toBe("workspace:*");
  });

  it("copies the shared package's source into the image", () => {
    const dockerfile = join(ROOT, "apps/api/Dockerfile");
    expect(existsSync(dockerfile)).toBe(true);
    const text = readFileSync(dockerfile, "utf8");
    // The manifest alone installs a workspace link pointing at nothing.
    expect(text).toMatch(/COPY\s+packages\/core\/package\.json/);
    expect(text).toMatch(/COPY\s+packages\/core\/src/);
  });

  it("every core subpath the gateway imports resolves under packages/core/src", () => {
    // `@wattsteer/core/schema/*` maps to `packages/core/schema`, which the
    // image does *not* copy. Nothing in the gateway may start importing it
    // without the Dockerfile learning about it — this is that tripwire.
    const offenders: string[] = [];
    for (const file of apiSources()) {
      const text = readFileSync(join(API_SRC, file), "utf8");
      for (const match of text.matchAll(/from "(@wattsteer\/core[^"]*)"/g)) {
        const specifier = match[1] as string;
        if (specifier.startsWith("@wattsteer/core/schema")) {
          offenders.push(`apps/api/src/${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

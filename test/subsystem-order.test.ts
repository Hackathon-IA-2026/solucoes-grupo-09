import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core/constants";
import { SUBSYSTEM_DECLARATION_ORDER } from "@wattsteer/core/domain";
import { subsystemCode } from "../apps/api/src/database/schema.js";

/**
 * One subsystem vocabulary, two orders, and neither may be mistaken for the
 * other.
 *
 *  - `SUBSYSTEM_DISPLAY_ORDER` is `N, NE, SE, S` — north to south, what the
 *    screens render and `GET /v1/meta` reports.
 *  - `SUBSYSTEM_DECLARATION_ORDER` is `N, NE, S, SE` — the textual order of the
 *    `SubsystemCode` union, which is also the order the `subsystem_code`
 *    Postgres type was created in and the basis the interchange adapter
 *    orients links against.
 *
 * They differ at index 2, on `S` and `SE`, and *two production behaviours turn
 * on that one swap*:
 *
 *  1. `drizzle-kit generate` diffs `pgEnum`'s values against the migration
 *     snapshot. Display order there emits a spurious enum migration — measured:
 *     `0043_new_hannibal_king.sql`, with `apps/api/test/drizzle-snapshot.test.ts`
 *     red.
 *  2. `ingest/ons/interchange.ts` states every subsystem exchange row from the
 *     earlier member of the basis to the later one, carrying the direction of
 *     the flow in the **sign**. Display order reverses every `S`↔`SE` link and
 *     negates a stored column. `apps/api/test/ons-interchange.test.ts` §"the
 *     orientation basis is declaration order" asserts that case on a single row.
 *
 * Until api-surface 28 only *one* of the orders had a name — the other existed
 * as two literals and a sentence in a test comment — and that is how it went
 * wrong: `c8e0063` records `jobs/diagnosis-publication.ts` being written the
 * same morning as `["N", "NE", "S", "SE"]` by an agent that did not know there
 * were two, harmless only because its consumer returns a keyed record.
 *
 * Everything below either pins one order to something outside TypeScript that
 * already committed to it, or asserts the two cannot be conflated. Per
 * api-surface 25, every scan and every parser here asserts its own input is
 * non-empty: a parser that silently matched nothing would satisfy every
 * equality in this file by comparing `[]` with `[]`.
 */
const ROOT = join(import.meta.dir, "..");

/** The four codes, sorted, so a set comparison never depends on an order. */
const FOUR = ["N", "NE", "S", "SE"];

/**
 * The members of a `SubsystemCode`-shaped literal union, in the order written.
 *
 * Parsed rather than imported because TypeScript gives a union no runtime
 * order, which is the whole reason `SUBSYSTEM_DECLARATION_ORDER` has to be a
 * literal at all. This is what stops the literal and the type it claims to
 * mirror drifting apart.
 */
export function unionMembers(source: string, typeName: string): string[] {
  const declaration = new RegExp(`export type ${typeName}\\s*=\\s*([^;]+);`).exec(source);
  if (declaration === null) {
    return [];
  }
  return [...(declaration[1] as string).matchAll(/"([A-Z]+)"/g)].map(
    (match) => match[1] as string,
  );
}

/** The values of one `CREATE TYPE ... AS ENUM(...)`, in the order created. */
export function enumValuesFromSql(sql: string, typeName: string): string[] {
  const statement = new RegExp(
    `CREATE TYPE "public"\\."${typeName}" AS ENUM\\(([^)]*)\\)`,
  ).exec(sql);
  if (statement === null) {
    return [];
  }
  return [...(statement[1] as string).matchAll(/'([^']+)'/g)].map(
    (match) => match[1] as string,
  );
}

/**
 * Who is allowed to import the orientation basis, and why.
 *
 * The point of the allow-list is not that these two are special: it is that
 * reaching for the declaration order is almost always a mistake, and the
 * failure mode is silent. A new site that needs to render, validate or iterate
 * the four wants `SUBSYSTEM_DISPLAY_ORDER`; only code answering to an order
 * fixed outside TypeScript belongs here.
 */
const MAY_IMPORT_DECLARATION_ORDER: Readonly<Record<string, string>> = {
  "apps/api/src/database/schema.ts":
    "the subsystem_code pgEnum; drizzle-kit diffs its values against the migration that created the Postgres type",
  "apps/api/src/ingest/ons/interchange.ts":
    "SUBSYSTEM_ORDER, the link orientation basis; display order would reverse every S↔SE row and negate its sign",
};

/** Every `.ts`/`.tsx` file under the three source trees, repo-relative. */
function sources(): string[] {
  const found: string[] = [];
  for (const tree of ["packages/core/src", "apps/api/src", "apps/web/src"]) {
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    for (const file of glob.scanSync({ cwd: join(ROOT, tree) })) {
      found.push(`${tree}/${file}`);
    }
  }
  return found.sort();
}

describe("the two subsystem orders are distinct and stay that way", () => {
  it("both are the whole enum, and neither is empty", () => {
    expect([...SUBSYSTEM_DISPLAY_ORDER]).toHaveLength(4);
    expect([...SUBSYSTEM_DECLARATION_ORDER]).toHaveLength(4);
    expect([...SUBSYSTEM_DISPLAY_ORDER].sort()).toEqual(FOUR);
    expect([...SUBSYSTEM_DECLARATION_ORDER].sort()).toEqual(FOUR);
    expect(SUBSYSTEM_DISPLAY_ORDER).not.toContain("SIN");
    expect(SUBSYSTEM_DECLARATION_ORDER).not.toContain("SIN");
  });

  it("are not the same sequence — collapsing one into the other fails here", () => {
    // The guard against the conflation itself: re-deriving the declaration
    // order from `SUBSYSTEMS`, or aliasing either to the other, lands here.
    expect([...SUBSYSTEM_DECLARATION_ORDER]).not.toEqual([...SUBSYSTEM_DISPLAY_ORDER]);
    expect([...SUBSYSTEM_DISPLAY_ORDER]).toEqual(["N", "NE", "SE", "S"]);
    expect([...SUBSYSTEM_DECLARATION_ORDER]).toEqual(["N", "NE", "S", "SE"]);
  });

  it("disagree on exactly the S/SE pair, which is the whole hazard", () => {
    const display = [...SUBSYSTEM_DISPLAY_ORDER];
    const declaration = [...SUBSYSTEM_DECLARATION_ORDER];
    const differing = declaration
      .map((code, index) => (code === display[index] ? null : code))
      .filter((code): code is string => code !== null);
    expect(differing.sort()).toEqual(["S", "SE"]);
    // And they disagree in the direction the interchange basis depends on.
    expect(declaration.indexOf("S")).toBeLessThan(declaration.indexOf("SE"));
    expect(display.indexOf("SE")).toBeLessThan(display.indexOf("S"));
  });

  it("the ambiguous name SUBSYSTEM_CODES is not reintroduced in TypeScript", () => {
    // It was the defect: a name reading like "the four codes" that was in fact
    // one of two orderings of them. Python keeps the name for its own display
    // order and is not scanned here.
    const offenders = sources().filter((file) => {
      const text = readFileSync(join(ROOT, file), "utf8");
      return /\bSUBSYSTEM_CODES\b/.test(text.replace(/`SUBSYSTEM_CODES`/g, ""));
    });
    expect(offenders).toEqual([]);
  });
});

describe("the declaration order is pinned to what already committed to it", () => {
  const domainSource = readFileSync(join(ROOT, "packages/core/src/domain.ts"), "utf8");
  const baseline = readFileSync(
    join(ROOT, "apps/api/drizzle/0000_hot_dakota_north.sql"),
    "utf8",
  );

  it("equals the SubsystemCode union's own textual order", () => {
    const members = unionMembers(domainSource, "SubsystemCode");
    // Non-vacuity: a regex that stopped matching would otherwise make the
    // equality below trivially true against an empty declaration order.
    expect(members).toHaveLength(4);
    expect(members).toEqual([...SUBSYSTEM_DECLARATION_ORDER]);
  });

  it("equals the CREATE TYPE that created the Postgres enum", () => {
    const created = enumValuesFromSql(baseline, "subsystem_code");
    expect(created).toHaveLength(4);
    expect(created).toEqual([...SUBSYSTEM_DECLARATION_ORDER]);
  });

  it("equals the pgEnum drizzle actually holds", () => {
    // `subsystemCode.enumValues` is what `drizzle-kit generate` diffs against
    // the snapshot. Reordering it emits a migration nobody asked for;
    // `apps/api/test/drizzle-snapshot.test.ts` is the other half of this and
    // catches it by generating, this half by comparing.
    expect([...subsystemCode.enumValues]).toHaveLength(4);
    expect([...subsystemCode.enumValues]).toEqual([...SUBSYSTEM_DECLARATION_ORDER]);
    expect([...subsystemCode.enumValues]).toEqual(
      enumValuesFromSql(baseline, "subsystem_code"),
    );
  });

  it("can fail: both parsers report display order when the source is in it", () => {
    // Without this, the two equalities above would be satisfied by parsers that
    // happen to return whatever the constant is. These show the parsers read
    // the *order they are given*, so the comparisons are load-bearing.
    expect(
      unionMembers('export type SubsystemCode = "N" | "NE" | "SE" | "S";', "Subsystem"),
    ).toEqual([]);
    expect(
      unionMembers(
        'export type SubsystemCode = "N" | "NE" | "SE" | "S";',
        "SubsystemCode",
      ),
    ).toEqual(["N", "NE", "SE", "S"]);
    expect(
      enumValuesFromSql(
        `CREATE TYPE "public"."subsystem_code" AS ENUM('N', 'NE', 'SE', 'S');`,
        "subsystem_code",
      ),
    ).toEqual(["N", "NE", "SE", "S"]);
    expect(enumValuesFromSql("-- nothing here", "subsystem_code")).toEqual([]);
  });
});

describe("only the code that answers to an outside order reads it", () => {
  const importers = (): string[] =>
    sources().filter((file) =>
      /\bSUBSYSTEM_DECLARATION_ORDER\b/.test(
        readFileSync(join(ROOT, file), "utf8").replace(
          /`SUBSYSTEM_DECLARATION_ORDER`/g,
          "",
        ),
      ),
    );

  it("scanned a real tree, so a clean result means something", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("apps/api/src/database/schema.ts");
    expect(files).toContain("apps/api/src/ingest/ons/interchange.ts");
    expect(files).toContain("packages/core/src/constants.ts");
  });

  it("both allow-listed files really do import it", () => {
    // Non-vacuity for the allow-list: an entry naming a file that has stopped
    // importing the constant is a stale exception, and an empty importer list
    // would make the next assertion pass while governing nothing.
    const found = importers();
    expect(found.length).toBeGreaterThan(0);
    for (const file of Object.keys(MAY_IMPORT_DECLARATION_ORDER)) {
      expect(found).toContain(file);
    }
  });

  it("nobody else does", () => {
    const offenders = importers().filter(
      (file) =>
        !(file in MAY_IMPORT_DECLARATION_ORDER) && file !== "packages/core/src/domain.ts",
    );
    expect(offenders).toEqual([]);
  });

  it("and neither of them reads the display order by mistake", () => {
    // The converse conflation: the two files above are precisely the ones for
    // which the display order is wrong, so importing it there is the defect
    // this whole ticket exists about.
    for (const file of Object.keys(MAY_IMPORT_DECLARATION_ORDER)) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const code = text
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/)/.test(line))
        .join("\n");
      expect(code).not.toContain("SUBSYSTEM_DISPLAY_ORDER");
    }
  });
});

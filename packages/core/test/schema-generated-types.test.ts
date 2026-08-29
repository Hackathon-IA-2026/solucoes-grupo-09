import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generatedSource } from "../scripts/generate-types.js";
import { ERROR_CODES, ERROR_STATUS } from "../src/errors.js";
import { readSchemas } from "../src/schema.js";
import type { WireErrorCode } from "../src/types.generated.js";

/**
 * The checked-in generated types are current, and the schema agrees with the
 * TypeScript authority it was generated against.
 *
 * Two separate claims, and they fail for different reasons:
 *
 *  1. **`src/types.generated.ts` is what `schema/` produces today.** A schema
 *     edited without regenerating leaves the web app compiling against last
 *     week's contract, which is precisely the "renamed field becomes an
 *     `undefined` on a chart" failure the generation exists to prevent. This is
 *     the CI check `docs/specs/api-surface.md` asks for, run in the default
 *     `bun test` path so it does not depend on anyone configuring CI.
 *  2. **`error.schema.json` carries exactly the codes `ERROR_STATUS` declares.**
 *     Ticket 02 built the code-to-status table in TypeScript and called it the
 *     authority. The schema restates the member list because Python has to see
 *     it, and a restatement that nothing checks is a second vocabulary. So it
 *     is checked, member for member, in both directions.
 */

describe("the checked-in generated types are current", () => {
  test("regenerating produces the file that is committed", () => {
    const committed = readFileSync(
      join(import.meta.dir, "..", "src", "types.generated.ts"),
      "utf8",
    );
    // If this fails: `bun run --cwd packages/core generate:types`, then read the
    // diff. The diff is the contract change.
    expect(generatedSource).toBe(committed);
  });

  test("every schema file contributed at least one type", () => {
    // A guard on the guard. A generator that silently skipped a file would
    // leave the assertion above passing and half the contract untyped.
    const missing: string[] = [];
    for (const file of readdirSync(join(import.meta.dir, "..", "schema"))) {
      if (!file.endsWith(".schema.json")) {
        continue;
      }
      const schema = readSchemas().get(file) as {
        title?: string;
        type?: string;
        $defs?: Record<string, { title?: string }>;
      };
      // A file's root has a type only if it *is* one — `common` and
      // `curtailment` are libraries of `$defs` and have no root shape. Either
      // way at least one name from the file has to reach the output.
      const names = [
        schema.type === undefined ? "" : (schema.title ?? ""),
        ...Object.values(schema.$defs ?? {}).map((node) => node.title ?? ""),
      ].filter((name) => name !== "");
      if (
        names.length > 0 &&
        !names.some((name) => generatedSource.includes(`${name} `))
      ) {
        missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("the error code enum has one definition and one restatement", () => {
  const errorSchema = readSchemas().get("error.schema.json") as {
    properties: { error: { properties: { code: { enum: string[] } } } };
  };
  const schemaCodes = errorSchema.properties.error.properties.code.enum;

  test("the schema names every code the TypeScript table declares", () => {
    expect([...schemaCodes].sort()).toEqual([...ERROR_CODES].sort());
  });

  test("the schema invents no code the table has never heard of", () => {
    const unknown = schemaCodes.filter((code) => !(code in ERROR_STATUS));
    expect(unknown).toEqual([]);
  });

  test("the generated wire type is the same union", () => {
    // A type-level assertion, checked by `bun run typecheck` rather than at
    // runtime: assigning every runtime code to the generated union fails to
    // compile the moment the two drift.
    const roundTrip: WireErrorCode[] = [...ERROR_CODES];
    expect(roundTrip).toHaveLength(ERROR_CODES.length);
    const sample: WireErrorCode = "MODEL_UNAVAILABLE";
    expect(ERROR_STATUS[sample]).toBe(503);
  });
});

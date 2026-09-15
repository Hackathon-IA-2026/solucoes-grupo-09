/**
 * The JSON Schema directory, loaded and made executable.
 *
 * **`schema/` is the cross-language authority.** Elysia's Eden treaty over
 * `type App` gives TypeScript-to-TypeScript parity between the gateway and the
 * web app for free, and it gives Python nothing — so the schema is the
 * contract and Eden is a convenience. Where the two disagree the schema wins,
 * and `apps/api/test/schema-treaty.test.ts` is the test that says so rather
 * than this comment.
 *
 * **This module reads files from disk at call time**, which is why nothing in
 * a request path may import it: `apps/api/Dockerfile` copies
 * `packages/core/src` and not `packages/core/schema`, so an import from a
 * route handler would pass typecheck, pass `bun test`, and die in the
 * container on the first request. `packages/core/test/schema-shape.test.ts`
 * asserts that no other module under `src/` imports it. It is for tests, for
 * the type generator, and for tooling.
 *
 * ### The one thing JSON Schema cannot say, and how it is said anyway
 *
 * `p10 <= p50 <= p90` is not expressible in JSON Schema — there is no way to
 * compare two sibling values. It is also the single most important thing about
 * a band: a band with `p10 > p50` is not a wide forecast, it is a bug, and
 * `docs/specs/api-surface.md` requires that it fail validation. So
 * `x-quantile-ordering` is registered as a keyword on **this one validator**,
 * which every side of the contract goes through. Registering it here rather
 * than checking it in each test is the same move the rest of the package
 * makes: the rule lives once, in the thing that enforces it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ajv2020,
  type AnySchemaObject,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** The directory the schema files live in. Sibling of `src/`, not inside it. */
export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "schema");

/** Every schema file, by its file name (`common.schema.json`). */
export function readSchemas(): Map<string, AnySchemaObject> {
  const schemas = new Map<string, AnySchemaObject>();
  for (const file of readdirSync(SCHEMA_DIR).sort()) {
    if (!file.endsWith(".schema.json")) {
      continue;
    }
    schemas.set(
      file,
      JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as AnySchemaObject,
    );
  }
  return schemas;
}

/** The file names, sorted. The order the generator walks them in. */
export function schemaFiles(): string[] {
  return [...readSchemas().keys()];
}

/**
 * A validator with the whole directory loaded and cross-file `$ref` resolved.
 *
 * Every `$id` is `https://wattsteer.com/schema/<file>`, and every cross-file
 * reference is written as the bare file name, so a relative `$ref` resolves
 * against the `$id` with no registry gymnastics.
 */
export function createValidator(): Ajv2020 {
  const validator = new Ajv2020({
    strict: false,
    allErrors: true,
    // The schemas describe a wire, and a wire carries what it carries. Removing
    // or defaulting values here would make the validator disagree with the
    // bytes, which is the one thing a contract must never do.
    useDefaults: false,
    removeAdditional: false,
  });
  addFormats(validator);
  validator.addKeyword({
    keyword: "x-quantile-ordering",
    type: "object",
    schemaType: "array",
    errors: false,
    compile(order: string[]) {
      return (data: Record<string, unknown>) => {
        let previous = Number.NEGATIVE_INFINITY;
        for (const key of order) {
          const value = data[key];
          if (typeof value !== "number") {
            return true; // `type`/`required` own that failure; this keyword owns ordering.
          }
          if (value < previous) {
            return false;
          }
          previous = value;
        }
        return true;
      };
    },
  });
  for (const [file, schema] of readSchemas()) {
    validator.addSchema(schema, `https://wattsteer.com/schema/${file}`);
  }
  return validator;
}

/** A JSON Pointer into the directory: `"grid-now.schema.json"` or `"common.schema.json#/$defs/band"`. */
export type SchemaRef = string;

let cachedAjv: Ajv2020 | null = null;

function ajv(): Ajv2020 {
  cachedAjv ??= createValidator();
  return cachedAjv;
}

/** The compiled validator for one schema or one `$defs` entry. */
export function validatorFor(ref: SchemaRef): ValidateFunction {
  const [file, pointer] = ref.split("#");
  const uri = `https://wattsteer.com/schema/${file}${pointer === undefined ? "" : `#${pointer}`}`;
  const found = ajv().getSchema(uri);
  if (found === undefined) {
    throw new RangeError(`No schema at ${ref}`);
  }
  return found;
}

/** The result of a validation: valid, or the errors that made it invalid. */
export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

/** Validate `value` against `ref`. Never throws for invalid data — only for an unknown `ref`. */
export function validate(ref: SchemaRef, value: unknown): ValidationResult {
  const check = validatorFor(ref);
  const valid = check(value) as boolean;
  return { valid, errors: valid ? [] : [...(check.errors ?? [])] };
}

/** One line per failure, for a test's assertion message. */
export function explain(result: ValidationResult): string {
  return result.errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

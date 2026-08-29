/**
 * The one translation between the wire and the app, and there is no second one.
 *
 * The wire is `snake_case` — forced rather than chosen. `flex-optimizer.md` and
 * `replay.md` both publish `snake_case` contracts and declare them fixed, the
 * modelling service is Python, and the database columns are `snake_case`. The
 * web app speaks `camelCase`. Something converts, and the only question was
 * where.
 *
 * **It converts here.** Not in each screen, not in a fetch wrapper per feature,
 * not in the gateway. `packages/core/test/one-translator.test.ts` is a
 * grep-level assertion over the whole repository that this file is the only
 * one that renames a field between the two casings; adding a second is a
 * failing test rather than a code review someone has to catch.
 *
 * ### Why a generated table and not a regular expression
 *
 * The obvious implementation is `key.replace(/_([a-z])/g, …)` applied to every
 * key of every response. It is one line, it is *nearly* right, and it is
 * exactly the shape of bug this package exists to prevent: it is not
 * invertible. `last_24h_constrained_off_mwh` camel-cases to
 * `last24hConstrainedOffMwh`, and no rule takes that back to the original —
 * the digit boundary is lost. A `POST` body built by the reverse of a lossy
 * function is a request the server silently misreads.
 *
 * So the mapping is a **table generated from the JSON Schema**
 * (`scripts/generate-types.ts` → `src/types.generated.ts`), pairing each wire
 * name with the camel name the generated interface declares. Renaming a field
 * in the schema regenerates the table and breaks the compile in the web app,
 * which is the property `docs/specs/api-surface.md` asks for in as many words:
 * "a field renamed in the API breaks a compile rather than a screen".
 *
 * The convention itself — one function, `toCamelKey` — lives in `src/casing.ts`
 * so that the generator can build the table without importing its own output.
 * It is re-exported here, and nothing at runtime calls it.
 */

import { toCamelKey } from "./casing.js";
import type { WireField, WireShape } from "./types.generated.js";
import { WIRE_SHAPES, type WireShapeName } from "./types.generated.js";

export type { WireField, WireShape, WireShapeName };
export { toCamelKey };

/** The shape descriptor for a generated type, by name. */
export function shapeOf(name: WireShapeName): WireShape {
  return WIRE_SHAPES[name];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function convert(
  shape: WireShape,
  value: unknown,
  direction: "decode" | "encode",
): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  const byIncoming = new Map<string, [string, WireField]>();
  for (const [camel, field] of Object.entries(shape)) {
    byIncoming.set(direction === "decode" ? field.wire : camel, [
      direction === "decode" ? camel : field.wire,
      field,
    ]);
  }
  for (const [key, raw] of Object.entries(value)) {
    const known = byIncoming.get(key);
    if (known === undefined) {
      // A key the schema does not name. Carried through unrenamed rather than
      // dropped: a client that silently discards a field it does not know about
      // makes an additive server change look like a data loss bug, and the
      // schemas are `additionalProperties: false`, so the *contract* test is
      // where an unexpected key is supposed to fail — not here, at runtime.
      out[key] = raw;
      continue;
    }
    const [renamed, field] = known;
    out[renamed] = convertField(field, raw, direction);
  }
  return out;
}

function convertField(
  field: WireField,
  raw: unknown,
  direction: "decode" | "encode",
): unknown {
  if (raw === null || raw === undefined || field.shape === undefined) {
    // A field with no nested shape is a scalar, or a map whose *values* are
    // scalars — `error.details`. Renaming either would rewrite values rather
    // than field names, so both pass through untouched.
    return raw;
  }
  // The one narrowing of the generated `shape: string`. It is a `WireShapeName`
  // by construction — the generator only ever writes a name it also emitted —
  // and typing it as one in the generated file would make the name union
  // reference the table it is derived from.
  const nested = WIRE_SHAPES[field.shape as WireShapeName];
  if (field.list === true) {
    return Array.isArray(raw) ? raw.map((item) => convert(nested, item, direction)) : raw;
  }
  if (field.map === true) {
    // A **map whose keys are data and whose values are a named shape** —
    // `/v1/meta`'s and `/v1/plants`' `attribution`, keyed by source identifier.
    // The keys are values and are carried through untouched; the values are
    // objects like any other and are renamed field by field.
    //
    // This used to be the same branch as "no shape at all", and the bug it hid
    // is the reason the schema now names the value's shape: the block validated
    // either way, so `derivative_database` travelled as `derivativeDatabase`
    // and nothing anywhere failed. A map is not an opaque blob — only its keys
    // are.
    if (!isPlainObject(raw)) {
      return raw;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      out[key] = convert(nested, value, direction);
    }
    return out;
  }
  return convert(nested, raw, direction);
}

/**
 * Wire (`snake_case`) → app (`camelCase`). The direction every read takes.
 *
 * The return type is the caller's business: `client.ts` is where a decoded
 * body is given the generated interface, and it is the only caller that
 * should need the cast.
 */
export function decodeWire(name: WireShapeName, body: unknown): unknown {
  return convert(WIRE_SHAPES[name], body, "decode");
}

/**
 * App (`camelCase`) → wire (`snake_case`). The direction a `POST` body takes.
 *
 * Exact rather than derived, which is the whole reason the table exists: a
 * Scenario encoded by a lossy inverse hashes to a different cache key and the
 * cache silently never hits.
 */
export function encodeWire(name: WireShapeName, value: unknown): unknown {
  return convert(WIRE_SHAPES[name], value, "encode");
}

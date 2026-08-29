/**
 * A scenario is a URL: the canonical encoding, the transport, and the hash.
 *
 * `docs/specs/flex-optimizer.md`: *"The URL is the storage; there is nothing to
 * persist and no identity to invent."* The product is public, read-only and has
 * no accounts, so a shared link carries the whole scenario. Two consequences
 * run through everything below.
 *
 * **The encoding has to be exact.** `sha256` of the canonical bytes is a Redis
 * cache key (`opt:v1:<hash>:<origin>:<build>`) *and* a reproducibility claim
 * stamped on every answer. Two spellings of one scenario that hash differently
 * are a cache that silently never hits; two different scenarios that hash alike
 * are a wrong plan served under a right-looking receipt. So the canonical form
 * is JCS (RFC 8785) — keys sorted, no insignificant whitespace, numbers in the
 * shortest round-tripping form — and `0.92`, `0.920` and `9.2e-1` all produce
 * the same bytes because all three are the same IEEE-754 double and the
 * serialisation is a function of the double, never of the text it arrived as.
 *
 * **`v` is mandatory and an unknown value is refused.** A schema change bumps
 * it and an old link then fails loudly instead of parsing into a subtly
 * different scenario. That refusal is the difference between a shareable URL
 * and a time bomb, and it lives here — in the transport — because it must
 * happen before anything downstream can read a field.
 *
 * ### The two paths, and why they cannot disagree
 *
 * ```
 * POST /v1/optimize          body: the Scenario object
 * GET  /v1/optimize?s=<blob> for deep links and shares
 * ```
 *
 * {@link decodeScenarioBody} and {@link decodeScenarioParam} converge on
 * {@link canonicalizeScenarioWire} after one step each — a `JSON.parse` for the
 * body, a base64url decode plus a `JSON.parse` for the blob — so "both paths
 * decode to the identical canonical bytes" is a fact about the call graph
 * rather than a pair of tests that happen to agree. The routes themselves are
 * flex-optimizer ticket 06 / api-surface ticket 17; this module is what they
 * call.
 *
 * ### What this module deliberately does *not* do
 *
 * The eighteen-rule validation table (`SHIFT_EXCEEDS_BASELINE`,
 * `SOC_BOUNDS_INVALID`, the magnitudes) is **flex-optimizer ticket 04**, and it
 * runs against a decoded scenario. Three refusals live here instead, because
 * each of them makes the bytes unreadable rather than the scenario nonsensical:
 * `SCENARIO_TOO_LARGE` bounds what is parsed at all, `SCENARIO_VERSION_UNSUPPORTED`
 * decides which grammar the bytes are in, and `ASSET_TYPE_UNKNOWN` /
 * `FIELD_NOT_ON_VARIANT` decide which variant of the sum type an asset object
 * even is — a battery carrying `max_shift_mw` has no canonical form, because
 * there is no variant whose key set contains it.
 *
 * That last check is driven by the **generated** `WIRE_SHAPES` table, not by a
 * hand-written field list: `additionalProperties: false` on each variant in
 * `schema/flexibility-asset.schema.json` is what makes `FIELD_NOT_ON_VARIANT` a
 * schema fact, and the table is that schema's field names. Adding an `EV`
 * variant to the schema regenerates the table and this module accepts it with
 * no edit — which is the extension property the spec asks for.
 */

import { ApiError } from "./client.js";
import { type ErrorCode, type ErrorDetails, statusForCode } from "./errors.js";
import { sha256Hex } from "./sha256.js";
import type { Scenario, ScenarioHash } from "./types.generated.js";
import { WIRE_SHAPES } from "./types.generated.js";
import { decodeWire, encodeWire } from "./wire.js";

/**
 * A blob this build cannot read, refused with the code the spec names.
 *
 * It extends `ApiError` rather than introducing a second error vocabulary: the
 * gateway already turns an `ApiError` into the one envelope, the code is a
 * member of the same closed enum, and `statusForCode` is what keeps two throw
 * sites from answering one condition with different numbers. The only thing
 * this subclass adds is that a transport refusal cannot be constructed without
 * a code.
 */
export class ScenarioTransportError extends ApiError {
  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super({ status: statusForCode(code), code, message, details });
    this.name = "ScenarioTransportError";
  }
}

/** The only `v` this build understands. An old link with any other fails loudly. */
export const SCENARIO_VERSION = 1;

/**
 * The cap on the base64url blob, in bytes.
 *
 * `docs/specs/flex-optimizer.md`'s `SCENARIO_TOO_LARGE`. It caps the **encoded**
 * blob rather than the decoded JSON, because the blob is what
 * arrives in a query string from an unauthenticated caller and the cap's job is
 * to bound what gets parsed at all.
 */
export const MAX_SCENARIO_BLOB_BYTES = 4096;

/** The query parameter a shared link carries the blob in. */
export const SCENARIO_PARAM = "s";

/** Any value that can appear in a parsed JSON document. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// --- the canonical form ------------------------------------------------------

/**
 * A number, in the shortest form that round-trips — RFC 8785 §3.2.2.3.
 *
 * The rule is ECMAScript's `Number::toString`, which is what `String(n)` and
 * `JSON.stringify(n)` already implement, so on this side the function is a
 * one-liner and its whole value is being *named*: `apps/ml`'s
 * `_ecmascript_number` reimplements this algorithm on purpose, because
 * Python's `repr` is also shortest-round-tripping and disagrees about where
 * exponential notation starts (`repr(1e16)` is `1e+16`, `String(1e16)` is
 * `10000000000000000`). The shared vectors in
 * `fixtures/scenario-canonical/numbers.json` are what stop the two drifting.
 *
 * `-0` serialises as `0`, which is ECMAScript's rule and therefore JCS's: a
 * signed zero is a distinction JSON cannot carry and a hash must not invent.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ScenarioTransportError(
      "SCENARIO_TOO_LARGE",
      `${String(value)} has no JSON form; a scenario carries finite numbers only`,
    );
  }
  return String(value);
}

/**
 * A string, escaped the one way — RFC 8785 §3.2.2.2.
 *
 * `JSON.stringify` of a string is already the JCS rule: the two-character
 * escapes where they exist, `\u00xx` for the remaining control characters, and the
 * raw code unit for everything else. Lone surrogates survive as they arrived,
 * which is what byte-stability requires — a canonicaliser that repaired them
 * would make two different inputs hash alike.
 */
function canonicalString(value: string): string {
  return JSON.stringify(value);
}

/**
 * JCS — the canonical serialisation of any JSON value.
 *
 * Object keys are sorted by UTF-16 code unit, which is what `Array#sort` on
 * strings already does and what RFC 8785 §3.2.3 specifies. `undefined` members
 * are dropped exactly as `JSON.stringify` drops them, so an optional field the
 * app left unset and one it never had produce the same bytes.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return canonicalNumber(value);
  }
  if (typeof value === "string") {
    return canonicalString(value);
  }
  if (Array.isArray(value)) {
    // Array order is data, never sorted: two assets in the other order are a
    // different scenario and must hash differently.
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  }
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const member = value[key];
    if (member === undefined) {
      continue;
    }
    parts.push(`${canonicalString(key)}:${canonicalJson(member)}`);
  }
  return `{${parts.join(",")}}`;
}

// --- base64url ---------------------------------------------------------------

// RFC 4648 §5's alphabet: a public constant, and the one string in this file
// that must never be edited.
// biome-ignore lint/security/noSecrets: an encoding alphabet, not a credential
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const REVERSE: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((character, index) => [character, index]),
);

/**
 * Bytes → base64url, unpadded.
 *
 * Written out rather than reached for: `btoa` is not in every runtime this
 * package loads into, it works in binary strings rather than bytes, and it
 * emits the `+/=` alphabet that has to be rewritten for a URL anyway. Padding
 * is omitted because `=` in a query string is one more thing to escape and
 * carries no information the length does not.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2] as string;
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)] as string;
    if (b === undefined) {
      break;
    }
    out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)] as string;
    if (c === undefined) {
      break;
    }
    out += ALPHABET[c & 0x3f] as string;
  }
  return out;
}

/**
 * base64url → bytes. Padding is tolerated, the standard `+/` alphabet is not.
 *
 * A blob that is not base64url is `SCENARIO_TOO_LARGE`'s sibling in spirit but
 * not in code: it is a malformed request, and the caller decides. This function
 * throws {@link ScenarioTransportError} with `BAD_INPUT`.
 */
export function fromBase64Url(blob: string): Uint8Array {
  const text = blob.replace(/=+$/, "");
  if (text.length % 4 === 1) {
    throw new ScenarioTransportError(
      "BAD_INPUT",
      "the scenario blob is not base64url: its length cannot decode to whole bytes",
    );
  }
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let written = 0;
  let accumulator = 0;
  let bits = 0;
  for (const character of text) {
    const value = REVERSE.get(character);
    if (value === undefined) {
      throw new ScenarioTransportError(
        "BAD_INPUT",
        `the scenario blob is not base64url: ${JSON.stringify(character)} is not in the alphabet`,
      );
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (accumulator >> bits) & 0xff;
      written += 1;
    }
  }
  return bytes.subarray(0, written);
}

const UTF8_ENCODER = new TextEncoder();
// `fatal` is the point: a blob whose bytes are not UTF-8 is refused rather than
// silently repaired into U+FFFD, which would make two different blobs decode to
// one scenario and hash alike.
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

// --- the transport -----------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `asset_type` — the discriminant, per `docs/domain-model.md` §6.
 *
 * Named once, as the wire name the schema declares it under. Everything else
 * about the sum type is read out of the generated table.
 */
const ASSET_DISCRIMINANT = "asset_type";

/** One entry of the generated table, narrowed to the two fields read here. */
interface VariantField {
  readonly wire: string;
  readonly const?: string;
}

/**
 * The key set one variant of the sum type admits, or `undefined` if there is no
 * such variant.
 *
 * Read from `WIRE_SHAPES`, which is generated from
 * `schema/flexibility-asset.schema.json`. A variant is *the* shape whose
 * discriminant field is pinned to this `asset_type`; its admitted keys are that
 * shape's wire names, which is precisely what `additionalProperties: false` on
 * the variant means. Adding `EV` to the schema and regenerating makes this
 * function accept it with no edit here — the extension property the spec asks
 * for, made structural rather than promised.
 */
function variantKeys(assetType: string): Set<string> | undefined {
  const shapes = Object.values(WIRE_SHAPES) as readonly Readonly<
    Record<string, VariantField>
  >[];
  for (const shape of shapes) {
    const fields = Object.values(shape);
    const discriminant = fields.find((field) => field.wire === ASSET_DISCRIMINANT);
    if (discriminant?.const === assetType) {
      return new Set(fields.map((field) => field.wire));
    }
  }
  return undefined;
}

/**
 * The wire form of a scenario, canonicalised.
 *
 * This is the one function both transports end at, and everything downstream —
 * the blob, the hash, the cache key — is derived from its output.
 */
export function canonicalizeScenarioWire(wire: JsonValue): string {
  if (!isPlainObject(wire)) {
    throw new ScenarioTransportError("BAD_INPUT", "a scenario is a JSON object");
  }
  const version = wire.v;
  if (version !== SCENARIO_VERSION) {
    throw new ScenarioTransportError(
      "SCENARIO_VERSION_UNSUPPORTED",
      `v must be ${SCENARIO_VERSION}; this link carries ${JSON.stringify(version) ?? "nothing"}`,
      { field: "v", limit: SCENARIO_VERSION },
    );
  }
  const assets = wire.assets;
  if (Array.isArray(assets)) {
    for (const [index, asset] of assets.entries()) {
      assertVariant(asset, index);
    }
  }
  return canonicalJson(wire as unknown as JsonValue);
}

/** An asset object is exactly one variant, and carries no field off it. */
function assertVariant(asset: unknown, index: number): void {
  if (!isPlainObject(asset)) {
    throw new ScenarioTransportError(
      "ASSET_TYPE_UNKNOWN",
      `assets[${index}] is not an object`,
      { field: `assets[${index}]` },
    );
  }
  const assetType = asset.asset_type;
  const allowed = typeof assetType === "string" ? variantKeys(assetType) : undefined;
  if (allowed === undefined) {
    throw new ScenarioTransportError(
      "ASSET_TYPE_UNKNOWN",
      `assets[${index}].asset_type is ${JSON.stringify(assetType) ?? "absent"}`,
      { field: `assets[${index}].asset_type` },
    );
  }
  for (const key of Object.keys(asset)) {
    if (!allowed.has(key)) {
      throw new ScenarioTransportError(
        "FIELD_NOT_ON_VARIANT",
        `${key} is not a field of ${String(assetType)}`,
        { field: `assets[${index}].${key}` },
      );
    }
  }
}

/** The canonical UTF-8 bytes of a scenario the app holds in `camelCase`. */
export function canonicalScenarioBytes(scenario: Scenario): Uint8Array {
  return UTF8_ENCODER.encode(canonicalScenarioJson(scenario));
}

/** The canonical JSON text of a scenario the app holds in `camelCase`. */
export function canonicalScenarioJson(scenario: Scenario): string {
  return canonicalizeScenarioWire(encodeWire("Scenario", scenario) as JsonValue);
}

/**
 * `sha256:<64 hex>` over canonical bytes — the `ScenarioHash` on every result.
 *
 * Takes bytes rather than a `Scenario` so that a gateway that already has the
 * canonical text from a decode does not re-derive it, and so that the hash and
 * the cache key are provably over the same bytes the answer was computed from.
 */
export function hashCanonicalBytes(bytes: Uint8Array): ScenarioHash {
  return `sha256:${sha256Hex(bytes)}`;
}

/** `sha256:<64 hex>` for a scenario the app holds in `camelCase`. */
export function scenarioHash(scenario: Scenario): ScenarioHash {
  return hashCanonicalBytes(canonicalScenarioBytes(scenario));
}

/**
 * A scenario → the `?s=` blob. Refuses over {@link MAX_SCENARIO_BLOB_BYTES}.
 *
 * The refusal is here as well as on the way in on purpose: a share button that
 * produced a link the API would reject is a worse failure than one that says
 * the scenario is too big to share.
 */
export function encodeScenario(scenario: Scenario): string {
  const blob = toBase64Url(canonicalScenarioBytes(scenario));
  assertWithinCap(blob.length);
  return blob;
}

function assertWithinCap(size: number): void {
  if (size > MAX_SCENARIO_BLOB_BYTES) {
    throw new ScenarioTransportError(
      "SCENARIO_TOO_LARGE",
      `the encoded scenario is ${size} bytes; the cap is ${MAX_SCENARIO_BLOB_BYTES}`,
      { field: SCENARIO_PARAM, limit: MAX_SCENARIO_BLOB_BYTES },
    );
  }
}

/** A decoded scenario, with the bytes it was decoded from. */
export interface DecodedScenario {
  /** The app's `camelCase` view — what a screen and a validator read. */
  scenario: Scenario;
  /** The canonical JSON text. Byte-identical from either transport. */
  canonical: string;
  /** The canonical UTF-8 bytes. */
  bytes: Uint8Array;
  /** `sha256:<64 hex>` over `bytes`. */
  hash: ScenarioHash;
}

function finish(wire: JsonValue): DecodedScenario {
  const canonical = canonicalizeScenarioWire(wire);
  const bytes = UTF8_ENCODER.encode(canonical);
  return {
    scenario: decodeWire("Scenario", wire) as Scenario,
    canonical,
    bytes,
    hash: hashCanonicalBytes(bytes),
  };
}

function parse(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (cause) {
    throw new ScenarioTransportError(
      "BAD_INPUT",
      `the scenario is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * `GET /v1/optimize?s=<blob>` — the deep-link path.
 *
 * The cap is checked against the blob **before** it is decoded, so a 5 KB query
 * string is refused without allocating a 3.7 KB buffer or running a parser over
 * attacker-controlled bytes.
 */
export function decodeScenarioParam(blob: string): DecodedScenario {
  assertWithinCap(blob.length);
  const bytes = fromBase64Url(blob);
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new ScenarioTransportError(
      "BAD_INPUT",
      "the scenario blob does not decode to UTF-8",
    );
  }
  return finish(parse(text));
}

/**
 * `POST /v1/optimize` — the body path.
 *
 * Accepts either the raw body text or an already-parsed value, because Elysia
 * hands a route one and a test the other, and the two must not take different
 * code paths to the canonical bytes.
 */
export function decodeScenarioBody(body: string | JsonValue): DecodedScenario {
  const wire = typeof body === "string" ? parse(body) : body;
  const decoded = finish(wire);
  // The body is not length-capped by the blob rule until it is encoded as one,
  // and a body that cannot be shared as a link is a scenario the product cannot
  // honour its own URL promise for. Checked after canonicalisation so that the
  // measured size is the one a share button would produce.
  assertWithinCap(toBase64Url(decoded.bytes).length);
  return decoded;
}

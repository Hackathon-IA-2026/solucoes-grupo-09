import { ApiError } from "@wattsteer/core/client";
import {
  type DecodedScenario,
  decodeScenarioBody,
  decodeScenarioParam,
  type JsonValue,
} from "@wattsteer/core/scenario";
import { validateScenarioWire } from "@wattsteer/core/scenario-validation";
import { CodedError } from "../errors.js";

/**
 * The gate a scenario passes through before anything expensive happens to it.
 *
 * `docs/specs/flex-optimizer.md` puts validation **in the Elysia gateway,
 * before the request reaches the solver**, and gives the reason: model
 * construction rather than solving dominates the request, so a rejected
 * scenario should never build one. This module is that sentence as a function.
 * The route it sits under is flex-optimizer ticket 06; nothing here knows about
 * a route, which is what lets the rule be tested without one.
 *
 * Three things happen in one call, in this order, and the order is the point:
 *
 * 1. **Decode** — base64url and JSON for `?s=`, JSON for the body, both landing
 *    on the same canonical bytes. Refuses the blobs that are unreadable at all.
 * 2. **Validate** — the eighteen-rule table, run on the *canonical* document
 *    rather than on a second parse of the request, so the scenario that passed
 *    is provably the scenario the answer will be stamped with.
 * 3. **Hand back the bytes and the hash** — and nothing else. There is no
 *    "corrected" scenario, because nothing is corrected. A gate that repaired
 *    its input would hand the solver a fleet the caller never described, and
 *    the response would carry a hash of it as though it were theirs.
 *
 * **What this module adds to `@wattsteer/core`.** Both refusals arrive as
 * `ApiError` — the shared class the web client also throws — and the gateway's
 * envelope is built from `AppError`. Rather than teach `toErrorEnvelope` a
 * second base class, the code is carried across into a `CodedError`, which is
 * the gateway's general "refuse by name" throw. The status is not copied: it is
 * re-derived from the code, so a refusal cannot arrive at a different number
 * here than the one `ERROR_STATUS` publishes for it.
 */

/** Where the scenario arrived from, and the clock the date rules are read on. */
export interface GateOptions {
  /**
   * The instant "tomorrow" is measured from. Injected so a test asserts a
   * boundary rather than the day it ran; a route omits it and gets the clock.
   */
  now?: Date;
}

/**
 * Re-throw a `@wattsteer/core` refusal as the gateway's own.
 *
 * `ApiError.code` is nullable — it is `null` for a transport failure that never
 * reached a gateway at all — and that case cannot arise here, because both
 * refusals this catches are constructed with a code. It is treated as a bug in
 * this file rather than smuggled out as a 500 with someone else's message.
 */
function rethrow(error: unknown): never {
  if (error instanceof ApiError) {
    if (error.code === null) {
      // `INTERNAL` is the honest answer: a refusal with no code is this file
      // being wrong about its own inputs, not the caller being wrong about
      // theirs, and nothing internal reaches the client under it.
      throw new CodedError("INTERNAL", "A scenario refusal arrived with no code", {
        cause: error,
      });
    }
    throw new CodedError(error.code, error.message, {
      cause: error,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  throw error;
}

/** Decode, then validate. The one path; both transports arrive here. */
function admit(decode: () => DecodedScenario, options: GateOptions): DecodedScenario {
  try {
    const decoded = decode();
    // `decoded.canonical` is the text the hash was taken over. Parsing it back
    // is deliberate: validating the *canonical* document rather than the body
    // as it arrived means no field can differ between what was checked and what
    // was hashed.
    validateScenarioWire(JSON.parse(decoded.canonical) as JsonValue, {
      ...(options.now ? { now: options.now } : {}),
    });
    return decoded;
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * `GET /v1/optimize?s=<blob>` — the deep-link and share path.
 *
 * The blob's length is checked before it is decoded, so an oversized query
 * string from an unauthenticated caller is refused without running a parser
 * over attacker-controlled bytes.
 */
export function admitScenarioParam(
  blob: string,
  options: GateOptions = {},
): DecodedScenario {
  return admit(() => decodeScenarioParam(blob), options);
}

/** `POST /v1/optimize` — the body path, ending at the identical bytes. */
export function admitScenarioBody(
  body: string | JsonValue,
  options: GateOptions = {},
): DecodedScenario {
  return admit(() => decodeScenarioBody(body), options);
}

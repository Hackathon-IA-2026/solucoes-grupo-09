import { Elysia } from "elysia";
import {
  type ErrorCode,
  type ErrorDetails,
  envelope,
  toErrorEnvelope,
} from "../../errors.js";
import { refuseToCache } from "./cache-policy.js";
import { requestIdOf } from "./request-context.js";

/**
 * **One error envelope for the whole API, including the two shapes that used
 * to escape it.**
 *
 * Before this, one surface answered in three shapes: the typed envelope for
 * domain errors, Elysia's native TypeBox body for a validation failure, and a
 * bare `{ error: "Not found" }` string for an unmatched route. The framework's
 * validation body is the worst of the three to leak, because it is the one a
 * client is most likely to need machine-readable detail from — and it is
 * TypeBox's shape, not ours, so it can change under us on a minor version.
 *
 * Both are mapped here. A validation failure keeps its **field path** in
 * `details.field`, and where the field is one whose refusal the closed enum
 * already names, it keeps that code too: a `subsystem` outside the four is a
 * `SUBSYSTEM_UNKNOWN`, exactly as it would be if a handler had checked it by
 * hand. That equivalence is the point — a client cannot tell, and must not
 * need to tell, whether a refusal came from the route schema or from a
 * handler.
 *
 * Every 5xx is logged with its cause server-side and answers with a code and
 * a generic sentence. Nothing internal reaches the client.
 */

/** One TypeBox error, read defensively: it is the framework's shape, not ours. */
interface RawValidationError {
  path?: unknown;
  message?: unknown;
}

/**
 * `/assets/1/max_shift_mw` → `assets[1].max_shift_mw`.
 *
 * TypeBox reports a JSON Pointer; the spec's envelope shows a field path in
 * the notation the scenario is written in, which is the one a caller can find
 * in their own request body.
 */
export function fieldPath(pointer: string): string {
  return pointer
    .split("/")
    .filter((segment) => segment !== "")
    .reduce((acc, segment) => {
      if (/^\d+$/.test(segment)) {
        return `${acc}[${segment}]`;
      }
      return acc === "" ? segment : `${acc}.${segment}`;
    }, "");
}

/**
 * Fields whose refusal the closed enum already names.
 *
 * Deliberately short, and keyed on the *last* segment so that `subsystem` and
 * `assets[0].subsystem` resolve alike. Anything not listed is a
 * `REQUEST_INVALID`, which is honest: the route schema refused it and the enum
 * has no more specific sentence for it.
 */
const CODE_BY_FIELD: Record<string, ErrorCode> = {
  subsystem: "SUBSYSTEM_UNKNOWN",
  gate_profile: "GATE_PROFILE_UNKNOWN",
  locale: "LOCALE_UNSUPPORTED",
};

/** The code and details a framework validation failure becomes. */
export function validationFailure(error: unknown): {
  code: ErrorCode;
  message: string;
  details: ErrorDetails;
} {
  const all = (error as { all?: unknown })?.all;
  const first = (Array.isArray(all) ? all : []).find(
    (candidate): candidate is RawValidationError =>
      typeof candidate === "object" && candidate !== null && "path" in candidate,
  );
  const pointer = typeof first?.path === "string" ? first.path : "";
  const field = fieldPath(pointer);
  const leaf =
    field
      .replace(/\[\d+\]$/, "")
      .split(".")
      .pop() ?? "";
  const code = CODE_BY_FIELD[leaf] ?? "REQUEST_INVALID";
  const location = (error as { type?: unknown })?.type;
  const reason = typeof first?.message === "string" ? first.message : "failed validation";
  return {
    code,
    message: field
      ? `Request validation failed: ${field} ${reason}.`
      : `Request validation failed: ${reason}.`,
    details: {
      ...(field ? { field } : {}),
      ...(typeof location === "string" ? { location } : {}),
    },
  };
}

export const errorHandler = new Elysia({ name: "error-handler" })
  .onError(({ code, error, set, request }) => {
    const requestId = requestIdOf(request);

    // Before anything else: an error is never shared-cacheable, and it never
    // carries a validator. A route that revalidates *before* it does its work
    // — `/v1/optimize` 304-checks a pinned scenario before calling the solver —
    // has already written a success directive and a success ETag by the time
    // the work fails, and `set` is the same object this handler answers on. A
    // shared cache that stored an upstream 503 under `public, max-age=300`
    // could then revalidate it to a 304 against the validator the eventual 200
    // will carry, and re-extend the window forever. `refuseToCache` is one call
    // in the one place every error already passes.
    refuseToCache(set);

    if (code === "VALIDATION") {
      // Elysia's native 422 body never reaches a client. Its field path does.
      const failure = validationFailure(error);
      const mapped = envelope(failure.code, failure.message, {
        details: failure.details,
        requestId,
      });
      set.status = mapped.status;
      return mapped.body;
    }

    if (code === "NOT_FOUND") {
      const path = new URL(request.url).pathname;
      const mapped = envelope(
        "ROUTE_NOT_FOUND",
        `No route matched ${request.method} ${path}`,
        { requestId },
      );
      set.status = mapped.status;
      return mapped.body;
    }

    const mapped = toErrorEnvelope(error, requestId);
    if (mapped.status >= 500) {
      console.error("💥 Unhandled API error:", error);
    }
    if (mapped.retryAfterSec !== undefined) {
      set.headers["retry-after"] = String(mapped.retryAfterSec);
    }
    set.status = mapped.status;
    return mapped.body;
  })
  .as("global");

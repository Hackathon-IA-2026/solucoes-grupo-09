import { Elysia } from "elysia";
import { envelope } from "../../errors.js";
import { requestIdOf } from "./request-context.js";

/** Default maximum request body size: 10 MB. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Pure predicate: does the Content-Length header exceed the limit? */
export function exceedsLimit(contentLength: string | null, maxBytes: number): boolean {
  const n = Number.parseInt(contentLength ?? "0", 10);
  return Number.isFinite(n) && n > maxBytes;
}

/**
 * Reject oversized request bodies up front (before parsing) via the
 * Content-Length header. Runs in `onRequest` so it short-circuits with a 413
 * before any handler allocates the body.
 *
 * It answers in the same envelope as everything else — `PAYLOAD_TOO_LARGE`,
 * with the limit in `details` so a client can say by how much it overshot.
 * A refusal that happens before a handler runs is still a refusal a client
 * has to parse, and it does not get its own shape.
 */
export const bodyLimit = (maxBytes: number = MAX_BODY_BYTES) =>
  new Elysia({ name: "body-limit", seed: maxBytes })
    .onRequest(({ request, set }) => {
      if (exceedsLimit(request.headers.get("content-length"), maxBytes)) {
        const mapped = envelope(
          "PAYLOAD_TOO_LARGE",
          `Request payload too large. Maximum size is ${maxBytes} bytes.`,
          {
            details: { limit_bytes: maxBytes },
            requestId: requestIdOf(request),
          },
        );
        set.status = mapped.status;
        return mapped.body;
      }
    })
    .as("global");

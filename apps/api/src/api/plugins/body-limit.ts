import { Elysia } from "elysia";

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
 */
export const bodyLimit = (maxBytes: number = MAX_BODY_BYTES) =>
  new Elysia({ name: "body-limit", seed: maxBytes })
    .onRequest(({ request, set }) => {
      if (exceedsLimit(request.headers.get("content-length"), maxBytes)) {
        set.status = 413;
        return {
          error: `Request payload too large. Maximum size is ${maxBytes} bytes.`,
        };
      }
    })
    .as("global");

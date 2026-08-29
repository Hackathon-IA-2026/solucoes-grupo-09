import { Elysia } from "elysia";
import { envelope } from "../../errors.js";
import { isSolvePath } from "./rate-limit.js";
import { requestIdOf } from "./request-context.js";

/** Default maximum request body size: 10 MB. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Maximum body on a solve route: 16 KB.
 *
 * 10 MB is the right number for an ingestion endpoint and the wrong one for a
 * solver. `flex-optimizer.md` caps the Scenario at 4096 bytes, so 16 KB is
 * four times the largest legal request and still small enough that a refusal
 * costs a header parse rather than an allocation. The point is *where* it is
 * enforced: model construction dominates the solve, so a request that cannot
 * be legal must die before a handler — and before a body — exists.
 */
export const SOLVE_MAX_BODY_BYTES = 16 * 1024;

/** Pure predicate: does the Content-Length header exceed the limit? */
export function exceedsLimit(contentLength: string | null, maxBytes: number): boolean {
  const n = Number.parseInt(contentLength ?? "0", 10);
  return Number.isFinite(n) && n > maxBytes;
}

export interface BodyLimitOptions {
  /** The ceiling in bytes. */
  maxBytes?: number;
  /**
   * Which requests this ceiling governs. Omitted means all of them — the
   * global mount. Supplied, it is how a stricter per-route limit is layered
   * over the global one without waiting for the route to exist.
   */
  applies?: (method: string, pathname: string) => boolean;
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
 *
 * Mount it more than once: the global 10 MB ceiling, then a 16 KB one scoped
 * to the solve routes. Both run in `onRequest`, so the strictest matching
 * limit is the one that answers.
 */
export const bodyLimit = (options: number | BodyLimitOptions = {}) => {
  const resolved: BodyLimitOptions =
    typeof options === "number" ? { maxBytes: options } : options;
  const maxBytes = resolved.maxBytes ?? MAX_BODY_BYTES;
  const applies = resolved.applies;
  return new Elysia({ name: "body-limit", seed: { maxBytes, applies } })
    .onRequest(({ request, set }) => {
      const pathname = applies ? new URL(request.url).pathname : "";
      if (applies && !applies(request.method, pathname)) {
        return;
      }
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
};

/**
 * The 16 KB ceiling on `/v1/optimize` and `/v1/replay`, mounted by path.
 *
 * Mounting it centrally rather than inside each route means the ceiling is in
 * force from the moment the route exists — a solve route cannot be added
 * without it, which is the failure mode a per-route mount invites.
 */
export const solveBodyLimit = () =>
  bodyLimit({
    maxBytes: SOLVE_MAX_BODY_BYTES,
    applies: (_method, pathname) => isSolvePath(pathname),
  });

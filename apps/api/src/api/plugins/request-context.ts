import { Elysia } from "elysia";

// Per-request id + start time (WeakMaps so finished requests are GC'd).
const ids = new WeakMap<Request, string>();
const starts = new WeakMap<Request, number>();

/**
 * The id this request is being handled under, for anything that has to name it
 * outside the lifecycle — chiefly the error envelope's `request_id`, which is
 * what turns a user-reported failure into one grep.
 *
 * Reads the WeakMap rather than the header, because the id is generated here
 * when the caller did not send one; the inbound header is the fallback for the
 * one case where this plugin has not run (a route tested in isolation).
 */
export function requestIdOf(request: Request): string | undefined {
  return ids.get(request) ?? request.headers.get("x-request-id") ?? undefined;
}

/**
 * Assigns each request a correlation id (honoring an inbound `x-request-id`),
 * echoes it on the response, and logs one structured line per request:
 * `[id] METHOD /path status durationms`. Health/docs noise is skipped.
 */
export const requestContext = new Elysia({ name: "request-context" })
  .onRequest(({ request, set }) => {
    const id = request.headers.get("x-request-id") ?? crypto.randomUUID();
    ids.set(request, id);
    starts.set(request, performance.now());
    set.headers["x-request-id"] = id;
  })
  .onAfterResponse(({ request, set }) => {
    const path = new URL(request.url).pathname;
    if (path === "/health" || path === "/ready" || path.startsWith("/docs")) {
      return;
    }
    const start = starts.get(request);
    const ms = start ? Math.round(performance.now() - start) : 0;
    console.log(
      `[${ids.get(request) ?? "-"}] ${request.method} ${path} ${set.status ?? 200} ${ms}ms`,
    );
  })
  .as("global");

import { Elysia } from "elysia";

// Per-request id + start time (WeakMaps so finished requests are GC'd).
const ids = new WeakMap<Request, string>();
const starts = new WeakMap<Request, number>();

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
    if (path === "/health" || path === "/ready" || path.startsWith("/docs")) return;
    const start = starts.get(request);
    const ms = start ? Math.round(performance.now() - start) : 0;
    console.log(
      `[${ids.get(request) ?? "-"}] ${request.method} ${path} ${set.status ?? 200} ${ms}ms`,
    );
  })
  .as("global");

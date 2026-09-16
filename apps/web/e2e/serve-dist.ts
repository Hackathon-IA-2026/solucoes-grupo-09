/**
 * Tiny static server for the exported web bundle (dist/), for Playwright and
 * Lighthouse. Mirrors what a production host should do: gzip for text
 * responses and long-lived immutable caching for hashed build assets.
 */
import { join, normalize } from "node:path";
import { candidatesFor, statusFor } from "../scripts/static-routing";

const PORT = Number(process.env.DIST_PORT ?? 4173);
const ROOT = join(import.meta.dir, "..", "dist");

/** Content types worth gzipping (binary/image types are already compressed). */
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json))|image\/svg/;

/** Hashed build output — safe to cache forever. */
const IMMUTABLE = /^\/(?:_expo|assets)\//;

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    // Prevent path traversal, then ask `scripts/static-routing.ts`. This file
    // used to mirror `server.ts` by hand, which is how the suite ends up
    // testing a server the deployment is not.
    const clean = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    const path = clean.replace(/^\/+/, "").replace(/\/+$/, "");
    // `candidatesFor` and `statusFor`, not a second copy of them: this file
    // used to mirror `server.ts` by hand, which is how the suite would end up
    // testing a server the deployment is not.
    const candidates = candidatesFor(path);
    for (const candidate of candidates) {
      const file = Bun.file(join(ROOT, candidate));
      if (await file.exists()) {
        const type = file.type || "application/octet-stream";
        const headers = new Headers({ "content-type": type });
        const status = statusFor(path, candidate);
        headers.set(
          "cache-control",
          // Key off the file actually served, NOT the request path — the SPA
          // fallback can answer an /_expo/... request with index.html, which
          // must never be cached as immutable.
          IMMUTABLE.test(`/${candidate}`)
            ? "public, max-age=31536000, immutable"
            : "public, max-age=0, must-revalidate",
        );
        const acceptsGzip = request.headers.get("accept-encoding")?.includes("gzip");
        if (acceptsGzip && COMPRESSIBLE.test(type)) {
          headers.set("content-encoding", "gzip");
          headers.set("vary", "accept-encoding");
          return new Response(Bun.gzipSync(new Uint8Array(await file.arrayBuffer())), {
            headers,
            status,
          });
        }
        return new Response(file, { headers, status });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`serving dist/ on http://localhost:${PORT}`);

/**
 * Production static server for the exported web bundle (dist/). Serves the
 * expo-router static export with gzip for text responses, long-lived immutable
 * caching for hashed build assets, and an SPA-style fallback to index.html.
 *
 * Mirrors e2e/serve-dist.ts (the test harness), but rooted next to this file
 * so it works from the Docker image, binds 0.0.0.0, and exposes /healthz for
 * the platform healthcheck.
 */
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = join(import.meta.dir, "dist");

/** Content types worth gzipping (binary/image types are already compressed). */
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json))|image\/svg/;

/** Hashed build output — safe to cache forever. */
const IMMUTABLE = /^\/(?:_expo|assets)\//;

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);

    // Cheap, dependency-free liveness probe for the platform healthcheck.
    // Answers both /healthz and /health so it passes whichever path the
    // Railway config resolves to.
    if (url.pathname === "/healthz" || url.pathname === "/health") {
      return new Response("ok", {
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      });
    }

    // Prevent path traversal; map "/" and route paths to their HTML files.
    const clean = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    const candidates =
      clean === "/"
        ? ["index.html"]
        : [clean.slice(1), `${clean.slice(1)}.html`, "index.html"];
    for (const candidate of candidates) {
      const file = Bun.file(join(ROOT, candidate));
      if (await file.exists()) {
        const type = file.type || "application/octet-stream";
        const headers = new Headers({ "content-type": type });
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
          });
        }
        return new Response(file, { headers });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`serving dist/ on http://0.0.0.0:${PORT}`);

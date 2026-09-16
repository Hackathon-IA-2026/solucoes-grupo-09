/**
 * Production static server for the exported web bundle (dist/). Serves the
 * expo-router static export with gzip for text responses, long-lived immutable
 * caching for hashed build assets, and an SPA-style fallback to index.html.
 *
 * Mirrors e2e/serve-dist.ts (the test harness), but rooted next to this file
 * so it works from the Docker image, binds 0.0.0.0, and exposes /healthz for
 * the platform healthcheck.
 *
 * **It no longer mirrors the harness in one respect, deliberately.** Compressed
 * bodies are cached here and are not there — see `gzipOnce` below. The harness
 * is restarted per run against a freshly exported `dist/`, and a cache in it
 * would be a cache that has to be reasoned about every time the export changes
 * under it, in exchange for saving milliseconds nobody is waiting on. Here the
 * export is fixed for the life of the process and visitors are waiting.
 */
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = join(import.meta.dir, "dist");

/** Content types worth gzipping (binary/image types are already compressed). */
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json))|image\/svg/;

/** Hashed build output — safe to cache forever. */
const IMMUTABLE = /^\/(?:_expo|assets)\//;

/**
 * Compressed bodies, computed **once** rather than once per request.
 *
 * This used to be `Bun.gzipSync(await file.arrayBuffer())` inline, on every
 * response: the whole file read into memory and deflated synchronously, on the
 * event loop, for each visitor. On the largest asset this export ships that is
 * megabytes of work per hit, and it is work whose answer never changes —
 * `dist/` is written at build time and is immutable for the life of the
 * process.
 *
 * **Keyed by the resolved file, not by the request path**, and that is a
 * security property rather than a style choice. Every unknown path in this
 * server falls back to `index.html`, so a cache keyed on `url.pathname` would
 * grow one entry per distinct URL an unauthenticated caller cared to invent —
 * an unbounded map on a public endpoint. Keyed by the candidate that actually
 * resolved, the key space is exactly the set of files in `dist/`, which is
 * fixed before the process starts.
 *
 * The four `file.exists()` probes stay per-request and uncached for the same
 * reason: their input is the caller's path, and the probe is a stat against a
 * directory the kernel has long since cached.
 */
const gzipCache = new Map<string, Uint8Array>();

async function gzipOnce(candidate: string, file: Bun.BunFile): Promise<Uint8Array> {
  const cached = gzipCache.get(candidate);
  if (cached !== undefined) {
    return cached;
  }
  const compressed = Bun.gzipSync(new Uint8Array(await file.arrayBuffer()));
  gzipCache.set(candidate, compressed);
  return compressed;
}

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
    // `${path}/index.html` is what makes the locale roots work: the export
    // writes `/pt/` as dist/pt/index.html, and a request for a directory has
    // to find it. Trailing slashes are trimmed so `/pt` and `/pt/` are the
    // same lookup.
    const clean = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    const path = clean.replace(/^\/+/, "").replace(/\/+$/, "");
    const candidates =
      path === ""
        ? ["index.html"]
        : [path, `${path}.html`, `${path}/index.html`, "index.html"];
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
          return new Response(await gzipOnce(candidate, file), { headers });
        }
        return new Response(file, { headers });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`serving dist/ on http://0.0.0.0:${PORT}`);

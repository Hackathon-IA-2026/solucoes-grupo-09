/** Tiny static server for the exported web bundle (dist/), for Playwright. */
import { join, normalize } from "node:path";

const PORT = Number(process.env.DIST_PORT ?? 4173);
const ROOT = join(import.meta.dir, "..", "dist");

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    // Prevent path traversal; map "/" and route paths to their HTML files.
    const clean = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    const candidates =
      clean === "/"
        ? ["index.html"]
        : [clean.slice(1), `${clean.slice(1)}.html`, "index.html"];
    for (const candidate of candidates) {
      const file = Bun.file(join(ROOT, candidate));
      if (await file.exists()) return new Response(file);
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`serving dist/ on http://localhost:${PORT}`);

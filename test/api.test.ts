import { describe, expect, it } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { app } from "../src/api/index.js";
import { exceedsLimit, MAX_BODY_BYTES } from "../src/api/plugins/body-limit.js";
import { cspFor } from "../src/api/plugins/security.js";

// Eden Treaty — Elysia's recommended type-safe testing client. It runs requests
// through the app in-process (no network, no server), so these stay fast and
// never trigger a real scrape (validation fails before the service runs).
const api = treaty(app);

describe("api · typed routes (Eden Treaty)", () => {
  it("GET /health returns ok", async () => {
    const { data, status } = await api.health.get();
    expect(status).toBe(200);
    expect(data).toEqual({ status: "ok" });
  });

  it("GET / returns api info with a docs link", async () => {
    const { data } = await api.get();
    expect(data?.name).toBe("noviq");
    expect(data?.docs).toBe("/docs");
  });

  it("rejects a missing appId with 422", async () => {
    // @ts-expect-error appId is required — the type itself guards the call
    const { error } = await api.reviews.get({ query: {} });
    expect(error?.status).toBe(422);
  });

  it("rejects an invalid store with 422", async () => {
    // @ts-expect-error store must be "apple" | "google"
    const { error } = await api.reviews.get({ query: { appId: "1", store: "nope" } });
    expect(error?.status).toBe(422);
  });

  it("rejects a limit above the max with 422 (runtime validation)", async () => {
    const { error } = await api.reviews.get({ query: { appId: "1", limit: 99999 } });
    expect(error?.status).toBe(422);
  });
});

describe("api · swagger", () => {
  const req = (path: string) => app.handle(new Request(`http://localhost${path}`));

  it("serves the swagger UI at /docs", async () => {
    expect((await req("/docs")).status).toBe(200);
  });

  it("exposes the OpenAPI schema including the /reviews path", async () => {
    const res = await req("/docs/json");
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(spec.paths["/reviews"]).toBeDefined();
  });
});

describe("api · security headers", () => {
  const req = (path: string) => app.handle(new Request(`http://localhost${path}`));

  it("sets hardening headers on API responses", async () => {
    const res = await req("/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-xss-protection")).toBe("1; mode=block");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
  });

  it("relaxes CSP only for the Swagger UI", async () => {
    const csp = (await req("/docs")).headers.get("content-security-policy");
    expect(csp).toContain("https://cdn.jsdelivr.net");
  });

  it("still sets security headers on error responses (e.g. 422)", async () => {
    const res = await req("/reviews"); // missing appId → 422
    expect(res.status).toBe(422);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("cspFor picks the right policy per path", () => {
    expect(cspFor("/health")).toBe("default-src 'self'");
    expect(cspFor("/docs")).toContain("cdn.jsdelivr.net");
    expect(cspFor("/docs/json")).toContain("cdn.jsdelivr.net");
  });
});

describe("api · body limit", () => {
  it("exceedsLimit compares Content-Length to the max", () => {
    expect(exceedsLimit(null, 100)).toBe(false);
    expect(exceedsLimit("0", 100)).toBe(false);
    expect(exceedsLimit("100", 100)).toBe(false);
    expect(exceedsLimit("101", 100)).toBe(true);
  });

  // Content-Length only exists on a real wire request, so this one boots an
  // ephemeral server (in-memory `app.handle` Requests carry no Content-Length).
  it("rejects an oversized request body with 413", async () => {
    app.listen(0);
    try {
      const res = await fetch(`http://localhost:${app.server?.port}/health`, {
        method: "POST",
        body: "x".repeat(MAX_BODY_BYTES + 1024),
      });
      expect(res.status).toBe(413);
    } finally {
      await app.stop();
    }
  });
});

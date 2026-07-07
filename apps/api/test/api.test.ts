import { describe, expect, it } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { Elysia } from "elysia";
import { app } from "../src/api/index.js";
import { exceedsLimit, MAX_BODY_BYTES } from "../src/api/plugins/body-limit.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { cspFor } from "../src/api/plugins/security.js";
import { BadInputError, UpstreamError } from "../src/errors.js";

// Eden Treaty — Elysia's recommended type-safe testing client. It runs requests
// through the app in-process (no network, no server), so these stay fast and
// never trigger a real scrape (validation fails before the service runs).
const api = treaty(app);

describe("api · typed routes (Eden Treaty)", () => {
  it("GET /health returns ok with concurrency stats", async () => {
    const { data, status } = await api.health.get();
    expect(status).toBe(200);
    expect(data?.status).toBe("ok");
    expect(data?.scrapes?.max).toBeGreaterThanOrEqual(1);
  });

  it("GET /ready reports a boolean readiness", async () => {
    const { data, status } = await api.ready.get();
    expect([200, 503]).toContain(status);
    expect(typeof data?.ready === "boolean" || data === null).toBe(true);
  });

  it("GET / returns api info with a docs link", async () => {
    const { data } = await api.get();
    expect(data?.name).toBe("noviq");
    expect(data?.docs).toBe("/docs");
  });

  it("echoes an x-request-id header for correlation", async () => {
    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.headers.get("x-request-id")).toBeTruthy();
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
    const { error } = await api.reviews.get({ query: { appId: "1", limit: 99_999 } });
    expect(error?.status).toBe(422);
  });

  it("rejects a junk appId like 'undefined' with 422 (Swagger examples bug)", async () => {
    const { error } = await api.reviews.get({
      query: { appId: "undefined", store: "google" },
    });
    expect(error?.status).toBe(422);
  });

  it("rejects a non-2-letter country with 422", async () => {
    const { error } = await api.reviews.get({
      query: { appId: "284882215", country: "usa" },
    });
    expect(error?.status).toBe(422);
  });

  it("rejects an invalid `since` date with 400 (before any scrape)", async () => {
    const { error } = await api.reviews.get({
      query: { appId: "284882215", since: "not-a-date" },
    });
    expect(error?.status).toBe(400);
  });

  it("GET /reviews/jobs/:id → 404 for an unknown id", async () => {
    const res = await app.handle(
      new Request("http://localhost/reviews/jobs/does-not-exist"),
    );
    expect(res.status).toBe(404);
  });

  it("POST /reviews/jobs rejects bad input at submit (400, no enqueue)", async () => {
    const res = await app.handle(
      new Request("http://localhost/reviews/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: "284882215", since: "not-a-date" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("GET /reviews/stored → 503 when no database is configured", async () => {
    const res = await app.handle(new Request("http://localhost/reviews/stored?appId=1"));
    expect(res.status).toBe(503);
  });

  it("GET /app rejects a missing appId with 422", async () => {
    const res = await app.handle(new Request("http://localhost/app"));
    expect(res.status).toBe(422);
  });

  it("GET /app rejects a junk appId with 422", async () => {
    const res = await app.handle(new Request("http://localhost/app?appId=instagram"));
    expect(res.status).toBe(422);
  });

  it("GET /apps/stored → 503 when no database is configured", async () => {
    const res = await app.handle(new Request("http://localhost/apps/stored?appId=1"));
    expect(res.status).toBe(503);
  });
});

describe("api · error mapping (global handler)", () => {
  const errApp = new Elysia()
    .use(errorHandler)
    .get("/bad", () => {
      throw new BadInputError("nope");
    })
    .get("/up", () => {
      throw new UpstreamError();
    })
    .get("/boom", () => {
      throw new Error("ECONN internal-db dsn=secret");
    });
  const hit = (p: string) => errApp.handle(new Request(`http://localhost${p}`));

  it("maps domain errors to their status", async () => {
    expect((await hit("/bad")).status).toBe(400);
    expect((await hit("/up")).status).toBe(502);
  });

  it("maps unknown errors to 500 without leaking the message", async () => {
    const res = await hit("/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });
});

describe("api · swagger", () => {
  const req = (path: string) => app.handle(new Request(`http://localhost${path}`));

  it("serves the swagger UI at /docs", async () => {
    expect((await req("/docs")).status).toBe(200);
  });

  it("exposes the OpenAPI schema including the /reviews and /app paths", async () => {
    const res = await req("/docs/json");
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(spec.paths["/reviews"]).toBeDefined();
    expect(spec.paths["/app"]).toBeDefined();
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

describe("api · CORS (browser frontend contract)", () => {
  // These run with NODE_ENV != production, so every origin is allowed. The
  // critical regression guard is POST: the web app's async job submission
  // (POST /reviews/jobs) must survive a browser preflight.
  it("preflights POST /reviews/jobs successfully", async () => {
    const res = await app.handle(
      new Request("http://localhost/reviews/jobs", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8081",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
    );
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    const allowedHeaders = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowedHeaders.toLowerCase()).toContain("content-type");
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("sends allow-origin on simple GETs from a browser origin", async () => {
    const res = await app.handle(
      new Request("http://localhost/health", {
        headers: { Origin: "http://localhost:8081" },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });
});

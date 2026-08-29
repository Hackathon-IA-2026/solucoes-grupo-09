import { describe, expect, it } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { Elysia } from "elysia";
import { app } from "../src/api/index.js";
import { exceedsLimit, MAX_BODY_BYTES } from "../src/api/plugins/body-limit.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { cspFor } from "../src/api/plugins/security.js";
import { BadInputError, UpstreamError } from "../src/errors.js";

// Eden Treaty — Elysia's recommended type-safe testing client. It runs requests
// through the app in-process (no network, no server), so these stay fast.
//
// There are no domain routes yet: the WattSteer surface was removed and
// WattSteer's arrives with the data platform. What these tests defend is the
// plugin stack — security headers, body limit, CORS, rate limiting, request
// correlation and error mapping — which every future route inherits.
const api = treaty(app);

describe("api · typed routes (Eden Treaty)", () => {
  it("GET /health returns ok", async () => {
    const { data, status } = await api.health.get();
    expect(status).toBe(200);
    expect(data?.status).toBe("ok");
  });

  it("GET /ready reports a boolean readiness", async () => {
    const { data, status } = await api.ready.get();
    expect([200, 503]).toContain(status);
    expect(typeof data?.ready === "boolean" || data === null).toBe(true);
  });

  it("GET / returns api info with a docs link", async () => {
    const { data } = await api.get();
    expect(data?.name).toBe("wattsteer");
    expect(data?.docs).toBe("/docs");
  });

  it("echoes an x-request-id header for correlation", async () => {
    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.headers.get("x-request-id")).toBeTruthy();
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
    expect(await res.json()).toEqual({
      error: "Internal server error",
      code: "INTERNAL",
    });
  });
});

describe("api · swagger", () => {
  const req = (path: string) => app.handle(new Request(`http://localhost${path}`));

  it("serves the swagger UI at /docs", async () => {
    expect((await req("/docs")).status).toBe(200);
  });

  it("exposes the OpenAPI schema for the probe endpoints", async () => {
    const res = await req("/docs/json");
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(spec.paths["/health"]).toBeDefined();
    expect(spec.paths["/ready"]).toBeDefined();
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

  it("still sets security headers on error responses (e.g. 404)", async () => {
    const res = await req("/no-such-route");
    expect(res.status).toBe(404);
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
  // regression guard that matters is POST: the web app's browser calls must
  // survive a preflight once real routes exist.
  it("preflights a POST successfully", async () => {
    const res = await app.handle(
      new Request("http://localhost/", {
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

describe("api · ML proxy", () => {
  // The proxy's whole job is to answer "whose fault is this?" honestly, so
  // these test the failure branches rather than the happy path — an outage
  // reported as an API bug is the defect this module exists to prevent.
  const hit = (qs: string) =>
    app.handle(new Request(`http://localhost/forecast/day-ahead${qs}`));

  it("rejects an unknown subsystem before dialling out", async () => {
    const res = await hit("?subsystem=SIN");
    expect(res.status).toBe(422);
  });

  it("requires a subsystem", async () => {
    expect((await hit("")).status).toBe(422);
  });

  it("reports 'not configured' as an upstream fault, not an internal one", async () => {
    // WATTSTEER_ML_URL is unset in the test env. The distinction that matters:
    // a 502 says the dependency is absent; a 500 would say WattSteer is broken.
    const res = await hit("?subsystem=NE");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "The ML service is not configured",
      code: "OPTIMIZER_NOT_CONFIGURED",
    });
  });

  it("advertises the route in the OpenAPI schema", async () => {
    const res = await app.handle(new Request("http://localhost/docs/json"));
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(spec.paths["/forecast/day-ahead"]).toBeDefined();
  });
});

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

describe("api · the unmetered tier carries a directive it chose", () => {
  // `/`, `/health`, `/ready` and `/docs` shipped with no `Cache-Control` at
  // all, which leaves an intermediary free to invent a freshness lifetime by
  // heuristic. Each now names a row of `plugins/cache-policy.ts`, and the four
  // rows are four arguments — the assertions below are what stops a fifth
  // route inheriting one of them for being on the same tier.
  const hit = (path: string, headers?: Record<string, string>) =>
    app.handle(new Request(`http://localhost${path}`, { headers }));

  it("refuses to let a shared cache answer for the readiness probe", async () => {
    // `/ingest/health`'s argument verbatim: `/ready` reports whether the
    // database is reachable and answers 503 when it is not, so a cached 200 is
    // a monitor being told everything is fine with the cache doing the
    // silencing. And that 503 is set by the handler on its own body, so it
    // never reaches `errors.ts` and `refuseToCache` never sees it.
    const res = await hit("/ready");
    expect([200, 503]).toContain(res.status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
  });

  it("refuses to let a shared cache answer for the liveness probe", async () => {
    // A different argument, not `/ready`'s. `/health` always answers the same
    // constant body, which is exactly what makes it look cacheable: the only
    // information in the response is that *this* process produced it, and a
    // stored copy turns "is this instance alive" into "was one alive recently".
    const res = await hit("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
  });

  it("lets the banner be cached, and revalidates it against the build", async () => {
    // The opposite call, on the opposite kind of route: the banner is a
    // constant of the deployment with a digest over the bytes it will serve —
    // a content provenance, the canonical manifest's kind — so it is
    // shared-cacheable and correctness does not depend on the window.
    const res = await hit("/");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^W\//);

    const revalidated = await hit("/", { "if-none-match": etag as string });
    expect(revalidated.status).toBe(304);
    // A 304 with no validator cannot be repeated; one with no directive resets
    // the window it exists to extend.
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(revalidated.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("gives /docs a short window precisely because it has no validator", async () => {
    // Scalar's own document is a build constant too, but this gateway holds no
    // digest of it: the UI shell belongs to the plugin and the OpenAPI document
    // is assembled from the route table at request time. So the window is the
    // whole guarantee rather than a revalidation hint, and it is short for that
    // reason — five minutes of a stale route list after a deploy, self-healing.
    const res = await hit("/docs");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("etag")).toBeNull();
  });

  it("covers the OpenAPI document and not only the UI shell", async () => {
    // The shell is useless without it, and a document with no directive is the
    // half an intermediary would still be free to invent a lifetime for.
    const res = await hit("/docs/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
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
    expect((await hit("/up")).status).toBe(503);
  });

  it("maps unknown errors to 500 without leaking the message", async () => {
    const res = await hit("/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL", message: "Internal server error" },
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

describe("api · the day-ahead read is versioned and served from Postgres", () => {
  // This block used to exercise `ml-proxy`'s provisional `GET
  // /forecast/day-ahead`. api-surface ticket 11 deleted that route: it was
  // unversioned, it returned the modelling service's body verbatim where the
  // gateway owes a shaped *record*, it could not filter `origin_kind`, and it
  // put the most-viewed screen behind the ML service. What it tested — the
  // failure mapping, which survives and is the reason the module survives —
  // is `ml-proxy.test.ts`, one test per branch.
  const hit = (path: string) => app.handle(new Request(`http://localhost${path}`));

  it("has no unversioned forecast route", async () => {
    // 404 and not a 502: nothing is dialled, because nothing is mounted.
    const res = await hit("/forecast/day-ahead?subsystem=NE");
    expect(res.status).toBe(404);
  });

  it("publishes only the versioned route in the OpenAPI schema", async () => {
    const res = await hit("/docs/json");
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(spec.paths["/forecast/day-ahead"]).toBeUndefined();
    expect(spec.paths["/v1/forecast/day-ahead"]).toBeDefined();
  });

  it("answers the versioned route without the modelling service", async () => {
    // WATTSTEER_ML_URL is unset in the test env, and so is a database. The old
    // route answered 502 OPTIMIZER_NOT_CONFIGURED here — a modelling-service
    // fault on the most-viewed screen. The new one never looks: what is
    // missing is persistence, and it says so.
    const res = await hit("/v1/forecast/day-ahead?subsystem=NE");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "DATA_UNAVAILABLE" } });
  });

  it("mounts the diagnosis beside it, on the same terms", async () => {
    // The Explain screen's read is the other half of the boundary decision: an
    // attribution is a stored row, so with the modelling service absent the
    // only thing this route can be missing is persistence.
    const spec = (await (await hit("/docs/json")).json()) as {
      paths: Record<string, unknown>;
    };
    expect(spec.paths["/v1/diagnosis/day-ahead"]).toBeDefined();
    const res = await hit("/v1/diagnosis/day-ahead?subsystem=NE");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "DATA_UNAVAILABLE" } });
  });

  it("refuses a technology parameter on the diagnosis rather than ignoring it", async () => {
    // Refused before persistence is even consulted: there is one attribution
    // per subsystem-day, so the question cannot be answered rather than
    // answered with numbers that are not about it.
    const res = await hit("/v1/diagnosis/day-ahead?subsystem=NE&technology=wind");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_INPUT" } });
  });
});

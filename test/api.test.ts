import { describe, expect, it } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { app } from "../src/api/index.js";

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

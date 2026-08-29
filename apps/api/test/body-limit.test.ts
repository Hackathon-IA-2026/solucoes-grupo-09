import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { app } from "../src/api/index.js";
import {
  bodyLimit,
  exceedsLimit,
  MAX_BODY_BYTES,
  SOLVE_MAX_BODY_BYTES,
  solveBodyLimit,
} from "../src/api/plugins/body-limit.js";
import type { ErrorEnvelope } from "../src/errors.js";

/**
 * **Per-route body limits.** 10 MB is right for an ingestion endpoint and
 * wrong for a solver whose largest legal request is 4096 bytes. The property
 * that matters is not the number but *when* it is enforced: model construction
 * dominates a solve, so an illegal request must be refused on `Content-Length`
 * in `onRequest`, before a handler — or a body — exists.
 */

/** `Content-Length` is set by the wire; in-memory Requests need it spelled out. */
const sized = (path: string, bytes: number) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-length": String(bytes) },
  });

describe("bodyLimit · the ceilings", () => {
  test("exceedsLimit compares Content-Length to the max", () => {
    expect(exceedsLimit(null, 100)).toBe(false);
    expect(exceedsLimit("0", 100)).toBe(false);
    expect(exceedsLimit("100", 100)).toBe(false);
    expect(exceedsLimit("101", 100)).toBe(true);
  });

  test("the solve ceiling is 16 KB — four times the largest legal Scenario", () => {
    expect(SOLVE_MAX_BODY_BYTES).toBe(16 * 1024);
    expect(MAX_BODY_BYTES).toBe(10 * 1024 * 1024);
  });

  test("a scoped limit governs only the paths it applies to", async () => {
    const scoped = new Elysia()
      .use(solveBodyLimit())
      .post("/v1/optimize", () => ({ ok: true }))
      .post("/ingest", () => ({ ok: true }));
    expect((await scoped.handle(sized("/v1/optimize", 20 * 1024))).status).toBe(413);
    expect((await scoped.handle(sized("/ingest", 20 * 1024))).status).toBe(200);
  });

  test("the numeric shorthand still means a global ceiling", async () => {
    const global = new Elysia().use(bodyLimit(1024)).post("/anything", () => "ok");
    expect((await global.handle(sized("/anything", 2048))).status).toBe(413);
    expect((await global.handle(sized("/anything", 512))).status).toBe(200);
  });
});

describe("bodyLimit · the mounted surface", () => {
  test("a 20 KB body on /v1/optimize is a 413 before any handler runs", async () => {
    const response = await app.handle(sized("/v1/optimize", 20 * 1024));

    // The route itself does not exist yet, so a 404 would be the answer if the
    // limit ran anywhere later than `onRequest`. It is a 413 — the refusal
    // happens before routing, which is before allocation.
    expect(response.status).toBe(413);
    const body = (await response.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(body.error.details?.limit_bytes).toBe(SOLVE_MAX_BODY_BYTES);
  });

  test("/v1/replay carries the same ceiling", async () => {
    expect((await app.handle(sized("/v1/replay", 20 * 1024))).status).toBe(413);
  });

  test("the same body elsewhere is under the global 10 MB ceiling", async () => {
    // Not a 413: 20 KB is only too large for the solver.
    expect((await app.handle(sized("/no-such-route", 20 * 1024))).status).toBe(404);
  });

  test("a 4 KB Scenario is well within the solve ceiling", async () => {
    // The limit refuses on size, not on existence — this one gets as far as
    // routing, which is the point.
    expect((await app.handle(sized("/v1/optimize", 4096))).status).not.toBe(413);
  });
});

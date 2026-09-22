import { afterAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { Elysia } from "elysia";
import { errorHandler } from "../src/api/plugins/errors.js";
import { classifyTier } from "../src/api/plugins/rate-limit.js";
import { createReplayRoutes, reviewProvenance } from "../src/api/replay.js";

/**
 * The reviewed day, on the public surface: `/v1/replay/compare/<date>`,
 * `/v1/replay/timeline/<date>` and `/v1/replay/attribution/<date>`.
 *
 * The verdicts, the bands and the absences are `apps/ml`'s and are tested there
 * (`tests/test_replay_review.py`). What the gateway owns, and what is asserted
 * here: the path and the axes reach the modelling service as sent, a malformed
 * date is a 400 before anything is forwarded, a refusal keeps its own status
 * and code, the validator is built from the body's provenance and never from a
 * clock, and the three routes are metered as the reads they are.
 *
 * The modelling service is stood up for real on a loopback port, as
 * `replay-days.test.ts` does: the thing under test is a proxy.
 */

let reply: (request: Request) => Response = () => new Response("{}");
let asked: URL[] = [];
const upstream: Server = Bun.serve({
  port: 0,
  fetch: (request) => {
    asked.push(new URL(request.url));
    return reply(request);
  },
});
afterAll(() => upstream.stop(true));

const endpoint = { baseUrl: `http://127.0.0.1:${upstream.port}`, timeoutMs: 2000 };
const app = new Elysia().use(errorHandler).use(createReplayRoutes(endpoint));

const LANE = "dessem_free_v1__gate_late__thr5";

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; etag: string | null; body: unknown }> {
  asked = [];
  const response = await app.handle(new Request(`http://local${path}`, { headers }));
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    body: await response.json().catch(() => null),
  };
}

/** Two provenances that must reach the validator: an origin and a vintage. */
const compareBody = (dataVersion: string) => ({
  target_date: "2025-11-12",
  lane: LANE,
  vintage_fidelity: "revision_optimistic",
  subsystems: [
    {
      subsystem: "NE",
      forecast_origin: {
        producer: "wattsteer",
        run_label: "2025-10-01T03:10:00Z",
        published_at: "2025-11-11T22:00:00Z",
        origin_kind: "backfilled_holdout",
        gate_profile: "gate_late",
      },
      settled_data_version: dataVersion,
    },
  ],
  national: { day_total: null },
});

describe("replay review · the three routes forward the axes they were given", () => {
  it("forwards compare with its date in the path and its lane in the query", async () => {
    reply = () => Response.json(compareBody("3"));
    const { status, body } = await get(`/v1/replay/compare/2025-11-12?lane=${LANE}`);
    expect(status).toBe(200);
    expect(body).toEqual(compareBody("3"));
    expect(asked[0]?.pathname).toBe("/v1/replay/compare/2025-11-12");
    expect(asked[0]?.searchParams.get("lane")).toBe(LANE);
  });

  it("forwards the timeline with its subsystem", async () => {
    reply = () => Response.json({ subsystem: "NE", gates: [], events: [] });
    const { status } = await get("/v1/replay/timeline/2025-11-12?subsystem=NE");
    expect(status).toBe(200);
    expect(asked[0]?.pathname).toBe("/v1/replay/timeline/2025-11-12");
    expect(asked[0]?.searchParams.get("subsystem")).toBe("NE");
  });

  it("forwards the attribution with both its subsystem and its lane", async () => {
    reply = () => Response.json({ attribution: null });
    const { status } = await get(
      `/v1/replay/attribution/2025-11-12?subsystem=SE&lane=${LANE}`,
    );
    expect(status).toBe(200);
    expect(asked[0]?.pathname).toBe("/v1/replay/attribution/2025-11-12");
    expect(asked[0]?.searchParams.get("subsystem")).toBe("SE");
    expect(asked[0]?.searchParams.get("lane")).toBe(LANE);
  });
});

describe("replay review · a malformed request never reaches the modelling service", () => {
  it("refuses a date that is not a civil date, before forwarding", async () => {
    const { status, body } = await get(`/v1/replay/compare/12-11-2025?lane=${LANE}`);
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("BAD_INPUT");
    expect(asked).toEqual([]);
  });

  it("refuses a subsystem that is not one of the four", async () => {
    const { status } = await get("/v1/replay/timeline/2025-11-12?subsystem=SIN");
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(asked).toEqual([]);
  });
});

describe("replay review · a refusal keeps its own status and its own code", () => {
  it("passes an integrity violation through as the 500 it is", async () => {
    reply = () =>
      Response.json(
        { error: { code: "REPLAY_INTEGRITY_VIOLATION", message: "leak" } },
        { status: 500 },
      );
    const { status, body } = await get(`/v1/replay/compare/2025-11-12?lane=${LANE}`);
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe(
      "REPLAY_INTEGRITY_VIOLATION",
    );
  });
});

describe("replay review · the validator is the body's provenance", () => {
  it("moves when ONS restates the day, and holds when nothing moved", async () => {
    reply = () => Response.json(compareBody("3"));
    const first = await get(`/v1/replay/compare/2025-11-12?lane=${LANE}`);
    const again = await get(`/v1/replay/compare/2025-11-12?lane=${LANE}`);
    reply = () => Response.json(compareBody("4"));
    const restated = await get(`/v1/replay/compare/2025-11-12?lane=${LANE}`);
    expect(first.etag).not.toBeNull();
    expect(again.etag).toBe(first.etag);
    expect(restated.etag).not.toBe(first.etag);
  });

  it("answers a matching validator with a 304 and no body", async () => {
    reply = () => Response.json(compareBody("3"));
    const first = await get(`/v1/replay/compare/2025-11-12?lane=${LANE}`);
    const revalidated = await get(`/v1/replay/compare/2025-11-12?lane=${LANE}`, {
      "if-none-match": first.etag ?? "",
    });
    expect(revalidated.status).toBe(304);
  });

  it("collects origins, versions and write instants, and nothing else", () => {
    const found = reviewProvenance({
      a: { published_at: "p", run_label: "r", day_total: { p50: 3 } },
      rows: [{ settled_data_version: "7" }, { written_at: "w" }],
      settled: { latest_written_at: "l", settled_total_mwh: 12 },
      events: [{ kind: "settled_restated", data_version: "8" }],
    });
    expect(found).toEqual(["p", "r", "7", "w", "l", "8"]);
  });
});

describe("replay review · metered as reads, not as solves", () => {
  it("names all three out of the solve tier the /v1/replay prefix would give them", () => {
    for (const path of [
      "/v1/replay/compare/2025-11-12",
      "/v1/replay/timeline/2025-11-12",
      "/v1/replay/attribution/2025-11-12",
    ]) {
      expect(classifyTier("GET", path)).toBe("read");
    }
    // The prefix still meters the solve itself.
    expect(classifyTier("GET", "/v1/replay")).toBe("solve");
  });
});

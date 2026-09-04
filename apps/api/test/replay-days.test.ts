import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ERROR_STATUS } from "@wattsteer/core/errors";
import type { Server } from "bun";
import { Elysia } from "elysia";
import { errorHandler } from "../src/api/plugins/errors.js";
import { createReplayRoutes } from "../src/api/replay.js";

/**
 * The replayable calendar, on the public surface.
 *
 * The predicate itself lives in `apps/ml/src/wattsteer_ml/replay/` and is tested
 * there, against fixtures, without a database — that is the seam. What is
 * asserted here is the half the gateway owns and the ML service cannot: that
 * every one of `replay.md`'s five refusals arrives at the client as **its own
 * status and its own code**, out of the closed vocabulary in
 * `@wattsteer/core/errors`, and never as one flattened "no".
 *
 * The modelling service is stood up for real on a loopback port rather than
 * mocked, exactly as `ml-proxy.test.ts` does it: the thing under test is a
 * proxy, and a stubbed `fetch` would be testing the stub.
 */

/** What the stub answers next. Set by each test before it calls. */
let reply: () => Response = () => new Response("{}");
const upstream: Server = Bun.serve({ port: 0, fetch: () => reply() });
afterAll(() => upstream.stop(true));

const endpoint = { baseUrl: `http://127.0.0.1:${upstream.port}`, timeoutMs: 2000 };
/** The routes behind the gateway's own envelope — the shape a client sees. */
const mounted = (ep: typeof endpoint) =>
  new Elysia().use(errorHandler).use(createReplayRoutes(ep));
const app = mounted(endpoint);

const refuses = (status: number, code: string) => {
  reply = () =>
    new Response(JSON.stringify({ error: { code, message: code } }), {
      status,
      headers: { "content-type": "application/json" },
    });
};

/** One day, as much of it as these assertions read. */
interface DayBody {
  provenance?: string;
  held_out_by?: { calibration_window?: string[] };
}

/** Either answer: the calendar, or the envelope a refusal is rendered into. */
interface JsonBody {
  error?: { code: string; message?: string };
  days?: DayBody[];
}

async function get(path: string): Promise<{ status: number; body: JsonBody }> {
  const response = await app.handle(new Request(`http://local${path}`));
  return { status: response.status, body: await response.json().catch(() => null) };
}

const CALENDAR = "/v1/replay/days?subsystem=NE&lane=dessem_free_v1__gate_late__thr5";
const ONE_DAY =
  "/v1/replay/days/2025-11-12?subsystem=NE&lane=dessem_free_v1__gate_late__thr5";

describe("replay · the calendar is server-evaluated and proxied whole", () => {
  it("returns the modelling service's calendar unchanged", async () => {
    const calendar = {
      subsystem: "NE",
      lane: "dessem_free_v1__gate_late__thr5",
      counts: { days: 1, replayable: 1, refused: {} },
      days: [
        {
          date: "2025-11-12",
          replayable: true,
          provenance: "fold_holdout",
          vintage_fidelity: "revision_optimistic",
          model_saw_this_day: false,
          held_out_by: {
            fold: "F3",
            artifact_id: "2025-10-01T03:10:00Z",
            train_window: ["2024-04-01", "2025-09-30"],
            calibration_window: ["2025-07-03", "2025-09-30"],
          },
        },
      ],
    };
    reply = () =>
      new Response(JSON.stringify(calendar), {
        headers: { "content-type": "application/json" },
      });
    const { status, body } = await get(CALENDAR);
    expect(status).toBe(200);
    // Byte-for-byte, because the body is already the wire casing. A second
    // translation here would be a second vocabulary.
    expect(body).toEqual(calendar);
  });

  it("carries provenance and both windows, not a training cut", async () => {
    reply = () =>
      new Response(
        JSON.stringify({
          days: [
            {
              date: "2026-08-01",
              replayable: true,
              provenance: "served",
              held_out_by: {
                fold: "F6",
                artifact_id: "a",
                train_window: ["2024-04-01", "2026-06-30"],
                calibration_window: ["2026-04-02", "2026-06-30"],
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    const { body } = await get(CALENDAR);
    const day = body.days?.[0];
    expect(day).toBeDefined();
    expect(day?.provenance).toBe("served");
    expect(day?.held_out_by?.calibration_window).toEqual(["2026-04-02", "2026-06-30"]);
  });
});

describe("replay · one typed refusal per failing clause", () => {
  // The table `replay.md` publishes, asserted as the pair a client reads.
  const table: [string, number][] = [
    ["REPLAY_DATE_BEFORE_HOLDOUT_WINDOW", 422],
    ["REPLAY_DATE_OUT_OF_RANGE", 422],
    ["REPLAY_FORECAST_UNAVAILABLE", 404],
    ["REPLAY_OBSERVATION_INCOMPLETE", 404],
    ["REPLAY_INTEGRITY_VIOLATION", 500],
  ];

  for (const [code, status] of table) {
    it(`${code} arrives as ${status} and keeps its code`, async () => {
      refuses(status, code);
      const answer = await get(ONE_DAY);
      expect(answer.status).toBe(status);
      expect(answer.body.error?.code).toBe(code);
    });
  }

  it("every replay code is in the closed vocabulary at the spec's status", () => {
    // The status is a property of the code and not of the throw site, so this
    // is checkable without a request — and a code the enum has no room for
    // could not be proxied at all.
    for (const [code, status] of table) {
      expect(ERROR_STATUS[code as keyof typeof ERROR_STATUS]).toBe(status);
    }
  });

  it("the four data refusals do not collapse into one 'no'", async () => {
    const seen = new Set<string>();
    for (const [code, status] of table) {
      refuses(status, code);
      const answer = await get(ONE_DAY);
      seen.add(`${answer.status}:${answer.body.error?.code}`);
    }
    expect(seen.size).toBe(table.length);
  });

  it("an integrity violation is a 500 and never a rendered day", async () => {
    refuses(500, "REPLAY_INTEGRITY_VIOLATION");
    const answer = await get(ONE_DAY);
    expect(answer.status).toBe(500);
    expect(answer.body.days).toBeUndefined();
    expect(answer.body.error?.code).toBe("REPLAY_INTEGRITY_VIOLATION");
  });
});

describe("replay · the request itself", () => {
  it("refuses a malformed date before it reaches the window predicate", async () => {
    // A date that is not a date is a statement about the request;
    // REPLAY_DATE_OUT_OF_RANGE is a statement about the window. Rounding the
    // first to the second would say a date is outside a range when it is not a
    // date at all.
    const answer = await get(
      "/v1/replay/days/2025-13-99?subsystem=NE&lane=dessem_free_v1__gate_late__thr5",
    );
    expect(answer.status).toBe(ERROR_STATUS.BAD_INPUT);
    expect(answer.body.error?.code).toBe("BAD_INPUT");
  });

  it("requires a lane and never defaults one", async () => {
    // The open decision, on the wire: nothing here chooses between the two
    // lanes a post-go-live day can be replayed from.
    const answer = await get("/v1/replay/days?subsystem=NE");
    expect(answer.status).toBe(422);
  });

  it("forwards the lane rather than resolving it", async () => {
    let seen = "";
    reply = () => new Response("{}", { headers: { "content-type": "application/json" } });
    const stub: Server = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen = new URL(request.url).search;
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    const routes = mounted({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      timeoutMs: 2000,
    });
    await routes.handle(new Request(`http://local${CALENDAR}&from=2025-04-01`));
    stub.stop(true);
    expect(seen).toContain("lane=dessem_free_v1__gate_late__thr5");
    expect(seen).toContain("from=2025-04-01");
  });
});

describe("replay · where the assertion lives", () => {
  /**
   * The gateway must not grow a second copy of the held-out predicate. It has
   * no artifact volume, so any version it could write would be asserted against
   * something other than the artifact card — which is the prototype's mistake
   * (`date <= MODEL_TRAINED_THROUGH`, the right question asked of the wrong
   * artifact) in a new place.
   */
  const source = readFileSync(new URL("../src/api/replay.ts", import.meta.url), "utf8");

  it("does not compare a date against a training window", () => {
    const body = source
      .split("\n")
      .filter((line) => !(line.trim().startsWith("*") || line.trim().startsWith("//")))
      .join("\n");
    expect(body).not.toContain("trained_through");
    expect(body).not.toContain("trainedThrough");
    expect(body).not.toContain("calibration_start");
    expect(body).not.toContain("MODEL_TRAINED_THROUGH");
  });

  it("resolves no artifact and reads no card", () => {
    expect(source).not.toContain("card.json");
    expect(source).not.toContain("load_promoted");
  });
});

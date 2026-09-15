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
    reply = () => Response.json(calendar);
    const { status, body } = await get(CALENDAR);
    expect(status).toBe(200);
    // Byte-for-byte, because the body is already the wire casing. A second
    // translation here would be a second vocabulary.
    expect(body).toEqual(calendar);
  });

  it("carries provenance and both windows, not a training cut", async () => {
    reply = () =>
      Response.json({
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
      });
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

/**
 * The calendar's row of `api-surface.md`'s caching table — api-surface 20.
 *
 * The table asks for `W/"<featured-days computation id>"` on these routes, and
 * `replay.ts` used to record that the id did not exist yet. Replay 07 landed it:
 * the shortlist travels *on* the calendar by `replay.md`'s own endpoint table,
 * so the validator is a field of a body the gateway is already holding, and it
 * is a digest over the basis rather than over the answer — a rerun that changes
 * one hour of one day moves it, and a rerun that changes nothing does not.
 */
describe("replay · the calendar caches on the shortlist's computation id", () => {
  const CALENDAR_BODY = (computationId: string | null) => ({
    subsystem: "NE",
    lane: "dessem_free_v1__gate_late__thr5",
    counts: { days: 0, replayable: 0, refused: {} },
    days: [],
    featured:
      computationId === null
        ? { state: "pending", computation_id: null, days: [] }
        : { state: "ready", computation_id: computationId, days: [] },
  });

  const answer = (body: unknown) => {
    reply = () => Response.json(body);
  };

  const ask = (path: string, headers: Record<string, string> = {}) =>
    app.handle(new Request(`http://local${path}`, { headers }));

  it("puts the computation id on the ETag beside the request's own axes", async () => {
    answer(CALENDAR_BODY("sha256:deadbeef"));
    const response = await ask(CALENDAR);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const etag = response.headers.get("etag") ?? "";
    expect(etag).toContain("sha256:deadbeef");
    // One computation id covers one (subsystem, lane) shortlist while the
    // calendar around it is cut to a window: two windows are two responses and
    // must not share a validator.
    expect(etag).toContain("NE");
  });

  it("revalidates to a 304 against it", async () => {
    answer(CALENDAR_BODY("sha256:deadbeef"));
    const etag = (await ask(CALENDAR)).headers.get("etag") ?? "";
    const again = await ask(CALENDAR, { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("moves the validator when the nightly recompute moves the basis", async () => {
    answer(CALENDAR_BODY("sha256:deadbeef"));
    const before = (await ask(CALENDAR)).headers.get("etag");
    answer(CALENDAR_BODY("sha256:cafe"));
    expect((await ask(CALENDAR)).headers.get("etag")).not.toBe(before);
  });

  it("serves a pending shortlist with the directive and no validator", async () => {
    // There is no computation to name, and inventing a hash of the body would
    // be a revalidation costing exactly what it saves.
    answer(CALENDAR_BODY(null));
    const response = await ask(CALENDAR);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("etag")).toBeNull();
  });

  it("gives one day the read's directive and never the solve's", async () => {
    // `/v1/replay/days/<date>` was once metered at the *solver's* rate purely
    // because it lives under `/v1/replay`. It is a date picker, and caching has
    // the same trap: an hour, not the replay's ten minutes.
    answer({ date: "2025-11-12", replayable: true });
    const response = await ask(ONE_DAY);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    // No validator: one day's verdict carries no shortlist, so there is no
    // computation id on this body to name. A gap in the ML contract, recorded
    // rather than papered over with a hash of the answer.
    expect(response.headers.get("etag")).toBeNull();
  });

  it("caches the backtest on its own computation id, which is the same digest", async () => {
    answer({
      state: "ready",
      computation_id: "sha256:aggregate",
      computed_at: "2026-08-28T06:00:00Z",
      rows: [],
    });
    const response = await app.handle(
      new Request(
        "http://local/v1/backtest?fold=F3&subsystem=NE&lane=dessem_free_v1__gate_late__thr5",
      ),
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("etag")).toContain("sha256:aggregate");
  });
});

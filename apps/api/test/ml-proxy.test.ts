import { afterAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { callMl, type MlEndpoint } from "../src/api/ml-proxy.js";
import { type ErrorCode, type ErrorStatus, toErrorEnvelope } from "../src/errors.js";

// The module's whole purpose is that a caller can tell whose fault a failure
// was, so these tests are one per failure branch and each asserts the pair the
// caller actually reads: the status and the code. A branch that agrees with
// another branch on both is the defect, not a duplicate test.
//
// The ML service is stood up for real on a loopback port rather than mocked,
// because three of the branches — refused, timed out, answered badly — are
// distinctions the network makes and a stubbed `fetch` would have to fake.

/** What the stub answers next. Set by each test before it calls. */
let reply: () => Response | Promise<Response> = () => new Response("{}");

const upstream: Server = Bun.serve({ port: 0, fetch: () => reply() });

/** A port nothing is listening on: opened, its number kept, then closed. */
const closedPort = (() => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = probe;
  probe.stop(true);
  return port;
})();

afterAll(() => {
  upstream.stop(true);
});

const endpoint = (overrides: Partial<MlEndpoint> = {}): MlEndpoint => ({
  baseUrl: `http://127.0.0.1:${upstream.port}`,
  timeoutMs: 2000,
  ...overrides,
});

/** Call, and report what a client would see. */
async function outcome(
  ep: MlEndpoint,
): Promise<{ status: ErrorStatus; code: ErrorCode; details?: unknown }> {
  try {
    await callMl("/v1/optimize", new URLSearchParams(), ep);
  } catch (error) {
    const { status, body } = toErrorEnvelope(error);
    return { status, code: body.error.code, details: body.error.details };
  }
  throw new Error("expected callMl to throw");
}

/** Answer as the ML service would, with its own status and its own code. */
const answers = (status: number, code?: string) => {
  reply = () =>
    new Response(code ? JSON.stringify({ error: { code } }) : "{}", {
      status,
      headers: { "content-type": "application/json" },
    });
};

describe("ml-proxy · failure mapping", () => {
  it("an unconfigured URL is 'absent', not 'broken'", async () => {
    // Dialling `undefined` and reporting the fetch error would file a missing
    // capability as an upstream fault.
    expect(await outcome(endpoint({ baseUrl: undefined }))).toMatchObject({
      status: 503,
      code: "OPTIMIZER_NOT_CONFIGURED",
    });
  });

  it("a refused connection says 'don't bother yet'", async () => {
    expect(
      await outcome(endpoint({ baseUrl: `http://127.0.0.1:${closedPort}` })),
    ).toMatchObject({ status: 503, code: "OPTIMIZER_UNAVAILABLE" });
  });

  it("a timeout says 'retry', which a refused connection does not", async () => {
    reply = () => new Promise<Response>(() => {});
    expect(await outcome(endpoint({ timeoutMs: 60 }))).toMatchObject({
      status: 503,
      code: "OPTIMIZER_TIMEOUT",
    });
  });

  it("an upstream 502/503/504 is an ML outage, never a WattSteer bug", async () => {
    for (const status of [502, 503, 504]) {
      answers(status);
      expect(await outcome(endpoint())).toMatchObject({
        status: 503,
        code: "OPTIMIZER_NOT_READY",
      });
    }
  });

  it("a rejected scenario keeps its 422 and its code — it is not an outage", async () => {
    answers(422, "SHIFT_EXCEEDS_BASELINE");
    expect(await outcome(endpoint())).toMatchObject({
      status: 422,
      code: "SHIFT_EXCEEDS_BASELINE",
    });
  });

  it("a solver bug surfaces as 500 SOLVER_BUG, distinct from an outage", async () => {
    answers(500, "SOLVER_BUG");
    expect(await outcome(endpoint())).toMatchObject({
      status: 500,
      code: "SOLVER_BUG",
    });
  });

  it("an unclosed gap and a solver timeout are two different sentences", async () => {
    answers(503, "SOLVER_GAP_UNCLOSED");
    const gap = await outcome(endpoint());
    answers(504, "SOLVER_TIMEOUT");
    const timeout = await outcome(endpoint());

    expect(gap).toMatchObject({ status: 503, code: "SOLVER_GAP_UNCLOSED" });
    expect(timeout).toMatchObject({ status: 504, code: "SOLVER_TIMEOUT" });
    expect(gap.status).not.toBe(timeout.status);
    expect(gap.code).not.toBe(timeout.code);
  });

  it("a 4xx with a code the enum has no room for keeps its status, and the code travels in details", async () => {
    answers(409, "SOME_FUTURE_REFUSAL");
    expect(await outcome(endpoint())).toMatchObject({
      status: 409,
      code: "UPSTREAM_REJECTED",
      details: { upstream_status: 409, upstream_code: "SOME_FUTURE_REFUSAL" },
    });
  });

  it("carries an admitted code's own details through with it", async () => {
    // `MODEL_UNAVAILABLE` is required to arrive with `details.lane_state`
    // (`docs/specs/api-surface.md`, the four "no forecast" states): "nothing
    // has been trained", "a candidate was refused" and "the volume cannot say"
    // are three sentences and a screen renders three different things. This
    // function consumes the upstream body, so a route in front of it has no
    // second chance at the details — they either travel here or they are gone.
    reply = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "MODEL_UNAVAILABLE",
            details: { lane_state: "present_unpromoted", volume_mounted: true },
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    expect(await outcome(endpoint())).toMatchObject({
      status: 503,
      code: "MODEL_UNAVAILABLE",
      details: { lane_state: "present_unpromoted", volume_mounted: true },
    });
  });

  it("a status this API cannot represent is an upstream failure, not a guess", async () => {
    answers(418);
    expect(await outcome(endpoint())).toMatchObject({
      status: 503,
      code: "UPSTREAM_FAILED",
      details: { upstream_status: 418 },
    });
  });

  it("every branch is distinguishable from every other", async () => {
    // The acceptance criterion, asserted directly: no two failure branches
    // agree on the pair a client reads.
    const seen: Array<{ status: ErrorStatus; code: ErrorCode }> = [];
    const push = async (ep: MlEndpoint) => {
      const { status, code } = await outcome(ep);
      seen.push({ status, code });
    };

    await push(endpoint({ baseUrl: undefined }));
    await push(endpoint({ baseUrl: `http://127.0.0.1:${closedPort}` }));
    reply = () => new Promise<Response>(() => {});
    await push(endpoint({ timeoutMs: 60 }));
    answers(503);
    await push(endpoint());
    answers(422, "SUBSYSTEM_UNKNOWN");
    await push(endpoint());
    answers(500, "SOLVER_BUG");
    await push(endpoint());
    answers(503, "SOLVER_GAP_UNCLOSED");
    await push(endpoint());
    answers(504, "SOLVER_TIMEOUT");
    await push(endpoint());

    expect(new Set(seen.map((o) => o.code)).size).toBe(seen.length);
    expect(new Set(seen.map((o) => `${o.status}:${o.code}`)).size).toBe(seen.length);
  });

  it("passes a healthy answer through untouched", async () => {
    reply = () => Response.json({ status: "ok" });
    const response = await callMl(
      "/v1/forecast/day-ahead",
      new URLSearchParams(),
      endpoint(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

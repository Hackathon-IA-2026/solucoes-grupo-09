import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "@wattsteer/core";
import { encodeScenario } from "@wattsteer/core/scenario";
import { encodeWire } from "@wattsteer/core/wire";
import type { Server } from "bun";
import { Elysia } from "elysia";
import { app } from "../src/api/index.js";
import type { MlEndpoint } from "../src/api/ml-proxy.js";
import { createOptimizeRoutes } from "../src/api/optimize.js";
import { SOLVE_MAX_BODY_BYTES } from "../src/api/plugins/body-limit.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { requestContext } from "../src/api/plugins/request-context.js";
import { memoryCache, noCache, optimizeKey } from "../src/api/plugins/result-cache.js";
import { config } from "../src/config.js";
import type { ErrorEnvelope } from "../src/errors.js";

/**
 * **`/v1/optimize` — the two boxes earlier tickets could not tick, and the
 * failure table one row at a time.**
 *
 * Ticket 03 asserted that `?s=` and a `POST` body reach the identical canonical
 * bytes *at the transport level*, because no route existed to assert it
 * through. Ticket 04 asserted that a refused scenario never reaches the solver
 * at the module boundary, against a recorded call list. Both are now claims
 * about a wire, and this file makes them over one: a real ML service stands up
 * on a loopback port and records what it was actually sent, so "the gateway
 * never called it" is a fact about a socket rather than about a spy.
 *
 * The one thing deliberately not asserted here is the *content* of a plan. The
 * MILP has its own suite (ticket 01), the simulator has its own (ticket 02),
 * and a gateway test that also checked the numbers would be asserting the
 * solver twice and the transport once.
 */

// --- the ML service, as a recording loopback ---------------------------------

interface Recorded {
  path: string;
  method: string;
  body: string;
}

const received: Recorded[] = [];
let reply: () => Response = () => new Response("{}");

const upstream: Server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    received.push({
      path: new URL(request.url).pathname,
      method: request.method,
      body: await request.text(),
    });
    return reply();
  },
});

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

/** The shape the ML service answers a solved scenario with. */
function plan(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    scenario_hash: `sha256:${"0".repeat(64)}`,
    forecast_origin: "2026-08-28T12:00:00Z",
    vintage_fidelity: "point_in_time",
    threshold_mw: 5,
    planning_basis: "p50",
    execution_rule: "follow_curtailment",
    baseline_curtailment_mwh: 397,
    optimized_curtailment_mwh: 245.2,
    avoided_energy_mwh: 151.8,
    avoidability: 0.382,
    recovered_floor_mwh: 84.1,
    solver: { backend: "SCIP", status: "OPTIMAL", wall_time_ms: 3.2 },
    ...overrides,
  });
}

/** Answer as the solver would, stamping the build that solved it. */
function solves(body = plan(), build = config.optimizerBuild): void {
  reply = () =>
    new Response(body, {
      headers: { "content-type": "application/json", "x-optimizer-build": build },
    });
}

/** Answer as a failure the ML service names by code. */
function refuses(status: number, code: string): void {
  reply = () =>
    new Response(JSON.stringify({ error: { code } }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

// --- the scenario ------------------------------------------------------------

/**
 * A UTC calendar date is always today or tomorrow in Brasilia, and both are
 * admitted. Deriving it beats writing one down: a fixture with a fixed date
 * starts failing on `TARGET_DATE_OUT_OF_RANGE` the day after it is written.
 */
const TARGET_DATE = new Date().toISOString().slice(0, 10);

const SCENARIO: Scenario = {
  v: 1,
  subsystem: "NE",
  targetDate: TARGET_DATE,
  forecastOrigin: "2026-08-28T12:00:00Z",
  assets: [
    {
      assetType: "battery",
      label: "Battery",
      subsystem: "NE",
      maxPowerMw: 100,
      energyCapacityMwh: 300,
      roundTripEfficiency: 0.92,
      initialStateOfCharge: 0.2,
    },
  ],
  economicAssumptions: { brlPerMwh: 180 },
};

/**
 * The same scenario as a `POST` body, written the way a client would rather
 * than the way the canonical form does: keys out of order, a trailing zero on
 * the efficiency, and whitespace throughout. If the two transports do not meet
 * at the identical bytes, this is what shows it.
 */
const BODY = `{
  "economic_assumptions": { "brl_per_mwh": 180.0 },
  "assets": [ { "initial_state_of_charge": 0.20, "asset_type": "battery",
    "round_trip_efficiency": 0.920, "subsystem": "NE", "label": "Battery",
    "energy_capacity_mwh": 300.0, "max_power_mw": 100 } ],
  "forecast_origin": "2026-08-28T12:00:00Z",
  "target_date": "${TARGET_DATE}",
  "subsystem": "NE",
  "v": 1
}`;

const BLOB = encodeScenario(SCENARIO);

// --- the route under test ----------------------------------------------------

function routes(overrides: Parameters<typeof createOptimizeRoutes>[0]) {
  return new Elysia()
    .use(requestContext)
    .use(errorHandler)
    .use(createOptimizeRoutes(overrides));
}

function fresh() {
  return routes({ cache: memoryCache(), endpoint: endpoint() });
}

/** The same route with nothing remembered, for the claims about what is sent. */
function uncached() {
  return routes({ cache: noCache(), endpoint: endpoint() });
}

const get = (api: ReturnType<typeof fresh>, blob: string) =>
  api.handle(new Request(`http://localhost/v1/optimize?s=${encodeURIComponent(blob)}`));

const post = (api: ReturnType<typeof fresh>, body: string) =>
  api.handle(
    new Request("http://localhost/v1/optimize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );

async function envelope(response: Response): Promise<ErrorEnvelope["error"]> {
  return ((await response.json()) as ErrorEnvelope).error;
}

beforeEach(() => {
  received.length = 0;
  solves();
});

// --- box: both transports decode to identical canonical bytes ----------------

describe("optimize · one scenario, two verbs, one set of bytes", () => {
  it("a GET blob and a POST body reach the solver as the same bytes", async () => {
    // The box ticket 03 could only tick at the transport level, because no
    // route existed. It is a claim about what crosses a socket, and it is now
    // asserted as one: two differently-written requests, one payload. The
    // cache is off, because a hit would prove the parity by *not* calling and
    // the claim here is about what crosses the wire.
    const api = uncached();
    await get(api, BLOB);
    await post(api, BODY);

    expect(received).toHaveLength(2);
    expect(received[0]?.body).toBe(received[1]?.body as string);
    expect(received[0]?.path).toBe("/v1/optimize");
    expect(received[0]?.method).toBe("POST");
    // The canonical form: sorted keys, no insignificant whitespace, shortest
    // round-tripping numbers. `0.920` and `180.0` are gone.
    expect(received[0]?.body).toContain('"round_trip_efficiency":0.92');
    expect(received[0]?.body).not.toContain(" ");
  });

  it("both verbs answer inside one request, with no job id in the contract", async () => {
    const api = fresh();
    const answer = await get(api, BLOB);
    expect(answer.status).toBe(200);
    const text = await answer.text();
    for (const noun of ["job_id", '"job"', "poll", "queued", "status_url"]) {
      expect(text.toLowerCase()).not.toContain(noun);
    }
    expect((await post(api, BODY)).status).toBe(200);
  });

  it("a shared link is shared-cacheable and a POST is not", async () => {
    const api = fresh();
    expect((await get(api, BLOB)).headers.get("cache-control")).toBe(
      "public, max-age=300",
    );
    expect((await post(api, BODY)).headers.get("cache-control")).toBe("no-store");
  });
});

// --- box: a refused scenario never reaches the ML service --------------------

describe("optimize · the gate is in front of the solver, on the wire", () => {
  const refused: [string, string, Scenario][] = [
    [
      "an initial state of charge outside its own bounds",
      "SOC_INITIAL_OUT_OF_BOUNDS",
      {
        ...SCENARIO,
        assets: [{ ...SCENARIO.assets[0], initialStateOfCharge: 0.99 } as never],
      },
    ],
    [
      "a version this build cannot read",
      "SCENARIO_VERSION_UNSUPPORTED",
      { ...SCENARIO, v: 2 as never },
    ],
    [
      "an asset in another subsystem",
      "SUBSYSTEM_MISMATCH",
      {
        ...SCENARIO,
        assets: [{ ...SCENARIO.assets[0], subsystem: "S" } as never],
      },
    ],
    [
      "a magnitude a hand-edited URL could hand the solver",
      "MAGNITUDE_OUT_OF_RANGE",
      {
        ...SCENARIO,
        assets: [{ ...SCENARIO.assets[0], maxPowerMw: 1_000_000 } as never],
      },
    ],
  ];

  for (const [what, code, scenario] of refused) {
    it(`refuses ${what} without dialling the solver`, async () => {
      const api = fresh();
      const response = await post(api, JSON.stringify(encodeWire("Scenario", scenario)));
      expect(response.status).toBe(422);
      expect((await envelope(response)).code).toBe(code);
      // The box ticket 04 could only tick at the module boundary. Zero
      // recorded requests is the same claim, made over a socket.
      expect(received).toHaveLength(0);
    });
  }

  it("refuses an oversized blob before running a parser over it", async () => {
    const api = fresh();
    const response = await get(api, "A".repeat(5000));
    expect(response.status).toBe(422);
    expect((await envelope(response)).code).toBe("SCENARIO_TOO_LARGE");
    expect(received).toHaveLength(0);
  });

  it("refuses a body that is not JSON at all", async () => {
    const api = fresh();
    const response = await post(api, "not json");
    expect(response.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

// --- the failure table, one test per row -------------------------------------

describe("optimize · the failure table, one row at a time", () => {
  it("a solve whose gap was not closed is a 503 and never a plan", async () => {
    refuses(503, "SOLVER_GAP_UNCLOSED");
    const response = await get(fresh(), BLOB);
    expect(response.status).toBe(503);
    expect((await envelope(response)).code).toBe("SOLVER_GAP_UNCLOSED");
  });

  it("a solve that ran out of time is a 504, which is a different sentence", async () => {
    refuses(504, "SOLVER_TIMEOUT");
    const response = await get(fresh(), BLOB);
    expect(response.status).toBe(504);
    expect((await envelope(response)).code).toBe("SOLVER_TIMEOUT");
  });

  it("an infeasible model is ours, so it is a 500", async () => {
    // The do-nothing dispatch satisfies every constraint, so infeasibility can
    // only mean validation let something through — a WattSteer bug and never a
    // user error.
    refuses(500, "SOLVER_BUG");
    const response = await get(fresh(), BLOB);
    expect(response.status).toBe(500);
    expect((await envelope(response)).code).toBe("SOLVER_BUG");
  });

  it("a scenario the ML service re-validated and rejected is still a 422", async () => {
    refuses(422, "SOC_INITIAL_OUT_OF_BOUNDS");
    const response = await get(fresh(), BLOB);
    expect(response.status).toBe(422);
    expect((await envelope(response)).code).toBe("SOC_INITIAL_OUT_OF_BOUNDS");
  });

  it("an unreachable solver is a 502 and not a bad request", async () => {
    const api = routes({
      cache: memoryCache(),
      endpoint: endpoint({ baseUrl: `http://127.0.0.1:${closedPort}` }),
    });
    const response = await get(api, BLOB);
    expect(response.status).toBe(502);
    expect((await envelope(response)).code).toBe("OPTIMIZER_UNAVAILABLE");
  });

  it("the gateway waits five seconds for a solve and no longer", () => {
    // `flex-optimizer.md`: `SetTimeLimit(2000)`, gateway timeout 5 s. The
    // margin is what lets a 2 s solve answer as a 504 rather than as a
    // gateway timeout, which is a different and less useful sentence.
    expect(config.mlTimeoutMs).toBe(5000);
  });
});

// --- the cache: a provenance, never a duration -------------------------------

describe("optimize · the cache is keyed on provenance", () => {
  it("a hit is byte-identical and does not solve again", async () => {
    const api = fresh();
    const first = await (await get(api, BLOB)).text();
    const second = await (await get(api, BLOB)).text();
    // Byte-identical to each other *and* to what the solver said: the gateway
    // passes the text through rather than re-serialising a parsed object, so
    // "identical" is not a property of two `JSON.stringify` calls agreeing.
    expect(first).toBe(plan());
    expect(second).toBe(first);
    expect(received).toHaveLength(1);
  });

  it("a superseding forecast origin misses", async () => {
    // The reason the origin is in the key at all: a 12Z run must not be served
    // an 00Z plan.
    const api = fresh();
    await get(api, BLOB);
    const superseded = encodeScenario({
      ...SCENARIO,
      forecastOrigin: "2026-08-29T00:00:00Z",
    });
    await get(api, superseded);
    expect(received).toHaveLength(2);
  });

  it("a changed optimizer build misses", async () => {
    const cache = memoryCache();
    const before = routes({ cache, endpoint: endpoint(), optimizerBuild: "0.1.0" });
    const after = routes({ cache, endpoint: endpoint(), optimizerBuild: "0.2.0" });
    await get(before, BLOB);
    await get(after, BLOB);
    // A deploy that changes the formulation must not serve yesterday's plan
    // under today's code.
    expect(received).toHaveLength(2);
  });

  it("a plan solved by a build the gateway does not key on is served, not stored", async () => {
    solves(plan(), "9.9.9");
    const api = fresh();
    await get(api, BLOB);
    await get(api, BLOB);
    // Two solves: the answer was honoured and deliberately not remembered,
    // because a key naming the wrong build is a cache that lies.
    expect(received).toHaveLength(2);
  });

  it("the key names the scenario, the origin and the build, in that order", () => {
    expect(
      optimizeKey({
        scenarioHash: "sha256:abc",
        forecastOrigin: "2026-08-28T12:00:00Z",
        optimizerBuild: "0.1.0",
      }),
    ).toBe("opt:v1:sha256:abc:2026-08-28T12:00:00Z:0.1.0");
  });

  it("the gateway's build agrees with the ML service's, with nothing configured", () => {
    // The two are one string in two languages. Read rather than restated: a
    // comment saying "keep these in sync" is how they stop being in sync.
    const source = readFileSync(
      join(import.meta.dir, "../../ml/src/wattsteer_ml/__init__.py"),
      "utf8",
    );
    const version = /__version__\s*=\s*"([^"]+)"/.exec(source)?.[1];
    expect(version).toBeTruthy();
    expect(config.optimizerBuild).toBe(version as string);
  });
});

// --- the two guards mounted centrally, against a real handler ----------------

describe("optimize · the budget and the body cap, in front of a real route", () => {
  /** A distinct client per test, so one test's spending is not another's. */
  const solve = (ip: string) =>
    app.handle(
      new Request(`http://localhost/v1/optimize?s=${encodeURIComponent(BLOB)}`, {
        headers: { "x-forwarded-for": ip },
      }),
    );

  it("the solve tier's bucket fires on the eleventh request", async () => {
    // `rate-limit.ts` classifies `/v1/optimize` as the solve tier, and until
    // now it did so against a path with no route behind it. Burst 10, then the
    // sustained rate takes over — a slider drag must not be throttled, and an
    // unauthenticated MILP must not be a free compute service.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await solve("203.0.113.10")).status);
    }
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);

    const limited = await solve("203.0.113.10");
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await envelope(limited)).code).toBe("RATE_LIMITED");
  });

  it("the read tier is not what a solve spends against", async () => {
    // Eleven reads in a row is ordinary traffic; eleven solves is not.
    const reads: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      reads.push((await app.handle(new Request("http://localhost/v1/canonical"))).status);
    }
    expect(reads).not.toContain(429);
  });

  it("a body over 16 KB is a 413 before a handler exists", async () => {
    // Content-Length only exists on a real wire request, so this one boots an
    // ephemeral server: an in-memory `Request` carries no length and the cap
    // is deliberately enforced from the header, before a body is allocated.
    app.listen(0);
    try {
      const response = await fetch(`http://localhost:${app.server?.port}/v1/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(SOLVE_MAX_BODY_BYTES + 1024),
      });
      expect(response.status).toBe(413);
      expect((await envelope(response)).code).toBe("PAYLOAD_TOO_LARGE");
      // Four times the largest legal scenario, and still an order of magnitude
      // under the global ceiling.
      expect(SOLVE_MAX_BODY_BYTES).toBe(16 * 1024);
    } finally {
      await app.stop();
    }
  });
});

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "@wattsteer/core";
import { canonicalScenarioJson, encodeScenario } from "@wattsteer/core/scenario";
import type { Server } from "bun";
import { Elysia } from "elysia";
import { app } from "../src/api/index.js";
import type { MlEndpoint } from "../src/api/ml-proxy.js";
import { createOptimizeRoutes } from "../src/api/optimize.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { classifyTier } from "../src/api/plugins/rate-limit.js";
import {
  memoryCache,
  noCache,
  type ResultCache,
  redisCache,
} from "../src/api/plugins/result-cache.js";
import { createReplayRoutes, createReplaySolveRoutes } from "../src/api/replay.js";
import { config } from "../src/config.js";
import type { ErrorEnvelope } from "../src/errors.js";

/**
 * **The solver surface, as one thing.**
 *
 * `api-surface.md` lists four routes that genuinely call the modelling service
 * per request — `/v1/optimize`, `/v1/replay`, `/v1/replay/days` and
 * `/v1/backtest` — and each of them arrived here from a different ticket:
 * flex-optimizer 06 brought the optimizer, replay 02 the calendar, replay 06
 * the replay and its pin. Each is well tested *in itself*;
 * `optimize.test.ts`, `replay-days.test.ts` and `replay-endpoint.test.ts` are
 * where the transports, the refusal tables and the pin live and this file does
 * not repeat them.
 *
 * What no file asserted until now is the property that only exists across all
 * four: that they are **one surface** with one failure posture, one cache
 * discipline and one boundary — and that nothing outside them reaches the
 * solver. Those are properties of the set, so they get a file about the set.
 *
 * Two kinds of claim live here and the difference matters:
 *
 * - **Structural**, asserted over the source with comments stripped, because a
 *   rule a docstring can satisfy is not a rule. This is where "these are the
 *   only route handlers permitted to reach the modelling service" and "the
 *   scenario is never persisted" belong: a route that *cannot* call the solver
 *   is a stronger claim than a route that happened not to, and no fixture can
 *   make it.
 * - **Behavioural**, over the wire against a recording stub upstream, for the
 *   claims that are about what a client receives — the 503 posture, the cache
 *   directives, and the replay that completes with nothing promoted.
 *
 * The fourth route is absent and its absence is asserted from both ends. See
 * "the fourth route" below, and the block comment at the foot of
 * `src/api/replay.ts` for why it is not a proxy in front of nothing.
 */

// --- the modelling service, as a recording loopback --------------------------

interface Recorded {
  path: string;
  search: string;
  method: string;
  body: string;
}

const received: Recorded[] = [];
let reply: (request: Recorded) => Response = () => new Response("{}");

const upstream: Server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    const record: Recorded = {
      path: url.pathname,
      search: url.search,
      method: request.method,
      body: await request.text(),
    };
    received.push(record);
    return reply(record);
  },
});

afterAll(() => {
  upstream.stop(true);
});

const endpoint = (): MlEndpoint => ({
  baseUrl: `http://127.0.0.1:${upstream.port}`,
  timeoutMs: 2000,
});

/** A day inside F1–F5: a replayable date *and* a valid planning date. */
const PAST_DATE = "2025-06-15";
const LANE = "dessem_free_v1__gate_late__thr5";
const PINNED = "2025-06-14T13:00:00Z";

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    v: 1,
    subsystem: "NE",
    targetDate: PAST_DATE,
    forecastOrigin: PINNED,
    assets: [
      {
        assetType: "battery" as const,
        label: "Battery",
        subsystem: "NE" as const,
        maxPowerMw: 100,
        energyCapacityMwh: 300,
        roundTripEfficiency: 0.92,
        initialStateOfCharge: 0.2,
      },
    ],
    economicAssumptions: { brlPerMwh: 180 },
    ...overrides,
  } as Scenario;
}

/**
 * The two transports of one scenario. `blob` is what a shared link carries and
 * `canonicalBody` is what the app posts, and both are deliberately built by the
 * same encoder the gateway will canonicalise with — a body hand-written in
 * `camelCase` would be refused by the wire and would test the fixture rather
 * than the route.
 */
const blob = (over: Partial<Scenario> = {}) => encodeScenario(scenario(over));
const canonicalBody = (over: Partial<Scenario> = {}) =>
  canonicalScenarioJson(scenario(over));

/** A complete replay, trimmed to the keys the gateway reads plus the headline. */
function replayed(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    target_date: PAST_DATE,
    subsystem: "NE",
    threshold_mw: 5,
    vintage_fidelity: "point_in_time",
    scenario_hash: `sha256:${"0".repeat(64)}`,
    forecast_origin: {
      producer: "wattsteer",
      run_label: "F3__dessem_free_v1__gate_late__thr5",
      published_at: PINNED,
      origin_kind: "backfilled_holdout",
      gate_profile: "gate_late",
    },
    baseline_curtailment_mwh: 402.0,
    optimized_curtailment_mwh: 250.2,
    avoided_energy_mwh: 151.8,
    avoidability: 0.377,
    recovered_floor_mwh: 84.1,
    floor_met: true,
    ...overrides,
  });
}

/** An optimization result, likewise trimmed. */
function optimized(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    forecast_origin: PINNED,
    threshold_mw: 5,
    scenario_hash: `sha256:${"1".repeat(64)}`,
    avoided_energy_mwh: 88.4,
    ...overrides,
  });
}

/** Answer every call as the ML service would, stamping the build that solved. */
function answers(body: (request: Recorded) => string): void {
  reply = (request) =>
    new Response(body(request), {
      headers: {
        "content-type": "application/json",
        "x-optimizer-build": config.optimizerBuild,
      },
    });
}

/** The whole modelling service, down but reachable — an upstream 503. */
function unavailable(): void {
  reply = () =>
    new Response(JSON.stringify({ detail: "no workers" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
}

beforeEach(() => {
  received.length = 0;
  answers((request) => (request.path === "/v1/optimize" ? optimized() : replayed()));
});

// --- the surface under test, with one cache shared as it is in production ----

function surface(cache: ResultCache = noCache()) {
  return new Elysia()
    .use(errorHandler)
    .use(createOptimizeRoutes({ cache, endpoint: endpoint() }))
    .use(createReplayRoutes(endpoint()))
    .use(createReplaySolveRoutes({ cache, endpoint: endpoint() }));
}

const hit = (api: Elysia, path: string, init?: RequestInit) =>
  api.handle(new Request(`http://localhost${path}`, init));

const post = (api: Elysia, path: string, body: string) =>
  hit(api, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

const OPTIMIZE_GET = (s: string) => `/v1/optimize?s=${encodeURIComponent(s)}`;
const REPLAY_GET = (s: string) =>
  `/v1/replay?d=${PAST_DATE}&lane=${encodeURIComponent(LANE)}&s=${encodeURIComponent(s)}`;
const REPLAY_POST = `/v1/replay?lane=${encodeURIComponent(LANE)}`;
const OBSERVED_ONLY_POST = `/v1/replay/observed-only?lane=${encodeURIComponent(LANE)}`;
const CALENDAR = `/v1/replay/days?subsystem=NE&lane=${encodeURIComponent(LANE)}`;
const CALENDAR_DAY = `/v1/replay/days/${PAST_DATE}?subsystem=NE&lane=${encodeURIComponent(LANE)}`;

/** The status and the code, which together are the whole verdict a client sees. */
async function verdict(
  response: Response,
): Promise<{ status: number; code: string | null }> {
  if (response.ok) {
    return { status: response.status, code: null };
  }
  const body = (await response.json()) as ErrorEnvelope;
  return { status: response.status, code: body.error.code };
}

// --- the source, for the structural claims -----------------------------------

const SOURCE = join(import.meta.dir, "..", "src");
const REPO = join(import.meta.dir, "..", "..", "..");

/** Source with block and line comments removed — prose may not satisfy a rule. */
function code(absolute: string): string {
  return readFileSync(absolute, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Every route module: `src/api/*.ts`, which is where a handler may live.
 *
 * Three files there carry no routes and are excluded by name rather than by a
 * pattern, so a fourth cannot join them silently: `ml-proxy.ts` **is** the
 * boundary and naturally mentions everything the rules below forbid; `params.ts`
 * parses query strings; `scenario-gate.ts` validates a blob. `index.ts` is the
 * composition root and mounts the others rather than handling anything itself.
 * `plugins/` is a directory and never matches.
 */
const NOT_A_ROUTE_MODULE = ["index.ts", "ml-proxy.ts", "params.ts", "scenario-gate.ts"];

const ROUTE_MODULES: readonly string[] = readdirSync(join(SOURCE, "api"))
  .filter((name) => name.endsWith(".ts") && !NOT_A_ROUTE_MODULE.includes(name))
  .sort();

const routeSource = (name: string) => code(join(SOURCE, "api", name));

// --- box: all four routes are versioned, and the fourth is named -------------

describe("solver surface · four routes, three served, and one absence that is asserted", () => {
  /** Every path the gateway actually serves, from Elysia's own table. */
  const served = app.routes.map((route) => `${route.method} ${route.path}`);

  it("serves the solve and replay surface at /v1 and nowhere else", () => {
    expect(served).toEqual(
      expect.arrayContaining([
        "GET /v1/optimize",
        "POST /v1/optimize",
        "GET /v1/replay",
        "POST /v1/replay",
        "POST /v1/replay/observed-only",
        "GET /v1/replay/days",
        "GET /v1/replay/days/:date",
      ]),
    );
    // The version prefix is the *only* re-pathing this spec does to these two
    // contracts, so an unversioned twin would be the one way to make a client
    // choose between two spellings of one route.
    for (const route of app.routes) {
      const unversioned = /^\/(optimize|replay|backtest)\b/.test(route.path);
      expect(unversioned).toBe(false);
    }
  });

  it("routes every solver path through the tier its cost belongs to", () => {
    // The surface is one thing here too: the budget follows the solver and not
    // the verb, and the date picker is a read at every depth.
    expect(classifyTier("GET", "/v1/optimize")).toBe("solve");
    expect(classifyTier("POST", "/v1/optimize")).toBe("solve");
    expect(classifyTier("GET", "/v1/replay")).toBe("solve");
    expect(classifyTier("POST", "/v1/replay")).toBe("solve");
    expect(classifyTier("POST", "/v1/replay/observed-only")).toBe("solve");
    expect(classifyTier("GET", "/v1/replay/days")).toBe("read");
    expect(classifyTier("GET", `/v1/replay/days/${PAST_DATE}`)).toBe("read");
  });

  /**
   * **The fourth route, now served — and this test is the record of why it was
   * not.**
   *
   * `/v1/backtest` serves an aggregate of many Replays: `domain-model.md` gives
   * `Backtest` that noun, and not the forecaster's fold evaluation. When this
   * surface landed, replay 08 had not, and a gateway route in front of nothing
   * would have published an endpoint answering "the modelling service is
   * unavailable" forever — naming the wrong thing as broken. So the route was
   * absent and **both halves of the absence were pinned**, deliberately
   * arranged to fail the moment `apps/ml` grew the aggregate and to name this
   * route as owed.
   *
   * It did exactly that. Replay 08 landed `wattsteer_ml.replay.backtest`, both
   * assertions fired, and the route was added. What is asserted now is the
   * shape the absence argued for: the gateway **forwards** and does not
   * aggregate, because computing the table here would be a second scoring
   * implementation a network hop from the replay path it aggregates, and would
   * have to express fidelity-as-group-key in a query string — the one place
   * that rule cannot be enforced.
   */
  it("serves /v1/backtest now that there is an aggregate to serve", () => {
    expect(served.some((route) => route.includes("/v1/backtest"))).toBe(true);
    const ml = readFileSync(
      join(REPO, "apps", "ml", "src", "wattsteer_ml", "app.py"),
      "utf8",
    );
    // The half that made the absence honest: the aggregate really is upstream.
    expect(ml).toContain("/v1/backtest");
  });

  it("forwards the aggregate rather than computing it", () => {
    const body = code(join(SOURCE, "api", "replay.ts"));
    // No grouping, no averaging, no fidelity literal: a gateway that knew how
    // to pool rows would be the second implementation the absence argued
    // against, and a fidelity value in a query string is a filter the rule
    // forbids.
    for (const forbidden of [
      "floor_coverage",
      "days_replayed",
      "point_in_time",
      "revision_optimistic",
      "reduce(",
    ]) {
      expect({ forbidden, present: body.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });
});

// --- box: synchronous, with no job identifier anywhere -----------------------

describe("solver surface · one request, and no job noun on either route", () => {
  it("neither module names a job, a queue or a poll", () => {
    for (const name of ["optimize.ts", "replay.ts"]) {
      const source = routeSource(name);
      // Identifiers, not prose. Both routes' OpenAPI descriptions use the word
      // "poll" in order to promise there is nothing to poll for, and a scan
      // that cannot tell a mechanism from a promise would forbid the sentence
      // that makes the promise.
      for (const noun of [
        "jobId",
        "job_id",
        "OptimizationJob",
        "enqueue",
        "Queue",
        "setInterval",
      ]) {
        expect(source).not.toContain(noun);
      }
    }
  });

  it("answers a solve and a replay inside the request that asked", async () => {
    const api = surface();
    for (const [path, sent] of [
      [OPTIMIZE_GET(blob()), null],
      [REPLAY_GET(blob()), null],
      [REPLAY_POST, canonicalBody()],
    ] as const) {
      const response = sent === null ? await hit(api, path) : await post(api, path, sent);
      expect(response.status).toBe(200);
      const answer = (await response.json()) as Record<string, unknown>;
      // The answer is the answer. Not a location to poll, not an id to hold.
      expect(answer).not.toHaveProperty("job_id");
      expect(answer).not.toHaveProperty("status_url");
      expect(response.headers.get("location")).toBeNull();
    }
  });
});

// --- box: these are the only handlers that may reach the modelling service ---

/**
 * **Who may cross the boundary, and by which verb.**
 *
 * The ticket's claim is "these are the only route handlers permitted to reach
 * the modelling service, asserted structurally". Asserted literally over
 * `ml-proxy` it is false, and the honest thing is to say which two others
 * cross and why rather than to widen the rule until it means nothing:
 *
 * | module          | verb      | why it crosses                                |
 * |-----------------|-----------|-----------------------------------------------|
 * | `optimize.ts`   | `postMl`  | the MILP — a solve cannot be precomputed      |
 * | `replay.ts`     | both      | the replay solve, and the calendar's predicate|
 * | `meta.ts`       | `callMl`  | the modelling service's self-description      |
 * | `model-card.ts` | `callMl`  | the card is a file on the ML service's volume |
 *
 * The rule that *is* exactly true, and is the one worth having, is about the
 * **solver**: `postMl` is the verb that carries canonical scenario bytes to a
 * MILP, and only these two route modules may use it. `meta.ts` and
 * `model-card.ts` cross with a `GET` for a document, which is a read of the
 * artifact volume the gateway does not have, and neither can reach the solver
 * even by accident.
 *
 * Both lists are exact rather than "contains", so a new route that quietly
 * dials the modelling service fails here rather than being discovered when it
 * takes the landing page down with it.
 */
describe("solver surface · the boundary, and who may cross it", () => {
  const SOLVER_CALLERS = ["optimize.ts", "replay.ts"];
  const BOUNDARY_CROSSERS = ["meta.ts", "model-card.ts", "optimize.ts", "replay.ts"];

  it("only the optimizer and the replay may reach the solver", () => {
    const callers = ROUTE_MODULES.filter((name) => routeSource(name).includes("postMl"));
    expect(callers).toEqual(SOLVER_CALLERS);
  });

  it("only four route modules import the proxy at all, and the other two only read", () => {
    const crossers = ROUTE_MODULES.filter((name) =>
      routeSource(name).includes("ml-proxy.js"),
    );
    expect(crossers).toEqual(BOUNDARY_CROSSERS);
    for (const name of ["meta.ts", "model-card.ts"]) {
      expect(routeSource(name)).toContain("callMl");
      expect(routeSource(name)).not.toContain("postMl");
    }
  });

  it("no route module dials the modelling service around the proxy", () => {
    // One mapping, or the honest answer to "whose fault was it" has two
    // implementations that will not agree. `plants.ts` fetches nothing and
    // `canonical.ts` reads Postgres; a `fetch(` in either would be a route
    // reaching for a network the boundary is supposed to own.
    for (const name of ROUTE_MODULES) {
      const source = routeSource(name);
      expect(source).not.toContain("config.mlUrl");
      if (!BOUNDARY_CROSSERS.includes(name)) {
        expect(source).not.toContain("fetch(");
      }
    }
  });
});

// --- box: the modelling service at 503 ---------------------------------------

/**
 * **What a client sees when the solver is down, and who is unaffected.**
 *
 * The spec's failure table promises that an ML outage costs Mitigate and Time
 * Machine's replay and nothing else. Two claims, asserted two ways:
 *
 * - The routes that *do* cross the boundary say so, at 503 with the code that
 *   means "up but not serving" — never at 500, which would file an ML outage as
 *   a WattSteer bug.
 * - The routes that do not cross it **cannot be affected**, which is asserted
 *   structurally rather than by a status code. That is deliberate: with no
 *   database configured these reads answer `DATA_UNAVAILABLE`, so a `200` here
 *   would be a fixture's property and not the surface's. "There is no path from
 *   this handler to the modelling service" is the claim that actually carries
 *   the promise, and it holds in every deployment rather than in a seeded one.
 */
describe("solver surface · with the modelling service returning 503", () => {
  const READS_WITH_NO_MODEL_PATH = [
    "grid.ts",
    "curtailment.ts",
    "forecast.ts",
    "plants.ts",
    "canonical.ts",
  ];

  it("every solve route answers 503 OPTIMIZER_NOT_READY", async () => {
    unavailable();
    const api = surface();
    const answers = await Promise.all([
      verdict(await hit(api, OPTIMIZE_GET(blob()))),
      verdict(await post(api, "/v1/optimize", canonicalBody())),
      verdict(await hit(api, REPLAY_GET(blob()))),
      verdict(await post(api, REPLAY_POST, canonicalBody())),
      verdict(await post(api, OBSERVED_ONLY_POST, canonicalBody())),
      verdict(await hit(api, CALENDAR)),
      verdict(await hit(api, CALENDAR_DAY)),
    ]);
    for (const answer of answers) {
      expect(answer).toEqual({ status: 503, code: "OPTIMIZER_NOT_READY" });
    }
  });

  it("the read routes have no path to the modelling service to be broken by", () => {
    for (const name of READS_WITH_NO_MODEL_PATH) {
      const source = routeSource(name);
      expect(source).not.toContain("ml-proxy");
      expect(source).not.toContain("mlUrl");
      expect(source).not.toContain("fetch(");
    }
  });

  it("/v1/meta still answers 200 with no modelling service at all", async () => {
    // The one route that crosses the boundary and is still obliged to answer:
    // it is what an operator reads to discover the outage, so it degrades into
    // a field rather than failing. `reachable: false` and the reason, not a 502.
    const response = await hit(app, "/v1/meta");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { model?: Record<string, unknown> };
    expect(body.model?.reachable).toBe(false);
    expect(typeof body.model?.unreachable_reason).toBe("string");
  });
});

// --- box: two verbs, one set of canonical bytes, one cache key ---------------

describe("solver surface · the query form and the body form are one request", () => {
  it("both routes send byte-identical bytes whichever verb carried them", async () => {
    const api = surface();
    await hit(api, OPTIMIZE_GET(blob()));
    await post(api, "/v1/optimize", canonicalBody());
    await hit(api, REPLAY_GET(blob()));
    await post(api, REPLAY_POST, canonicalBody());

    const optimizeCalls = received.filter((call) => call.path === "/v1/optimize");
    const replayCalls = received.filter((call) => call.path === "/v1/replay");
    expect(optimizeCalls).toHaveLength(2);
    expect(replayCalls).toHaveLength(2);
    expect(optimizeCalls[0]?.body).toBe(optimizeCalls[1]?.body as string);
    expect(replayCalls[0]?.body).toBe(replayCalls[1]?.body as string);
  });

  it("a GET warms the key a POST hits, on both routes", async () => {
    const cache = memoryCache();
    const api = surface(cache);

    // Optimizer: GET first, then POST. One upstream call between them.
    await hit(api, OPTIMIZE_GET(blob()));
    const afterGet = received.filter((call) => call.path === "/v1/optimize").length;
    const fromCache = await post(api, "/v1/optimize", canonicalBody());
    expect(received.filter((call) => call.path === "/v1/optimize")).toHaveLength(
      afterGet,
    );
    expect(await fromCache.text()).toBe(optimized());

    // Replay: the same, under its own prefix and its own key.
    await hit(api, REPLAY_GET(blob()));
    const afterReplayGet = received.filter((call) => call.path === "/v1/replay").length;
    const replayFromCache = await post(api, REPLAY_POST, canonicalBody());
    expect(received.filter((call) => call.path === "/v1/replay")).toHaveLength(
      afterReplayGet,
    );
    expect(await replayFromCache.text()).toBe(replayed());
  });
});

// --- box: the scenario is carried, never stored ------------------------------

/**
 * **A cache, and nothing that could be mistaken for persistence.**
 *
 * `api-surface.md` refuses a scenario-shortening service on the ground that it
 * would invent the persistence and the identity the domain model spent a
 * section removing. That refusal is only true if the result cache stays a
 * cache: evictable at any moment, at the cost of one solve and no correctness.
 */
describe("solver surface · the scenario is carried, and the cache is evictable", () => {
  it("neither route module can write anything anywhere", () => {
    for (const name of ["optimize.ts", "replay.ts"]) {
      const source = routeSource(name);
      // No database, no schema, no Drizzle. A scenario reaching a table would
      // be the identity the domain model refuses, arriving by the back door.
      expect(source).not.toContain("database");
      expect(source).not.toContain("drizzle");
      expect(source).not.toContain("schema.js");
      // The only write either module performs is into the result cache.
      const writes = source.match(/\.(set|insert|write|save)\(/g) ?? [];
      for (const write of writes) {
        expect(write).toBe(".set(");
      }
    }
  });

  it("answers the same bytes with no cache at all", async () => {
    const cached = surface(memoryCache());
    const uncached = surface(noCache());
    for (const path of [OPTIMIZE_GET(blob()), REPLAY_GET(blob())]) {
      const warm = await hit(cached, path);
      await hit(cached, path);
      const cold = await hit(uncached, path);
      expect(await cold.text()).toBe(await warm.text());
      expect(cold.status).toBe(200);
    }
  });

  it("serves every request with the cache's Redis unreachable", async () => {
    // Where the swallowing lives, asserted at the level that does it. Neither
    // route catches around `cache.get`, and that is correct: the `ResultCache`
    // interface says a failure *is* a miss, so a route wrapping it would be a
    // second place the promise is kept and the first place it could rot. What
    // has to hold is that the one implementation with a network under it keeps
    // that promise, because a solver behind a cache that throws when Redis
    // blinks is a solver that is down when Redis is down.
    const unreachable: ResultCache = redisCache("redis://127.0.0.1:6399", 50);
    try {
      const api = surface(unreachable);
      const answers = await Promise.all([
        hit(api, OPTIMIZE_GET(blob())).then(verdict),
        hit(api, REPLAY_GET(blob())).then(verdict),
      ]);
      for (const answer of answers) {
        expect(answer.status).toBe(200);
      }
      // And the miss is a miss rather than a throw, on both verbs of the
      // interface — which is the property the routes are entitled to assume.
      expect(await unreachable.get("opt:v1:nothing:here:0.0.0")).toBeNull();
      await unreachable.set("opt:v1:nothing:here:0.0.0", "{}", 60);
    } finally {
      await unreachable.close();
    }
  });
});

// --- box: a replay completes with no promoted artifact -----------------------

/**
 * **Time Machine survives an unpromoted model.**
 *
 * `replay.md`: the replay path "never consults the currently promoted serving
 * artifact for a historical day". `api-surface.md` calls that a real and
 * slightly surprising product property and puts it on the screen. It is
 * asserted here at the gateway, where it is a statement about the *calls the
 * request path makes*: a replay that resolved a promotion would have to ask
 * something for it, and the recording upstream can see that it does not.
 */
describe("solver surface · a replay with nothing promoted", () => {
  it("answers a complete replay while the lane holds no artifact", async () => {
    reply = (request) =>
      request.path === "/v1/meta"
        ? new Response(
            JSON.stringify({
              artifacts: {
                mounted: true,
                writable: false,
                lanes: [{ lane: LANE, state: "no_artifact", promoted: null }],
              },
            }),
            { headers: { "content-type": "application/json" } },
          )
        : new Response(replayed(), {
            headers: {
              "content-type": "application/json",
              "x-optimizer-build": config.optimizerBuild,
            },
          });

    const response = await post(surface(), REPLAY_POST, canonicalBody());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    // Complete, not partial: the headline scalars, the pin and the caveat.
    for (const field of [
      "avoided_energy_mwh",
      "avoidability",
      "recovered_floor_mwh",
      "floor_met",
      "vintage_fidelity",
      "forecast_origin",
    ]) {
      expect(body[field]).not.toBeUndefined();
    }
    // Absent, never zeroed: a replay with nothing promoted is a real replay.
    expect(body.avoided_energy_mwh).not.toBe(0);
  });

  it("asks the modelling service for the replay and for nothing else", async () => {
    await post(surface(), REPLAY_POST, canonicalBody());
    // One call. Not a promotion lookup, not a lane resolution, not a card read
    // — the pinned row is the forecast and there is nothing else to consult.
    expect(received.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/replay",
    ]);
  });
});

// --- box: one cache discipline across the four surfaces ----------------------

/**
 * **The directives, from `api-surface.md`'s caching table, over the wire.**
 *
 * Four surfaces and three different windows, each with a reason, and the
 * reasons are what make them different numbers rather than one rounded to
 * taste:
 *
 * | surface                  | directive                | why                       |
 * |--------------------------|--------------------------|---------------------------|
 * | `GET /v1/optimize`       | `public, max-age=300`    | plans against a band that supersedes twice a day |
 * | `GET /v1/replay`         | `public, max-age=600`    | the forecast half is pinned; only the observed half can move |
 * | `GET /v1/replay/days`    | `public, max-age=3600`   | a verdict, recomputed nightly |
 * | every `POST`             | `no-store`               | a POST is not shared-cacheable; Redis does that work |
 *
 * And one rule over all of them: **nothing is `immutable`.** A replay is
 * reproducible, not immutable — ONS restates history in place, and a cache that
 * froze a replay against a restatement would hide exactly what
 * `revision_optimistic` exists to surface.
 */
describe("solver surface · one cache discipline", () => {
  const EXPECTED: readonly [string, string, string | null][] = [
    ["GET", OPTIMIZE_GET(blob()), "public, max-age=300"],
    ["GET", REPLAY_GET(blob()), "public, max-age=600"],
    ["GET", CALENDAR, "public, max-age=3600"],
    ["GET", CALENDAR_DAY, "public, max-age=3600"],
    ["POST", "/v1/optimize", "no-store"],
    ["POST", REPLAY_POST, "no-store"],
    ["POST", OBSERVED_ONLY_POST, "no-store"],
  ];

  it("sets the directive the spec's table publishes, on every surface", async () => {
    const api = surface();
    for (const [method, path, directive] of EXPECTED) {
      const response =
        method === "GET" ? await hit(api, path) : await post(api, path, canonicalBody());
      expect(response.status).toBe(200);
      expect(
        `${method} ${path.split("?")[0]}: ${response.headers.get("cache-control")}`,
      ).toBe(`${method} ${path.split("?")[0]}: ${directive}`);
    }
  });

  it("marks nothing on this surface immutable", async () => {
    const api = surface();
    for (const [method, path] of EXPECTED) {
      const response =
        method === "GET" ? await hit(api, path) : await post(api, path, canonicalBody());
      expect(response.headers.get("cache-control")).not.toContain("immutable");
    }
  });
});

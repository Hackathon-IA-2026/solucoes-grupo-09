import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { Scenario } from "@wattsteer/core";
import { decodeScenarioParam, encodeScenario } from "@wattsteer/core/scenario";
import { latestTargetDate } from "@wattsteer/core/scenario-validation";
import type { Server } from "bun";
import { Elysia } from "elysia";
import type { MlEndpoint } from "../src/api/ml-proxy.js";
import { createOptimizeRoutes } from "../src/api/optimize.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { classifyTier } from "../src/api/plugins/rate-limit.js";
import { requestContext } from "../src/api/plugins/request-context.js";
import { memoryCache, noCache, replayKey } from "../src/api/plugins/result-cache.js";
import { createReplaySolveRoutes } from "../src/api/replay.js";
import { config } from "../src/config.js";
import type { ErrorEnvelope } from "../src/errors.js";

/**
 * **`/v1/replay` — the transport, the pin and the one clause that cannot match.**
 *
 * The claims this file exists to make, in the order the ticket lists them:
 *
 * 1. **Parity with `/v1/optimize`, minus its date clause.** One corpus is fed
 *    to *both* endpoints and their verdicts compared blob for blob. The date
 *    cases are not quietly dropped from the corpus — they are asserted to
 *    diverge, in the documented direction, because "parity" stated without the
 *    carve-out is a claim no implementation can satisfy: a 2024-06 target is a
 *    valid planning date and is refused by a replay as pre-F1.
 * 2. **The pin is the cache key.** A hit is byte-identical to the miss that
 *    filled it, and a changed `forecast_origin` or `optimizer_build` misses.
 * 3. **The solve tier applies**, because it is the same solver behind the same
 *    public surface — and a replay is the *more* expensive of the two.
 *
 * What is deliberately not asserted here is the content of a replay. The
 * arithmetic has its own suite in `apps/ml`; a gateway test that also checked
 * the numbers would be asserting the solver twice and the transport once.
 */

// --- the ML service, as a recording loopback ---------------------------------

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

/** The shape the ML service answers a replayed day with, trimmed to the keys the gateway reads. */
function replayed(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    target_date: PAST_DATE,
    subsystem: "NE",
    scenario_hash: `sha256:${"0".repeat(64)}`,
    forecast_origin: {
      producer: "wattsteer",
      run_label: "F3__dessem_free_v1__gate_late__thr5",
      published_at: "2025-06-14T13:00:00Z",
      origin_kind: "backfilled_holdout",
      gate_profile: "gate_late",
    },
    // The vintage of the observed half — the half a pin cannot freeze, because
    // ONS restates history in place. It is what makes the deep link's validator
    // a complete provenance rather than one that ignores half the answer.
    actual: { total_mwh: 900.4, peak_mw: 110.0, data_version: "7" },
    avoided_energy_mwh: 151.8,
    recovered_floor_mwh: 84.1,
    floor_met: true,
    ...overrides,
  });
}

/** Answer as the ML service would, stamping the build that solved. */
function solves(body: string, build = config.optimizerBuild): void {
  reply = () =>
    new Response(body, {
      headers: { "content-type": "application/json", "x-optimizer-build": build },
    });
}

/** Answer as a failure the ML service names by code. */
function refuses(status: number, code: string): void {
  reply = () =>
    new Response(JSON.stringify({ error: { code, message: code } }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

/** Solve `/v1/optimize`, and refuse `/v1/replay` with the named code. */
function splits(status: number, code: string): void {
  reply = (request) =>
    request.path === "/v1/optimize"
      ? new Response(`{"forecast_origin":"2025-06-14T13:00:00Z"}`, {
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ error: { code, message: code } }), {
          status,
          headers: { "content-type": "application/json" },
        });
}

// --- the corpus --------------------------------------------------------------

/**
 * A day comfortably inside F1–F5, so it is a replayable date *and* a valid
 * planning date, which is what makes it the one blob both endpoints can agree
 * on without either of them bending.
 */
const PAST_DATE = "2025-06-15";

const BATTERY = {
  assetType: "battery" as const,
  label: "Battery",
  subsystem: "NE" as const,
  maxPowerMw: 100,
  energyCapacityMwh: 300,
  roundTripEfficiency: 0.92,
  initialStateOfCharge: 0.2,
};

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    v: 1,
    subsystem: "NE",
    targetDate: PAST_DATE,
    forecastOrigin: "2025-06-14T13:00:00Z",
    assets: [BATTERY],
    economicAssumptions: { brlPerMwh: 180 },
    ...overrides,
  } as Scenario;
}

const blob = (over: Partial<Scenario> = {}) => encodeScenario(scenario(over));

/** A blob written straight to the wire form, for refusals a typed `Scenario` cannot express. */
function rawBlob(mutate: (wire: Record<string, unknown>) => void): string {
  const wire: Record<string, unknown> = {
    v: 1,
    subsystem: "NE",
    target_date: PAST_DATE,
    forecast_origin: "2025-06-14T13:00:00Z",
    assets: [
      {
        asset_type: "battery",
        label: "Battery",
        subsystem: "NE",
        max_power_mw: 100,
        energy_capacity_mwh: 300,
        round_trip_efficiency: 0.92,
        initial_state_of_charge: 0.2,
      },
    ],
  };
  mutate(wire);
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
}

/** The one asset a corpus entry mutates, without asserting it is there. */
function firstAsset(wire: Record<string, unknown>): Record<string, unknown> {
  const [asset] = wire.assets as Record<string, unknown>[];
  if (asset === undefined) {
    throw new Error("the corpus template has an asset");
  }
  return asset;
}

/**
 * Every rule of the table that is **not** the date clause, one blob each.
 *
 * These are the blobs the parity claim is about: whatever the two endpoints do
 * with them, they must do the same thing, because it is the same solver behind
 * the same public surface and a link accepted by one and refused by the other
 * would mean two things.
 */
const SHARED_CORPUS: { name: string; blob: string }[] = [
  { name: "a valid scenario", blob: blob() },
  { name: "no forecast_origin", blob: blob({ forecastOrigin: undefined }) },
  { name: "an unsupported version", blob: rawBlob((w) => (w.v = 2)) },
  { name: "an unknown subsystem", blob: rawBlob((w) => (w.subsystem = "SIN")) },
  { name: "no assets", blob: rawBlob((w) => (w.assets = [])) },
  {
    name: "too many assets",
    blob: rawBlob((w) => {
      w.assets = Array.from({ length: 21 }, () => ({
        asset_type: "battery",
        label: "B",
        subsystem: "NE",
        max_power_mw: 1,
        energy_capacity_mwh: 1,
        round_trip_efficiency: 0.92,
        initial_state_of_charge: 0.2,
      }));
    }),
  },
  {
    name: "a magnitude out of range",
    blob: rawBlob((w) => {
      firstAsset(w).max_power_mw = 1e9;
    }),
  },
  {
    name: "an efficiency below the physical floor",
    blob: rawBlob((w) => {
      firstAsset(w).round_trip_efficiency = 0.1;
    }),
  },
  {
    name: "an asset in another subsystem",
    blob: rawBlob((w) => {
      firstAsset(w).subsystem = "S";
    }),
  },
  {
    name: "a missing required number",
    blob: rawBlob((w) => {
      firstAsset(w).max_power_mw = undefined;
    }),
  },
  {
    name: "an economic assumption out of range",
    blob: rawBlob((w) => (w.economic_assumptions = { brl_per_mwh: 1e9 })),
  },
  { name: "a malformed target_date", blob: rawBlob((w) => (w.target_date = "15/06/25")) },
  {
    name: "a target_date naming no day",
    blob: rawBlob((w) => (w.target_date = "2025-02-31")),
  },
  { name: "not an object at all", blob: Buffer.from("[]", "utf8").toString("base64url") },
];

// --- the routes under test ---------------------------------------------------

function replayRoutes(
  overrides: Partial<Parameters<typeof createReplaySolveRoutes>[0]> = {},
) {
  return new Elysia()
    .use(requestContext)
    .use(errorHandler)
    .use(
      createReplaySolveRoutes({ cache: noCache(), endpoint: endpoint(), ...overrides }),
    );
}

function optimizeRoutes() {
  return new Elysia()
    .use(requestContext)
    .use(errorHandler)
    .use(createOptimizeRoutes({ cache: noCache(), endpoint: endpoint() }));
}

const replayGet = (api: Elysia, s: string, d = PAST_DATE, lane = LANE) =>
  api.handle(
    new Request(
      `http://localhost/v1/replay?d=${d}&lane=${encodeURIComponent(lane)}&s=${encodeURIComponent(s)}`,
    ),
  );

const replayPost = (api: Elysia, body: string, lane = LANE) =>
  api.handle(
    new Request(`http://localhost/v1/replay?lane=${encodeURIComponent(lane)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );

const optimizeGet = (api: Elysia, s: string) =>
  api.handle(new Request(`http://localhost/v1/optimize?s=${encodeURIComponent(s)}`));

const LANE = "dessem_free_v1__gate_late__thr5";

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

beforeEach(() => {
  received.length = 0;
  solves(replayed());
});

// --- box: scenario validation parity, minus the date clause ------------------

describe("replay · scenario validation parity with /v1/optimize, minus its date clause", () => {
  it("one corpus, two endpoints, the same verdict on every non-date rule", async () => {
    reply = (request) =>
      new Response(
        request.path === "/v1/optimize"
          ? `{"forecast_origin":"2025-06-14T13:00:00Z"}`
          : replayed(),
        { headers: { "content-type": "application/json" } },
      );

    const replay = replayRoutes();
    const optimize = optimizeRoutes();
    const disagreements: string[] = [];
    for (const entry of SHARED_CORPUS) {
      const fromOptimize = await verdict(await optimizeGet(optimize, entry.blob));
      const fromReplay = await verdict(await replayGet(replay, entry.blob));
      if (
        fromOptimize.code !== fromReplay.code ||
        fromOptimize.status !== fromReplay.status
      ) {
        disagreements.push(
          `${entry.name}: optimize ${fromOptimize.status}/${fromOptimize.code} vs ` +
            `replay ${fromReplay.status}/${fromReplay.code}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("the corpus actually exercises the table rather than passing everything", async () => {
    // Guards the test above against becoming vacuous: a corpus that no longer
    // refuses anything would agree with itself perfectly.
    const optimize = optimizeRoutes();
    const codes = new Set<string>();
    for (const entry of SHARED_CORPUS) {
      const { code } = await verdict(await optimizeGet(optimize, entry.blob));
      if (code) {
        codes.add(code);
      }
    }
    expect(codes).toContain("SCENARIO_VERSION_UNSUPPORTED");
    expect(codes).toContain("SUBSYSTEM_UNKNOWN");
    expect(codes).toContain("SCENARIO_TOO_LARGE");
    expect(codes).toContain("MAGNITUDE_OUT_OF_RANGE");
    expect(codes).toContain("REQUEST_INVALID");
    expect(codes.size).toBeGreaterThanOrEqual(6);
  });

  it("a refused scenario never reaches the solver, on either endpoint", async () => {
    const replay = replayRoutes();
    const optimize = optimizeRoutes();
    const bad = rawBlob((w) => (w.subsystem = "SIN"));
    expect((await replayGet(replay, bad)).status).toBe(422);
    expect((await optimizeGet(optimize, bad)).status).toBe(422);
    expect(received).toEqual([]);
  });

  it("the date clause is where they part, and it parts in the documented direction", async () => {
    // A 2024-06 target: a valid planning date, because the data window opens
    // 2024-04, and not a replayable one, because F1's test period opens
    // 2025-04. The gateway does not decide the second — the replayable
    // predicate does, where the fold calendar lives — so what is asserted here
    // is that the gateway *forwards* it rather than refusing it as
    // `TARGET_DATE_OUT_OF_RANGE`, and that the predicate's own code is what
    // reaches the client.
    splits(422, "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW");
    const preF1 = blob({ targetDate: "2024-06-15" });

    const fromOptimize = await verdict(await optimizeGet(optimizeRoutes(), preF1));
    expect(fromOptimize.status).toBe(200);

    const fromReplay = await verdict(
      await replayGet(replayRoutes(), preF1, "2024-06-15"),
    );
    expect(fromReplay).toEqual({
      status: 422,
      code: "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW",
    });
    // Forwarded, which is the half the gateway is responsible for.
    expect(received.map((entry) => entry.path)).toContain("/v1/replay");
  });

  it("tomorrow is a planning date and is not a day that has happened", async () => {
    // The published boundary, read rather than written down: the last date
    // `/v1/optimize` will plan for is tomorrow in Brasília, and a fixture that
    // guessed at it would fail for three hours every evening.
    const tomorrow = latestTargetDate(new Date());
    splits(422, "REPLAY_DATE_OUT_OF_RANGE");
    const future = blob({ targetDate: tomorrow });

    expect((await verdict(await optimizeGet(optimizeRoutes(), future))).status).toBe(200);
    expect(await verdict(await replayGet(replayRoutes(), future, tomorrow))).toEqual({
      status: 422,
      code: "REPLAY_DATE_OUT_OF_RANGE",
    });
  });

  it("a date before the data window is refused by both, under their own codes", async () => {
    splits(422, "REPLAY_DATE_OUT_OF_RANGE");
    const ancient = blob({ targetDate: "2023-01-01" });
    expect(await verdict(await optimizeGet(optimizeRoutes(), ancient))).toEqual({
      status: 422,
      code: "TARGET_DATE_OUT_OF_RANGE",
    });
    expect(await verdict(await replayGet(replayRoutes(), ancient, "2023-01-01"))).toEqual(
      {
        status: 422,
        code: "REPLAY_DATE_OUT_OF_RANGE",
      },
    );
  });
});

// --- box: one case per replay refusal code -----------------------------------

describe("replay · one case per refusal code, each a rejection and not a caveat", () => {
  const table: [string, number][] = [
    ["REPLAY_DATE_BEFORE_HOLDOUT_WINDOW", 422],
    ["REPLAY_DATE_OUT_OF_RANGE", 422],
    ["REPLAY_FORECAST_UNAVAILABLE", 404],
    ["REPLAY_OBSERVATION_INCOMPLETE", 404],
    ["REPLAY_INTEGRITY_VIOLATION", 500],
  ];

  for (const [code, status] of table) {
    it(`${code} reaches the client as ${status}, with no number beside it`, async () => {
      refuses(status, code);
      const response = await replayGet(replayRoutes(), blob());
      expect(response.status).toBe(status);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.code).toBe(code);
      // A refusal, and not an answer wearing one. None of the fields a replay
      // publishes may appear on it.
      const text = JSON.stringify(body);
      for (const field of [
        "avoided_energy_mwh",
        "recovered_floor_mwh",
        "avoidability",
        "scored",
      ]) {
        expect(text).not.toContain(field);
      }
    });
  }

  it("the five statuses stay apart rather than collapsing into one 'no'", async () => {
    const seen = new Set<number>();
    for (const [code, status] of table) {
      refuses(status, code);
      seen.add((await replayGet(replayRoutes(), blob())).status);
    }
    expect([...seen].sort()).toEqual([404, 422, 500]);
  });
});

// --- box: the cache, keyed on the pin ----------------------------------------

describe("replay · a cache hit is byte-identical, and the pin is in the key", () => {
  it("answers inside one request, with no job id in the contract", async () => {
    const response = await replayGet(replayRoutes(), blob());
    expect(response.status).toBe(200);
    const text = (await response.text()).toLowerCase();
    for (const noun of ["job_id", '"job"', "poll", "queued", "status_url"]) {
      expect(text).not.toContain(noun);
    }
  });

  it("a second identical request is served from the cache, byte for byte", async () => {
    const api = replayRoutes({ cache: memoryCache() });
    const first = await (await replayGet(api, blob())).text();
    const second = await (await replayGet(api, blob())).text();
    expect(second).toBe(first);
    // One solve, two answers: the second never crossed the wire.
    expect(received.filter((entry) => entry.path === "/v1/replay")).toHaveLength(1);
  });

  it("a changed forecast_origin misses", async () => {
    const api = replayRoutes({ cache: memoryCache() });
    await replayGet(api, blob());
    // The same scenario, pinned to a different publication: a different link,
    // and a different key.
    const moved = blob({ forecastOrigin: "2025-06-14T01:00:00Z" });
    await replayGet(api, moved);
    expect(received.filter((entry) => entry.path === "/v1/replay")).toHaveLength(2);
  });

  it("a changed optimizer_build misses", async () => {
    const cache = memoryCache();
    await replayGet(replayRoutes({ cache, optimizerBuild: "build-a" }), blob());
    // A formulation change must not serve yesterday's plan under today's code.
    solves(replayed(), "build-b");
    await replayGet(replayRoutes({ cache, optimizerBuild: "build-b" }), blob());
    expect(received.filter((entry) => entry.path === "/v1/replay")).toHaveLength(2);
  });

  it("the key is the spec's, and the origin carries its kind", () => {
    const key = replayKey({
      scenarioHash: "sha256:abc",
      targetDate: PAST_DATE,
      forecastOrigin: "backfilled_holdout@2025-06-14T13:00:00Z",
      optimizerBuild: "0.1.0",
    });
    expect(key).toBe(
      `replay:v1:sha256:abc:${PAST_DATE}:backfilled_holdout@2025-06-14T13:00:00Z:0.1.0`,
    );
    // A record and a reconstruction of the same day share a publication instant
    // — a backfilled row's `published_at` *is* the gate — so an instant-only
    // key would serve one under the other's name.
    expect(
      replayKey({
        scenarioHash: "sha256:abc",
        targetDate: PAST_DATE,
        forecastOrigin: "served@2025-06-14T13:00:00Z",
        optimizerBuild: "0.1.0",
      }),
    ).not.toBe(key);
  });

  it("a build the gateway does not know about is served and not remembered", async () => {
    const api = replayRoutes({ cache: memoryCache(), optimizerBuild: "gateway-build" });
    solves(replayed(), "some-other-build");
    expect((await replayGet(api, blob())).status).toBe(200);
    await replayGet(api, blob());
    expect(received.filter((entry) => entry.path === "/v1/replay")).toHaveLength(2);
  });
});

// --- box: the transports meet, and the link is legible -----------------------

describe("replay · one scenario, two verbs, one set of bytes", () => {
  it("a GET blob and a POST body reach the solver as the same bytes", async () => {
    const api = replayRoutes();
    await replayGet(api, blob());
    await replayPost(
      api,
      JSON.stringify({
        economic_assumptions: { brl_per_mwh: 180.0 },
        assets: [
          {
            initial_state_of_charge: 0.2,
            asset_type: "battery",
            round_trip_efficiency: 0.92,
            subsystem: "NE",
            label: "Battery",
            energy_capacity_mwh: 300.0,
            max_power_mw: 100,
          },
        ],
        forecast_origin: "2025-06-14T13:00:00Z",
        target_date: PAST_DATE,
        subsystem: "NE",
        v: 1,
      }),
    );
    const solves = received.filter((entry) => entry.path === "/v1/replay");
    expect(solves).toHaveLength(2);
    expect(solves[0]?.body).toBe(solves[1]?.body as string);
    expect(solves[0]?.method).toBe("POST");
    expect(solves[0]?.search).toContain("lane=dessem_free_v1__gate_late__thr5");
  });

  it("a link whose visible date is not the day it replays is refused", async () => {
    const response = await replayGet(replayRoutes(), blob(), "2025-06-16");
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe("BAD_INPUT");
    expect(received).toEqual([]);
  });

  it("a shared link is shared-cacheable and a POST is not", async () => {
    const api = replayRoutes();
    // Ten minutes, which is `api-surface.md`'s caching table and not the
    // optimizer's five: the optimizer's window is short because a plan is built
    // on a band that supersedes twice a day, and a replay's forecast half is a
    // pinned historical row no gate can supersede. `solver-surface.test.ts`
    // holds the whole table, this holds the pair.
    expect((await replayGet(api, blob())).headers.get("cache-control")).toBe(
      "public, max-age=600",
    );
    expect(
      (await replayPost(api, JSON.stringify({ ...scenarioWire() }))).headers.get(
        "cache-control",
      ),
    ).toBe("no-store");
  });

  it("puts the whole provenance on the deep link's ETag, and none on the POST", async () => {
    // api-surface 24: **five** components, and the fifth is the observed
    // `data_version` the ML service now publishes. The Redis key has four —
    // the gateway must build that one *before* it calls, and the observed
    // vintage is knowable only from the answer — but a validator is built from
    // the answer, so this is where the observed half's provenance belongs and
    // it is complete here.
    const api = replayRoutes();
    const response = await replayGet(api, blob());
    const etag = response.headers.get("etag") ?? "";
    expect(etag).toBe(
      `W/"${decodeScenarioParam(blob()).hash}:${PAST_DATE}:` +
        `backfilled_holdout@2025-06-14T13:00:00Z:${config.optimizerBuild}:7"`,
    );
    // `<origin_kind>@<published_at>` and never the instant alone: a record and
    // the reconstruction that shares its publication instant must not collide.
    expect(etag).toContain("@");

    const posted = await replayPost(api, JSON.stringify(scenarioWire()));
    expect(posted.headers.get("etag")).toBeNull();
  });

  it("moves the validator when ONS restates the day underneath the replay", async () => {
    // The hole this closed. The forecast half is pinned and the scenario, the
    // date and the build are unchanged, so before the observed vintage was on
    // the validator a restatement produced the *same* ETag — and a client
    // holding the pre-restatement numbers revalidated to a 304 forever, never
    // seeing the record move. Now the validator moves with the record.
    const api = replayRoutes();
    const before = (await replayGet(api, blob())).headers.get("etag") ?? "";

    solves(
      replayed({ actual: { total_mwh: 1210.9, peak_mw: 140.0, data_version: "8" } }),
    );
    const after = (await replayGet(api, blob())).headers.get("etag") ?? "";
    expect(after).not.toBe(before);

    const stale = await api.handle(
      new Request(
        `http://localhost/v1/replay?d=${PAST_DATE}&lane=${encodeURIComponent(LANE)}` +
          `&s=${encodeURIComponent(blob())}`,
        { headers: { "if-none-match": before } },
      ),
    );
    expect(stale.status).toBe(200);
  });

  it("gives an answer that names no observed vintage no validator at all", async () => {
    // The same posture the missing origin gets, for the same reason: a
    // validator over a provenance with a hole in it collides two answers that
    // are not the same answer, and the hole here is the half that moves.
    const api = replayRoutes();
    solves(replayed({ actual: { total_mwh: 900.4, peak_mw: 110.0 } }));
    const response = await replayGet(api, blob());
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
  });

  it("revalidates the deep link to a 304 once the origin is known", async () => {
    // The pin resolves to one of two origin kinds and only the answer says
    // which, so unlike `/v1/optimize` this route cannot revalidate before it
    // computes. It still serves the 304: an ETag that never produced one would
    // be a header with no mechanism behind it, and the payload it saves carries
    // 24 dispatch hours, an episode list and the perfect-foresight bound.
    const api = replayRoutes();
    const etag = (await replayGet(api, blob())).headers.get("etag") ?? "";
    expect(etag).not.toBe("");

    const again = await api.handle(
      new Request(
        `http://localhost/v1/replay?d=${PAST_DATE}&lane=${encodeURIComponent(LANE)}` +
          `&s=${encodeURIComponent(blob())}`,
        { headers: { "if-none-match": etag } },
      ),
    );
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("cache-control")).toBe("public, max-age=600");
  });
});

function scenarioWire(): Record<string, unknown> {
  return {
    v: 1,
    subsystem: "NE",
    target_date: PAST_DATE,
    forecast_origin: "2025-06-14T13:00:00Z",
    assets: [
      {
        asset_type: "battery",
        label: "Battery",
        subsystem: "NE",
        max_power_mw: 100,
        energy_capacity_mwh: 300,
        round_trip_efficiency: 0.92,
        initial_state_of_charge: 0.2,
      },
    ],
  };
}

// --- box: the per-IP rate limit ----------------------------------------------

describe("replay · the solve tier applies, because it is the same solver", () => {
  it("a replay spends the solve budget and the calendar spends the read one", () => {
    expect(classifyTier("GET", "/v1/replay")).toBe("solve");
    expect(classifyTier("POST", "/v1/replay")).toBe("solve");
    expect(classifyTier("POST", "/v1/replay/observed-only")).toBe("solve");
    expect(classifyTier("GET", "/v1/optimize")).toBe("solve");
    // Two `group by`s and a card read. Metering a date picker at the solver's
    // rate would throttle the screen that chooses which day to solve.
    expect(classifyTier("GET", "/v1/replay/days")).toBe("read");
    expect(classifyTier("GET", "/v1/replay/days/2025-06-15")).toBe("read");
  });
});

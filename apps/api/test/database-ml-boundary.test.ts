import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Scenario } from "@wattsteer/core";
import { canonicalScenarioJson } from "@wattsteer/core/scenario";
import type { Server } from "bun";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { createCurtailmentRoutes } from "../src/api/curtailment.js";
import { createDiagnosisRoutes } from "../src/api/diagnosis.js";
import { createForecastRoutes } from "../src/api/forecast.js";
import { createGridRoutes } from "../src/api/grid.js";
import { createMetaRoutes } from "../src/api/meta.js";
import type { MlEndpoint } from "../src/api/ml-proxy.js";
import { createModelCardRoutes } from "../src/api/model-card.js";
import { createOptimizeRoutes } from "../src/api/optimize.js";
import { dailyCap } from "../src/api/plugins/daily-cap.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { memoryStore } from "../src/api/plugins/limit-store.js";
import { memoryLockedCache } from "../src/api/plugins/locked-cache.js";
import { noCache } from "../src/api/plugins/result-cache.js";
import { createReplayRoutes, createReplaySolveRoutes } from "../src/api/replay.js";
import { createDatabase } from "../src/database/connection.js";
import {
  parseAttributionPublication,
  writeAttributionPublication,
} from "../src/diagnosis/publication.js";
import { parsePublication, writePublication } from "../src/forecast/publication.js";
import {
  ARTIFACT,
  attributionPayload,
  GATE_LATE,
  REGIME,
  TARGET_DATE,
} from "./support/attribution-payload.js";

/**
 * **A modelling outage is a stale timestamp, not a product outage** — the whole
 * product promise of the boundary decision, as one table.
 *
 * `ml-boundary.test.ts` asserts the same property *structurally*: no handler
 * outside four named crossings can reach the modelling service. That claim is
 * stronger in one way — it holds in every deployment rather than in a seeded
 * one — and weaker in another: "there is no import edge" is not "a user gets
 * their forecast". This file is the second half, and it is behavioural on
 * purpose, because what an operator was promised is a status code.
 *
 * **Two columns, because the ML service fails in two shapes and they are not
 * the same sentence.** `docs/specs/api-surface.md` seam 2 names only one — "the
 * ML service returning 503" — and then predicts `502 OPTIMIZER_UNAVAILABLE` for
 * the solver, which the mapping in the *same spec* (and `ml-proxy.ts`, and
 * `ml-proxy.test.ts`) contradicts: an upstream 502/503/504 maps to **`503
 * OPTIMIZER_NOT_READY`**, deliberately, so that "up but not serving" is not
 * filed as "unreachable". `502 OPTIMIZER_UNAVAILABLE` is the *unreachable*
 * answer and `502 OPTIMIZER_NOT_CONFIGURED` the *unset* one. Rather than pick a
 * side of the spec's own contradiction, the table runs both columns:
 *
 * | route                       | ML up, answering 503 | ML unconfigured        |
 * |-----------------------------|----------------------|------------------------|
 * | `GET /v1/grid/outlook`      | 200                  | 200                    |
 * | `GET /v1/forecast/day-ahead`| 200                  | 200                    |
 * | `GET /v1/diagnosis/day-ahead`| 200                 | 200                    |
 * | `GET /v1/curtailment/hours` | 200                  | 200                    |
 * | `GET /v1/curtailment/episodes`| 200                | 200                    |
 * | `GET /v1/curtailment/reasons`| 200                 | 200                    |
 * | `GET /v1/meta`              | 200, model unreachable| 200, model unreachable|
 * | `GET /v1/model/card`        | 503 NOT_READY        | 502 NOT_CONFIGURED     |
 * | `GET /v1/replay/days`       | 503 NOT_READY        | 502 NOT_CONFIGURED     |
 * | `POST /v1/optimize`         | 503 NOT_READY        | 502 NOT_CONFIGURED     |
 * | `POST /v1/replay`           | 503 NOT_READY        | 502 NOT_CONFIGURED     |
 *
 * **`/v1/replay/days` is in the wrong half of the spec's table.** Seam 2 lists
 * it with the routes that serve, and api-surface 17 built it as a *pure proxy*
 * — for a stated reason: which past days are replayable is a property of which
 * holdout artifacts exist, and those live on the modelling service's volume,
 * which the gateway does not have. So it cannot serve without it, the table
 * above records that, and the cost is bounded and correct: the Time Machine's
 * date picker is unavailable during an outage, and every read on Overview and
 * Explain is not. Asserting the spec's 200 here would have meant either
 * asserting something false or quietly deleting the row.
 *
 * **What is seeded, and what deliberately is not.** The three observed reads
 * and `/v1/meta` answer 200 on an empty schema by design — an absence is
 * rendered as an absence, not as an error — so seeding them would prove less,
 * not more. The forecast, outlook and diagnosis rows are written through the
 * real publication writers rather than by hand, so the 200s below are over rows
 * the worker would have written.
 *
 * Gated exactly like the other database suites: `WATTSTEER_TEST_DATABASE_URL`
 * supplies the URL and the default `bun test` skips this file. Spin one up:
 *   docker run -d -p 5434:5432 -e POSTGRES_PASSWORD=wattsteer \
 *     -e POSTGRES_DB=wattsteer postgres:17-alpine
 */
const DATABASE = process.env.WATTSTEER_TEST_DATABASE_URL;
const suite = DATABASE ? describe : describe.skip;

const SUBSYSTEMS = ["N", "NE", "SE", "S"] as const;
type Code = (typeof SUBSYSTEMS)[number];

/** The diagnosis fixture's subsystem, so one target date serves both halves. */
const SUBSYSTEM: Code = "NE";
const LANE = "dessem_free_v1__gate_late__thr5";

/** After the late gate for the target date, so the forecast has published. */
const NOW = new Date("2024-05-07T02:00:00.000Z");

/** The local day starts at 03:00Z while Brazil observes no summer time. */
const hourInstant = (hour: number): string =>
  new Date(Date.UTC(2024, 4, 7, 3 + hour)).toISOString();

/** One subsystem's lane-day, in the modelling service's own payload shape. */
function forecastPayload(subsystem: Code): Record<string, unknown> {
  const hours = Array.from({ length: 24 }, (_value, hour) => ({
    subsystem,
    valid_time: hourInstant(hour),
    target_date: TARGET_DATE,
    local_hour: hour,
    threshold_mw: 5,
    occurrence_probability: hour === 14 ? 0.72 : 0.08,
    p10_mwh: 0,
    p50_mwh: hour === 14 ? 40.25 : 0,
    p90_mwh: hour === 14 ? 120.5 : 10.125,
    expected_mwh: hour === 14 ? 30.5 : 2.25,
    p50_wind_mwh: hour === 14 ? 32.2 : 0,
    p50_solar_mwh: hour === 14 ? 8.05 : 0,
    expected_wind_mwh: hour === 14 ? 24.4 : 1.8,
    expected_solar_mwh: hour === 14 ? 6.1 : 0.45,
    crossed: false,
    derivation: "hurdle_mixture",
    correction_regime: REGIME,
  }));
  // Matched to the attribution fixture's decomposition on purpose: the
  // diagnosis route refuses to serve bars that do not add up to the figure
  // beside them, so a forecast and an attribution that disagree is a 502 and
  // not a 200. Discovered by writing the two fixtures independently and
  // watching the route say so.
  const expected = 412;
  return {
    lane: LANE,
    feature_set: "dessem_free_v1",
    threshold_mw: 5,
    target_date: TARGET_DATE,
    correction_regime: REGIME,
    forecast_origin: {
      producer: "wattsteer",
      run_label: ARTIFACT,
      published_at: GATE_LATE,
      origin_kind: "served",
      gate_profile: "gate_late",
    },
    artifact: {
      artifact_id: ARTIFACT,
      feature_set: "dessem_free_v1",
      trained_through: "2024-04-30",
    },
    risk_bins: { low: [0, 0.25], elevated: [0.25, 0.6], high: [0.6, 1] },
    hours,
    days: [
      {
        subsystem,
        target_date: TARGET_DATE,
        threshold_mw: 5,
        day_total: { p10: 12.5, p50: 2780.25, p90: 4260.25 },
        peak_power: { p10: 4.5, p50: 96.25, p90: 180.75 },
        day_occurrence_probability: 0.89,
        expected_mwh: expected,
        expected_wind_mwh: expected * 0.75,
        expected_solar_mwh: expected * 0.25,
        hours_p50_nonzero: 1,
        derivation: "path_ensemble",
        ensemble_draws: 500,
        ensemble_seed: 20_240_506,
        ensemble_calibration_days: 90,
        correction_regime: REGIME,
      },
    ],
  };
}

/**
 * A scenario the gateway will admit, built with the encoder the gateway
 * canonicalises with — a body hand-written in either casing would be refused by
 * the wire, and the table would then be asserting a `422` from the gate rather
 * than a refusal from the boundary.
 *
 * Its day is a replayable one, which is a different window from the forecast
 * fixture's target date above: the solve routes read no Postgres, so the two
 * halves of this file are deliberately not made to share a date they have no
 * reason to share.
 */
const SOLVE_DATE = "2025-06-15";
const SCENARIO = canonicalScenarioJson({
  v: 1,
  subsystem: SUBSYSTEM,
  targetDate: SOLVE_DATE,
  forecastOrigin: "2025-06-14T13:00:00Z",
  assets: [
    {
      assetType: "battery",
      label: "Battery",
      subsystem: SUBSYSTEM,
      maxPowerMw: 100,
      energyCapacityMwh: 300,
      roundTripEfficiency: 0.92,
      initialStateOfCharge: 0.2,
    },
  ],
  economicAssumptions: { brlPerMwh: 180 },
} as Scenario);

interface Verdict {
  status: number;
  code?: string;
}

suite("the boundary, as behaviour · a modelling outage against real Postgres", () => {
  const handle = createDatabase(DATABASE as string, 5);
  const { db } = handle;

  /**
   * The modelling service, up and refusing everything — the one failure the
   * spec's seam 2 names. Held for the whole file so that a 200 below is a route
   * that never needed it rather than a route that got lucky.
   */
  const refusing: Server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ detail: "no workers" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  });

  /** The two shapes of "the model is not there", as two endpoints. */
  const DOWN: MlEndpoint = {
    baseUrl: `http://127.0.0.1:${refusing.port}`,
    timeoutMs: 2000,
  };
  const UNSET: MlEndpoint = { baseUrl: undefined, timeoutMs: 2000 };

  /**
   * The whole public surface, composed exactly as `src/api/index.ts` composes
   * it, with one modelling endpoint shared by everything that crosses. A route
   * that answers 200 here has no path to `ml` to be broken by; that is the
   * claim, and it is why the reads are mounted beside the crossings rather than
   * in a suite of their own.
   */
  const surfaceWith = (ml: MlEndpoint) =>
    new Elysia()
      .use(errorHandler)
      .use(createGridRoutes({ db, now: () => NOW }))
      .use(createForecastRoutes({ db, now: () => NOW }))
      .use(createCurtailmentRoutes({ db }))
      .use(
        createDiagnosisRoutes({
          db,
          now: () => NOW,
          narration: {
            store: memoryLockedCache(),
            cap: dailyCap({ name: "narration", limit: 200, store: memoryStore() }),
            // No language model is reachable from this suite, and none should
            // be needed: the narration falls back to the template, and the
            // route still answers 200. That is a boundary too.
            messages: {
              create: async () => {
                throw new Error("no language model is reachable from this suite");
              },
            },
          },
        }),
      )
      .use(createMetaRoutes({ db, ml, now: () => NOW }))
      .use(createModelCardRoutes(ml))
      .use(createReplayRoutes(ml))
      .use(createReplaySolveRoutes({ cache: noCache(), endpoint: ml }))
      .use(createOptimizeRoutes({ cache: noCache(), endpoint: ml }));

  const down = surfaceWith(DOWN);
  const unset = surfaceWith(UNSET);

  async function verdict(app: Elysia, request: Request): Promise<Verdict> {
    const response = await app.handle(request);
    if (response.status === 200) {
      return { status: 200 };
    }
    const body = (await response.json()) as { error?: { code?: string } };
    return { status: response.status, code: body.error?.code };
  }

  const GET = (path: string) => () => new Request(`http://localhost${path}`);
  const POST = (path: string) => () =>
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: SCENARIO,
    });

  /**
   * The table. One row per route, one expectation per failure shape, and the
   * reason the row reads the way it does — because the rows that answer 200 are
   * a *decision*, not an accident, and the next author to move one should have
   * to delete a sentence.
   */
  const TABLE: readonly {
    route: string;
    request: () => Request;
    down: Verdict;
    unset: Verdict;
    why: string;
  }[] = [
    {
      route: "GET /v1/grid/outlook",
      request: GET(`/v1/grid/outlook?target_date=${TARGET_DATE}`),
      down: { status: 200 },
      unset: { status: 200 },
      why: "four published day rows, read from Postgres",
    },
    {
      route: "GET /v1/forecast/day-ahead",
      request: GET(
        `/v1/forecast/day-ahead?subsystem=${SUBSYSTEM}&target_date=${TARGET_DATE}`,
      ),
      down: { status: 200 },
      unset: { status: 200 },
      why: "the most-viewed screen, and the route this boundary was drawn for",
    },
    {
      route: "GET /v1/diagnosis/day-ahead",
      request: GET(`/v1/diagnosis/day-ahead?subsystem=${SUBSYSTEM}&date=${TARGET_DATE}`),
      down: { status: 200 },
      unset: { status: 200 },
      why: "the attribution is a published row; the narration falls back to the template",
    },
    {
      route: "GET /v1/curtailment/hours",
      request: GET(
        `/v1/curtailment/hours?subsystem=${SUBSYSTEM}` +
          "&from=2024-05-01T00:00:00Z&to=2024-05-08T00:00:00Z",
      ),
      down: { status: 200 },
      unset: { status: 200 },
      why: "observed history, and an absence renders as an absence rather than an error",
    },
    {
      route: "GET /v1/curtailment/episodes",
      request: GET(
        `/v1/curtailment/episodes?subsystem=${SUBSYSTEM}` +
          "&from=2024-05-01T00:00:00Z&to=2024-05-08T00:00:00Z",
      ),
      down: { status: 200 },
      unset: { status: 200 },
      why: "episodes are a SQL function over observed rows",
    },
    {
      route: "GET /v1/curtailment/reasons",
      request: GET(`/v1/curtailment/reasons?subsystem=${SUBSYSTEM}&date=${TARGET_DATE}`),
      down: { status: 200 },
      unset: { status: 200 },
      why: "ONS's own stated causes, observed and stored",
    },
    {
      route: "GET /v1/meta",
      request: GET("/v1/meta"),
      down: { status: 200 },
      unset: { status: 200 },
      why: "the readout an operator discovers the outage on; it degrades into a field",
    },
    {
      route: "GET /v1/model/card",
      request: GET(`/v1/model/card?lane=${LANE}`),
      down: { status: 503, code: "OPTIMIZER_NOT_READY" },
      unset: { status: 502, code: "OPTIMIZER_NOT_CONFIGURED" },
      why: "the card is a file on the modelling service's volume; Explain loses its curve, not its attribution",
    },
    {
      route: "GET /v1/replay/days",
      request: GET(`/v1/replay/days?subsystem=${SUBSYSTEM}&lane=${LANE}`),
      down: { status: 503, code: "OPTIMIZER_NOT_READY" },
      unset: { status: 502, code: "OPTIMIZER_NOT_CONFIGURED" },
      why: "which days are replayable is a property of the holdout artifacts on that volume",
    },
    {
      route: "POST /v1/optimize",
      request: POST("/v1/optimize"),
      down: { status: 503, code: "OPTIMIZER_NOT_READY" },
      unset: { status: 502, code: "OPTIMIZER_NOT_CONFIGURED" },
      why: "a MILP over user input cannot be precomputed",
    },
    {
      route: "POST /v1/replay",
      request: POST(`/v1/replay?lane=${LANE}`),
      down: { status: 503, code: "OPTIMIZER_NOT_READY" },
      unset: { status: 502, code: "OPTIMIZER_NOT_CONFIGURED" },
      why: "the replay solve runs the same simulator, per request",
    },
  ];

  const clear = async (): Promise<void> => {
    await db.execute(sql`delete from diagnosis_attribution_driver`);
    await db.execute(
      sql`delete from diagnosis_attribution where target_date = ${TARGET_DATE}::date`,
    );
    await db.execute(
      sql`delete from curtailment_forecast_hour where target_date = ${TARGET_DATE}::date`,
    );
    await db.execute(
      sql`delete from curtailment_forecast_day where target_date = ${TARGET_DATE}::date`,
    );
  };

  beforeAll(async () => {
    await clear();
    for (const subsystem of SUBSYSTEMS) {
      await writePublication(db, parsePublication(forecastPayload(subsystem)), {
        ingestedAt: NOW,
      });
    }
    await writeAttributionPublication(
      db,
      parseAttributionPublication(attributionPayload({ subsystem: SUBSYSTEM })),
      { ingestedAt: NOW },
    );
  });

  afterAll(async () => {
    await clear();
    refusing.stop(true);
    await handle.close();
  });

  it("is one table, and every row of it holds", async () => {
    // One assertion over the whole table, because the promise is a property of
    // the *set*: "these serve and those fail" is the sentence, and eleven
    // separate `it`s would let a green run hide which half moved.
    const observed = await Promise.all(
      TABLE.map(async (row) => ({
        route: row.route,
        down: await verdict(down, row.request()),
        unset: await verdict(unset, row.request()),
      })),
    );
    expect(observed).toEqual(
      TABLE.map((row) => ({ route: row.route, down: row.down, unset: row.unset })),
    );
  });

  it("every row of the table carries the reason it reads the way it does", () => {
    // Moving a route from the serving half to the failing half should cost the
    // author a sentence, not a number.
    for (const row of TABLE) {
      expect({ route: row.route, why: row.why.length > 30 }).toEqual({
        route: row.route,
        why: true,
      });
    }
    // And the two halves are both non-empty, or the table is asserting nothing.
    expect(TABLE.filter((row) => row.down.status === 200).length).toBeGreaterThan(5);
    expect(TABLE.filter((row) => row.down.status !== 200).length).toBeGreaterThan(2);
  });

  it("the serving routes carry a real forecast, not an empty 200", async () => {
    // A 200 over no rows would satisfy the table while proving nothing about
    // the boundary. The day-ahead read must come back with the published
    // origin on it — the stale timestamp the outage is supposed to cost.
    const response = await down.handle(
      new Request(
        `http://localhost/v1/forecast/day-ahead?subsystem=${SUBSYSTEM}&target_date=${TARGET_DATE}`,
      ),
    );
    const body = (await response.json()) as {
      forecast_origin?: { published_at?: string; origin_kind?: string };
      day_energy_mwh?: { p50?: number };
    };
    expect(body.forecast_origin?.published_at).toBe(GATE_LATE);
    expect(body.forecast_origin?.origin_kind).toBe("served");
    expect(body.day_energy_mwh?.p50).toBe(2780.25);
  });

  it("/v1/meta names the modelling service unreachable and stays otherwise correct", async () => {
    // The one crossing that is obliged to answer during the outage: it is what
    // an operator reads to *discover* it. So the model block degrades into a
    // field, and the rest of the readout — which is a Postgres read — is
    // unaffected and still says what published last.
    for (const app of [down, unset]) {
      const response = await app.handle(new Request("http://localhost/v1/meta"));
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        model?: { reachable?: boolean; unreachable_reason?: string };
        forecast?: { latest_published?: { target_date?: string }[] };
      };
      expect(body.model?.reachable).toBe(false);
      expect(typeof body.model?.unreachable_reason).toBe("string");
      // "Otherwise correct" is the load-bearing half: the Postgres side of the
      // readout still reports what published, which is exactly the stale
      // timestamp the boundary trades an outage for.
      expect(body.forecast?.latest_published?.map((each) => each.target_date)).toContain(
        TARGET_DATE,
      );
    }
  });
});

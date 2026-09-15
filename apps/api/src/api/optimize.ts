import { type DecodedScenario, SCENARIO_PARAM } from "@wattsteer/core/scenario";
import { Elysia, t } from "elysia";
import { config } from "../config.js";
import { type MlEndpoint, postMl } from "./ml-proxy.js";
import {
  applyCachePolicy,
  CACHE_POLICIES,
  type CacheContext,
} from "./plugins/cache-policy.js";
import {
  createResultCache,
  OPTIMIZE_TTL_SEC,
  optimizeKey,
  type ResultCache,
} from "./plugins/result-cache.js";
import { admitScenarioBody, admitScenarioParam } from "./scenario-gate.js";

/**
 * `POST /v1/optimize` and `GET /v1/optimize?s=` — **one HTTP request, no job
 * id.**
 *
 * `docs/specs/flex-optimizer.md`: the research measured 3.15 ms at real size,
 * 33.7 ms at ten batteries plus ten loads and 63.2 ms at 96 periods. There is
 * no queue, no job and no `OptimizationJob` noun, because Mitigate is a what-if
 * tool and a slider must move the chart. Anything on this route that looks like
 * polling is a defect, and `optimize.test.ts` asserts the absence by name.
 *
 * **Two verbs, one path through the code.** The `GET` is for deep links and
 * shares — the scenario *is* the URL, there is nothing to persist and no
 * identity to invent — and the `POST` is for the app. Both decode to the
 * identical canonical bytes and both hand those bytes, unmodified, to the
 * solver: the two transports meet in `scenario-gate.ts` and nothing downstream
 * can tell them apart. That is asserted over the wire rather than argued, since
 * "the same scenario returns a different hash depending on the verb" is exactly
 * the failure a shareable URL cannot survive.
 *
 * **What happens before a model is built**, in order, because the order is the
 * whole point — model construction rather than solving dominates the request,
 * so a request that cannot be legal must die before a model exists:
 *
 * 1. the 16 KB body cap and the solve tier's token bucket, both mounted
 *    centrally in `index.ts` and in force in `onRequest` before this handler is
 *    reached at all;
 * 2. the blob's own 4096-byte cap, checked before it is base64-decoded;
 * 3. the eighteen-rule refusal table, on the canonical document;
 * 4. the cache;
 * 5. and only then the ML service.
 *
 * A scenario refused at step 3 never reaches the solver — not "usually does
 * not", never: the gate throws and `postMl` is below it in the same function.
 *
 * **The response is passed through as text**, not as a parsed object that this
 * gateway re-serialises. The body carries a `scenario_hash` that a user may
 * reasonably compare across two requests, and re-serialising would make
 * "byte-identical" a property of key ordering rather than of the cache.
 */

/** How long the answer to an identical scenario may be reused. */
export { OPTIMIZE_TTL_SEC } from "./plugins/result-cache.js";

/** The dependencies, injected so every branch is reachable without a network. */
export interface OptimizeDeps {
  /** Where solved plans are remembered. Losing it costs one solve. */
  cache: ResultCache;
  /** Which ML service, and how long it may take. Defaults to the configured one. */
  endpoint?: MlEndpoint;
  /**
   * The build the cache keys on.
   *
   * The ML service stamps the build that actually solved on the response as
   * `x-optimizer-build`; when the two disagree, the answer is served and *not*
   * stored, because a key naming the wrong build is how a formulation change
   * quietly keeps serving yesterday's plans.
   */
  optimizerBuild?: string;
  /** The instant "tomorrow" is measured from, for the date rules. */
  now?: () => Date;
}

/** The one thing the gateway reads out of the body it is passing through. */
function resolvedOrigin(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { forecast_origin?: unknown };
    return typeof parsed.forecast_origin === "string" ? parsed.forecast_origin : null;
  } catch {
    return null;
  }
}

export function createOptimizeRoutes(deps: OptimizeDeps) {
  const build = deps.optimizerBuild ?? config.optimizerBuild;

  /**
   * Apply the shared-link row over this answer's provenance, and say whether
   * the client already holds it.
   *
   * The Redis key's own three components — `result-cache.ts` builds the key
   * from exactly these — because they are the same statement in two places: a
   * shared cache and a private one, invalidated by the same facts. A validator
   * that drifted from the key would be a 304 served against an entry the key
   * had already replaced.
   */
  const revalidate = (
    context: CacheContext,
    scenarioHash: string,
    forecastOrigin: string,
  ): boolean =>
    applyCachePolicy(context, CACHE_POLICIES.solveShared, [
      scenarioHash,
      forecastOrigin,
      build,
    ]);

  /**
   * Decode, validate, answer — from the cache when the key is fully known, and
   * from the solver otherwise.
   */
  const solve = async (decoded: DecodedScenario): Promise<string> => {
    const pinned = decoded.scenario.forecastOrigin ?? null;

    // A scenario that pins its origin has a complete key before the call, so it
    // can be answered from the cache. One that does not cannot: the origin in
    // the key is the *resolved* one, and resolving "latest" needs the forecast
    // table flex-optimizer 07 owns. Until then an unpinned request always
    // solves and warms the pinned key — which is the honest failure, the other
    // being a `latest` sentinel that serves an 00Z plan after a 12Z run lands.
    if (pinned !== null) {
      const hit = await deps.cache.get(
        optimizeKey({
          scenarioHash: decoded.hash,
          forecastOrigin: pinned,
          optimizerBuild: build,
        }),
      );
      if (hit !== null) {
        return hit;
      }
    }

    const response = await postMl("/v1/optimize", decoded.bytes, deps.endpoint);
    const body = await response.text();

    const solvedBy = response.headers.get("x-optimizer-build");
    const origin = resolvedOrigin(body);
    if (origin !== null && (solvedBy === null || solvedBy === build)) {
      await deps.cache.set(
        optimizeKey({
          scenarioHash: decoded.hash,
          forecastOrigin: origin,
          optimizerBuild: build,
        }),
        body,
        OPTIMIZE_TTL_SEC,
      );
    } else if (solvedBy !== null && solvedBy !== build) {
      // Serve it, refuse to remember it, and say why. A build the gateway does
      // not know about is a deploy skew, and the safe failure is a cache that
      // stops working rather than one that starts lying.
      console.warn(
        `optimize: solved by build ${solvedBy} but the gateway keys on ${build}; ` +
          "not caching. Set WATTSTEER_OPTIMIZER_BUILD to match the ML service.",
      );
    }
    return body;
  };

  return new Elysia({ name: "optimize" })
    .get(
      "/v1/optimize",
      async ({ query, set, request }) => {
        const decoded = admitScenarioParam(query.s, deps.now ? { now: deps.now() } : {});
        // A shared link is shared-cacheable: the answer is a function of the
        // blob, the origin and the build, none of which is the reader.
        //
        // A pinned scenario knows its whole provenance before anything is
        // solved, so the revalidation happens *here* — a client holding this
        // version costs a header comparison rather than a MILP. That is the
        // read/solve distinction this ticket keeps making: the cheapest solve
        // is the one a validator answers.
        const pinned = decoded.scenario.forecastOrigin ?? null;
        if (pinned !== null && revalidate({ set, request }, decoded.hash, pinned)) {
          return null;
        }
        const body = await solve(decoded);
        // An unpinned scenario resolves its origin *on the answer*, so its
        // validator can only be built once the answer exists. The 304 is still
        // offered here rather than only on the next request: it costs the
        // solve it could not avoid, and saves the payload — which for a
        // 96-period plan is the larger of the two. A body carrying no origin at
        // all gets no validator: `result-cache.ts` refuses to remember such an
        // answer for the same reason, and a validator over an unknown
        // provenance would collide two answers that are not the same.
        const resolved = pinned ?? resolvedOrigin(body);
        if (resolved === null) {
          applyCachePolicy({ set, request }, CACHE_POLICIES.solveShared);
          set.headers["content-type"] = "application/json";
          return body;
        }
        if (revalidate({ set, request }, decoded.hash, resolved)) {
          return null;
        }
        set.headers["content-type"] = "application/json";
        return body;
      },
      {
        query: t.Object({
          [SCENARIO_PARAM]: t.String({
            description:
              "The scenario, base64url of its canonical UTF-8 bytes, capped at " +
              "4096 bytes. The same bytes a POST carries in its body.",
          }),
        }),
        detail: {
          summary: "Optimise a shared scenario (deep link)",
          description:
            "The share and deep-link form of the solve. Decodes to the identical " +
            "canonical bytes as the POST body, answers inside one request, and " +
            "carries no job id: there is nothing to poll for.",
        },
      },
    )
    .post(
      "/v1/optimize",
      async ({ body, set, request }) => {
        const answer = await solve(
          admitScenarioBody(body as string, deps.now ? { now: deps.now() } : {}),
        );
        // A POST is not shared-cacheable; Redis does that work behind the
        // gateway, where the key can carry the provenance a URL cannot. No
        // validator: a response nobody may store has nothing to revalidate.
        applyCachePolicy({ set, request }, CACHE_POLICIES.solveBody);
        set.headers["content-type"] = "application/json";
        return answer;
      },
      {
        // Taken as text, not as a parsed object: the hash the answer is stamped
        // with is over the bytes that arrived, and a body Elysia has already
        // turned into an object is a body this route would have to re-serialise
        // before it could canonicalise it.
        parse: "text",
        body: t.String({ description: "The Scenario object, as JSON." }),
        detail: {
          summary: "Optimise a scenario",
          description:
            "One MILP built on the planning envelope, scored by the simulator " +
            "against all three, answered inside one request. No job id, no " +
            "polling: the research measured 3.15 ms at real size.",
        },
      },
    );
}

/** The wired routes, over the process-wide cache. */
export const optimizeCache: ResultCache = createResultCache(config.redisUrl);

export const optimizeRoutes = createOptimizeRoutes({ cache: optimizeCache });

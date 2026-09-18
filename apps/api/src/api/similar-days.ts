import type { SimilarDays } from "@wattsteer/core/api";
import { SUBSYSTEMS } from "@wattsteer/core/constants";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia, t } from "elysia";
import { UpstreamError } from "../errors.js";
import { callMl, type MlEndpoint } from "./ml-proxy.js";
import { laneName, targetDate as parseTargetDate } from "./params.js";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";

/**
 * `GET /v1/similar-days` — the analogue, proxied.
 *
 * ## Why the gateway adds nothing here
 *
 * The search runs where the feature rows are, which is the modelling service:
 * the day vector is six aggregates of one lane's feature function, and building
 * it here would mean a second implementation of a feature contract that already
 * has exactly one. So this route parses, forwards, and caches — and the shape
 * it forwards is typed against the generated `SimilarDays`, so a field renamed
 * in the schema breaks this compile rather than a screen.
 *
 * ## What it is, on the record
 *
 * Evidence and never a second forecast. `apps/ml`'s `similar_days.py` holds the
 * argument in full; the half that matters at this boundary is that every
 * coordinate is a `dessem_*` column published D−1, so the answer is "which past
 * day *looked* like this one" and not "which past day ended like it". A screen
 * may put a neighbour's settled total beside the band; nothing may combine
 * them.
 *
 * ## The cache key
 *
 * The lane, the subsystem, the day and the two shape parameters. Not the
 * artifact id: this read does not touch an artifact — it is feature rows and
 * settled labels — so a promotion does not change the answer and must not
 * invalidate it. It moves when ONS publishes, which is what the `now` policy is
 * for.
 */

const LANE_DESCRIPTION =
  "The artifact lane whose feature set and gate the search runs in, e.g. " +
  "dessem_free_v1__gate_late__thr5. Required and never defaulted: the day " +
  "vector is built from that lane's feature rows.";

export function createSimilarDaysRoutes(deps: { endpoint?: MlEndpoint } = {}) {
  return new Elysia({ name: "similar-days" }).get(
    "/v1/similar-days",
    async ({ query, request, set }) => {
      const lane = laneName("lane", query.lane);
      const day = parseTargetDate(query.target_date, new Date());
      const params = new URLSearchParams({
        subsystem: query.subsystem,
        lane,
        target_date: day,
      });
      if (query.days !== undefined) {
        params.set("days", query.days);
      }
      if (query.k !== undefined) {
        params.set("k", query.k);
      }

      const response = await callMl(
        "/v1/similar-days",
        params,
        ...(deps.endpoint === undefined ? [] : [deps.endpoint]),
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (body === null || typeof body !== "object") {
        throw new UpstreamError("The modelling service returned an unreadable answer", {
          code: "UPSTREAM_FAILED",
        });
      }

      if (
        applyCachePolicy({ set, request }, CACHE_POLICIES.now, [
          lane,
          query.subsystem,
          day,
          query.days ?? "default",
          query.k ?? "default",
        ])
      ) {
        return null;
      }

      // The service already speaks the wire's `snake_case`; `encodeWire` is
      // reached through the camelCase interface so the compiler checks the
      // shape rather than trusting the upstream body.
      return encodeWire("SimilarDays", fromUpstream(body as Record<string, unknown>));
    },
    {
      query: t.Object({
        subsystem: t.Union(SUBSYSTEMS.map(({ code }) => t.Literal(code))),
        lane: t.String({ description: LANE_DESCRIPTION }),
        target_date: t.Optional(
          t.String({ description: "Civil date. Defaults to tomorrow, BRT." }),
        ),
        days: t.Optional(t.String({ description: "Pool depth in days, 30–730." })),
        k: t.Optional(t.String({ description: "How many analogues, 1–10." })),
      }),
      detail: {
        summary: "The past days that looked most like this one",
        description:
          "Nearest neighbours over six day-level aggregates of ONS's " +
          "day-ahead programme, with each neighbour's settled curtailment " +
          "beside it. Evidence a reader can check against ONS's archive " +
          "without the model: nothing is fitted here and no outcome is " +
          "combined with the forecast. Empty where the pool has no spread to " +
          "measure a distance against.",
      },
    },
  );
}

/** The upstream body, read field by field into the generated shape. */
function fromUpstream(body: Record<string, unknown>): SimilarDays {
  const neighbours = Array.isArray(body.neighbours) ? body.neighbours : [];
  return {
    subsystem: String(body.subsystem) as SimilarDays["subsystem"],
    targetDate: String(body.target_date),
    lane: String(body.lane),
    poolFrom: String(body.pool_from),
    poolDays: Number(body.pool_days),
    features: Array.isArray(body.features) ? body.features.map(String) : [],
    neighbours: neighbours.map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        targetDate: String(row.target_date),
        distance: Number(row.distance),
        observedConstrainedOffMwh: Number(row.observed_constrained_off_mwh),
        hours: Number(row.hours),
      };
    }),
  };
}

export const similarDaysRoutes = createSimilarDaysRoutes();

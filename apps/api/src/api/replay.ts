import { type DecodedScenario, SCENARIO_PARAM } from "@wattsteer/core/scenario";
import { replayTargetDate } from "@wattsteer/core/scenario-validation";
import { Elysia, t } from "elysia";
import { config } from "../config.js";
import { CodedError, UpstreamError } from "../errors.js";
import { callMl, type MlEndpoint, mapUpstreamFailure, postMl } from "./ml-proxy.js";
import { optimizeCache } from "./optimize.js";
import {
  applyCachePolicy,
  CACHE_POLICIES,
  type CacheContext,
} from "./plugins/cache-policy.js";
import { OPTIMIZE_TTL_SEC, type ResultCache, replayKey } from "./plugins/result-cache.js";
import {
  admitScenarioBody,
  admitScenarioParam,
  type GateOptions,
} from "./scenario-gate.js";

/**
 * The replayable calendar — which past days can be replayed honestly, and why
 * the others are refused.
 *
 * `docs/specs/replay.md`, "The endpoint": `GET /v1/replay/days` returns the
 * calendar, **server-evaluated**, and every refusal is a typed code rather than
 * a translated string.
 *
 * ### Why this one is a proxy when `/v1/forecast/day-ahead` is not
 *
 * The forecast route resolves entirely from Postgres, and it does so precisely
 * because the gateway has no artifact volume: the day row carries
 * `trained_through` and the risk-bin edges so that nothing has to ask the
 * modelling service for them.
 *
 * The replayable predicate cannot be answered that way, and the reason is the
 * ticket's whole substance. The held-out property is re-asserted **against the
 * artifact card's own recorded windows** — both of them — and the card records
 * a *calibration* window that no forecast row carries. `trained_through` alone
 * answers a weaker question, and the prototype's `date <= MODEL_TRAINED_THROUGH`
 * is exactly that weaker question asked of the wrong artifact. So the assertion
 * runs where the cards are, and this module forwards.
 *
 * The alternative — teach the gateway the predicate and fetch the windows over
 * the wire — would put a second implementation of the assertion on the far side
 * of a network hop from the documents it asserts against, which is the class of
 * arrangement this project keeps ruling out.
 *
 * ### What the gateway still owns
 *
 * The public surface: CORS, the read budget, the error envelope, and the closed
 * error vocabulary. `ml-proxy.ts` admits upstream's code into `ERROR_CODES`
 * rather than forwarding a body, so `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW` reaches
 * a client as a 422 with a code the web app has copy for, and a
 * `REPLAY_INTEGRITY_VIOLATION` reaches it as a 500 — never as a badge over a
 * number, which is the failure mode the spec exists to prevent.
 *
 * ### The lane is required, and that is a decision left open on purpose
 *
 * Post-go-live the forecaster serves two lanes, so a `served` day has two
 * candidate forecasts, and `replay.md` uses `gate_at(d, gate_late)` in one place
 * and the generic `gate_at(d, gate_profile)` in another. Nothing here picks. The
 * caller names a lane, the answer echoes it, and every day carries
 * `candidate_lanes` so that a day with two is visibly a day with two rather than
 * one silently resolved by a default in a query-string.
 */

/** The reply is the modelling service's, unchanged. */
export type ReplayCalendarBody = Record<string, unknown>;

/**
 * The featured-days computation id, off the body that was forwarded.
 *
 * `api-surface.md`'s caching table asks for `W/"<featured-days computation
 * id>"` on these routes, and this file used to say the id did not exist yet.
 * It does: replay 07 landed `wattsteer_ml.replay.shortlist`, and the id is a
 * **digest over the basis the shortlist was computed from** — the replayable
 * days, the artifact windows and the realised numbers. A rerun that changes a
 * single hour of a single day changes it; a rerun that changes nothing does
 * not. That is a provenance in the strongest sense available on this surface,
 * and it costs nothing to read: the calendar and the shortlist travel together
 * in one response by `replay.md`'s own endpoint table, so the validator is a
 * field of a body the gateway is already holding.
 *
 * `null` while the nightly job has not run on the instance being proxied — the
 * shortlist publishes a stated `pending` rather than an empty list. An absent
 * id is served with the directive and **no** validator, which is honest: there
 * is no computation to name, and inventing a hash of the body would be a
 * revalidation costing exactly what it saves.
 */
function featuredComputationId(body: ReplayCalendarBody): string | null {
  const featured: unknown = body.featured;
  if (typeof featured !== "object" || featured === null) {
    return null;
  }
  const id: unknown = (featured as { computation_id?: unknown }).computation_id;
  return typeof id === "string" ? id : null;
}

/**
 * The same digest, where a body carries it at the top level.
 *
 * `/v1/backtest` is computed by the same nightly construction and publishes its
 * own `computation_id` — "the same construction the featured days use, and for
 * the same reason: a rerun writes a new vintage of the same publication, so
 * `forecast_origin` cannot see it and the realised numbers can."
 */
function bodyComputationId(body: ReplayCalendarBody): string | null {
  const id: unknown = body.computation_id;
  return typeof id === "string" ? id : null;
}

/**
 * The calendar's row of `api-surface.md`'s caching table, applied.
 *
 * An hour and not the replay's ten minutes because the two answer different
 * questions. A replay is a *number*, and a number's observed half is read
 * `AsOf(now)` against a record ONS restates in place; a day's *verdict* —
 * replayable, or refused under which clause — moves only when a fold calendar,
 * an artifact promotion or a settled-hour count moves, none of which happens
 * inside an hour. Under-caching it would be a date picker that revalidates on
 * every keystroke.
 *
 * These are **reads**, and the distinction is not a formality on this path:
 * `/v1/replay/days` was once metered at the *solver's* rate purely because it
 * lives under `/v1/replay`, and `rate-limit.ts` now names it out of that tier
 * by hand. Caching has the same trap and avoids it the same way — the row is
 * named here rather than inherited from the neighbouring solve.
 *
 * The request's own axes ride beside the id because one computation id covers
 * one (subsystem, lane) shortlist while the calendar around it is cut to a
 * window: two windows are two responses and must not share a validator.
 */
function calendarCache(
  context: CacheContext,
  id: string | null,
  axes: readonly string[],
): boolean {
  if (id === null) {
    return applyCachePolicy(context, CACHE_POLICIES.featuredDays);
  }
  return applyCachePolicy(context, CACHE_POLICIES.featuredDays, [id, ...axes]);
}

/**
 * Forward one replay read, or throw the failure that says whose fault it was.
 *
 * The body is returned as it arrived. It is already `snake_case` — the wire
 * casing `api-surface.md` fixes and the one Python emits — so re-encoding it
 * here would be a second translator, which `packages/core/src/wire.ts` is the
 * only one of.
 */
async function forward(
  path: string,
  query: URLSearchParams,
  endpoint?: MlEndpoint,
): Promise<ReplayCalendarBody> {
  const response = await callMl(
    path,
    query,
    ...(endpoint === undefined ? [] : [endpoint]),
  );
  if (!response.ok) {
    // `mapUpstreamFailure` keeps a recognised code at the status upstream chose,
    // which is what keeps the four replay refusals apart: two 422s about the
    // date and two 404s about the data are four different sentences and must
    // not collapse into one "no".
    throw await mapUpstreamFailure(response);
  }
  const body = await response.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    throw new UpstreamError("The ML service returned an unreadable replay calendar", {
      code: "UPSTREAM_FAILED",
    });
  }
  return body as ReplayCalendarBody;
}

/** `YYYY-MM-DD`, and a civil date rather than an instant. */
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function civilDate(label: string, raw: string): string {
  if (!CIVIL_DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    // Refused here rather than forwarded: a malformed date is a statement about
    // the request, and `REPLAY_DATE_OUT_OF_RANGE` is a statement about the
    // window. Rounding the first to the second would tell a caller their date is
    // outside a range when it is not a date.
    throw new CodedError("BAD_INPUT", `${label} must be a civil date, YYYY-MM-DD`);
  }
  return raw;
}

const LANE_DESCRIPTION =
  "The artifact lane a replay is pinned to, e.g. dessem_free_v1__gate_late__thr5. " +
  "Required and never defaulted: a post-go-live day has one candidate forecast " +
  "per served lane, and no rule yet says which one a replay is of.";

export function createReplayRoutes(endpoint?: MlEndpoint) {
  return new Elysia({ name: "replay" })
    .get(
      "/v1/backtest",
      async ({ query, set, request }) => {
        // The fourth route of this surface, and the one api-surface 17 refused
        // to serve while `wattsteer_ml.replay.backtest` did not exist — a proxy
        // in front of nothing answers 502 forever and names a healthy service
        // as broken. Replay 08 landed the aggregate, so the proxy is now honest,
        // and the test that pinned the absence named this route as owed.
        //
        // It forwards rather than aggregates, for the reason that ticket gave:
        // computing the table here would be a second scoring implementation a
        // network hop from the replay path it aggregates, and would have to
        // express fidelity-as-group-key in a query string — the one place that
        // rule cannot be enforced.
        const params = new URLSearchParams({
          fold: query.fold,
          subsystem: query.subsystem,
          lane: query.lane,
        });
        const body = await forward("/v1/backtest", params, endpoint);
        if (
          calendarCache({ set, request }, bodyComputationId(body), [
            query.fold,
            query.subsystem,
            query.lane,
          ])
        ) {
          return null;
        }
        return body;
      },
      {
        query: t.Object({
          fold: t.String({
            description:
              "The fold to report. One row comes back, or two when the fold " +
              "straddles ingestion go-live — a property of the fold rather " +
              "than a choice the caller makes.",
          }),
          subsystem: t.Union([
            t.Literal("N"),
            t.Literal("NE"),
            t.Literal("S"),
            t.Literal("SE"),
          ]),
          lane: t.String({ description: LANE_DESCRIPTION }),
        }),
        detail: {
          tags: ["replay"],
          summary: "The Backtest: many replays, aggregated per fold and vintage",
        },
      },
    )
    .get(
      "/v1/replay/days",
      async ({ query, set, request }) => {
        const params = new URLSearchParams({
          subsystem: query.subsystem,
          lane: query.lane,
        });
        if (query.from !== undefined) {
          params.set("from", civilDate("from", query.from));
        }
        if (query.to !== undefined) {
          params.set("to", civilDate("to", query.to));
        }
        const body = await forward("/v1/replay/days", params, endpoint);
        if (
          calendarCache(
            { set, request },
            featuredComputationId(body),
            [...params.entries()].flat(),
          )
        ) {
          return null;
        }
        return body;
      },
      {
        query: t.Object({
          subsystem: t.String({
            description: "ONS subsystem code: N, NE, S or SE. There is no SIN.",
          }),
          lane: t.String({ description: LANE_DESCRIPTION }),
          from: t.Optional(
            t.String({ description: "Window start. Defaults to the data window." }),
          ),
          to: t.Optional(
            t.String({ description: "Window end. Defaults to yesterday, BRT." }),
          ),
        }),
        detail: {
          summary: "Which days are replayable, and why the others are refused",
          description:
            "Every day of the window with a verdict on each. A replayable day " +
            "carries its provenance (served | fold_holdout), its " +
            "VintageFidelity, and `held_out_by` naming the fold, the artifact " +
            "and **both** of the artifact's recorded windows. A refused day " +
            "carries the code of the clause that failed — never a computed " +
            "answer with a caveat over it.",
        },
      },
    )
    .get(
      "/v1/replay/days/:date",
      async ({ params, query, set, request }) => {
        const search = new URLSearchParams({
          subsystem: query.subsystem,
          lane: query.lane,
        });
        const body = await forward(
          `/v1/replay/days/${civilDate("date", params.date)}`,
          search,
          endpoint,
        );
        // The directive and no validator: one day's verdict is answered off the
        // calendar and carries no shortlist, so there is no computation id on
        // this body to name. Inventing one from the payload would be a hash of
        // the answer — a revalidation costing exactly what it saves — and the
        // id this route wants is `/v1/replay/days`'s, which this route does not
        // receive. It is a gap in the ML contract and not in the policy.
        applyCachePolicy({ set, request }, CACHE_POLICIES.featuredDays);
        return body;
      },
      {
        params: t.Object({ date: t.String({ description: "The civil day, BRT." }) }),
        query: t.Object({
          subsystem: t.String({ description: "ONS subsystem code." }),
          lane: t.String({ description: LANE_DESCRIPTION }),
        }),
        detail: {
          summary: "One day, answered at the status of the clause that refused it",
          description:
            "422 REPLAY_DATE_OUT_OF_RANGE or REPLAY_DATE_BEFORE_HOLDOUT_WINDOW; " +
            "404 REPLAY_FORECAST_UNAVAILABLE or REPLAY_OBSERVATION_INCOMPLETE; " +
            "500 REPLAY_INTEGRITY_VIOLATION when the read-time held-out " +
            "assertion fails, which is a WattSteer bug and is logged with the " +
            "artifact id.",
        },
      },
    );
}

/**
 * `GET /v1/replay?d=&s=` and `POST /v1/replay` — **one HTTP request, no job id.**
 *
 * `docs/specs/replay.md`, "The endpoint": a replay is a `Scenario` with a past
 * `target_date`, so inventing a second transport would be inventing a second
 * scenario format. The blob is the optimizer's byte-for-byte — the same
 * canonical JCS encoding, the same `v: 1`, the same 4096-byte cap, the same
 * validation table, the same per-IP solve tier and the same failure posture —
 * and the two verbs meet in `scenario-gate.ts` exactly as `/v1/optimize`'s do,
 * so nothing downstream can tell a deep link from an app request.
 *
 * **Validation parity, minus the date clause.** The gate runs the same eighteen
 * rules; the one substitution is `replayTargetDate`, which checks the shape and
 * stops. That exception is the spec's own, and it is not a shortcut: the two
 * endpoints *cannot* agree about the date, because a 2024-06 target is a
 * perfectly good planning date (the window opens 2024-04) and is refused by a
 * replay as pre-F1. Every replay date verdict therefore comes from the
 * replayable predicate in `apps/ml`, which is the module that reads the fold
 * calendar; teaching this gateway where the holdout window opens would put a
 * second implementation of that predicate on the far side of a network hop.
 *
 * **`d` is required on the deep link and is checked, not used.** The scenario
 * already carries the day — it is a `Scenario` with a past `target_date` — so
 * `d` is redundant by construction. It is in the contract because a shared
 * replay URL should be legible to the human pasting it, and it is *checked*
 * against the blob because a URL whose visible date disagrees with the date it
 * actually replays is the one way this contract could lie to a reader.
 *
 * **What is not here.** No pre-F1 knowledge, no fold calendar, no artifact
 * cards, and no forecast: the request path contains no joblib load, no feature
 * build and no day-ahead call, which is `replay.md` story 37 and the reason a
 * replay is cheap enough to answer inline at all.
 *
 * **What the pin can and cannot promise.** It names a *publication* — the key
 * carries `<origin_kind>@<published_at>` — so a shared link is never answered
 * from a different publication, and a retrain of the serving artifact cannot
 * touch it at all, because a replay never consults the promoted artifact. It
 * does **not** name a backtest *run*: a `backfilled_holdout` row's
 * `published_at` is `gate_at(target_date, gate_profile)` by construction, so a
 * rerun of one day publishes at the same instant and appends a new vintage of
 * the same publication. `apps/ml/tests/test_database_replay_reads.py` asserts
 * that as the fact it is; closing it needs a pin that can name the run, which
 * is a change to the shared scenario transport rather than to this route.
 */

/** How long an identical replay may be reused. The optimizer's TTL, per spec. */
export const REPLAY_TTL_SEC = OPTIMIZE_TTL_SEC;

/** The dependencies, injected so every branch is reachable without a network. */
export interface ReplayDeps {
  /** Where replayed days are remembered. Losing it costs one replay. */
  cache: ResultCache;
  /** Which ML service, and how long it may take. Defaults to the configured one. */
  endpoint?: MlEndpoint;
  /**
   * The build the cache keys on. The ML service stamps the build that actually
   * solved as `x-optimizer-build`; when the two disagree the answer is served
   * and *not* stored, because a key naming the wrong build is how a formulation
   * change quietly keeps serving yesterday's plans.
   */
  optimizerBuild?: string;
  /** The instant the date rules are read on. */
  now?: () => Date;
}

/**
 * The origin component of the key, read off the answer.
 *
 * `<origin_kind>@<published_at>` and never the instant alone: a
 * `backfilled_holdout` row's `published_at` equals `gate_at(target_date,
 * gate_profile)` exactly, so on a day WattSteer both served and later
 * reconstructed, the record and the reconstruction share a publication instant.
 * The kind is what keeps them apart everywhere else in this system and it is
 * what keeps them apart here.
 *
 * `null` when the body carries no origin at all, and a body with no origin is
 * not cached: an entry whose provenance is unknown is an entry that cannot be
 * invalidated by the thing that supersedes it.
 */
function resolvedReplayOrigin(body: string): { origin: string; date: string } | null {
  try {
    const parsed = JSON.parse(body) as {
      forecast_origin?: { origin_kind?: unknown; published_at?: unknown };
      target_date?: unknown;
    };
    const origin = parsed.forecast_origin;
    if (
      typeof parsed.target_date !== "string" ||
      typeof origin?.origin_kind !== "string" ||
      typeof origin.published_at !== "string"
    ) {
      return null;
    }
    return {
      origin: `${origin.origin_kind}@${origin.published_at}`,
      date: parsed.target_date,
    };
  } catch {
    return null;
  }
}

export function createReplaySolveRoutes(deps: ReplayDeps) {
  const build = deps.optimizerBuild ?? config.optimizerBuild;
  const gate = (): GateOptions => ({
    targetDate: replayTargetDate,
    ...(deps.now ? { now: deps.now() } : {}),
  });

  /**
   * Answer one replay — from the cache when the key is fully known, and from
   * the solver otherwise.
   *
   * A scenario that pins its `forecast_origin` has a complete key *before* the
   * call and can be served from the cache; one that does not cannot, because
   * the origin in the key is the **resolved** one and resolving it is a read of
   * the forecast table this gateway does not do. So an unpinned request always
   * recomputes and warms the pinned key — which is the honest failure. The
   * other, a `latest` sentinel in the key, would serve one backtest vintage's
   * numbers under the next one's name, and that is precisely the silent
   * re-meaning of a shared link this ticket exists to prevent.
   */
  const answer = async (
    path: string,
    decoded: DecodedScenario,
    lane: string,
  ): Promise<{ body: string; origin: string | null }> => {
    const pinnedInstant = decoded.scenario.forecastOrigin ?? null;
    const targetDate = decoded.scenario.targetDate;

    // A pinned instant still resolves to one of two kinds — a record outranks a
    // reconstruction — so the key cannot be built from the pin alone. It is
    // built from the *answer*, and a pinned request is looked up under both
    // spellings: at most one of them can exist, because at most one publication
    // answered.
    const keysFor = (origin: string) =>
      replayKey({
        scenarioHash: decoded.hash,
        targetDate,
        forecastOrigin: origin,
        optimizerBuild: build,
      });

    if (pinnedInstant !== null) {
      for (const kind of ["served", "backfilled_holdout"]) {
        const origin = `${kind}@${pinnedInstant}`;
        const hit = await deps.cache.get(keysFor(origin));
        if (hit !== null) {
          return { body: hit, origin };
        }
      }
    }

    const query = new URLSearchParams({ lane });
    const response = await postMl(
      `${path}?${query.toString()}`,
      decoded.bytes,
      deps.endpoint,
    );
    const body = await response.text();

    const solvedBy = response.headers.get("x-optimizer-build");
    const resolved = resolvedReplayOrigin(body);
    if (resolved !== null && (solvedBy === null || solvedBy === build)) {
      await deps.cache.set(keysFor(resolved.origin), body, REPLAY_TTL_SEC);
    } else if (solvedBy !== null && solvedBy !== build) {
      // Serve it, refuse to remember it, and say why. A build the gateway does
      // not know about is a deploy skew, and the safe failure is a cache that
      // stops working rather than one that starts lying.
      console.warn(
        `replay: solved by build ${solvedBy} but the gateway keys on ${build}; ` +
          "not caching. Set WATTSTEER_OPTIMIZER_BUILD to match the ML service.",
      );
    }
    return { body, origin: resolved?.origin ?? null };
  };

  /**
   * The provenance a replayed day has, as an ETag.
   *
   * The Redis key's components, so the shared validator and the private key are
   * invalidated by the same facts. What is **not** in either is the observed
   * `data_version`, which `api-surface.md`'s table asks for and the replay
   * contract does not publish — the gap `plugins/result-cache.ts` records on
   * `replayKey`, and it is the same gap here for the same reason. Until the ML
   * service names the vintage of the observed half, an ONS restatement is
   * waited out by the ten-minute window rather than evicted by the key, and
   * `vintage_fidelity` on the payload is what tells a reader the ground may
   * have moved.
   *
   * Returns `true` when the client already holds this replay, in which case the
   * status is 304 and there is no body to write.
   */
  const revalidate = (
    context: CacheContext,
    decoded: DecodedScenario,
    origin: string,
  ): boolean =>
    applyCachePolicy(context, CACHE_POLICIES.replay, [
      decoded.hash,
      decoded.scenario.targetDate,
      origin,
      build,
    ]);

  /**
   * The deep link's visible date, checked against the blob it links to.
   *
   * A statement about the request, so `BAD_INPUT` — not
   * `REPLAY_DATE_OUT_OF_RANGE`, which is a statement about the window and would
   * tell a caller their date is outside a range when the problem is that they
   * sent two of them.
   */
  const sameDay = (d: string, decoded: DecodedScenario): DecodedScenario => {
    if (civilDate("d", d) !== decoded.scenario.targetDate) {
      throw new CodedError(
        "BAD_INPUT",
        `d is ${d} and the scenario replays ${decoded.scenario.targetDate}; a ` +
          "replay link whose visible date is not the day it replays is not a link " +
          "anyone can read",
      );
    }
    return decoded;
  };

  const LANE = t.String({ description: LANE_DESCRIPTION });

  return new Elysia({ name: "replay-solve" })
    .get(
      "/v1/replay",
      async ({ query, set, request }) => {
        const decoded = sameDay(query.d, admitScenarioParam(query.s, gate()));
        const answered = await answer("/v1/replay", decoded, query.lane);
        // A shared link is shared-cacheable: the answer is a function of the
        // blob, the pinned origin and the build, none of which is the reader.
        //
        // Ten minutes and not the optimizer's five, per `api-surface.md`'s
        // caching table. The optimizer's window is short because a scenario is
        // planned against a forecast that supersedes twice a day and a shared
        // cache must not outlive the next gate; a replay's forecast half is a
        // pinned historical row that no gate can supersede. What can still move
        // underneath it is the *observed* half — ONS restates history in place —
        // so this is a `max-age` and never `immutable`, and the response is
        // deliberately not frozen against a restatement.
        // A body carrying no origin gets no validator, for the reason
        // `result-cache.ts` refuses to remember one: an entry whose provenance
        // is unknown cannot be invalidated by the thing that supersedes it, and
        // a validator over an unknown provenance would collide two answers that
        // are not the same answer.
        //
        // The pin resolves to one of two origin kinds and only the answer says
        // which, so unlike `/v1/optimize` this route cannot revalidate before
        // it computes. The 304 is still served: it costs the replay it could
        // not avoid and saves a payload carrying 24 dispatch hours, an episode
        // list and a perfect-foresight bound.
        if (answered.origin === null) {
          applyCachePolicy({ set, request }, CACHE_POLICIES.replay);
          set.headers["content-type"] = "application/json";
          return answered.body;
        }
        if (revalidate({ set, request }, decoded, answered.origin)) {
          return null;
        }
        set.headers["content-type"] = "application/json";
        return answered.body;
      },
      {
        query: t.Object({
          d: t.String({
            description:
              "The civil day being replayed, YYYY-MM-DD. Redundant with the " +
              "scenario's own target_date and checked against it: a link whose " +
              "visible date is not the day it replays cannot be read.",
          }),
          [SCENARIO_PARAM]: t.String({
            description:
              "The scenario, base64url of its canonical UTF-8 bytes, capped at " +
              "4096 bytes. The same bytes a POST carries in its body, and the " +
              "same bytes /v1/optimize takes.",
          }),
          lane: LANE,
        }),
        detail: {
          summary: "Replay a past day (deep link)",
          description:
            "One MILP on the pinned D−1 P50, five simulator passes and the " +
            "fenced perfect-foresight bound, answered inside one request. The " +
            "response echoes the **pinned** forecast_origin, which is what makes " +
            "the link reproducible after a retrain.",
        },
      },
    )
    .post(
      "/v1/replay",
      async ({ body, query, set, request }) => {
        const decoded = admitScenarioBody(body as string, gate());
        const answered = await answer(
          "/v1/replay",
          query.d === undefined ? decoded : sameDay(query.d, decoded),
          query.lane,
        );
        // Not shared-cacheable; Redis does that work behind the gateway, where
        // the key can carry the provenance a URL cannot. No validator: a
        // response nobody may store has nothing to revalidate.
        applyCachePolicy({ set, request }, CACHE_POLICIES.solveBody);
        set.headers["content-type"] = "application/json";
        return answered.body;
      },
      {
        // Taken as text for the reason `/v1/optimize` takes it as text: the hash
        // the answer is stamped with is over the bytes that arrived, and a body
        // Elysia has already parsed is one this route would have to
        // re-serialise before it could canonicalise it.
        parse: "text",
        query: t.Object({
          lane: LANE,
          d: t.Optional(
            t.String({
              description:
                "Optional here, and checked when present. The body already " +
                "carries the day; this is for a caller that wants the two " +
                "asserted equal.",
            }),
          ),
        }),
        body: t.String({ description: "The Scenario object, as JSON." }),
        detail: {
          summary: "Replay a past day",
          description:
            "The same replay as the GET, over the identical canonical bytes. No " +
            "job id and no polling: the request path contains no model — the " +
            "forecast is a pinned row, and what runs is the MILP and the simulator.",
        },
      },
    )
    .post(
      "/v1/replay/observed-only",
      async ({ body, query, set, request }) => {
        const answered = await answer(
          "/v1/replay/observed-only",
          admitScenarioBody(body as string, gate()),
          query.lane,
        );
        applyCachePolicy({ set, request }, CACHE_POLICIES.solveBody);
        set.headers["content-type"] = "application/json";
        return answered.body;
      },
      {
        parse: "text",
        query: t.Object({ lane: LANE }),
        body: t.String({ description: "The Scenario object, as JSON." }),
        detail: {
          summary: "A pre-F1 day: what happened, and the bound",
          description:
            "The view a day with no honest counterfactual gets instead of a " +
            "replay: the settled profile, its episodes and the perfect-foresight " +
            "bound, which needs no forecast and therefore no model. `scored`, " +
            "`avoided_energy_mwh` and `recovered_floor_mwh` are **absent**, not " +
            "zero — WattSteer made no plan for these days. Any day that is not " +
            "pre-F1 is refused with its own code.",
        },
      },
    );
}

/**
 * The gateway's instance, mounted in `index.ts` — the calendar routes and the
 * solve routes as one plugin, so `/v1/replay*` arrives at the gateway from one
 * place.
 *
 * **The cache is the optimizer's instance, under a different key prefix.** One
 * Redis, one connection, one shutdown — `replay:v1:…` and `opt:v1:…` cannot
 * collide, and a second client to the same server would be a second thing to
 * close and a second thing to get the timeout right on.
 *
 * The factories above stay exported so a test can point the same routes at a
 * stub upstream and an in-memory cache: the failure mapping and the key are
 * most of what this module is for, and neither is reachable from a module-level
 * constant.
 */
export const replayRoutes = createReplayRoutes().use(
  createReplaySolveRoutes({ cache: optimizeCache }),
);

/**
 * ### `GET /v1/backtest` is the fourth route of this surface and it is not here
 *
 * `api-surface.md` lists it at #13 and `replay.md` fixes its contract, and the
 * reason it is absent is not that it was forgotten: **the aggregate it would
 * serve does not exist.** Replay 08 owns it, and `docs/domain-model.md` gives
 * `Backtest` to the aggregate of many Replays consumed by the hot-swap gate —
 * not to the forecaster's fold evaluation, which is a different noun that
 * happens to share an English word. Nothing in this repository computes
 * `days_replayed`, `floor_coverage` or `mean_avoidability` at any grain, and
 * `apps/ml` exposes no `/v1/backtest` for a proxy to stand in front of.
 *
 * Three things were available and two of them are worse than the absence.
 *
 * A route forwarding to an upstream path that does not exist would publish an
 * endpoint in `/docs` that answers `502 OPTIMIZER_NOT_READY` forever, which
 * tells a client the modelling service is broken when the truth is that the
 * feature is unbuilt. A route computing the aggregate here would put a second
 * scoring implementation on the far side of a network hop from the replay path
 * it is supposed to be an aggregate *of* — the exact drift replay 08's own
 * acceptance list forbids in the sentence "every metric is produced by running
 * the ticket 03 replay path per day". Either would also have to choose the
 * grouping, and the one structural rule this endpoint has — fidelity is a
 * **group key** and never a filter, so an aggregate cannot average a
 * `revision_optimistic` row into a `point_in_time` one — is a property of an
 * aggregation function, not of a query string. Inventing one at the gateway
 * would put that rule where it cannot be enforced.
 *
 * So the surface serves three of the four and says so. `solver-surface.test.ts`
 * holds the absence in place from both ends: the gateway is asserted to serve no
 * `/v1/backtest`, and `apps/ml` is asserted to expose none — so the day replay
 * 08 lands the aggregate, that test fails and names this route as the thing then
 * owed. An absence that cannot rot into a silence.
 */

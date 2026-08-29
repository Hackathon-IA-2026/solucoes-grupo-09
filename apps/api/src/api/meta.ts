import type { Meta, MetaFreshness, MetaLane, MetaModel } from "@wattsteer/core/api";
import {
  BRL_PER_MWH,
  MAX_GAP_HOURS,
  REFERENCE_FLEET,
  REPORTING_ENTITY_THRESHOLD_MW,
  SOURCE_ATTRIBUTION,
  SUBSYSTEM_THRESHOLD_MW,
} from "@wattsteer/core/constants";
import { DATA_WINDOW, GATES, nextPublication } from "@wattsteer/core/schedule";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia } from "elysia";
import { config } from "../config.js";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import { readSourceFreshness } from "../ingest/index.js";
import { callMl, type MlEndpoint } from "./ml-proxy.js";

/**
 * `GET /v1/meta` — what this deployment can actually do, in one request.
 *
 * The precondition every screen reads before it renders anything, and the
 * endpoint that makes a misconfigured deployment diagnosable without a shell.
 * It is **the gateway's own answer**, not a proxy of the modelling service's
 * `/v1/meta`: it merges what only the gateway knows — the window bounds, the
 * published constants, the gate table, ingestion freshness, the publication
 * state — with the two facts only the modelling service knows, which are the
 * artifact lanes and the volume.
 *
 * Five things it carries, and each is load-bearing rather than convenient:
 *
 * - **The lane states, verbatim.** `no_artifact`, `present_unpromoted` and
 *   `promoted` are `apps/ml/src/wattsteer_ml/artifacts.py`'s own spellings and
 *   are not re-worded here, because "a stale forecast and an unmounted volume
 *   do not look alike" is a requirement and a re-wording is where two
 *   vocabularies start. The volume is reported *beside* them for the same
 *   reason: an unmounted volume is a fact about the mount, not a lane with
 *   nothing in it.
 * - **The gate table as data.** The Overview's "tomorrow's view publishes at
 *   19:00 BRT" sentence is built from `gates` and `next_publication_at`, so no
 *   screen hardcodes a publication time and no screen keeps saying one after
 *   the schedule moves.
 * - **Per-source freshness**, including the sources that have never ingested at
 *   all — reported with nulls rather than omitted, because an omitted source is
 *   an invisible one.
 * - **The reference fleet, echoed.** `docs/specs/api-surface.md` refuses to give
 *   it an endpoint: a caller that *fetches* the fleet in order to compute
 *   against it can be served a different battery than the number it is looking
 *   at was computed with. It is here to be read by a human, and
 *   `test/meta.test.ts` asserts nothing in the product fetches it.
 * - **The attribution block as data**, from the one shared constant, with the
 *   licence identifiers untranslated so the bilingual §4.3 notice is assembled
 *   by the client around them.
 *
 * ### It degrades, and that is the point
 *
 * This is the endpoint an operator reaches for when things are broken, so a
 * broken modelling service must not break it. Every other block resolves from
 * Postgres and from published constants; the `model` block is the only one
 * behind the ML call, and a failed call fills it with `reachable: false` plus
 * the code that says *which* failure it was — unconfigured, refused, timed out.
 * `apps/ml`'s own `/v1/meta` never raises for the same reason: a damaged
 * promotion log arrives there as a reported `unresolvable` lane rather than a
 * 500, and it arrives here as one too, because mapping it onto `no_artifact`
 * would report a damaged volume as an untrained lane.
 *
 * This route is therefore the **one read that crosses to the modelling service
 * on purpose** — `docs/specs/api-surface.md`'s Seam 1 names the optimizer and
 * the replay solve, and this is the third and last crossing: it is diagnostic,
 * it is not a data path, and it is the only one whose failure changes nothing
 * but a single field.
 *
 * ### No `ETag`, and no cache
 *
 * `no-store`, with no validator, which is `api-surface.md`'s caching table and
 * is in tension with its own story 25 ("an ETag on every read"). The tension is
 * resolved in favour of `no-store`, and not by splitting the difference: an
 * ETag exists so a shared cache can revalidate rather than re-query, and a
 * response that may not be stored has nothing to revalidate. Worse, the 304 it
 * would enable is the wrong answer to this endpoint's actual question — an
 * operator asking "is the volume still gone?" must not be told "unchanged" by a
 * cache that was never allowed to hold the previous answer. Story 25's benefit
 * is measured against re-querying Postgres, and this read is a handful of
 * aggregates over indexed columns plus one 5-second-budgeted call.
 */

/** The gateway's identity, as `/` and the OpenAPI document also spell it. */
const SERVICE = "wattsteer-api";
const VERSION = "0.1.0";

/** The lane states the modelling service is allowed to report. */
const LANE_STATES = new Set([
  "no_artifact",
  "present_unpromoted",
  "promoted",
  "unresolvable",
]);

/** The modelling service's `/v1/meta`, read tolerantly. */
interface MlMeta {
  artifacts?: {
    mounted?: unknown;
    writable?: unknown;
    lanes?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One lane, translated into this endpoint's vocabulary.
 *
 * `promoted` becomes `artifact_id` because that is what the identifier is —
 * the artifact this lane is allowed to serve — and `null` is a fact rather than
 * an absence of information: nothing has been promoted here.
 *
 * A state this gateway does not recognise becomes `unresolvable` carrying the
 * value it saw, never one of the three. A newer modelling service that grows a
 * fourth state must not have it silently rounded down to "nothing trained".
 */
function toLane(raw: unknown): MetaLane | null {
  if (!isRecord(raw) || typeof raw.lane !== "string") {
    return null;
  }
  const reported = typeof raw.state === "string" ? raw.state : "";
  const known = LANE_STATES.has(reported);
  const fault =
    typeof raw.fault === "string" && raw.fault !== ""
      ? raw.fault
      : known
        ? undefined
        : `The modelling service reported an unrecognised lane state "${reported}"`;
  return {
    lane: raw.lane,
    state: known ? (reported as MetaLane["state"]) : "unresolvable",
    artifactId: typeof raw.promoted === "string" ? raw.promoted : null,
    ...(fault === undefined ? {} : { fault }),
  };
}

/**
 * The `model` block, from the modelling service or from its absence.
 *
 * Never throws. The one call this endpoint makes across the boundary is wrapped
 * whole, including the JSON parse, because a service answering 200 with an
 * unreadable body is a broken service and not a broken gateway.
 */
async function readModel(endpoint?: MlEndpoint): Promise<MetaModel> {
  let body: unknown;
  try {
    const response = await callMl(
      "/v1/meta",
      new URLSearchParams(),
      ...(endpoint === undefined ? [] : [endpoint]),
    );
    body = await response.json();
  } catch (error) {
    // `ml-proxy.ts` has already decided whose fault it was and named it:
    // `OPTIMIZER_NOT_CONFIGURED` is a deployment that has no modelling service,
    // `OPTIMIZER_UNAVAILABLE` is one that will not answer, `OPTIMIZER_TIMEOUT`
    // is one that is too slow. Three different sentences for an operator, and
    // the reason this field is not a boolean.
    const code =
      isRecord(error) && typeof error.code === "string" ? error.code : "UPSTREAM_FAILED";
    return { reachable: false, unreachableReason: code, lanes: [], volume: null };
  }

  const meta = (isRecord(body) ? body : {}) as MlMeta;
  const artifacts = isRecord(meta.artifacts) ? meta.artifacts : {};
  const lanes = Array.isArray(artifacts.lanes) ? artifacts.lanes : [];
  return {
    reachable: true,
    lanes: lanes.map(toLane).filter((lane): lane is MetaLane => lane !== null),
    // The mount's two states, reported separately from the lanes' three.
    volume: {
      mounted: artifacts.mounted === true,
      writable: artifacts.writable === true,
    },
  };
}

/** The freshness block, in the wire's own vocabulary of instants. */
function toFreshness(source: {
  source: string;
  latestValidTime: Date | null;
  latestIngestedAt: Date | null;
  lagHours: number | null;
}): MetaFreshness {
  return {
    source: source.source,
    latestValidTime: source.latestValidTime?.toISOString() ?? null,
    latestIngestedAt: source.latestIngestedAt?.toISOString() ?? null,
    lagHours: source.lagHours,
  };
}

/**
 * The whole body, built field by field against the generated interface.
 *
 * Field by field rather than by handing an observation to the encoder, as
 * `grid.ts` and `plants.ts` do it and for the same reason: the schema is
 * `additionalProperties: false`, so a key the payload has no business carrying
 * is a contract violation found by a compiler here instead of by a validator in
 * production.
 */
export function toMeta(parts: {
  now: Date;
  environment: string;
  model: MetaModel;
  freshness: MetaFreshness[];
}): Meta {
  const next = nextPublication(parts.now);
  return {
    service: SERVICE,
    version: VERSION,
    environment: parts.environment,
    serverTime: parts.now.toISOString(),
    window: {
      opensOn: DATA_WINDOW.opensOn,
      ingestionGoLive: DATA_WINDOW.ingestionGoLive,
      firstHoldoutFoldStart: DATA_WINDOW.firstHoldoutFoldStart,
    },
    // The four published constants, echoed from `packages/core`. Echoed for
    // diagnosability — a client that *reads* its threshold from here is a
    // client whose numbers were computed against a different one.
    defaults: {
      subsystemThresholdMw: SUBSYSTEM_THRESHOLD_MW,
      reportingEntityThresholdMw: REPORTING_ENTITY_THRESHOLD_MW,
      maxGapHours: MAX_GAP_HOURS,
      brlPerMwh: BRL_PER_MWH,
    },
    gates: GATES.map((gate) => ({
      profile: gate.profile,
      publishesAtLocal: gate.publishesAtLocal,
      timezone: gate.timezone,
      weatherRun: gate.weatherRun,
    })),
    model: parts.model,
    forecast: {
      // Empty until the publication job exists (`api-surface` ticket 10): there
      // is no `curtailment_forecast_hour` to read, and nothing has been
      // published, so an empty list is the true statement rather than a
      // placeholder. `next_publication_at` is already real — it is derived from
      // the gate table, which is why a failed publication is visible as an
      // instant that passed with no origin behind it.
      latestPublished: [],
      nextPublicationAt: next.at.toISOString(),
    },
    data: { freshness: parts.freshness },
    referenceFleet: {
      battery: { ...REFERENCE_FLEET.battery },
      shiftableLoad: { ...REFERENCE_FLEET.shiftableLoad },
    },
    // Every source the shared constant names, whole. The map's keys are data
    // and travel untouched; its values are a named shape, so
    // `derivativeDatabase` reaches the wire as `derivative_database` — which it
    // did not before `packages/core`'s translator learned that a map value is
    // still an object. See `wire.ts`.
    attribution: Object.fromEntries(
      Object.entries(SOURCE_ATTRIBUTION).map(([key, source]) => [key, { ...source }]),
    ),
  };
}

export function createMetaRoutes(deps: {
  db: Database | undefined;
  ml?: MlEndpoint;
  now?: () => Date;
  environment?: string;
}) {
  return new Elysia({ name: "meta" }).get(
    "/v1/meta",
    async ({ set }) => {
      const now = deps.now?.() ?? new Date();

      // Both halves are attempted regardless of the other, which is what
      // "degrades" means here: a modelling service that is down does not cost
      // the caller the freshness block, and a database that is not configured
      // does not cost them the lane states. Neither absence is an error on this
      // endpoint — being able to say *which* things are missing is its job.
      const [model, freshness] = await Promise.all([
        readModel(deps.ml),
        deps.db === undefined ? [] : readSourceFreshness(deps.db, { now }),
      ]);

      set.headers["cache-control"] = "no-store";
      return encodeWire(
        "Meta",
        toMeta({
          now,
          environment: deps.environment ?? config.nodeEnv,
          model,
          freshness: freshness.map(toFreshness),
        }),
      );
    },
    {
      detail: {
        summary: "What this deployment can do, and what is wrong with it",
        description:
          "The window bounds, the published defaults, the gate table, the model " +
          "lanes and the artifact volume, the forecast publication state, " +
          "per-source ingestion freshness, the reference fleet and the source " +
          "attribution. Degrades rather than fails: with the modelling service " +
          "unreachable this is still a 200 and only the model block says so. " +
          "`no-store` — a cached answer to 'what is broken' is worse than none.",
      },
    },
  );
}

/** The wired route, over the process-wide handle. */
export const metaRoutes = createMetaRoutes({ db: database?.db });

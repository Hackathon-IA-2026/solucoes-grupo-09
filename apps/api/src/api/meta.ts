import type {
  DeclinedFigure,
  Meta,
  MetaDeclines,
  MetaForecastStateLatestPublishedItem,
  MetaFreshness,
  MetaLane,
  MetaModel,
} from "@wattsteer/core/api";
import {
  BRL_PER_MWH,
  MAX_GAP_HOURS,
  REFERENCE_FLEET,
  REPORTING_ENTITY_THRESHOLD_MW,
  SOURCE_ATTRIBUTION,
  SUBSYSTEM_THRESHOLD_MW,
} from "@wattsteer/core/constants";
import { DECLINE_KINDS, GATEWAY_DECLINED_FIGURES } from "@wattsteer/core/declines";
import { DATA_WINDOW, GATES, nextPublication } from "@wattsteer/core/schedule";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia } from "elysia";
import { config } from "../config.js";
import type { Database } from "../database/connection.js";
import { database } from "../database/connection.js";
import { type PublishedOrigin, readLatestPublished } from "../forecast/reads.js";
import { readSourceFreshness } from "../ingest/index.js";
import { callMl, type MlEndpoint } from "./ml-proxy.js";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";

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
 *   nothing in it. **`usable` and `retrain_owed` travel with them**: a lane can
 *   be `promoted` and still serve nothing, when the artifact the promotion log
 *   names has been marked invalid against a feature contract that moved under
 *   it, and that is the one unserviceable state a human has to act on.
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
 * - **The census of figures this deployment declines to state** — forecaster
 *   25's `declines` block, and the argument for it being *here* is below.
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
 * ### Why the census of declined figures is on this endpoint
 *
 * The discipline of refusing to publish a number rather than fabricating one
 * produced a growing set of *named* absences — `ARCHIVE_FEATURES_HAVE_NO_SHAPE`,
 * `NOT_RUN_YET`, `MARGINAL_COVERAGE_NOT_RUN_YET`, `no_joint_ensemble` and the
 * rest. Each is honest where it stands and collectively they were unfindable,
 * scattered across cards, blocks and wire fields. The value of refusing to
 * fabricate is only realised if the refusals are findable, so forecaster 25
 * asks for one surface. Three candidates, and this is the one:
 *
 * - **Not the model card.** A card is a property of one lane's *promoted
 *   artifact*: `/v1/model/card` requires a `lane`, refuses with
 *   `MODEL_UNAVAILABLE` when nothing is promoted, and is cached for an hour
 *   against the artifact id. All three are wrong for this set. What a build
 *   declines to state is not lane-scoped — the transformer benchmark and the
 *   national band belong to no lane — it does not change on promotion, so the
 *   card's cache identity would hold it stale across the deploy that *did*
 *   change it, and a reviewer would be refused the list in precisely the
 *   deployment where knowing what is not claimed matters most.
 * - **Not its own read.** It would need a new row in `api-surface.md`'s caching
 *   table and a second copy of this endpoint's degradation machinery, to answer
 *   in one request the same question this one already answers.
 * - **Here.** "What is this deployment, and what is wrong with it" is already
 *   the question, the answer is already `no-store` so it cannot be served stale
 *   across a deploy, and the merge is already the shape: what only the gateway
 *   knows joined to what only the modelling service knows, degrading rather
 *   than failing.
 *
 * The set is **assembled, never listed**. The modelling service walks its own
 * package for declared reason constants; the gateway's one entry is keyed by
 * the schema enum that owns it, so a second `band_unavailable_reason` is a
 * compile error rather than a silent omission. Adding a named reason on either
 * side requires editing no list, and nothing in this module enumerates them —
 * `test/declined-figures.test.ts` scans `apps/ml`'s source and requires every
 * declaration it finds to arrive on the response.
 *
 * **And the block says when it is short.** With the modelling service
 * unreachable its half is unknown, and `incomplete_reason` says so rather than
 * letting a one-row census read as a deployment that withholds one figure. A
 * census of what a system refuses to claim is the last place that could afford
 * to imply a completeness it does not have.
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

/**
 * The lane **conditions** the modelling service is allowed to report.
 *
 * Four, and named `LANE_CONDITIONS` rather than `LANE_STATES` because
 * `@wattsteer/core/errors` exports a `LANE_STATES` with **three** — the
 * error-envelope vocabulary, which excludes `promoted` on purpose. This module
 * once spelt its local four-member set with that same identifier, which left
 * `LANE_STATES.has(reported)` reading, to anyone who followed the name to its
 * other definition, like a gateway that reports every healthy lane as
 * unrecognised. It never did; the name was the defect.
 *
 * The two vocabularies answer different questions and legitimately differ about
 * one lane at one moment: a contract-faulted lane is `promoted` here (the
 * promote line exists; `usable`, `retrain_owed` and `contract_fault` beside it
 * say it cannot serve) and `unresolvable` in a `/v1/model/card` 503. This
 * endpoint mirrors the *condition* vocabulary, because that is the question an
 * operator reading `/v1/meta` is asking.
 */
const LANE_CONDITIONS = new Set([
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
  declines?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field the modelling service reports as prose, or nothing at all. */
function prose(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * One lane, translated into this endpoint's vocabulary.
 *
 * `promoted` becomes `artifact_id` because that is what the identifier is —
 * the artifact this lane is allowed to serve — and `null` is a fact rather than
 * an absence of information: nothing has been promoted here.
 *
 * A condition this gateway does not recognise becomes `unresolvable` carrying
 * the value it saw, never one of the other three. A newer modelling service
 * that grows a fifth condition must not have it silently rounded down to
 * "nothing trained".
 *
 * **`usable` and `retrain_owed` are forwarded, not derived.** `state:
 * "promoted"` does not mean the lane can answer: an artifact the hot-swap
 * gate's contract check marked invalid is refused by the loader, which is the
 * state `0039_the_gate_over_a_backfill.sql` put both serving lanes into by
 * moving `feature_hash` on purpose. Only the modelling service can read the
 * card that says so, so this endpoint carries its answer rather than inferring
 * one from the state — and **omits the fields when they are absent**, because
 * an older modelling service that cannot say is not one reporting `false`.
 */
function toLane(raw: unknown): MetaLane | null {
  if (!isRecord(raw) || typeof raw.lane !== "string") {
    return null;
  }
  const reported = typeof raw.state === "string" ? raw.state : "";
  const known = LANE_CONDITIONS.has(reported);
  const fault =
    prose(raw, "fault") ??
    (known
      ? undefined
      : `The modelling service reported an unrecognised lane state "${reported}"`);
  const usable = typeof raw.usable === "boolean" ? raw.usable : undefined;
  const retrainOwed =
    typeof raw.retrain_owed === "boolean" ? raw.retrain_owed : undefined;
  const contractFault = prose(raw, "contract_fault");
  const cardError = prose(raw, "card_error");
  const unusableReason = prose(raw, "unusable_reason");
  return {
    lane: raw.lane,
    state: known ? (reported as MetaLane["state"]) : "unresolvable",
    artifactId: typeof raw.promoted === "string" ? raw.promoted : null,
    ...(fault === undefined ? {} : { fault }),
    ...(usable === undefined ? {} : { usable }),
    ...(retrainOwed === undefined ? {} : { retrainOwed }),
    ...(contractFault === undefined ? {} : { contractFault }),
    ...(cardError === undefined ? {} : { cardError }),
    ...(unusableReason === undefined ? {} : { unusableReason }),
  };
}

/**
 * The two kinds a declared absence may be, as a set the runtime can check.
 *
 * `unrunnable` says a figure cannot be produced here; `unrun` says nobody has
 * produced it yet. They are two on purpose and this module may not make them
 * one: forecaster 16's `ARCHIVE_FEATURES_HAVE_NO_SHAPE` is the first sentence
 * and forecaster 18 chose `NOT_RUN_YET` specifically so that it would not read
 * like it. A shared "unavailable" bucket would delete the difference three
 * tickets were written to create.
 */
const KINDS: ReadonlySet<string> = new Set<string>(DECLINE_KINDS);

/** What a field the modelling service did not supply is reported as. */
const NOT_REPORTED = "(not reported by the modelling service)";

/** A non-empty string, or nothing — a blank field is not a statement. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * One declared absence, forwarded — and it is forwarded rather than shaped.
 *
 * Every field keeps the modelling service's own spelling for the reason
 * `model-card.ts` keeps the card's: the forecaster owns the vocabulary of its
 * own absences, and a re-wording on the way out is where two vocabularies
 * start. So this function has exactly one job, which is to refuse to lose
 * anything.
 *
 * **A `kind` this build does not recognise becomes `unresolvable`, never one of
 * the two, and never a dropped row.** It is the same refusal {@link toLane}
 * makes for an unrecognised lane state: rounding an unknown value onto a known
 * one publishes a claim on the strength of not recognising a name, and the two
 * claims available here are exactly the two this census exists to keep apart. A
 * field the service did not supply is reported as unsupplied for the same
 * reason — a census that quietly shed the rows it could not parse would be
 * shorter than the truth, which is the one direction it may never be wrong in.
 */
function toDeclinedFigure(raw: unknown): DeclinedFigure {
  const record = isRecord(raw) ? raw : {};
  const faults: string[] = [];
  const field = (key: string): string => {
    const value = text(record[key]);
    if (value === undefined) {
      faults.push(`no ${key}`);
      return NOT_REPORTED;
    }
    return value;
  };
  const name = field("name");
  const declaredIn = field("declared_in");
  const figure = field("figure");
  const reason = field("reason");
  const surface = field("surface");
  const reported = text(record.kind);
  const known = reported !== undefined && KINDS.has(reported);
  if (!known) {
    faults.push(`an unrecognised kind ${JSON.stringify(reported ?? null)}`);
  }
  return {
    name,
    declaredIn,
    figure,
    kind: known ? (reported as DeclinedFigure["kind"]) : "unresolvable",
    reason,
    surface,
    ...(faults.length === 0
      ? {}
      : {
          fault:
            "The modelling service reported this absence with " +
            `${faults.join(", ")}, so what it is a statement about could not ` +
            "be resolved here. It is reported as it arrived rather than " +
            "dropped: a census that shed the rows it could not read would be " +
            "shorter than the truth.",
        }),
  };
}

/**
 * The census, from this build's own half and the modelling service's.
 *
 * Sorted by name across both halves, so two deployments are diffable and the
 * order carries no argument about which half matters more.
 */
function toDeclines(model: {
  figures: DeclinedFigure[];
  incompleteReason: string | null;
}): MetaDeclines {
  return {
    figures: [...model.figures, ...GATEWAY_DECLINED_FIGURES].sort((one, other) =>
      one.name.localeCompare(other.name),
    ),
    incompleteReason: model.incompleteReason,
  };
}

/**
 * The `model` block, from the modelling service or from its absence.
 *
 * Never throws. The one call this endpoint makes across the boundary is wrapped
 * whole, including the JSON parse, because a service answering 200 with an
 * unreadable body is a broken service and not a broken gateway.
 */
async function readModel(endpoint?: MlEndpoint): Promise<{
  model: MetaModel;
  figures: DeclinedFigure[];
  incompleteReason: string | null;
}> {
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
    // The same code answers two questions on this response, and that is the
    // point rather than a shortcut: with the service unreachable its half of
    // the census is unknown, so the census says it may be short *and why*, in
    // the same words the `model` block uses to say what went wrong.
    return {
      model: { reachable: false, unreachableReason: code, lanes: [], volume: null },
      figures: [],
      incompleteReason: code,
    };
  }

  const meta = (isRecord(body) ? body : {}) as MlMeta;
  const artifacts = isRecord(meta.artifacts) ? meta.artifacts : {};
  const lanes = Array.isArray(artifacts.lanes) ? artifacts.lanes : [];
  // An array is the only thing that can be believed here. A modelling service
  // that answered without a census block at all is an *older build*, not a
  // build that withholds nothing — the two look identical on the wire and only
  // one of them is a deployment whose absences are all accounted for, so the
  // absence of the key is reported rather than read as an empty set. An empty
  // array, by contrast, is a statement and is taken as one.
  const declared = Array.isArray(meta.declines) ? meta.declines : undefined;
  return {
    model: {
      reachable: true,
      lanes: lanes.map(toLane).filter((lane): lane is MetaLane => lane !== null),
      // The mount's two states, reported separately from the lanes' three.
      volume: {
        mounted: artifacts.mounted === true,
        writable: artifacts.writable === true,
      },
    },
    figures: declared === undefined ? [] : declared.map(toDeclinedFigure),
    incompleteReason: declared === undefined ? "MODEL_DECLINES_NOT_REPORTED" : null,
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
 * One published origin, in the wire's vocabulary.
 *
 * `age_hours` is derived here rather than on a screen, for the reason the
 * day-ahead response derives it: "is this stale?" is a question every surface
 * asks, and none of them should answer it by differencing against a clock the
 * server has and the client may not.
 */
function toPublished(
  origin: PublishedOrigin,
  now: Date,
): MetaForecastStateLatestPublishedItem {
  return {
    targetDate: origin.targetDate,
    gateProfile: origin.gateProfile,
    publishedAt: origin.publishedAt.toISOString(),
    ageHours:
      Math.round(
        Math.max(0, (now.getTime() - origin.publishedAt.getTime()) / 3_600_000) * 10,
      ) / 10,
    subsystems: origin.subsystems,
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
  declines: MetaDeclines;
  freshness: MetaFreshness[];
  latestPublished?: MetaForecastStateLatestPublishedItem[];
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
      // The publications that exist, newest target date first, read from the
      // day-grain rows — one per (subsystem, day), so a publication is one
      // group rather than 96 rows. Empty is a true statement and never a
      // placeholder: nothing has been published. `next_publication_at` is
      // derived from the gate table, which is what makes a failed publication
      // visible as an instant that passed with no origin behind it.
      latestPublished: parts.latestPublished ?? [],
      nextPublicationAt: next.at.toISOString(),
    },
    data: { freshness: parts.freshness },
    // What this deployment will not tell a caller, and why — assembled from
    // the declared reasons on both sides of the boundary. See the note above
    // on why it is on this endpoint and not on the model card.
    declines: parts.declines,
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
    async ({ set, request }) => {
      const now = deps.now?.() ?? new Date();

      // Both halves are attempted regardless of the other, which is what
      // "degrades" means here: a modelling service that is down does not cost
      // the caller the freshness block, and a database that is not configured
      // does not cost them the lane states. Neither absence is an error on this
      // endpoint — being able to say *which* things are missing is its job.
      const [service, freshness, published] = await Promise.all([
        readModel(deps.ml),
        deps.db === undefined ? [] : readSourceFreshness(deps.db, { now }),
        deps.db === undefined ? [] : readLatestPublished(deps.db, { asOf: now }),
      ]);

      // No validator, and that is the point rather than an omission: a
      // response that may not be stored has nothing to revalidate, and the 304
      // one would enable is the wrong answer to "is anything broken?". See the
      // note above on story 25.
      applyCachePolicy({ set, request }, CACHE_POLICIES.meta);
      return encodeWire(
        "Meta",
        toMeta({
          now,
          environment: deps.environment ?? config.nodeEnv,
          model: service.model,
          declines: toDeclines(service),
          freshness: freshness.map(toFreshness),
          latestPublished: published.map((origin) => toPublished(origin, now)),
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
          "attribution, and the census of every figure this deployment " +
          "declines to state with the reason for each. Degrades rather than " +
          "fails: with the modelling service " +
          "unreachable this is still a 200 and only the model block says so. " +
          "`no-store` — a cached answer to 'what is broken' is worse than none.",
      },
    },
  );
}

/** The wired route, over the process-wide handle. */
export const metaRoutes = createMetaRoutes({ db: database?.db });

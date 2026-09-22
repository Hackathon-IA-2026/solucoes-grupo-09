/**
 * The typed API client — a fetch wrapper, and the only thing that crosses the
 * casing boundary.
 *
 * It returns the generated `camelCase` interfaces and throws an `ApiError`
 * carrying three things a screen actually branches on: the **status**, the
 * **domain code** from the closed enum, and a **`retryable` flag**. That last
 * one is the reason the class exists rather than a bare `fetch`: a screen has
 * to choose between offering "retry" and rendering one of the four no-forecast
 * states, and that decision is a property of the failure, not of the screen.
 * Computing it in one place is what stops four screens computing it four ways.
 *
 * **Two mechanisms, and the schema wins.** Elysia's Eden treaty over
 * `type App` gives the gateway and the web app compile-time parity for free
 * and gives Python nothing, so it stays a convenience; the JSON Schema is the
 * cross-language authority. Where they disagree the schema wins, and
 * `apps/api/test/schema-treaty.test.ts` asserts it against real values rather
 * than asserting that two type systems agree, which is a test that is harder
 * to write well than it looks.
 *
 * **No response envelope.** A successful response is the resource; there is no
 * `{data, meta}` to unwrap. Pagination exists on exactly two routes and carries
 * its own `nextCursor` field.
 *
 * **This module never reads `schema/`.** Validation is a test-time authority,
 * not a request-time cost, and `apps/api/Dockerfile` copies `packages/core/src`
 * only — so an import of `./schema.js` from here would pass every check on a
 * developer's machine and die in the container.
 */

import {
  type ErrorCode,
  type ErrorDetails,
  type ErrorEnvelope,
  isErrorCode,
} from "./errors.js";
import type {
  AnswerFeedback,
  AnswerFeedbackRequest,
  CurtailmentEpisodes,
  CurtailmentHours,
  DiagnosisDayAhead,
  ForecastDayAhead,
  GridContext,
  GridDay,
  GridNow,
  GridOutlook,
  Meta,
  ModelCard,
  ObservedReasons,
  OptimizationResult,
  Replay,
  ReplayObservedOnly,
  Scenario,
  SimilarDays,
} from "./types.generated.js";
import { decodeWire, encodeWire, type WireShapeName } from "./wire.js";

/**
 * What went wrong, in the three terms a caller can act on.
 *
 * `message` is deliberately the developer prose the gateway sent: it is for a
 * log line, never for a screen. A screen renders `t("error." + code)`.
 */
export class ApiError extends Error {
  /** The HTTP status. `0` for a transport failure that never got one. */
  readonly status: number;
  /** A member of the closed enum, or `null` when the failure never reached the gateway. */
  readonly code: ErrorCode | null;
  readonly details?: ErrorDetails;
  readonly requestId?: string;
  /**
   * Worth trying again: 429, any 5xx, and a network failure.
   *
   * A 4xx that is not 429 is the caller's own request and retrying it produces
   * the same answer more slowly. `MODEL_UNAVAILABLE` is a 503 and therefore
   * retryable, which is right — the artifact may be promoted a minute later —
   * and it is *also* one of the four no-forecast states, which is why a screen
   * branches on `code` first and `retryable` second.
   */
  readonly retryable: boolean;

  constructor(init: {
    status: number;
    code: ErrorCode | null;
    message: string;
    details?: ErrorDetails;
    requestId?: string;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryable = isRetryableStatus(init.status);
  }
}

/**
 * 429, 5xx and a transport failure. Nothing else.
 *
 * Exported because the same question is asked of a status that never became an
 * `ApiError` — a `HEAD` probe, a retry wrapper — and a second spelling of this
 * rule is a second answer.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/** How the client reaches the gateway. */
export interface ClientOptions {
  /** The gateway's origin, with or without a trailing slash. */
  baseUrl: string;
  /** Injectable for tests and for a runtime with its own fetch. */
  fetch?: typeof globalThis.fetch;
  /** Sent on every request. `Accept-Language` is how the diagnosis route negotiates locale. */
  headers?: Record<string, string>;
}

/** A query string, with `undefined` values dropped rather than sent as "undefined". */
export type Query = Record<string, string | number | boolean | undefined>;

function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const url = new URL(path.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function readEnvelope(status: number, body: unknown, fallback: string): ApiError {
  const envelope = body as Partial<ErrorEnvelope> | null;
  const error = envelope?.error;
  if (error === undefined || error === null) {
    // The gateway promises one envelope everywhere. A body that is not one came
    // from a proxy, a CDN or a crash, and saying so is more useful than
    // pretending a code was returned.
    return new ApiError({ status, code: null, message: fallback });
  }
  return new ApiError({
    status,
    code: isErrorCode(error.code) ? error.code : null,
    message: typeof error.message === "string" ? error.message : fallback,
    details: error.details,
    requestId: error.request_id,
  });
}

/** The typed client. One instance per base URL. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers ?? {};
  }

  /**
   * One request, one decode, one error shape.
   *
   * Every typed method below is a call to this with a shape name; there is no
   * second path through which a response reaches a screen, which is what makes
   * "it converts once" a structural claim rather than a convention.
   */
  async request<T>(
    shape: WireShapeName,
    path: string,
    init?: {
      query?: Query;
      method?: string;
      body?: unknown;
      bodyShape?: WireShapeName;
      /**
       * A body that is already the exact bytes the route must receive, sent
       * verbatim.
       *
       * The one caller is a replay of a past day: `/v1/replay` answers over the
       * **canonical** scenario bytes and stamps the hash of what arrived, so a
       * body this client re-serialised would be a different document under the
       * same name. It is mutually exclusive with `body`.
       */
      bodyText?: string;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const url = buildUrl(this.baseUrl, path, init?.query);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.headers,
    };
    let payload: string | undefined;
    if (init?.bodyText !== undefined) {
      headers["content-type"] = "application/json";
      payload = init.bodyText;
    } else if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(
        init.bodyShape === undefined ? init.body : encodeWire(init.bodyShape, init.body),
      );
    }

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: init?.method ?? "GET",
        headers,
        body: payload,
        signal: init?.signal,
      });
    } catch (cause) {
      // Never reached the gateway: status 0, no code, and retryable — which is
      // the distinction a screen needs between "we are down" and "you asked for
      // something that does not exist".
      throw new ApiError({
        status: 0,
        code: null,
        message: `Request to ${url} failed`,
        cause,
      });
    }

    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }

    if (!response.ok) {
      throw readEnvelope(response.status, body, `${response.status} from ${url}`);
    }
    return decodeWire(shape, body) as T;
  }

  /** `GET /v1/meta` — the precondition every screen reads first. */
  meta(signal?: AbortSignal): Promise<Meta> {
    return this.request<Meta>("Meta", "/v1/meta", { signal });
  }

  /** `GET /v1/grid/outlook` — four subsystems, one target date, one request. */
  gridOutlook(
    query: { targetDate?: string; gateProfile?: string } = {},
    signal?: AbortSignal,
  ): Promise<GridOutlook> {
    return this.request<GridOutlook>("GridOutlook", "/v1/grid/outlook", {
      query: { target_date: query.targetDate, gate_profile: query.gateProfile },
      signal,
    });
  }

  /**
   * `GET /v1/grid/context` — ONS's plan for a day beside what the grid did.
   *
   * Neither series is a WattSteer number, which is the point of having it: it
   * is the official comparison a reviewer can hold the product's own forecast
   * up against.
   */
  gridContext(
    query: { subsystem: string; date: string; asOf?: string },
    signal?: AbortSignal,
  ): Promise<GridContext> {
    return this.request<GridContext>("GridContext", "/v1/grid/context", {
      query: { subsystem: query.subsystem, date: query.date, as_of: query.asOf },
      signal,
    });
  }

  /**
   * `GET /v1/similar-days` — the past days that looked most like this one.
   *
   * Evidence, not a second forecast: the neighbours' settled totals sit beside
   * the band and are never combined with it.
   */
  similarDays(
    query: { subsystem: string; lane: string; targetDate?: string; k?: number },
    signal?: AbortSignal,
  ): Promise<SimilarDays> {
    return this.request<SimilarDays>("SimilarDays", "/v1/similar-days", {
      query: {
        subsystem: query.subsystem,
        lane: query.lane,
        target_date: query.targetDate,
        k: query.k === undefined ? undefined : String(query.k),
      },
      signal,
    });
  }

  /** `GET /v1/grid/now` — observed, and therefore honest with no promoted artifact. */
  gridNow(signal?: AbortSignal): Promise<GridNow> {
    return this.request<GridNow>("GridNow", "/v1/grid/now", { signal });
  }

  /**
   * `GET /v1/grid/day` — the same four subsystems over a **named** settled day.
   *
   * The day-axis twin of `gridNow`, and a separate call rather than a parameter
   * on that one: `now` finds its own window from the latest hour every
   * subsystem has settled, and the two fields that make it mean anything —
   * `latest_settled_hour` and `lag_hours` — describe a clock a caller asking
   * for a Tuesday did not ask about.
   */
  gridDay(
    query: { date: string; asOf?: string },
    signal?: AbortSignal,
  ): Promise<GridDay> {
    return this.request<GridDay>("GridDay", "/v1/grid/day", {
      query: { date: query.date, as_of: query.asOf },
      signal,
    });
  }

  /**
   * `GET /v1/forecast/day-ahead` — one subsystem, one day, one gate.
   *
   * There is no `technology` parameter, deliberately: the forecast grain is the
   * subsystem and the split is two scalars, so a client cannot request an
   * explanation the model has no head for.
   */
  forecastDayAhead(
    query: { subsystem: string; targetDate?: string; gateProfile?: string },
    signal?: AbortSignal,
  ): Promise<ForecastDayAhead> {
    return this.request<ForecastDayAhead>("ForecastDayAhead", "/v1/forecast/day-ahead", {
      query: {
        subsystem: query.subsystem,
        target_date: query.targetDate,
        gate_profile: query.gateProfile,
      },
      signal,
    });
  }

  /**
   * `GET /v1/diagnosis/day-ahead` — the attribution and the narration.
   *
   * One attribution per subsystem-day, and no `technology` parameter for the
   * same reason. `locale` is negotiated by primary subtag, so `en` and `pt`
   * are both accepted rather than 422'd against an exact-match list.
   */
  diagnosisDayAhead(
    query: { subsystem: string; date?: string; gateProfile?: string; locale?: string },
    signal?: AbortSignal,
  ): Promise<DiagnosisDayAhead> {
    return this.request<DiagnosisDayAhead>(
      "DiagnosisDayAhead",
      "/v1/diagnosis/day-ahead",
      {
        query: {
          subsystem: query.subsystem,
          date: query.date,
          gate_profile: query.gateProfile,
          locale: query.locale,
        },
        signal,
      },
    );
  }

  /**
   * `POST /v1/optimize` — the MILP, synchronously, with no job id.
   *
   * The Scenario goes out through the same generated table the responses come
   * back through, which is the half of "convert once" that a read-only client
   * would never exercise: an inverse built by hand is where a cache key stops
   * matching.
   */
  /**
   * `GET /v1/curtailment/hours` — the observed series, and therefore honest
   * with no promoted artifact.
   *
   * `cursor` continues a paged range and is opaque: it is the server's page
   * boundary, not an argument a caller composes. The range is capped at 400
   * days and a longer one is refused rather than truncated.
   */
  curtailmentHours(
    query: {
      subsystem: string;
      from: string;
      to: string;
      technology?: string;
      asOf?: string;
      cursor?: string;
    },
    signal?: AbortSignal,
  ): Promise<CurtailmentHours> {
    return this.request<CurtailmentHours>("CurtailmentHours", "/v1/curtailment/hours", {
      query: {
        subsystem: query.subsystem,
        from: query.from,
        to: query.to,
        technology: query.technology,
        as_of: query.asOf,
        cursor: query.cursor,
      },
      signal,
    });
  }

  /**
   * `GET /v1/curtailment/episodes` — the read-time view.
   *
   * The threshold and the gap tolerance are optional here and stamped on the
   * answer either way, which is the point: a screen renders the episodes beside
   * the parameters that produced them rather than beside the ones it meant.
   */
  curtailmentEpisodes(
    query: {
      /**
       * Omit it for the whole grid: the episodes of all four subsystems,
       * chronological, each stamped with its own. Concatenating four subsystems' runs is exact —
       * they are measurements, not quantiles — so this is not the aggregate
       * that `SIN` would be and the gateway does not build one.
       */
      subsystem?: string;
      from: string;
      to: string;
      technology?: string;
      thresholdMw?: number;
      maxGapHours?: number;
      asOf?: string;
    },
    signal?: AbortSignal,
  ): Promise<CurtailmentEpisodes> {
    return this.request<CurtailmentEpisodes>(
      "CurtailmentEpisodes",
      "/v1/curtailment/episodes",
      {
        query: {
          subsystem: query.subsystem,
          from: query.from,
          to: query.to,
          technology: query.technology,
          threshold_mw: query.thresholdMw,
          max_gap_hours: query.maxGapHours,
          as_of: query.asOf,
        },
        signal,
      },
    );
  }

  /**
   * `GET /v1/curtailment/reasons` — observed causes at reporting-entity grain.
   *
   * There is no `plant` parameter, deliberately: a plant's reason derived from
   * its conjunto's is an allocation, and v1 computes none. Every row says which
   * grain it was observed at.
   */
  observedReasons(
    query: { subsystem: string; date: string; limit?: number; asOf?: string },
    signal?: AbortSignal,
  ): Promise<ObservedReasons> {
    return this.request<ObservedReasons>("ObservedReasons", "/v1/curtailment/reasons", {
      query: {
        subsystem: query.subsystem,
        date: query.date,
        limit: query.limit,
        as_of: query.asOf,
      },
      signal,
    });
  }

  /**
   * `GET /v1/model/card?lane=` — the reliability curve and the lane's identity.
   *
   * **Keyed by lane and by nothing else.** The same artifact serves all four
   * subsystems, so "the curve for NE on the 29th" is a question the card cannot
   * answer; `docs/specs/api-surface.md` §9 splits it off the per-day payload for
   * that reason and so a weekly-changing 40 KB object does not acquire a daily
   * cache key.
   *
   * `lane` is required and never defaulted here, for the same reason `replay`'s
   * is: the lane a reader's numbers came from is a property of the deployment,
   * discoverable on `GET /v1/meta` at `model.lanes[].lane`, and a default
   * invented in this module would be the client deciding which artifact family
   * a screen is describing.
   *
   * **It refuses whenever no artifact is promoted**, with `MODEL_UNAVAILABLE`
   * (503) carrying `details.lane_state`. That is not an edge case: the response
   * type's `laneState` is the constant `"promoted"` precisely because the other
   * three states never reach this shape. A caller must have a branch for the
   * refusal before it has one for the card.
   */
  modelCard(query: { lane: string }, signal?: AbortSignal): Promise<ModelCard> {
    return this.request<ModelCard>("ModelCard", "/v1/model/card", {
      query: { lane: query.lane },
      signal,
    });
  }

  optimize(scenario: Scenario, signal?: AbortSignal): Promise<OptimizationResult> {
    return this.request<OptimizationResult>("OptimizationResult", "/v1/optimize", {
      method: "POST",
      body: scenario,
      bodyShape: "Scenario",
      signal,
    });
  }

  /**
   * `GET /v1/replay?d=&s=&lane=` — one past day, replayed at its pinned origin.
   *
   * **A `GET` and not the `POST`, deliberately.** `docs/specs/replay.md` makes
   * a replay a `Scenario` with a past `target_date`, so the transport is the
   * optimizer's blob byte-for-byte — and the blob is already in the address bar
   * of the screen that asks. Sending it as a query parameter keeps the request
   * a shared-cacheable function of exactly what a shared link contains: the
   * gateway's own `max-age=600` on this route is only reachable this way.
   *
   * `d` is the civil day, redundant with the scenario's own `target_date` and
   * checked against it by the gateway: a link whose visible date is not the day
   * it replays is not a link anybody can read.
   *
   * `lane` is required and never defaulted here for the reason the gateway
   * gives — a post-go-live day has one candidate forecast per served lane, and
   * no rule yet says which one a replay is of. A client-side default would be
   * this module inventing that rule.
   *
   * The forecast is a **pinned row**: there is no joblib load and no feature
   * build behind this call, which is why it answers inside one request and why
   * changing the fleet re-plans without ever re-forecasting.
   */
  replay(
    query: { d: string; s: string; lane: string },
    signal?: AbortSignal,
  ): Promise<Replay> {
    return this.request<Replay>("Replay", "/v1/replay", {
      query: { d: query.d, s: query.s, lane: query.lane },
      signal,
    });
  }

  /**
   * `POST /v1/replay/observed-only` — what a pre-F1 day gets instead.
   *
   * Every artifact was fitted on the pre-F1 block, so no honest counterfactual
   * exists and the day is **refused** rather than labelled. What comes back is
   * the settled profile, its episodes and the perfect-foresight bound, which
   * needs no forecast and therefore no model. `scored`, `avoided_energy_mwh`
   * and `recovered_floor_mwh` are absent rather than zero, because a zero would
   * be a claim about a plan WattSteer was never asked to build.
   *
   * `canonicalScenario` is sent verbatim — `canonicalScenarioJson(scenario)`,
   * whose bytes the answer is hashed over. A body re-serialised on the way out
   * would be a different document answering under the same hash.
   */
  /**
   * `POST /v1/feedback` — file what a reader thought of one answer.
   *
   * An opinion and never a measurement: it reaches no canonical view and no
   * metric, and the screens that collect it say so. It is here rather than in a
   * component because the shape is the contract's — `FeedbackSurface` is closed
   * so that a fourth kind of answer is a decision somebody makes rather than a
   * string a screen invents.
   *
   * The refusals are worth handling rather than swallowing: a deployment with
   * no database answers `DATA_UNAVAILABLE`, and a reason over the gateway's
   * limit answers `REQUEST_INVALID`. A thumbs-down that quietly vanished is the
   * one failure this surface cannot absorb — the reader believes they told us.
   */
  fileFeedback(
    body: AnswerFeedbackRequest,
    signal?: AbortSignal,
  ): Promise<AnswerFeedback> {
    return this.request<AnswerFeedback>("AnswerFeedback", "/v1/feedback", {
      method: "POST",
      // Through the generated table, as `optimize` sends a Scenario: the app
      // writes camelCase and the wire is snake_case, and a body serialised here
      // would be a second, hand-written copy of that mapping.
      body,
      bodyShape: "AnswerFeedbackRequest",
      signal,
    });
  }

  replayObservedOnly(
    canonicalScenario: string,
    query: { lane: string },
    signal?: AbortSignal,
  ): Promise<ReplayObservedOnly> {
    return this.request<ReplayObservedOnly>(
      "ReplayObservedOnly",
      "/v1/replay/observed-only",
      {
        method: "POST",
        query: { lane: query.lane },
        bodyText: canonicalScenario,
        signal,
      },
    );
  }

  /**
   * `GET /v1/voice/session` — an ephemeral credential for the realtime socket.
   *
   * **The one method that does not decode through `WIRE_SHAPES`, and the reason
   * is that there is nothing to decode.** Every other route on this client
   * answers with a *published resource*: a forecast, a diagnosis, a replay —
   * something with a JSON Schema in `packages/core/schema`, a Python consumer,
   * and a generated camelCase interface that a renamed field breaks the compile
   * of. This route answers with a **credential**: four fields, good for a few
   * minutes, never cached (the route sets `no-store` for a reason —
   * `apps/api/src/api/voice.ts`), never rendered, never persisted, and with no
   * cross-language consumer at all. Giving it a schema would publish a contract
   * for a secret.
   *
   * So the two snake_case names are read here, by hand, at their one call site.
   * That is a four-field boundary rather than a second translator: there is no
   * rule being applied, nothing generic to disagree with `wire.ts` about, and
   * nothing a future field could silently slip past — a fifth field would be
   * invisible here and therefore unused, which is the failure mode a credential
   * can afford.
   *
   * It throws `ApiError` like everything else, so the web app tells
   * `VOICE_NOT_CONFIGURED` (render no dock at all) from `VOICE_UNAVAILABLE`
   * (voice exists here and is having a bad day) off the same closed enum every
   * other refusal on this client uses.
   */
  async voiceSession(signal?: AbortSignal): Promise<VoiceSessionCredential> {
    const body = await this.requestRaw("/v1/voice/session", signal);
    const payload = (typeof body === "object" && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    return {
      clientSecret: String(payload.client_secret ?? ""),
      expiresAt: String(payload.expires_at ?? ""),
      model: String(payload.model ?? ""),
      voice: String(payload.voice ?? ""),
    };
  }

  /**
   * A `GET` that returns the parsed body without a shape, for the one caller
   * above. Private, so "no schema" cannot spread beyond the credential.
   */
  private async requestRaw(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = buildUrl(this.baseUrl, path);
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: "GET",
        headers: { accept: "application/json", ...this.headers },
        signal,
      });
    } catch (cause) {
      throw new ApiError({
        status: 0,
        code: null,
        message: `Request to ${url} failed`,
        cause,
      });
    }
    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      throw readEnvelope(response.status, body, `${response.status} from ${url}`);
    }
    return body;
  }
}

/**
 * What `GET /v1/voice/session` hands the browser.
 *
 * camelCase here and `snake_case` on the wire, like every other shape — the
 * difference is only that this one is renamed at its call site rather than
 * through the generated table, for the reason {@link ApiClient.voiceSession}
 * gives.
 */
export interface VoiceSessionCredential {
  /** Short-lived. Not the account key, and it cannot be used as one. */
  readonly clientSecret: string;
  /** ISO-8601 UTC. The client re-mints against this rather than dying mid-sentence. */
  readonly expiresAt: string;
  readonly model: string;
  readonly voice: string;
}

/** Build a client. A function, so a caller does not have to know the class name. */
export function createClient(options: ClientOptions): ApiClient {
  return new ApiClient(options);
}

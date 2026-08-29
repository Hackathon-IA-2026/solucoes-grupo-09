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
  DiagnosisDayAhead,
  ForecastDayAhead,
  GridNow,
  GridOutlook,
  Meta,
  OptimizationResult,
  Scenario,
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
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const url = buildUrl(this.baseUrl, path, init?.query);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.headers,
    };
    let payload: string | undefined;
    if (init?.body !== undefined) {
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

  /** `GET /v1/grid/now` — observed, and therefore honest with no promoted artifact. */
  gridNow(signal?: AbortSignal): Promise<GridNow> {
    return this.request<GridNow>("GridNow", "/v1/grid/now", { signal });
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
  optimize(scenario: Scenario, signal?: AbortSignal): Promise<OptimizationResult> {
    return this.request<OptimizationResult>("OptimizationResult", "/v1/optimize", {
      method: "POST",
      body: scenario,
      bodyShape: "Scenario",
      signal,
    });
  }
}

/** Build a client. A function, so a caller does not have to know the class name. */
export function createClient(options: ClientOptions): ApiClient {
  return new ApiClient(options);
}

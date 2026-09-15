import { config } from "../config.js";
import {
  type AppError,
  asErrorStatus,
  BusyError,
  type ErrorCode,
  type ErrorDetails,
  isErrorCode,
  ProxiedError,
  UpstreamError,
} from "../errors.js";

/**
 * The gateway's edge onto the ML service — and, since flex-optimizer ticket 06
 * wired `/v1/optimize` through it, onto the solver, which is the only thing
 * that will be left behind it. Forecasts and diagnoses resolve from Postgres; a
 * solve cannot be precomputed, so this is where a request crosses the language
 * boundary.
 *
 * The architecture decision this implements: Expo talks only to Elysia, and
 * Elysia forwards anything model-shaped. Keeping that boundary in one small
 * module means the web app never learns the ML service exists, and the ML
 * service never grows a second public surface with its own CORS, rate limits
 * and error vocabulary to keep in step.
 *
 * **This module carries no routes.** It used to carry one — an unversioned
 * `GET /forecast/day-ahead` that forwarded the modelling service's body
 * verbatim — and api-surface ticket 11 deleted it once the published rows
 * existed. It was a stopgap in four ways: unversioned against a service whose
 * own path is versioned; verbatim, which is right for a proxy and wrong for a
 * record the gateway must stamp with the origin kind, the as-of pin, the risk
 * class read off the artifact's bins and the licence attribution; unable to
 * honour the `origin_kind = 'served'` filter, because a verbatim proxy has no
 * row to filter, so a `backfilled_holdout` reconstruction could have left by
 * it; and it made the most-viewed screen depend on the modelling service being
 * up. `api/forecast.ts` answers that read from Postgres now, and imports
 * nothing from here. What survives is the failure mapping below and the two
 * calls that share it, which is what `/v1/optimize`, `/v1/meta` and the
 * publication job need — a solve cannot be precomputed, so the boundary
 * crossing stays even though the route does not.
 *
 * The reason it is a module rather than three lines inline is the failure
 * mapping. A proxy that lets upstream statuses through unexamined reports an
 * ML outage as an API bug — the caller sees a 500 from WattSteer and has no
 * way to tell whose fault it is. Every branch below is about answering that
 * question honestly, and there are seven of them:
 *
 * | branch                          | status | code                       |
 * |---------------------------------|--------|----------------------------|
 * | `mlUrl` unset                   | 502    | `OPTIMIZER_NOT_CONFIGURED` |
 * | connection refused / DNS        | 502    | `OPTIMIZER_UNAVAILABLE`    |
 * | aborted by the runtime, not us  | 502    | `OPTIMIZER_UNAVAILABLE`    |
 * | no answer within `timeoutMs`    | 503    | `OPTIMIZER_TIMEOUT`        |
 * | upstream 502/503/504            | 503    | `OPTIMIZER_NOT_READY`      |
 * | upstream 4xx                    | 4xx    | the upstream code          |
 * | upstream 5xx                    | 5xx    | the upstream code          |
 *
 * The first four are four different sentences: not configured is not broken, a
 * refused connection says don't bother yet, an abort nobody here asked for says
 * the call never arrived, and a timeout — *ours*, against the ceiling this
 * endpoint was given — says retry. Keeping the third and the fourth apart is
 * forecaster 45's repair and is argued at the throw site. The fifth refuses to
 * pass an ML outage on as a WattSteer bug. The last two are the
 * ones that make the module worth having in front of a solver: a scenario the
 * ML service re-validated and rejected (422) must not read as an outage, and
 * neither must a `SOLVER_BUG` (500) — nor may `SOLVER_GAP_UNCLOSED` (503) and
 * `SOLVER_TIMEOUT` (504) collapse into one sentence, because "the gap was not
 * closed" is a different thing to tell a user than "we gave up waiting".
 *
 * The upstream status and code survive, but the *response* does not: it is
 * re-wrapped in this API's envelope rather than forwarded verbatim, and the
 * upstream code is admitted into the closed enum in `errors.ts` rather than
 * smuggled past it. A client that had to parse one shape for gateway errors
 * and another for upstream ones would have no closed enum at all. Anything the
 * enum has no room for travels in `details`.
 */

/** Upstream statuses that mean "the ML service is up but cannot serve yet". */
const UNAVAILABLE = new Set([502, 503, 504]);

/** Where a call goes and how long it may take. Injectable so every branch of
 *  the mapping below is reachable from a test. */
export interface MlEndpoint {
  readonly baseUrl: string | undefined;
  readonly timeoutMs: number;
}

const configuredEndpoint = (): MlEndpoint => ({
  baseUrl: config.mlUrl,
  timeoutMs: config.mlTimeoutMs,
});

/**
 * The identifier the ML service put on a failure, if it put one there.
 *
 * Read tolerantly: the service answers with `{"error": {"code": …}}` where it
 * owns the shape and with FastAPI's `{"detail": …}` where it does not. A body
 * that is unreadable is not itself an error — it just means the failure has no
 * code and is mapped on its status alone.
 */
async function upstreamCode(
  response: Response,
): Promise<{ code: string | null; details?: ErrorDetails }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { code: null };
  }
  if (typeof body !== "object" || body === null) {
    return { code: null };
  }
  const record = body as Record<string, unknown>;
  for (const candidate of [record.error, record.detail, record]) {
    if (typeof candidate === "object" && candidate !== null) {
      const failure = candidate as Record<string, unknown>;
      if (typeof failure.code === "string") {
        // The upstream `details` travel with the code they belong to. A
        // `MODEL_UNAVAILABLE` is required to carry `details.lane_state`
        // (`docs/specs/api-surface.md`, the four "no forecast" states), and
        // "nothing has been trained", "a candidate was refused" and "the
        // volume cannot say" are three sentences a screen renders three ways.
        // Dropping them here would flatten all three into one 503 — the exact
        // collapse the code table exists to prevent — and the route in front
        // has no second chance at the body, which this function consumed.
        return {
          code: failure.code,
          ...(typeof failure.details === "object" &&
          failure.details !== null &&
          !Array.isArray(failure.details)
            ? { details: failure.details as ErrorDetails }
            : {}),
        };
      }
    }
  }
  return { code: null };
}

/**
 * Turn a non-`ok` upstream response into the error this API will answer with.
 *
 * Order matters. A recognised code is honoured first, at the status the ML
 * service chose, because that is the case where upstream knows more than we
 * do — it is what keeps `SOLVER_GAP_UNCLOSED` (503) and `SOLVER_TIMEOUT` (504)
 * apart. Only a failure that named no code we know falls back to being mapped
 * on its status.
 */
export async function mapUpstreamFailure(response: Response): Promise<AppError> {
  const { code: raw, details: upstreamDetails } = await upstreamCode(response);
  const code: ErrorCode | null = isErrorCode(raw) ? raw : null;
  const status = asErrorStatus(response.status);
  const details = {
    upstream_status: response.status,
    ...(raw && !code ? { upstream_code: raw } : {}),
  };

  if (code && status) {
    return new ProxiedError(
      status,
      code,
      `The ML service answered ${code} (HTTP ${response.status})`,
      upstreamDetails === undefined ? undefined : { details: upstreamDetails },
    );
  }

  if (response.status < 500) {
    // A refusal, not an outage. It keeps its own status so a client can tell a
    // rejected scenario from a broken service; a status this API has no room
    // for is an upstream contract violation, which is an upstream failure.
    return status
      ? new ProxiedError(
          status,
          "UPSTREAM_REJECTED",
          `The ML service refused the request: HTTP ${response.status}`,
          { details },
        )
      : new UpstreamError(`The ML service answered HTTP ${response.status}`, {
          code: "UPSTREAM_FAILED",
          details,
        });
  }

  if (UNAVAILABLE.has(response.status)) {
    // Up but not serving. Reported as busy rather than passed through, so an
    // ML outage is not filed as a WattSteer bug.
    return new BusyError("The ML service is not ready", {
      code: "OPTIMIZER_NOT_READY",
      details,
    });
  }

  return new ProxiedError(
    status ?? 500,
    "UPSTREAM_FAILED",
    `The ML service failed: HTTP ${response.status}`,
    { details },
  );
}

/**
 * `GET` the ML service, or throw the error that says whose fault it was.
 *
 * Exported so the routes in front of the solver share one mapping — the point
 * of the module is that there is exactly one. `postMl` below is the same call
 * with a body, and both land on `request`.
 */
export async function callMl(
  path: string,
  query: URLSearchParams,
  endpoint: MlEndpoint = configuredEndpoint(),
): Promise<Response> {
  // The `?` only when there is something after it: the retrain's status route
  // takes its run id in the path and no query at all, and a bare trailing `?`
  // in a job log is a thing somebody has to stop and think about.
  const search = query.toString();
  return request(search ? `${path}?${search}` : path, {}, endpoint);
}

/**
 * `POST` the canonical scenario bytes to the ML service, through the same
 * mapping.
 *
 * A second function rather than a `method` argument on `callMl`, because the
 * two calls differ in more than a verb: this one carries a body, and the body
 * is *bytes and not an object* — the exact canonical UTF-8 the gateway hashed.
 * Re-serialising a parsed scenario here would let the answer be stamped with a
 * hash of something the solver never saw, which is the one thing the canonical
 * encoding exists to prevent.
 */
export async function postMl(
  path: string,
  body: Uint8Array | string,
  endpoint: MlEndpoint = configuredEndpoint(),
): Promise<Response> {
  return request(
    path,
    {
      method: "POST",
      body: body as BodyInit,
      headers: { "content-type": "application/json" },
    },
    endpoint,
  );
}

/** The one call, the one timeout and the one failure mapping. */
async function request(
  pathAndQuery: string,
  init: RequestInit,
  endpoint: MlEndpoint,
): Promise<Response> {
  if (!endpoint.baseUrl) {
    // Not configured is not the same as broken. Say so rather than dialling
    // `undefined` and reporting the resulting fetch error as an upstream fault.
    throw new UpstreamError("The ML service is not configured", {
      code: "OPTIMIZER_NOT_CONFIGURED",
    });
  }

  const url = `${endpoint.baseUrl.replace(/\/$/, "")}${pathAndQuery}`;
  // **Our own controller rather than `AbortSignal.timeout`, and the reason is
  // forecaster 45.** Bun raises `TimeoutError` for its *own* connect and idle
  // timeouts too, so mapping every `TimeoutError` to `OPTIMIZER_TIMEOUT` let an
  // abort that had nothing to do with this ceiling arrive wearing its name. On
  // 2026-09-15 that is exactly what happened: a 300-second ceiling somewhere in
  // the platform's internal networking aborted a retrain POST, the gateway
  // reported `OPTIMIZER_TIMEOUT`, and the retrain's own failure line read it as
  // its forty-minute ceiling — an hour of looking for a forty-minute run that
  // had been killed at five. A flag we set ourselves is the only thing that can
  // tell the two apart, because the error object cannot.
  const controller = new AbortController();
  let weAborted = false;
  const ceiling = setTimeout(() => {
    weAborted = true;
    controller.abort();
  }, endpoint.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: "application/json", ...init.headers },
    });
  } catch (error) {
    // A timeout is not the same failure as a refused connection: one says the
    // service is overloaded, the other that it is absent. 503 tells a caller
    // to retry; 502 tells them not to bother yet.
    if (weAborted) {
      throw new BusyError("The ML service did not answer in time", {
        code: "OPTIMIZER_TIMEOUT",
        details: { timeout_source: "gateway", timeout_ms: endpoint.timeoutMs },
      });
    }
    // Aborted, but not by us: the runtime gave up on the socket, or something
    // between here and there did. The call never got an answer *and* never
    // reached this ceiling, which is what `OPTIMIZER_UNAVAILABLE` means — and
    // the `timeout_source` says which of the two kinds of silence it was, so a
    // future ceiling cannot borrow this one's name either.
    const runtimeTimeout = error instanceof Error && error.name === "TimeoutError";
    throw new UpstreamError("The ML service is unreachable", {
      cause: error,
      code: "OPTIMIZER_UNAVAILABLE",
      details: { timeout_source: runtimeTimeout ? "runtime" : "transport" },
    });
  } finally {
    clearTimeout(ceiling);
  }

  if (!response.ok) {
    throw await mapUpstreamFailure(response);
  }
  return response;
}

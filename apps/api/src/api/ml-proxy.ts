import { Elysia, t } from "elysia";
import { config } from "../config.js";
import {
  type AppError,
  asErrorStatus,
  BusyError,
  type ErrorCode,
  isErrorCode,
  ProxiedError,
  UpstreamError,
} from "../errors.js";

/**
 * The gateway's edge onto the ML service — and, once `/v1/optimize` is wired
 * through it, onto the solver, which is the only thing that will be left
 * behind it. Forecasts and diagnoses resolve from Postgres; a solve cannot be
 * precomputed, so this is where a request crosses the language boundary.
 *
 * The architecture decision this implements: Expo talks only to Elysia, and
 * Elysia forwards anything model-shaped. Keeping that boundary in one small
 * module means the web app never learns the ML service exists, and the ML
 * service never grows a second public surface with its own CORS, rate limits
 * and error vocabulary to keep in step.
 *
 * The reason it is a module rather than three lines inline is the failure
 * mapping. A proxy that lets upstream statuses through unexamined reports an
 * ML outage as an API bug — the caller sees a 500 from WattSteer and has no
 * way to tell whose fault it is. Every branch below is about answering that
 * question honestly, and there are six of them:
 *
 * | branch                          | status | code                       |
 * |---------------------------------|--------|----------------------------|
 * | `mlUrl` unset                   | 502    | `OPTIMIZER_NOT_CONFIGURED` |
 * | connection refused / DNS        | 502    | `OPTIMIZER_UNAVAILABLE`    |
 * | no answer within `mlTimeoutMs`  | 503    | `OPTIMIZER_TIMEOUT`        |
 * | upstream 502/503/504            | 503    | `OPTIMIZER_NOT_READY`      |
 * | upstream 4xx                    | 4xx    | the upstream code          |
 * | upstream 5xx                    | 5xx    | the upstream code          |
 *
 * The first three are three different sentences: not configured is not broken,
 * a timeout says retry, a refused connection says don't bother yet. The fourth
 * refuses to pass an ML outage on as a WattSteer bug. The last two are the
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
async function upstreamCode(response: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  for (const candidate of [record.error, record.detail, record]) {
    if (typeof candidate === "object" && candidate !== null) {
      const code = (candidate as Record<string, unknown>).code;
      if (typeof code === "string") {
        return code;
      }
    }
  }
  return null;
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
  const raw = await upstreamCode(response);
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
 * Exported so the routes that will sit in front of the solver share one
 * mapping — the point of the module is that there is exactly one.
 */
export async function callMl(
  path: string,
  query: URLSearchParams,
  endpoint: MlEndpoint = configuredEndpoint(),
): Promise<Response> {
  if (!endpoint.baseUrl) {
    // Not configured is not the same as broken. Say so rather than dialling
    // `undefined` and reporting the resulting fetch error as an upstream fault.
    throw new UpstreamError("The ML service is not configured", {
      code: "OPTIMIZER_NOT_CONFIGURED",
    });
  }

  const url = `${endpoint.baseUrl.replace(/\/$/, "")}${path}?${query.toString()}`;
  const signal = AbortSignal.timeout(endpoint.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { accept: "application/json" } });
  } catch (error) {
    // A timeout is not the same failure as a refused connection: one says the
    // service is overloaded, the other that it is absent. 503 tells a caller
    // to retry; 502 tells them not to bother yet.
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new BusyError("The ML service did not answer in time", {
        code: "OPTIMIZER_TIMEOUT",
      });
    }
    throw new UpstreamError("The ML service is unreachable", {
      cause: error,
      code: "OPTIMIZER_UNAVAILABLE",
    });
  }

  if (!response.ok) {
    throw await mapUpstreamFailure(response);
  }
  return response;
}

/**
 * `GET /forecast/day-ahead`.
 *
 * **Provisional**, and documented as such: it stands in until a published
 * forecast is persisted and served from Postgres, at which point this route is
 * deleted and the module keeps only the solve. Until then it returns the ML
 * service's response verbatim. The gateway deliberately does not reshape it:
 * the forecast contract belongs to the service that computes it, and a
 * translation layer here would be a second place for the P10/P50/P90 shape to
 * drift out of step with the model that produces it.
 */
export const mlProxy = new Elysia({ name: "ml-proxy" }).get(
  "/forecast/day-ahead",
  async ({ query }) => {
    const params = new URLSearchParams({ subsystem: query.subsystem });
    if (query.target_date) {
      params.set("target_date", query.target_date);
    }
    const response = await callMl("/v1/forecast/day-ahead", params);
    return response.json();
  },
  {
    query: t.Object({
      subsystem: t.Union([
        t.Literal("N"),
        t.Literal("NE"),
        t.Literal("S"),
        t.Literal("SE"),
      ]),
      target_date: t.Optional(t.String({ format: "date" })),
    }),
    detail: {
      summary: "Day-ahead curtailment forecast (provisional)",
      description:
        "Proxied to the modelling service. Returns P10/P50/P90 per hour once the " +
        "forecaster is built; until then it returns the contract's shape with an " +
        "empty profile and a status saying so, never invented numbers. Provisional: " +
        "it is replaced by a Postgres-backed route once forecasts are published.",
    },
  },
);

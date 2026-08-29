/**
 * Domain errors that carry an intended HTTP status, a stable code and a
 * client-safe message. Anything that isn't an `AppError` is treated as an
 * unexpected 500 and its detail is logged server-side but never returned to
 * the client.
 *
 * **The code is the part a client can act on.** `message` is English developer
 * prose, for logs and `/docs`; `code` is a stable identifier a client maps to
 * its own copy. The set below is closed: every error this API returns names a
 * member of it, and an upstream code worth preserving is *admitted into it*
 * rather than smuggled past it as a free-form string.
 *
 * The full envelope — `{ error: { code, message, details, request_id } }`,
 * with the enum published in `packages/core` — is a later ticket. What exists
 * here is the enum itself and a `code` on every error, because a failure
 * mapping is worthless if the caller cannot read the answer.
 */

/**
 * Every code this API can return.
 *
 * The first group is the gateway's own. The second is admitted from the
 * modelling service: `docs/specs/flex-optimizer.md` owns those identifiers and
 * the gateway repeats them rather than inventing parallel names for the same
 * conditions — a client that has to learn two vocabularies for one failure has
 * no closed enum at all.
 */
export const ERROR_CODES = [
  // --- the gateway's own ---
  /** Caller's input was wrong. */
  "BAD_INPUT",
  /** Anything unexpected. Never carries detail to the client. */
  "INTERNAL",
  /** A data source outside WattSteer failed or was unreachable. */
  "UPSTREAM_UNAVAILABLE",
  /** The gateway itself is at capacity. */
  "SERVICE_BUSY",
  /** `WATTSTEER_ML_URL` is unset: the capability is absent, not broken. */
  "OPTIMIZER_NOT_CONFIGURED",
  /** The modelling service could not be reached at all. */
  "OPTIMIZER_UNAVAILABLE",
  /** The modelling service did not answer within `mlTimeoutMs`. */
  "OPTIMIZER_TIMEOUT",
  /** The modelling service answered 502/503/504: up, but cannot serve yet. */
  "OPTIMIZER_NOT_READY",
  /**
   * The modelling service refused the request (4xx) with a code this enum has
   * no room for. The upstream code travels in `details`.
   */
  "UPSTREAM_REJECTED",
  /** The modelling service failed (5xx) with a code this enum has no room for. */
  "UPSTREAM_FAILED",

  // --- admitted from the modelling service (docs/specs/flex-optimizer.md) ---
  "SOLVER_GAP_UNCLOSED",
  "SOLVER_TIMEOUT",
  "SOLVER_BUG",
  "RATE_LIMITED",
  "SCENARIO_VERSION_UNSUPPORTED",
  "SCENARIO_TOO_LARGE",
  "ASSET_TYPE_UNKNOWN",
  "SUBSYSTEM_UNKNOWN",
  "SUBSYSTEM_MISMATCH",
  "FIELD_NOT_ON_VARIANT",
  "MAGNITUDE_OUT_OF_RANGE",
  "RTE_OUT_OF_RANGE",
  "EFFICIENCY_PAIR_INCOMPLETE",
  "SOC_BOUNDS_INVALID",
  "SOC_INITIAL_OUT_OF_BOUNDS",
  "POWER_LIMIT_INCONSISTENT",
  "SHIFT_EXCEEDS_CONNECTION",
  "SHIFT_EXCEEDS_BASELINE",
  "SHIFT_WINDOW_OUT_OF_RANGE",
  "RECOVERY_TIME_OUT_OF_RANGE",
  "AVAILABILITY_INVALID",
  "ECONOMIC_ASSUMPTION_OUT_OF_RANGE",
  "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW",
  "REPLAY_DATE_OUT_OF_RANGE",
  "REPLAY_FORECAST_UNAVAILABLE",
  "REPLAY_OBSERVATION_INCOMPLETE",
  "REPLAY_INTEGRITY_VIOLATION",
] as const;

/** A member of the closed code enum. */
export type ErrorCode = (typeof ERROR_CODES)[number];

const CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/** Is `value` a member of the closed enum? The gate an upstream code passes. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && CODES.has(value);
}

/** Extra machine-readable context, typed per code. Never free-form prose. */
export type ErrorDetails = Record<string, string | number | boolean | null>;

/** Options every `AppError` accepts. */
export interface AppErrorOptions {
  cause?: unknown;
  code?: ErrorCode;
  details?: ErrorDetails;
}

/**
 * HTTP statuses this API maps errors to.
 *
 * Wider than the gateway's own handful because a `ProxiedError` carries the
 * modelling service's status. A status outside this set is one the enum has no
 * room for, and `asErrorStatus` refuses it rather than guessing.
 */
export type ErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 415
  | 422
  | 429
  | 500
  | 502
  | 503
  | 504;

const STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503, 504,
]);

/** `status` if this API can return it, `null` otherwise. */
export function asErrorStatus(status: number): ErrorStatus | null {
  return STATUSES.has(status) ? (status as ErrorStatus) : null;
}

export abstract class AppError extends Error {
  abstract readonly status: number;
  /** The stable identifier a client renders its copy from. */
  readonly code: ErrorCode;
  /** Optional machine-readable context. */
  readonly details?: ErrorDetails;

  protected constructor(message: string, fallback: ErrorCode, options?: AppErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = options?.code ?? fallback;
    this.details = options?.details;
  }
}

/** Caller's input was wrong: unknown identifier, bad date, out-of-range value. */
export class BadInputError extends AppError {
  readonly status = 400;
  constructor(message: string, options?: AppErrorOptions) {
    super(message, "BAD_INPUT", options);
    this.name = "BadInputError";
  }
}

/** An upstream data source failed or was unreachable (5xx, network, timeout). */
export class UpstreamError extends AppError {
  readonly status = 502;
  constructor(message = "Upstream data source error", options?: AppErrorOptions) {
    super(message, "UPSTREAM_UNAVAILABLE", options);
    this.name = "UpstreamError";
  }
}

/** The server is at capacity. */
export class BusyError extends AppError {
  readonly status = 503;
  constructor(
    message = "Server at capacity — try again shortly",
    options?: AppErrorOptions,
  ) {
    super(message, "SERVICE_BUSY", options);
    this.name = "BusyError";
  }
}

/**
 * A failure another WattSteer service reported, re-wrapped in this API's
 * envelope with its status and its code preserved.
 *
 * This is the one place where "pass the body through" and "one envelope,
 * everywhere" collide, and the envelope wins. A client that must parse one
 * shape for gateway errors and another for upstream ones has no closed enum,
 * which is the property the envelope exists to provide. What has to survive is
 * the *information* — a rejected scenario is not an outage — and that lives in
 * the status and the code, not in the byte-for-byte body.
 */
export class ProxiedError extends AppError {
  readonly status: ErrorStatus;
  constructor(
    status: ErrorStatus,
    code: ErrorCode,
    message: string,
    options?: Omit<AppErrorOptions, "code">,
  ) {
    super(message, code, { ...options, code });
    this.status = status;
    this.name = "ProxiedError";
  }
}

/** Map any thrown value to a safe `{ status, body }` for an HTTP response. */
export function toHttpError(error: unknown): {
  status: ErrorStatus;
  body: { error: string; code: ErrorCode; details?: ErrorDetails };
} {
  if (error instanceof AppError) {
    return {
      status: error.status as ErrorStatus,
      body: {
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  return { status: 500, body: { error: "Internal server error", code: "INTERNAL" } };
}

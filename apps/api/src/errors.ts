/**
 * Domain errors that carry an intended HTTP status, a stable code and a
 * client-safe message. Anything that isn't an `AppError` is treated as an
 * unexpected 500 and its detail is logged server-side but never returned to
 * the client.
 *
 * **The code is the part a client can act on.** `message` is English developer
 * prose, for logs and `/docs`; `code` is a stable identifier a client maps to
 * its own copy. The set is closed and lives in `@wattsteer/core/errors`, which
 * is what makes it closed: the gateway and the web app import the same file,
 * so there is exactly one vocabulary. An upstream code worth preserving is
 * **admitted into it** rather than smuggled past as a free-form string.
 *
 * Everything here is the *construction* side of that contract. The wire shape —
 * `{ error: { code, message, details, request_id } }` — is produced in exactly
 * one place, `toErrorEnvelope`, and rendered by `plugins/errors.ts` and by the
 * two `onRequest` guards that answer before a handler runs.
 *
 * **A status is a property of the code, not of the throw site.** Every class
 * below reads its status from `ERROR_STATUS`, so two routes cannot answer the
 * same condition with different numbers. `ProxiedError` is the one sanctioned
 * exception, because upstream knows more about its own failure than we do.
 */

import {
  ERROR_STATUS,
  type ErrorCode,
  type ErrorDetails,
  type ErrorEnvelope,
  type ErrorStatus,
  resolveLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  statusForCode,
} from "@wattsteer/core/errors";

export type {
  ErrorCode,
  ErrorDetails,
  ErrorEnvelope,
  ErrorStatus,
  LaneState,
  NoForecastState,
  SupportedLocale,
} from "@wattsteer/core/errors";
export {
  asErrorStatus,
  ERROR_CODES,
  ERROR_STATUS,
  errorCopyKey,
  isErrorCode,
  LANE_STATES,
  NO_FORECAST_STATES,
  resolveLocale,
  SUPPORTED_LOCALES,
  statusForCode,
} from "@wattsteer/core/errors";

/** Options every `AppError` accepts. */
export interface AppErrorOptions {
  cause?: unknown;
  code?: ErrorCode;
  details?: ErrorDetails;
  /**
   * Answer at this status instead of the code's canonical one. For
   * `ProxiedError` only: upstream's status is evidence about upstream.
   */
  status?: ErrorStatus;
  /** Seconds to wait, for the failures that are a budget rather than a bug. */
  retryAfterSec?: number;
}

export abstract class AppError extends Error {
  /** The status this API answers with — read from the code, not chosen here. */
  readonly status: ErrorStatus;
  /** The stable identifier a client renders its copy from. */
  readonly code: ErrorCode;
  /** Optional machine-readable context. */
  readonly details?: ErrorDetails;
  /** Seconds a client should wait, when the failure is a budget rather than a bug. */
  readonly retryAfterSec?: number;

  protected constructor(message: string, fallback: ErrorCode, options?: AppErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = options?.code ?? fallback;
    this.details = options?.details;
    this.status = options?.status ?? ERROR_STATUS[this.code];
    this.retryAfterSec =
      options?.retryAfterSec === undefined
        ? undefined
        : Math.max(1, Math.ceil(options.retryAfterSec));
  }
}

/** Caller's input was wrong: unknown identifier, bad date, out-of-range value. */
export class BadInputError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, "BAD_INPUT", options);
    this.name = "BadInputError";
  }
}

/** An upstream data source failed or was unreachable (5xx, network, timeout). */
export class UpstreamError extends AppError {
  constructor(message = "Upstream data source error", options?: AppErrorOptions) {
    super(message, "UPSTREAM_UNAVAILABLE", options);
    this.name = "UpstreamError";
  }
}

/**
 * The refusal kinds an adapter may raise about a payload's *content*.
 *
 * Each names a defect that is a property of the bytes, not of the run: the
 * same bytes parsed again will be refused again, identically. That is what
 * makes a refusal recordable against a fingerprint rather than retried.
 */
export const PAYLOAD_REFUSALS = [
  /** A required column is missing or unreadable — the published header moved. */
  "schema",
  /** The period is not the period it claims: short, incomplete, duplicated. */
  "coverage",
  /** The time axis would be a guess — a period index or a zone that no longer maps. */
  "time_axis",
  /** A forecast row that is not shaped like a forecast (published at/after its own valid time). */
  "forecast_integrity",
] as const;

export type PayloadRefusal = (typeof PAYLOAD_REFUSALS)[number];

/**
 * **These bytes are unusable, and re-fetching them will not help.**
 *
 * The distinction this class exists to draw is the one that made a day of ONS
 * history silently never arrive (data-platform 21): a parse that throws because
 * the *payload* is wrong is a permanent fact about a fingerprint, and a parse
 * that throws because a socket died, Postgres was down or an adapter had a bug
 * is not. Both used to be the same `UpstreamError`, and both used to leave the
 * resource marked as successfully fetched.
 *
 * A `PayloadRefusedError` is therefore **recorded** against the
 * `ons_resource_version` row — `refused_at` and a reason — so the next sweep
 * neither re-downloads it in a hot loop nor mistakes it for a day that loaded.
 * Anything else is left unmarked and **retried**, which is what a transient
 * failure and a fixed adapter both need.
 *
 * It stays an `UpstreamError` subclass on purpose: it *is* an upstream problem,
 * every existing `instanceof UpstreamError` catcher keeps working, and the wire
 * code is unchanged. What is new is only the classification.
 *
 * A refusal is not permanent about the *dataset*, only about the bytes. ONS
 * re-publishing the file is a new `change_key`, and therefore a new version row
 * with nothing recorded against it; an adapter fix is re-applied with
 * `force: true`.
 */
export class PayloadRefusedError extends UpstreamError {
  readonly refusal: PayloadRefusal;

  constructor(refusal: PayloadRefusal, message: string, options?: AppErrorOptions) {
    super(message, options);
    this.name = "PayloadRefusedError";
    this.refusal = refusal;
  }
}

/**
 * The refusal in this error, or null when the failure is not about the bytes.
 *
 * The one place the question "may this be recorded against a fingerprint?" is
 * answered, so no ingestor can answer it differently. Deliberately an
 * `instanceof` check and not a message match: a refusal is declared at the
 * throw site by the adapter that knows what it refused.
 */
export function payloadRefusal(error: unknown): PayloadRefusedError | null {
  return error instanceof PayloadRefusedError ? error : null;
}

/** The server is at capacity. */
export class BusyError extends AppError {
  constructor(
    message = "Server at capacity — try again shortly",
    options?: AppErrorOptions,
  ) {
    super(message, "SERVICE_BUSY", options);
    this.name = "BusyError";
  }
}

/**
 * Any refusal named by its code, at the status the code owns.
 *
 * The general constructor the specific ones above are shorthands for. A route
 * that refuses a subsystem, a gate profile, a locale or a date range throws
 * this and never picks a number: `SUBSYSTEM_UNKNOWN` is a 422 everywhere or it
 * is not a contract.
 */
export class CodedError extends AppError {
  constructor(code: ErrorCode, message: string, options?: Omit<AppErrorOptions, "code">) {
    super(message, code, { ...options, code });
    this.name = "CodedError";
  }
}

/**
 * Over the tier's budget.
 *
 * Carries the wait so that `Retry-After` is set from the same object that
 * chose the status — the header and the body cannot disagree about whether
 * this was a rate limit.
 */
export class RateLimitedError extends AppError {
  constructor(
    retryAfterSec: number,
    message = "Too many requests — this endpoint is rate limited",
    options?: Omit<AppErrorOptions, "code" | "status" | "retryAfterSec">,
  ) {
    super(message, "RATE_LIMITED", { ...options, code: "RATE_LIMITED", retryAfterSec });
    this.name = "RateLimitedError";
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
 *
 * It is also the only class that may answer at a status other than the code's
 * canonical one, because the upstream status is evidence: `SOLVER_TIMEOUT` at
 * 504 and `SOLVER_GAP_UNCLOSED` at 503 are two different sentences.
 */
export class ProxiedError extends AppError {
  constructor(
    status: ErrorStatus,
    code: ErrorCode,
    message: string,
    options?: Omit<AppErrorOptions, "code" | "status">,
  ) {
    super(message, code, { ...options, code, status });
    this.name = "ProxiedError";
  }
}

/** What an error becomes on the wire, plus the headers it obliges. */
export interface ErrorResponse {
  status: ErrorStatus;
  body: ErrorEnvelope;
  /** Set as `Retry-After` when present. */
  retryAfterSec?: number;
}

/**
 * Build the envelope. **The single place the error wire shape is produced.**
 *
 * Anything that is not an `AppError` is a 500 whose message is discarded: an
 * unexpected failure's text is a connection string, a query or a stack as
 * often as not, and none of that belongs in a public response.
 */
/**
 * Postgres `undefined_table` / `invalid_schema_name`.
 *
 * A database that answers and has no schema is not a bug in this code, and
 * saying `INTERNAL` about it is the opposite of what every other refusal in
 * this service does. Measured on the first production deploy: `/v1/meta`
 * returned `500 INTERNAL` while the logs said `relation
 * "subsystem_energy_balance_hour" does not exist` — the operator could not
 * tell a missing migration from a genuine fault without reading the logs,
 * which is exactly the diagnosis the envelope exists to carry.
 *
 * It maps to `DATA_UNAVAILABLE` (503) rather than a new code: that code is
 * documented as "Postgres unreachable. The generic case, and the only generic
 * sentence", and a reachable-but-unmigrated database belongs to the same
 * family — the data is not there to be read, through no fault of the caller.
 * 503 also says retry-after-an-operator-acts, which 500 does not.
 */
const SCHEMA_ABSENT = new Set(["42P01", "3F000"]);

/** The relation Postgres named, when it named one. */
function missingRelation(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !SCHEMA_ABSENT.has(code)) {
    return null;
  }
  const message = (error as { message?: unknown }).message;
  const named =
    typeof message === "string"
      ? /relation "([^"]+)" does not exist/.exec(message)
      : null;
  return named?.[1] ?? "unknown";
}

export function toErrorEnvelope(error: unknown, requestId?: string): ErrorResponse {
  const absent = missingRelation(error);
  if (absent !== null && !(error instanceof AppError)) {
    return {
      status: statusForCode("DATA_UNAVAILABLE"),
      body: {
        error: {
          code: "DATA_UNAVAILABLE",
          message:
            "The database is reachable but has no schema for this read. " +
            "Apply the migrations before serving.",
          details: { relation: absent },
          ...(requestId ? { request_id: requestId } : {}),
        },
      },
    };
  }
  const known = error instanceof AppError ? error : null;
  const code: ErrorCode = known ? known.code : "INTERNAL";
  const message = known ? known.message : "Internal server error";
  return {
    status: known ? known.status : statusForCode("INTERNAL"),
    body: {
      error: {
        code,
        message,
        ...(known?.details ? { details: known.details } : {}),
        ...(requestId ? { request_id: requestId } : {}),
      },
    },
    ...(known?.retryAfterSec === undefined ? {} : { retryAfterSec: known.retryAfterSec }),
  };
}

/**
 * The locale to answer in, or the 422 that says why not.
 *
 * `LOCALE_UNSUPPORTED` fires on the **primary subtag**, never on an exact
 * match: `apps/web`'s `Locale` is `"pt" | "en"` and its `languageTag` helper
 * emits `pt-BR` and plain `en`, so exact-matching `{pt-BR, en-US}` would have
 * the gateway answer 422 to its own client. `pt*` resolves to `pt-BR`, `en*`
 * to `en-US`, and only a third language is a refusal.
 */
export function requireLocale(tag: string): SupportedLocale {
  const resolved = resolveLocale(tag);
  if (resolved) {
    return resolved;
  }
  throw new CodedError(
    "LOCALE_UNSUPPORTED",
    `Unsupported locale "${tag}": WattSteer answers in ${SUPPORTED_LOCALES.join(" and ")}.`,
    { details: { field: "locale", requested: tag } },
  );
}

/**
 * The message it is safe to persist or hand back for an arbitrary failure.
 *
 * An `AppError`'s prose was written to be seen; anything else's was not, and
 * is as likely to be a DSN or a stack as a sentence. Used by the job runners,
 * which record a failure reason rather than answer an HTTP request.
 */
export function clientSafeMessage(error: unknown): string {
  return toErrorEnvelope(error).body.error.message;
}

/**
 * The envelope for a refusal raised before any handler runs.
 *
 * The body-limit and rate-limit guards answer from `onRequest`, where there is
 * nothing to throw *to* yet. They still may not hand-roll a body — that is how
 * a surface grows a second error shape — so they build theirs through the same
 * function everything else does.
 */
export function envelope(
  code: ErrorCode,
  message: string,
  options?: { details?: ErrorDetails; requestId?: string; retryAfterSec?: number },
): ErrorResponse {
  const error = new CodedError(code, message, {
    details: options?.details,
    retryAfterSec: options?.retryAfterSec,
  });
  return toErrorEnvelope(error, options?.requestId);
}

/**
 * What an error may be written to a **log** as.
 *
 * `toErrorEnvelope` guards the response path. This guards the log path, and the
 * two need separate answers: a response must carry no detail at all, while a
 * log wants the stack — an uncaught exception with no frames is an incident
 * with no lead.
 *
 * **What it exists to drop is an error's own attached properties.** ioredis
 * hangs the failed command off the error object — `err.command` is
 * `{ name: "auth", args: ["default", "<the password>"] }` — and every console
 * that formats an `Error` by inspecting its properties (Bun's among them)
 * prints those args verbatim. One WRONGPASS therefore writes `REDIS_URL`'s
 * password into the deployment log, where it outlives the rotation that was
 * meant to retire it. `redactedRedisError` in `jobs/bullmq.ts` was written when
 * that happened; it was applied to one of the two Redis handlers and to none of
 * the five process-level sinks that can receive the same object through an
 * unhandled rejection.
 *
 * **`stack` rather than `message`, and by construction rather than by
 * redaction.** `Error.prototype.stack` is built from the name, the message and
 * the frames; it does not walk own-properties, so `command.args` cannot appear
 * in it however many fields a library attaches. A redactor would have to be
 * right about every field ioredis — or the next library — might add. This has
 * to be right about one: that `stack` is a string.
 */
export function loggableError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

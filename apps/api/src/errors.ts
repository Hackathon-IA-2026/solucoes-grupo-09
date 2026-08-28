/**
 * Domain errors that carry an intended HTTP status and a client-safe message.
 * Anything that isn't an `AppError` is treated as an unexpected 500 and its
 * detail is logged server-side but never returned to the client.
 */
export abstract class AppError extends Error {
  abstract readonly status: number;
}

/** Caller's input was wrong: unknown identifier, bad date, out-of-range value. */
export class BadInputError extends AppError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadInputError";
  }
}

/** An upstream data source failed or was unreachable (5xx, network, timeout). */
export class UpstreamError extends AppError {
  readonly status = 502;
  constructor(message = "Upstream data source error", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamError";
  }
}

/** The server is at capacity. */
export class BusyError extends AppError {
  readonly status = 503;
  constructor(message = "Server at capacity — try again shortly") {
    super(message);
    this.name = "BusyError";
  }
}

/** HTTP statuses this API maps errors to. */
export type ErrorStatus = 400 | 500 | 502 | 503;

/** Map any thrown value to a safe `{ status, body }` for an HTTP response. */
export function toHttpError(error: unknown): {
  status: ErrorStatus;
  body: { error: string };
} {
  if (error instanceof AppError) {
    return { status: error.status as ErrorStatus, body: { error: error.message } };
  }
  return { status: 500, body: { error: "Internal server error" } };
}

import { describe, expect, it } from "bun:test";
import {
  asErrorStatus,
  BadInputError,
  BusyError,
  ERROR_CODES,
  isErrorCode,
  ProxiedError,
  toHttpError,
  UpstreamError,
} from "../src/errors.js";

describe("errors · toHttpError", () => {
  it("maps each domain error to its status with a client-safe message", () => {
    expect(toHttpError(new BadInputError("bad id"))).toEqual({
      status: 400,
      body: { error: "bad id", code: "BAD_INPUT" },
    });
    expect(toHttpError(new UpstreamError()).status).toBe(502);
    expect(toHttpError(new BusyError()).status).toBe(503);
  });

  it("maps unknown errors to a generic 500 — never leaks the message", () => {
    const r = toHttpError(new Error("ECONN to internal-db:5432 dsn=secret"));
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("Internal server error");
  });

  it("UpstreamError keeps the cause for server-side logging", () => {
    const cause = new Error("net::ERR_CONNECTION_RESET");
    expect(new UpstreamError("Failed to load", { cause }).cause).toBe(cause);
  });
});

describe("errors · the closed code enum", () => {
  it("has no duplicates — a code means one thing", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("admits a code into the enum rather than letting one past it", () => {
    expect(isErrorCode("SOLVER_GAP_UNCLOSED")).toBe(true);
    expect(isErrorCode("SOME_FUTURE_REFUSAL")).toBe(false);
    expect(isErrorCode(422)).toBe(false);
  });

  it("refuses a status this API cannot return rather than guessing", () => {
    expect(asErrorStatus(422)).toBe(422);
    expect(asErrorStatus(418)).toBeNull();
  });

  it("a ProxiedError carries the upstream status and code into the envelope", () => {
    const error = new ProxiedError(
      504,
      "SOLVER_TIMEOUT",
      "The ML service answered SOLVER_TIMEOUT",
    );
    expect(toHttpError(error)).toEqual({
      status: 504,
      body: { error: "The ML service answered SOLVER_TIMEOUT", code: "SOLVER_TIMEOUT" },
    });
  });

  it("details travel with the error when the enum has no room for something", () => {
    const error = new BusyError("not ready", {
      code: "OPTIMIZER_NOT_READY",
      details: { upstream_status: 503 },
    });
    expect(toHttpError(error).body.details).toEqual({ upstream_status: 503 });
  });
});

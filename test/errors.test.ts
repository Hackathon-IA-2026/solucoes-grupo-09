import { describe, expect, it } from "bun:test";
import {
  BadInputError,
  BusyError,
  ScrapeTimeoutError,
  toHttpError,
  UpstreamError,
} from "../src/errors.js";

describe("errors · toHttpError", () => {
  it("maps each domain error to its status with a client-safe message", () => {
    expect(toHttpError(new BadInputError("bad id"))).toEqual({
      status: 400,
      body: { error: "bad id" },
    });
    expect(toHttpError(new UpstreamError()).status).toBe(502);
    expect(toHttpError(new ScrapeTimeoutError()).status).toBe(504);
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

import { describe, expect, it } from "bun:test";
import {
  asErrorStatus,
  BadInputError,
  BusyError,
  CodedError,
  clientSafeMessage,
  ERROR_CODES,
  ERROR_STATUS,
  envelope,
  isErrorCode,
  NO_FORECAST_STATES,
  ProxiedError,
  RateLimitedError,
  requireLocale,
  resolveLocale,
  toErrorEnvelope,
  UpstreamError,
} from "../src/errors.js";

describe("errors · toErrorEnvelope", () => {
  it("maps each domain error to its status inside the one envelope", () => {
    expect(toErrorEnvelope(new BadInputError("bad id"))).toEqual({
      status: 400,
      body: { error: { code: "BAD_INPUT", message: "bad id" } },
    });
    expect(toErrorEnvelope(new UpstreamError()).status).toBe(502);
    expect(toErrorEnvelope(new BusyError()).status).toBe(503);
  });

  it("maps unknown errors to a generic 500 — never leaks the message", () => {
    const r = toErrorEnvelope(new Error("ECONN to internal-db:5432 dsn=secret"));
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("INTERNAL");
    expect(r.body.error.message).toBe("Internal server error");
  });

  it("echoes the request id so a reported failure is one grep", () => {
    const r = toErrorEnvelope(new BadInputError("bad id"), "1f2c");
    expect(r.body.error.request_id).toBe("1f2c");
    // Absent rather than null when there is none: an absence is not a value.
    expect("request_id" in toErrorEnvelope(new BadInputError("x")).body.error).toBe(
      false,
    );
  });

  it("UpstreamError keeps the cause for server-side logging", () => {
    const cause = new Error("net::ERR_CONNECTION_RESET");
    expect(new UpstreamError("Failed to load", { cause }).cause).toBe(cause);
  });

  it("clientSafeMessage keeps written prose and discards everything else", () => {
    expect(clientSafeMessage(new BadInputError("unknown subsystem XX"))).toBe(
      "unknown subsystem XX",
    );
    expect(clientSafeMessage(new Error("dsn=postgres://u:pw@h/db"))).toBe(
      "Internal server error",
    );
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

  it("carries the four statuses this surface needed adding", () => {
    // The union was 400 | 500 | 502 | 503 and could not express any of these.
    expect([404, 413, 422, 429].map(asErrorStatus)).toEqual([404, 413, 422, 429]);
  });

  it("a status is a property of the code, not of the throw site", () => {
    // Two routes cannot answer the same condition with different numbers,
    // because neither of them picks the number.
    expect(new CodedError("SUBSYSTEM_UNKNOWN", "not one of the four").status).toBe(422);
    expect(new BadInputError("x", { code: "SUBSYSTEM_UNKNOWN" }).status).toBe(422);
    expect(new CodedError("MODEL_UNAVAILABLE", "no promoted artifact").status).toBe(503);
  });

  it("a ProxiedError carries the upstream status and code into the envelope", () => {
    const error = new ProxiedError(
      504,
      "SOLVER_TIMEOUT",
      "The ML service answered SOLVER_TIMEOUT",
    );
    expect(toErrorEnvelope(error)).toEqual({
      status: 504,
      body: {
        error: {
          code: "SOLVER_TIMEOUT",
          message: "The ML service answered SOLVER_TIMEOUT",
        },
      },
    });
  });

  it("keeps SOLVER_GAP_UNCLOSED and SOLVER_TIMEOUT apart, as two sentences", () => {
    expect(ERROR_STATUS.SOLVER_GAP_UNCLOSED).toBe(503);
    expect(ERROR_STATUS.SOLVER_TIMEOUT).toBe(504);
  });

  it("details travel with the error when the enum has no room for something", () => {
    const error = new BusyError("not ready", {
      code: "OPTIMIZER_NOT_READY",
      details: { upstream_status: 503 },
    });
    expect(toErrorEnvelope(error).body.error.details).toEqual({ upstream_status: 503 });
  });

  it("a rate limit carries its own wait, so header and body cannot disagree", () => {
    const mapped = toErrorEnvelope(new RateLimitedError(4.2));
    expect(mapped.status).toBe(429);
    expect(mapped.retryAfterSec).toBe(5);
    expect(mapped.body.error.code).toBe("RATE_LIMITED");
  });

  it("envelope() builds the same shape for a refusal raised before a handler", () => {
    const mapped = envelope("PAYLOAD_TOO_LARGE", "too big", {
      details: { limit_bytes: 16_384 },
      requestId: "abc",
    });
    expect(mapped).toEqual({
      status: 413,
      body: {
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "too big",
          details: { limit_bytes: 16_384 },
          request_id: "abc",
        },
      },
    });
  });
});

describe("errors · the four 'no forecast' states", () => {
  /**
   * The point is that there are four of them and they do not collapse. A
   * screen that renders one spinner for all four is the failure the error
   * contract exists to prevent, so "four, distinguishable" is asserted here
   * rather than left to a paragraph someone has to remember.
   */
  it("is four states, and no two answer the same way", () => {
    expect(NO_FORECAST_STATES).toHaveLength(4);
    const signatures = NO_FORECAST_STATES.map((s) => `${s.status}:${s.code ?? "-"}`);
    expect(new Set(signatures).size).toBe(4);
    expect(new Set(NO_FORECAST_STATES.map((s) => s.screen)).size).toBe(4);
  });

  it("names three refusals whose codes are in the closed enum", () => {
    const codes = NO_FORECAST_STATES.map((s) => s.code).filter((c) => c !== null);
    expect(codes).toEqual([
      "FORECAST_NOT_YET_PUBLISHED",
      "MODEL_UNAVAILABLE",
      "DATA_UNAVAILABLE",
    ]);
    expect(codes.every(isErrorCode)).toBe(true);
    for (const state of NO_FORECAST_STATES) {
      if (state.code) {
        expect(ERROR_STATUS[state.code]).toBe(state.status);
      }
    }
  });

  it("keeps 'stale' a 200 — a forecast from this morning is a real forecast", () => {
    const stale = NO_FORECAST_STATES.find((s) => s.state === "stale");
    expect(stale?.status).toBe(200);
    expect(stale?.code).toBeNull();
  });

  it("distinguishes a publication failure from a gate that has not passed", () => {
    // Both are 404s and they are not the same sentence: one is our fault.
    expect(ERROR_STATUS.FORECAST_NOT_YET_PUBLISHED).toBe(404);
    expect(ERROR_STATUS.FORECAST_UNAVAILABLE).toBe(404);
    expect(isErrorCode("FORECAST_UNAVAILABLE")).toBe(true);
  });
});

describe("errors · LOCALE_UNSUPPORTED fires on the primary subtag", () => {
  /**
   * Exact-matching `{pt-BR, en-US}` would have the gateway answer 422 to its
   * own client: `apps/web`'s `languageTag` emits `pt-BR` and plain `en`.
   */
  it("resolves anything Portuguese to pt-BR and anything English to en-US", () => {
    expect(resolveLocale("pt")).toBe("pt-BR");
    expect(resolveLocale("pt-BR")).toBe("pt-BR");
    expect(resolveLocale("pt-PT")).toBe("pt-BR");
    expect(resolveLocale("en")).toBe("en-US");
    expect(resolveLocale("en-GB")).toBe("en-US");
    expect(resolveLocale("EN_us")).toBe("en-US");
  });

  it("refuses only a primary subtag that is neither", () => {
    expect(resolveLocale("es")).toBeNull();
    expect(resolveLocale("es-AR")).toBeNull();
    expect(resolveLocale("")).toBeNull();
    expect(ERROR_STATUS.LOCALE_UNSUPPORTED).toBe(422);
  });

  it("resolves its own client's tags rather than refusing them", () => {
    // `languageTag` emits "pt-BR" and plain "en"; both must resolve.
    expect(requireLocale("pt-BR")).toBe("pt-BR");
    expect(requireLocale("en")).toBe("en-US");
  });

  it("refuses a third language with the code, the status and the field", () => {
    try {
      requireLocale("es-AR");
      throw new Error("expected requireLocale to throw");
    } catch (error) {
      const mapped = toErrorEnvelope(error);
      expect(mapped.status).toBe(422);
      expect(mapped.body.error.code).toBe("LOCALE_UNSUPPORTED");
      expect(mapped.body.error.details).toEqual({ field: "locale", requested: "es-AR" });
    }
  });
});

describe("a database with no schema is not an INTERNAL", () => {
  it("names the missing relation and answers 503, not 500", () => {
    // Measured on the first production deploy: `/v1/meta` returned
    // `500 INTERNAL` while the logs said `relation
    // "subsystem_energy_balance_hour" does not exist`. The operator could not
    // tell a missing migration from a genuine fault without reading the logs.
    const pgError = Object.assign(new Error('relation "plant" does not exist'), {
      code: "42P01",
    });
    const { status, body } = toErrorEnvelope(pgError, "req-1");
    expect(status).toBe(503);
    expect(body.error.code).toBe("DATA_UNAVAILABLE");
    expect(body.error.details).toEqual({ relation: "plant" });
    expect(body.error.request_id).toBe("req-1");
  });

  it("still discards the text of a genuine fault", () => {
    // The rule this must not weaken: an unexpected failure's message is a
    // connection string or a query as often as not, so it is dropped. Only the
    // two schema codes are given a voice, and only the relation name from them.
    const secret = new Error("connect ECONNREFUSED postgres://user:hunter2@host/db");
    const { status, body } = toErrorEnvelope(secret, "req-2");
    expect(status).toBe(500);
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("is not fooled by a message without the code, or a code without a message", () => {
    // Both halves are required, so a log line quoted into an ordinary error
    // cannot promote itself to a 503.
    const prose = new Error('relation "plant" does not exist');
    expect(toErrorEnvelope(prose).body.error.code).toBe("INTERNAL");

    const coded = Object.assign(new Error("something else entirely"), { code: "42P01" });
    const envelope = toErrorEnvelope(coded);
    expect(envelope.body.error.code).toBe("DATA_UNAVAILABLE");
    // Named "unknown" rather than invented, because Postgres did not say.
    expect(envelope.body.error.details).toEqual({ relation: "unknown" });
  });
});

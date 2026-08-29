import { describe, expect, it, test } from "bun:test";
import { Elysia, t } from "elysia";
import { bodyLimit } from "../src/api/plugins/body-limit.js";
import { errorHandler, fieldPath, validationFailure } from "../src/api/plugins/errors.js";
import { rateLimit } from "../src/api/plugins/rate-limit.js";
import { requestContext } from "../src/api/plugins/request-context.js";
import {
  CodedError,
  ERROR_CODES,
  ERROR_STATUS,
  type ErrorCode,
  type ErrorEnvelope,
  isErrorCode,
} from "../src/errors.js";

/**
 * **One envelope, everywhere, including the two shapes that used to escape it.**
 *
 * The property under test is not "errors have a code" — it is that a client
 * can write *one* parser. So every case below goes through a real Elysia app
 * and asserts the bytes: the status, the envelope, and that the code it
 * carries is a member of the closed enum. A code that answered at a different
 * status from another route's identical condition, or a failure that arrived
 * in TypeBox's shape instead of ours, is a client that has to branch — which
 * is the failure this whole contract exists to prevent.
 */

const REQUEST_ID = "1f2c-test-request-id";

/** Fire `error` through the real handler and read what a client would read. */
async function answer(
  build: (app: Elysia) => Elysia,
): Promise<{ status: number; body: ErrorEnvelope; retryAfter: string | null }> {
  const app = build(new Elysia().use(requestContext).use(errorHandler) as Elysia);
  const response = await app.handle(
    new Request("http://localhost/boom", { headers: { "x-request-id": REQUEST_ID } }),
  );
  return {
    status: response.status,
    body: (await response.json()) as ErrorEnvelope,
    retryAfter: response.headers.get("retry-after"),
  };
}

const throwing = (error: unknown) => (app: Elysia) =>
  app.get("/boom", () => {
    throw error;
  }) as Elysia;

describe("the error envelope · one case per code", () => {
  // One test per member of the closed enum, generated from the enum itself so
  // that a code added without a status, or added and never exercised, cannot
  // pass by being forgotten.
  for (const code of ERROR_CODES) {
    test(`${code} answers ${ERROR_STATUS[code]} in the envelope`, async () => {
      const { status, body } = await answer(
        throwing(new CodedError(code, `developer prose for ${code}`)),
      );

      expect(status).toBe(ERROR_STATUS[code]);
      // The shape, exactly: one key, `error`, and nothing beside it.
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error.code).toBe(code);
      expect(isErrorCode(body.error.code)).toBe(true);
      expect(body.error.message).toBe(`developer prose for ${code}`);
      expect(body.error.request_id).toBe(REQUEST_ID);
    });
  }

  it("covers every code and no more — the enum is closed", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES.every((code) => isErrorCode(code))).toBe(true);
    expect(isErrorCode("SOME_FUTURE_REFUSAL")).toBe(false);
  });
});

describe("the error envelope · the shapes that used to escape it", () => {
  it("maps a framework validation failure into the envelope, field path intact", async () => {
    const app = new Elysia()
      .use(requestContext)
      .use(errorHandler)
      .get("/boom", ({ query }) => query.subsystem, {
        query: t.Object({
          subsystem: t.Union([t.Literal("N"), t.Literal("NE")]),
        }),
      });
    const response = await app.handle(
      new Request("http://localhost/boom?subsystem=XX", {
        headers: { "x-request-id": REQUEST_ID },
      }),
    );
    const body = (await response.json()) as ErrorEnvelope;

    // Not TypeBox's `{ type, on, property, message, expected, found, errors }`.
    expect(Object.keys(body)).toEqual(["error"]);
    // A schema-refused subsystem is the same refusal a handler would raise.
    expect(body.error.code).toBe("SUBSYSTEM_UNKNOWN");
    expect(response.status).toBe(ERROR_STATUS.SUBSYSTEM_UNKNOWN);
    expect(body.error.details?.field).toBe("subsystem");
    expect(body.error.request_id).toBe(REQUEST_ID);
  });

  it("falls back to REQUEST_INVALID for a field the enum does not name", async () => {
    const app = new Elysia().use(errorHandler).post("/boom", ({ body }) => body, {
      body: t.Object({ horizon_hours: t.Number() }),
    });
    const response = await app.handle(
      new Request("http://localhost/boom", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ horizon_hours: "many" }),
      }),
    );
    const body = (await response.json()) as ErrorEnvelope;
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("REQUEST_INVALID");
    expect(body.error.details?.field).toBe("horizon_hours");
  });

  it("answers an unmatched route with ROUTE_NOT_FOUND, not the old string shape", async () => {
    const app = new Elysia()
      .use(requestContext)
      .use(errorHandler)
      .get("/known", () => "ok");
    const response = await app.handle(new Request("http://localhost/nope"));
    const body = (await response.json()) as ErrorEnvelope & { error: unknown };

    expect(response.status).toBe(404);
    // The old shape was `{ error: "Not found" }` — a string where the envelope is.
    expect(typeof body.error).not.toBe("string");
    expect(body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("answers an oversized body with PAYLOAD_TOO_LARGE and the limit", async () => {
    const app = new Elysia()
      .use(requestContext)
      .use(bodyLimit(16 * 1024))
      .use(errorHandler)
      .post("/boom", () => "ok");
    const response = await app.handle(
      new Request("http://localhost/boom", {
        method: "POST",
        headers: { "content-length": String(64 * 1024) },
      }),
    );
    const body = (await response.json()) as ErrorEnvelope;

    expect(response.status).toBe(413);
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(body.error.details?.limit_bytes).toBe(16 * 1024);
  });

  it("answers a 429 in the envelope and still sets Retry-After", async () => {
    const app = new Elysia()
      .use(requestContext)
      .use(rateLimit({ max: 1, windowMs: 60_000, counts: () => true }))
      .use(errorHandler)
      .get("/boom", () => "ok");
    const hit = () =>
      app.handle(
        new Request("http://localhost/boom", {
          headers: { "x-forwarded-for": "9.9.9.9" },
        }),
      );
    await hit();
    const response = await hit();
    const body = (await response.json()) as ErrorEnvelope;

    expect(response.status).toBe(429);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});

describe("the error envelope · what never reaches the client", () => {
  it("a 5xx logs server-side and answers with nothing internal", async () => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const { status, body } = await answer(
        throwing(new Error("ECONN to internal-db:5432 dsn=postgres://user:pw@host/db")),
      );
      expect(status).toBe(500);
      expect(body.error.code).toBe("INTERNAL");
      expect(body.error.message).toBe("Internal server error");
      expect(JSON.stringify(body)).not.toContain("dsn=");
      expect(logged.length).toBe(1);
    } finally {
      console.error = original;
    }
  });

  it("never carries a stack, a cause or a field the envelope does not define", async () => {
    const { body } = await answer(
      throwing(
        new CodedError("SHIFT_EXCEEDS_BASELINE", "max_shift_mw (70) exceeds 50.", {
          cause: new Error("internal detail"),
          details: { field: "assets[1].max_shift_mw", limit: 50 },
        }),
      ),
    );
    expect(Object.keys(body.error).sort()).toEqual([
      "code",
      "details",
      "message",
      "request_id",
    ]);
    expect(JSON.stringify(body)).not.toContain("internal detail");
  });
});

describe("the error envelope · the field path", () => {
  it("reads a JSON Pointer as the notation the caller wrote", () => {
    expect(fieldPath("/assets/1/max_shift_mw")).toBe("assets[1].max_shift_mw");
    expect(fieldPath("/subsystem")).toBe("subsystem");
    expect(fieldPath("")).toBe("");
  });

  it("names the code the enum already has for a field it recognises", () => {
    const named = (path: string): ErrorCode =>
      validationFailure({ all: [{ path, message: "Expected one of" }], type: "query" })
        .code;
    expect(named("/subsystem")).toBe("SUBSYSTEM_UNKNOWN");
    expect(named("/gate_profile")).toBe("GATE_PROFILE_UNKNOWN");
    expect(named("/locale")).toBe("LOCALE_UNSUPPORTED");
    expect(named("/assets/0/subsystem")).toBe("SUBSYSTEM_UNKNOWN");
    expect(named("/horizon_hours")).toBe("REQUEST_INVALID");
  });

  it("survives a validation error whose shape it does not recognise", () => {
    // TypeBox's shape is the framework's, not ours; it may change on a minor.
    const failure = validationFailure({});
    expect(failure.code).toBe("REQUEST_INVALID");
    expect(failure.details.field).toBeUndefined();
  });
});

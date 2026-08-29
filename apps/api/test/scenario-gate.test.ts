import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  decodeScenarioBody,
  type JsonValue,
  toBase64Url,
} from "@wattsteer/core/scenario";
import { Elysia } from "elysia";
import { callMl } from "../src/api/ml-proxy.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { requestContext } from "../src/api/plugins/request-context.js";
import { admitScenarioBody, admitScenarioParam } from "../src/api/scenario-gate.js";
import {
  ERROR_STATUS,
  type ErrorCode,
  type ErrorEnvelope,
  isErrorCode,
} from "../src/errors.js";

/**
 * The gate, at the gateway: **a rejected scenario never reaches the solver.**
 *
 * `docs/specs/flex-optimizer.md` puts validation in Elysia *before* the request
 * crosses the language boundary, because model construction rather than solving
 * dominates the request. That is a claim about what does not happen, so the
 * tests below run the real refusals through a real Elysia app whose only
 * downstream is an ML endpoint that **fails the test if it is ever called**.
 *
 * The vectors are `packages/core/fixtures/scenario-validation/`, the same
 * directory `packages/core/test/scenario-validation.test.ts` and
 * `apps/ml/tests/test_scenario_validation.py` read. This suite asserts the
 * third thing neither of those can: that the refusal survives the trip through
 * the HTTP envelope with its code intact and with no ML call behind it.
 */

const FIXTURES = join(
  dirname(import.meta.dir),
  "..",
  "..",
  "packages",
  "core",
  "fixtures",
  "scenario-validation",
);

interface Vector {
  file: string;
  name: string;
  now: string;
  scenario: Record<string, JsonValue>;
  expected_code: ErrorCode;
  expected_field?: string;
  /**
   * The field the *gateway* names, where the transport's own cap refuses the
   * scenario before the table reaches the rule. One vector needs it: twenty-one
   * batteries are a 4 550-byte blob, so `SCENARIO_TOO_LARGE` arrives from the
   * byte cap rather than the asset cap — the same code, a different field.
   */
  gateway_field?: string;
}

const REFUSALS: Vector[] = readdirSync(join(FIXTURES, "refusals"))
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    ...(JSON.parse(readFileSync(join(FIXTURES, "refusals", file), "utf8")) as Omit<
      Vector,
      "file"
    >),
  }));

/**
 * An ML endpoint that must not be dialled.
 *
 * The URL is unroutable, but that is not what the assertion rests on: a
 * connection error would only prove the network was down. What is asserted is
 * `reached` — the hash pushed immediately before the call — so "never reached
 * the ml service" is a recorded fact rather than an inference from a failure.
 */
const UNREACHABLE_ML = { baseUrl: "http://ml.invalid", timeoutMs: 50 } as const;

/** The route flex-optimizer ticket 06 will wire, in the shape this ticket fixes. */
function optimizeApp(reached: string[], now: Date): Elysia {
  return new Elysia()
    .use(requestContext)
    .use(errorHandler)
    .post("/v1/optimize", async ({ body }) => {
      const decoded = admitScenarioBody(body as JsonValue, { now });
      // Only a scenario that passed the gate gets this far. The call is real —
      // it is `ml-proxy`'s own `callMl` — and the endpoint records the attempt
      // before failing, so a validator that let something through is a test
      // failure with the scenario's hash beside it.
      reached.push(decoded.hash);
      await callMl("/v1/optimize", new URLSearchParams(), UNREACHABLE_ML);
      return { ok: true };
    }) as Elysia;
}

async function post(
  app: Elysia,
  body: unknown,
): Promise<{ status: number; envelope: ErrorEnvelope }> {
  const response = await app.handle(
    new Request("http://localhost/v1/optimize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, envelope: (await response.json()) as ErrorEnvelope };
}

describe("a scenario rejected at the gateway never reaches the ml service", () => {
  test("the vector directory is not empty, so a passing run means something", () => {
    expect(REFUSALS.length).toBeGreaterThan(0);
  });

  for (const vector of REFUSALS) {
    test(`${vector.file}: ${vector.expected_code}`, async () => {
      const reached: string[] = [];
      const app = optimizeApp(reached, new Date(vector.now));
      const { status, envelope } = await post(app, vector.scenario);

      expect(status).toBe(ERROR_STATUS[vector.expected_code]);
      expect(status).toBe(422);
      expect(envelope.error.code).toBe(vector.expected_code);
      // Nothing crossed the language boundary. This is the assertion the
      // spec's "before the request reaches the solver" is made of.
      expect(reached).toEqual([]);
    });
  }

  test("a valid scenario does reach it — so the guard above is not vacuous", async () => {
    // The test of the test. If the gate refused everything, every assertion
    // above would pass and the endpoint would be a 422 machine.
    const reached: string[] = [];
    const app = optimizeApp(reached, new Date("2026-08-28T12:00:00Z"));
    const valid = JSON.parse(
      readFileSync(join(FIXTURES, "admissions", "01-the-reference-fleet.json"), "utf8"),
    ) as { scenario: Record<string, JsonValue> };
    const { status } = await post(app, valid.scenario);

    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The ML service is genuinely unreachable in this test, so the request ends
    // as an upstream failure rather than a validation one — which is exactly
    // the distinction the envelope has to keep: `502` is not the caller's fault.
    expect(status).toBeGreaterThanOrEqual(500);
  });
});

describe("the refusal a client actually receives", () => {
  for (const vector of REFUSALS) {
    test(`${vector.file} carries a code and no translated string`, async () => {
      const app = optimizeApp([], new Date(vector.now));
      const { envelope } = await post(app, vector.scenario);

      // `docs/specs/i18n.md`: the API returns codes, never translated strings.
      // The client renders `t("error." + code)`; `message` is English developer
      // prose for logs and `/docs` and is never shown to a user.
      expect(isErrorCode(envelope.error.code)).toBe(true);
      expect(Object.keys(envelope)).toEqual(["error"]);
      const field = vector.gateway_field ?? vector.expected_field;
      if (field !== undefined) {
        expect(envelope.error.details?.field).toBe(field);
      }
    });
  }
});

describe("both transports pass through the same gate", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  const prototypeLoad = {
    v: 1,
    subsystem: "NE",
    target_date: "2026-08-29",
    assets: [
      {
        asset_type: "shiftable_load",
        label: "Flexible load",
        subsystem: "NE",
        max_power_mw: 70,
        max_shift_mw: 70,
        shift_window_hours: 3,
        daily_energy_mwh: 1200,
      },
    ],
  } as unknown as JsonValue;

  function code(run: () => unknown): string | null {
    try {
      run();
    } catch (error) {
      return (error as { code?: string }).code ?? null;
    }
    return null;
  }

  test("the prototype's 70 MW load is refused on the body path", () => {
    expect(code(() => admitScenarioBody(prototypeLoad, { now }))).toBe(
      "SHIFT_EXCEEDS_BASELINE",
    );
  });

  test("and on the ?s= path, from the same bytes", () => {
    // A share link and a POST are the same scenario, so they cannot disagree
    // about whether it is one. The blob is built from the canonical bytes the
    // body path produced, which is what a share button would put in the URL.
    const blob = toBase64Url(decodeScenarioBody(prototypeLoad).bytes);
    expect(code(() => admitScenarioParam(blob, { now }))).toBe("SHIFT_EXCEEDS_BASELINE");
  });

  test("the byte cap, not the asset cap, is what a fleet of batteries hits", () => {
    // Worth pinning rather than discovering later: the two halves of
    // `SCENARIO_TOO_LARGE` do not bite in the order the table lists them.
    // Nineteen minimal batteries already exceed the 4 096-byte blob cap, so the
    // twenty-asset limit is a second bound on a request no transport can carry.
    // They share a code on purpose — a caller who hand-edited a URL into either
    // is told the same thing — and both are kept because the byte cap is a
    // property of the encoding and the asset cap a property of the model.
    const battery = (index: number): JsonValue => ({
      asset_type: "battery",
      label: `B${index}`,
      subsystem: "NE",
      max_power_mw: 100,
      energy_capacity_mwh: 300,
      round_trip_efficiency: 0.92,
      initial_state_of_charge: 0.2,
    });
    const fleet = (count: number): JsonValue => ({
      v: 1,
      subsystem: "NE",
      target_date: "2026-08-29",
      assets: Array.from({ length: count }, (_, index) => battery(index)),
    });
    expect(code(() => admitScenarioBody(fleet(18), { now }))).toBeNull();
    expect(code(() => admitScenarioBody(fleet(19), { now }))).toBe("SCENARIO_TOO_LARGE");
    expect(code(() => admitScenarioBody(fleet(21), { now }))).toBe("SCENARIO_TOO_LARGE");
  });

  test("an oversized blob is refused before anything parses it", () => {
    expect(code(() => admitScenarioParam("A".repeat(5000), { now }))).toBe(
      "SCENARIO_TOO_LARGE",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, createClient, isRetryableStatus } from "../src/client.js";
import { ERROR_STATUS } from "../src/errors.js";

/**
 * The typed client: what a screen gets, and what it can decide with.
 *
 * The interesting assertions are all about **failure**. A read that works is a
 * fetch and a rename; the reason `ApiError` exists is that a screen has to
 * choose between offering "retry" and rendering one of the four no-forecast
 * states, and `docs/specs/api-surface.md` is emphatic that collapsing those
 * four into a spinner is the failure the whole error contract exists to
 * prevent. So the client hands over three facts — status, domain code,
 * retryable — and this suite is about each of them being right in the cases
 * that are easy to get wrong.
 */

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dir, "..", "fixtures", "spec-examples", name), "utf8"),
  ) as unknown;

/** A fetch that answers one canned response and records what it was asked. */
function stub(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const doFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, doFetch };
}

describe("a successful read arrives in the app's vocabulary", () => {
  test("the wire's snake_case is gone by the time a screen sees it", async () => {
    const { doFetch, calls } = stub(200, fixture("03-grid-now.json"));
    const client = createClient({ baseUrl: "https://api.example.com", fetch: doFetch });
    const now = await client.gridNow();
    expect(now.asOf).toBe("2026-08-28T15:02:11Z");
    expect(now.national.derived).toBe("sum_of_four");
    expect(now.subsystems[0]?.onsDisplayName).toBe("NORDESTE");
    expect(now.subsystems[0]?.split.windMwh).toBeGreaterThan(0);
    expect(calls[0]?.url).toBe("https://api.example.com/v1/grid/now");
  });

  test('a query parameter that was not supplied is not sent as "undefined"', async () => {
    const { doFetch, calls } = stub(200, fixture("02-grid-outlook.json"));
    const client = createClient({ baseUrl: "https://api.example.com/", fetch: doFetch });
    await client.gridOutlook({ targetDate: "2026-08-29" });
    expect(calls[0]?.url).toBe(
      "https://api.example.com/v1/grid/outlook?target_date=2026-08-29",
    );
  });

  test("a POST body leaves in the wire's casing", async () => {
    const { doFetch, calls } = stub(200, fixture("11-optimization-result.json"));
    const client = createClient({ baseUrl: "https://api.example.com", fetch: doFetch });
    const scenario = fixture("10-scenario.json") as Record<string, unknown>;
    const app = {
      v: 1,
      subsystem: "NE",
      targetDate: "2026-08-29",
      forecastOrigin: "2026-08-28T12:00:00Z",
      assets: (scenario.assets as Record<string, unknown>[]).map((asset) => ({
        assetType: asset.asset_type,
        label: asset.label,
        subsystem: asset.subsystem,
        maxPowerMw: asset.max_power_mw,
        energyCapacityMwh: asset.energy_capacity_mwh,
        roundTripEfficiency: asset.round_trip_efficiency,
        initialStateOfCharge: asset.initial_state_of_charge,
        maxShiftMw: asset.max_shift_mw,
        shiftWindowHours: asset.shift_window_hours,
        dailyEnergyMwh: asset.daily_energy_mwh,
        recoveryTimeHours: asset.recovery_time_hours,
        availableFrom: asset.available_from,
        availableTo: asset.available_to,
      })),
      economicAssumptions: { brlPerMwh: 180 },
    };
    // `as never` only because this test hand-builds a partial camelCase value
    // rather than decoding one; the encode path itself is the thing under test.
    await client.optimize(app as never);
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent.target_date).toBe("2026-08-29");
    expect((sent.economic_assumptions as Record<string, unknown>).brl_per_mwh).toBe(180);
    expect((sent.assets as Record<string, unknown>[])[0]?.asset_type).toBe("battery");
  });
});

describe("a replay is the optimizer's blob, asked as a question about the past", () => {
  test("the pinned day goes out as a GET, with the blob and the lane", async () => {
    // A `GET` and not the `POST`: the scenario is already in the address bar of
    // the screen that asks, so sending it as a query parameter keeps the
    // request a shared-cacheable function of exactly what a shared link
    // contains — which is the only way the gateway's `max-age` on this route is
    // reachable. `lane` is required and never defaulted, because a
    // post-go-live day has one candidate forecast per served lane and no rule
    // yet says which one a replay is of.
    const { doFetch, calls } = stub(200, fixture("12-replay.json"));
    const client = createClient({ baseUrl: "https://api.example.com", fetch: doFetch });
    const replay = await client.replay({
      d: "2025-09-14",
      s: "eyJ2IjoxfQ",
      lane: "dessem_free_v1__gate_late__thr5",
    });
    expect(calls[0]?.url).toBe(
      "https://api.example.com/v1/replay?d=2025-09-14&s=eyJ2IjoxfQ" +
        "&lane=dessem_free_v1__gate_late__thr5",
    );
    expect(calls[0]?.init.method).toBe("GET");
    // And it arrives in the app's vocabulary, through the one translator.
    expect(replay.integrity.provenance).toBe("fold_holdout");
    expect(replay.integrity.heldOutBy?.trainWindow).toHaveLength(2);
    expect(replay.forecast.dayTotal.p50).toBeGreaterThan(0);
    expect(replay.scoredOn).toBe("observed");
  });

  test("an observed-only body is sent verbatim, byte for byte", async () => {
    // The answer is stamped with the hash of the bytes that arrived, so a body
    // this client re-serialised would be a different document answering under
    // the same name. `bodyText` is the path that guarantees it, and this is the
    // assertion that says so: the string that went in is the string on the
    // wire, key order and all.
    const { doFetch, calls } = stub(200, fixture("12-replay.json"));
    const client = createClient({ baseUrl: "https://api.example.com", fetch: doFetch });
    const canonical = '{"v":1,"subsystem":"NE","target_date":"2024-11-05"}';
    await client.replayObservedOnly(canonical, { lane: "lane_a" });
    expect(calls[0]?.url).toBe(
      "https://api.example.com/v1/replay/observed-only?lane=lane_a",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(canonical);
  });

  test("a refused day is a code, not a caveated answer", async () => {
    // The one refusal with a view behind it. Every other clause is answered
    // with its sentence and no figures.
    const { doFetch } = stub(422, {
      error: {
        code: "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW",
        message: "2024-11-05 precedes the first walk-forward test fold",
        details: {},
      },
    });
    const client = createClient({ baseUrl: "https://api.example.com", fetch: doFetch });
    const failure = await client
      .replay({ d: "2024-11-05", s: "blob", lane: "lane_a" })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("REPLAY_DATE_BEFORE_HOLDOUT_WINDOW");
    expect((failure as ApiError).status).toBe(422);
    expect((failure as ApiError).retryable).toBe(false);
  });
});

describe("the typed error carries status, domain code and a retryable flag", () => {
  test("a 404 envelope becomes an ApiError with all three", async () => {
    const { doFetch } = stub(404, {
      error: {
        code: "FORECAST_NOT_YET_PUBLISHED",
        message: "The gate for 2026-08-30 has not passed.",
        details: { gate_profile: "gate_late" },
        request_id: "1f2c3d4e",
      },
    });
    const client = createClient({ baseUrl: "https://api.example.com", fetch: doFetch });
    const failure = await client
      .forecastDayAhead({ subsystem: "NE" })
      .then(() => null)
      .catch((error: unknown) => error as ApiError);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure?.status).toBe(404);
    expect(failure?.code).toBe("FORECAST_NOT_YET_PUBLISHED");
    expect(failure?.details?.gate_profile).toBe("gate_late");
    expect(failure?.requestId).toBe("1f2c3d4e");
    // Not retryable, and that is the point: a countdown, not a spinner.
    expect(failure?.retryable).toBe(false);
  });

  test("no promoted artifact is a 503 and is retryable, but is still its own state", async () => {
    const { doFetch } = stub(503, {
      error: {
        code: "MODEL_UNAVAILABLE",
        message: "No promoted artifact in dessem_free_v1__gate_late__thr5.",
        details: { lane_state: "present_unpromoted" },
      },
    });
    const client = createClient({ baseUrl: "https://api.example.com", fetch: doFetch });
    const failure = (await client
      .forecastDayAhead({ subsystem: "NE" })
      .catch((error: unknown) => error)) as ApiError;
    expect(failure.retryable).toBe(true);
    // A screen branches on `code` first: this one renders the observed panels
    // and states which artifact state holds, rather than offering a retry
    // button that will fail identically for the next hour.
    expect(failure.code).toBe("MODEL_UNAVAILABLE");
    expect(failure.details?.lane_state).toBe("present_unpromoted");
  });

  test("a transport failure has no status and no code, and is retryable", async () => {
    const doFetch = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof globalThis.fetch;
    const client = createClient({ baseUrl: "https://api.example.com", fetch: doFetch });
    const failure = (await client.meta().catch((error: unknown) => error)) as ApiError;
    expect(failure.status).toBe(0);
    expect(failure.code).toBeNull();
    expect(failure.retryable).toBe(true);
  });

  test("a body that is not the envelope is reported as such, not as a code", async () => {
    // A CDN 502 page, or a proxy that answered before the gateway did. Claiming
    // a domain code here would be inventing one.
    const { doFetch } = stub(502, "<html>Bad gateway</html>");
    const client = createClient({ baseUrl: "https://api.example.com", fetch: doFetch });
    const failure = (await client.meta().catch((error: unknown) => error)) as ApiError;
    expect(failure.status).toBe(502);
    expect(failure.code).toBeNull();
    expect(failure.retryable).toBe(true);
  });

  test("an unknown code is not admitted to the closed enum", async () => {
    const { doFetch } = stub(400, {
      error: { code: "SOMETHING_NEW", message: "from a newer gateway" },
    });
    const client = createClient({ baseUrl: "https://api.example.com", fetch: doFetch });
    const failure = (await client.meta().catch((error: unknown) => error)) as ApiError;
    expect(failure.code).toBeNull();
    expect(failure.message).toBe("from a newer gateway");
  });
});

describe("retryable is a property of the failure, not of the screen", () => {
  test("429, 5xx and a transport failure; nothing else", () => {
    expect(isRetryableStatus(0)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(413)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
  });

  test("every code in the closed enum gets a verdict from its canonical status", () => {
    // No code can be in a state where a screen has to guess. Asserted over the
    // whole enum rather than over a sample, so a code added by a later ticket
    // is covered the moment it is declared.
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      const verdict = isRetryableStatus(status);
      expect(typeof verdict).toBe("boolean");
      if (status >= 500 || status === 429) {
        expect(verdict).toBe(true);
      } else {
        expect(`${code} ${verdict}`).toBe(`${code} false`);
      }
    }
  });
});

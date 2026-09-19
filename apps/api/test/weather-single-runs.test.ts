import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadInputError } from "../src/errors.js";
import {
  ACCUMULATED_VARIABLES,
  assertNoGridCollisions,
  backoffDelayMs,
  CENTROIDS,
  type Centroid,
  callBudget,
  fetchModelRun,
  GridCellCollisionError,
  locationsOf,
  MODEL_COVERAGE_START,
  type ModelRunResponse,
  ModelRunUnavailableError,
  parseModelRun,
  RUN_CYCLES,
  redact,
  resolveCentroids,
  runAgeHours,
  runCycleOf,
  runParam,
  scheduledRunFor,
  singleRunsUrl,
  targetDays,
  UndefinedWeatherVariableError,
  WEATHER_MODEL,
  WEATHER_VARIABLES,
  WeatherRateLimitError,
} from "../src/ingest/index.js";

// Seam 1 — the weather source adapter, fixture-driven. Every fixture is a real
// captured payload from `https://single-runs-api.open-meteo.com`, dated
// 2026-08-28; see `fixtures/weather/FIXTURES.md` for the exact URLs.
//
// This adapter's risk profile is the same as the carga API's — silence — but
// worse in one respect: where the carga API answers a bad area code with an
// empty array, Open-Meteo answers a wrong model with *plausible numbers from a
// different model*. Nothing in the response says which model produced it, so
// every test below that matters is about the request rather than the reply.
const FIXTURES = join(import.meta.dir, "fixtures", "weather");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const RUN_12Z = read("single-runs-ecmwf-2024-04-09T12Z.json");
const RUN_00Z = read("single-runs-ecmwf-2024-04-09T00Z.json");
const UNAVAILABLE = read("single-runs-unavailable.json");
const UNDEFINED_VARIABLE = read("single-runs-undefined-variable.json");

/** The three centroids the multi-point fixtures were captured for, in order. */
const FIXTURE_CENTROIDS = resolveCentroids(["W1", "W7", "S5"]);

const INIT_12Z = new Date("2024-04-09T12:00:00.000Z");
const INIT_00Z = new Date("2024-04-09T00:00:00.000Z");

/** A fetch that answers every call with one canned body. */
const stubFetch = (body: string, status = 200): typeof fetch =>
  (async () => new Response(body, { status })) as typeof fetch;

const responseOf = (body: string): ModelRunResponse => ({
  locations: locationsOf(JSON.parse(body)),
  url: "https://single-runs-api.open-meteo.com/v1/forecast",
  fetchedAt: new Date("2026-08-28T00:00:00.000Z"),
  body,
  httpStatus: 200,
  rateLimitRetries: 0,
});

describe("single runs · the model is pinned on every request", () => {
  it("writes models=ecmwf_ifs, and best_match is not expressible", () => {
    const url = singleRunsUrl({
      runInit: INIT_12Z,
      points: [{ id: "W1", latitude: -11.216, longitude: -41.341 }],
    });
    expect(url).toContain(`models=${WEATHER_MODEL}`);
    expect(url).not.toContain("best_match");
    // The measured trap: under `best_match` day 0 is ECMWF and day 1 is DWD
    // ICON, with no null and no warning. There is no parameter to pass one.
    expect(Object.keys({ runInit: 0, points: 0 })).not.toContain("models");
  });

  it("always names a run — the stitched archive is not addressable from here", () => {
    const url = singleRunsUrl({
      runInit: INIT_12Z,
      points: [{ id: "W1", latitude: -11.216, longitude: -41.341 }],
    });
    expect(url).toContain("run=2024-04-09T12%3A00");
    expect(url).toContain("single-runs-api.open-meteo.com");
    expect(url).not.toContain("historical-forecast-api");
    expect(url).not.toContain("previous_day");
  });

  it("asks in GMT, so the run's own hour zero is where it says it is", () => {
    const url = singleRunsUrl({
      runInit: INIT_00Z,
      points: [{ id: "W1", latitude: -11.216, longitude: -41.341 }],
    });
    expect(url).toContain("timezone=GMT");
  });

  it("sends the twelve settled variables, in the settled order", () => {
    const url = new URL(
      singleRunsUrl({
        runInit: INIT_12Z,
        points: [{ id: "W1", latitude: -11.216, longitude: -41.341 }],
      }),
    );
    expect(url.searchParams.get("hourly")?.split(",")).toEqual([...WEATHER_VARIABLES]);
    expect(WEATHER_VARIABLES).toHaveLength(12);
    // Excluded by the feature-engineering spec, each for a stated reason.
    for (const excluded of [
      "temperature_120m",
      "boundary_layer_height",
      "cape",
      "wind_speed_180m",
    ]) {
      expect(WEATHER_VARIABLES).not.toContain(excluded as never);
    }
  });

  it("carries the key as configuration and redacts it from provenance", () => {
    const url = singleRunsUrl({
      runInit: INIT_12Z,
      points: [{ id: "W1", latitude: -11.216, longitude: -41.341 }],
      baseUrl: "https://customer-single-runs-api.open-meteo.com",
      apiKey: "secret-key",
    });
    expect(url).toContain("customer-single-runs-api.open-meteo.com");
    expect(url).toContain("apikey=secret-key");
    // The URL is stored as provenance on every run request, so the key must
    // never be one of the bytes it stores.
    expect(redact(url)).toContain("apikey=REDACTED");
    expect(redact(url)).not.toContain("secret-key");
  });
});

describe("single runs · run cycles and the D−1 lead", () => {
  it("resolves the run a real day-ahead pipeline would have received", () => {
    expect(scheduledRunFor("2024-04-10", "12Z").toISOString()).toBe(
      "2024-04-09T12:00:00.000Z",
    );
    expect(scheduledRunFor("2024-04-10", "00Z").toISOString()).toBe(
      "2024-04-09T00:00:00.000Z",
    );
  });

  it("names both cycles, and only those two", () => {
    expect([...RUN_CYCLES]).toEqual(["00Z", "12Z"]);
    expect(runCycleOf(INIT_00Z)).toBe("00Z");
    expect(runCycleOf(INIT_12Z)).toBe("12Z");
    // 06Z and 18Z exist from 2025 but not in 2024, so they cannot cover the
    // training window and are refused rather than silently attempted.
    expect(() => runCycleOf(new Date("2024-04-09T06:00:00.000Z"))).toThrow(BadInputError);
  });

  it("formats `run=` the way the API wants it", () => {
    expect(runParam(INIT_12Z)).toBe("2024-04-09T12:00");
  });

  it("measures the age of a fallback run in whole hours", () => {
    expect(runAgeHours(INIT_12Z, INIT_12Z)).toBe(0);
    expect(runAgeHours(INIT_12Z, INIT_00Z)).toBe(12);
  });

  it("knows where ecmwf_ifs coverage begins, exactly", () => {
    // Measured: `run=2024-03-10T00:00` errors, `run=2024-03-14T00:00` returns
    // 48/48 non-null. It clears the 2024-04-01 window start by 18 days.
    expect(MODEL_COVERAGE_START).toBe("2024-03-14");
  });
});

describe("single runs · an all-null variable fails loudly", () => {
  it("refuses a variable the model does not serve, on a real HTTP 200", () => {
    // The captured payload: `temperature_120m` comes back with 24/24 nulls and
    // `"units": "undefined"`, beside a `wind_speed_120m` that is fine.
    const payload = JSON.parse(UNDEFINED_VARIABLE) as {
      hourly_units: Record<string, string>;
      hourly: Record<string, unknown[]>;
    };
    expect(payload.hourly_units.temperature_120m).toBe("undefined");
    expect(payload.hourly.temperature_120m?.every((value) => value === null)).toBe(true);

    expect(() =>
      parseModelRun(responseOf(UNDEFINED_VARIABLE), {
        centroids: resolveCentroids(["W1"]),
        runInit: INIT_12Z,
        variables: ["wind_speed_120m", "temperature_120m"] as never,
      }),
    ).toThrow(UndefinedWeatherVariableError);
  });

  it("refuses an all-null array even where the units look plausible", () => {
    const body = JSON.stringify({
      latitude: -11.21,
      longitude: -41.36,
      elevation: 741,
      hourly_units: { time: "iso8601", wind_speed_120m: "km/h" },
      hourly: {
        time: ["2024-04-09T12:00", "2024-04-09T13:00", "2024-04-09T14:00"],
        wind_speed_120m: [null, null, null],
      },
    });
    expect(() =>
      parseModelRun(responseOf(body), {
        centroids: resolveCentroids(["W1"]),
        runInit: INIT_12Z,
        variables: ["wind_speed_120m"],
      }),
    ).toThrow(/null values and nothing else/);
  });

  it("refuses a variable that is simply absent from the response", () => {
    const body = JSON.stringify({
      latitude: -11.21,
      longitude: -41.36,
      elevation: 741,
      hourly_units: { time: "iso8601" },
      hourly: { time: ["2024-04-09T13:00"] },
    });
    expect(() =>
      parseModelRun(responseOf(body), {
        centroids: resolveCentroids(["W1"]),
        runInit: INIT_12Z,
        variables: ["wind_speed_120m"],
      }),
    ).toThrow(UndefinedWeatherVariableError);
  });

  it("does not mistake the hour-zero null of an accumulated variable for absence", () => {
    // A single-hour request for an accumulated variable is *entirely* null and
    // is still correct. Firing the loud failure here would make the check
    // useless in exactly the case it is most tempting to.
    const body = JSON.stringify({
      latitude: -11.21,
      longitude: -41.36,
      elevation: 741,
      hourly_units: { time: "iso8601", precipitation: "mm" },
      hourly: { time: ["2024-04-09T12:00"], precipitation: [null] },
    });
    const parsed = parseModelRun(responseOf(body), {
      centroids: resolveCentroids(["W1"]),
      runInit: INIT_12Z,
      variables: ["precipitation"],
    });
    expect(parsed.rows).toEqual([]);
    expect(parsed.hourZeroRowsExcluded).toBe(1);
  });
});

describe("single runs · the run's own hour zero is excluded", () => {
  it("proves the trap on the captured payload", () => {
    const [first] = locationsOf(JSON.parse(RUN_12Z));
    const hourly = (first as { hourly: Record<string, (number | null)[]> }).hourly;
    // The five accumulated/time-averaged variables have no preceding window at
    // initialisation; the instantaneous ones do have a value there.
    for (const variable of ACCUMULATED_VARIABLES) {
      expect(hourly[variable]?.[0]).toBeNull();
      expect(hourly[variable]?.[1]).not.toBeNull();
    }
    expect(hourly.wind_speed_120m?.[0]).not.toBeNull();
  });

  it("drops the whole hour-zero row rather than storing it five-twelfths NULL", () => {
    const parsed = parseModelRun(responseOf(RUN_12Z), {
      centroids: FIXTURE_CENTROIDS,
      runInit: INIT_12Z,
    });
    // One dropped row per centroid; three days of hours minus that one each.
    expect(parsed.hourZeroRowsExcluded).toBe(FIXTURE_CENTROIDS.length);
    expect(parsed.rows).toHaveLength(FIXTURE_CENTROIDS.length * 71);
    expect(
      parsed.rows.some((row) => row.validTime.getTime() === INIT_12Z.getTime()),
    ).toBe(false);
    // And nothing else went missing with it.
    expect(parsed.nullValues).toBe(0);
  });

  it("keeps the target day's hours, which are all at lead ≥ 15 h anyway", () => {
    const parsed = parseModelRun(responseOf(RUN_12Z), {
      centroids: FIXTURE_CENTROIDS,
      runInit: INIT_12Z,
    });
    const w1 = parsed.rows.filter((row) => row.centroidId === "W1");
    const firstHour = w1[0]?.validTime.toISOString();
    expect(firstHour).toBe("2024-04-09T13:00:00.000Z");
  });
});

describe("single runs · both cycles, and the run is the publication", () => {
  it("stamps the run initialisation on every row of both cycles", () => {
    const twelve = parseModelRun(responseOf(RUN_12Z), {
      centroids: FIXTURE_CENTROIDS,
      runInit: INIT_12Z,
    });
    const midnight = parseModelRun(responseOf(RUN_00Z), {
      centroids: FIXTURE_CENTROIDS,
      runInit: INIT_00Z,
    });
    expect(twelve.rows.every((row) => row.runCycle === "12Z")).toBe(true);
    expect(midnight.rows.every((row) => row.runCycle === "00Z")).toBe(true);
    expect(
      twelve.rows.every((row) => row.runInitTime.getTime() === INIT_12Z.getTime()),
    ).toBe(true);
    expect(
      midnight.rows.every((row) => row.runInitTime.getTime() === INIT_00Z.getTime()),
    ).toBe(true);
  });

  it("has the two cycles disagree about the same valid hours — the whole point", () => {
    const target = new Date("2024-04-10T18:00:00.000Z").getTime();
    const pick = (parse: ReturnType<typeof parseModelRun>) =>
      parse.rows.find(
        (row) => row.centroidId === "W7" && row.validTime.getTime() === target,
      );
    const twelve = pick(
      parseModelRun(responseOf(RUN_12Z), {
        centroids: FIXTURE_CENTROIDS,
        runInit: INIT_12Z,
      }),
    );
    const midnight = pick(
      parseModelRun(responseOf(RUN_00Z), {
        centroids: FIXTURE_CENTROIDS,
        runInit: INIT_00Z,
      }),
    );
    expect(twelve).toBeDefined();
    expect(midnight).toBeDefined();
    // Same hour, same grid cell, different runs — so it is a restatement, and
    // the later one is the better one. If these were ever equal the whole
    // supersession story would be untestable.
    expect(twelve?.validTime).toEqual(midnight?.validTime as Date);
    expect(twelve?.windSpeed120mKmh).not.toBe(midnight?.windSpeed120mKmh as number);
  });

  it("records how much older a fallback run is", () => {
    const parsed = parseModelRun(responseOf(RUN_00Z), {
      centroids: FIXTURE_CENTROIDS,
      runInit: INIT_00Z,
      scheduledRunInit: INIT_12Z,
    });
    expect(parsed.rows.every((row) => row.runAgeHours === 12)).toBe(true);
  });
});

describe("single runs · a missing run is a named fact, not a hole", () => {
  it("names the archive gap rather than reporting a generic upstream failure", async () => {
    // The captured 400 body for `run=2024-03-10T00:00`, four days before
    // coverage begins. 4.5% of slots in the sampled 2025-08 fortnight look the
    // same, in the middle of the window.
    const request = {
      runInit: new Date("2024-03-10T00:00:00.000Z"),
      points: [{ id: "W1", latitude: -11.216, longitude: -41.341 }],
      fetch: stubFetch(UNAVAILABLE, 400),
    };
    expect(fetchModelRun(request)).rejects.toThrow(ModelRunUnavailableError);
  });

  it("names it when the multi-point stream reports it with a 200", async () => {
    // Captured on 19/09/2026 at 15:30 UTC for `run=2026-09-19T12:00`, not yet
    // published, asked for all nineteen centroids: HTTP 200, a JSON content
    // type, and this text. A single point gets the 400 above; the streamed
    // multi-point response has already sent its status when it finds out. It
    // reached JSON.parse, and every hourly weather task failed until the run
    // appeared instead of falling back to the 00Z one.
    const request = {
      runInit: new Date("2026-09-19T12:00:00.000Z"),
      points: [{ id: "W1", latitude: -11.216, longitude: -41.341 }],
      fetch: stubFetch(
        "Unexpected error while streaming data: modelRunUnavailable(model: " +
          "App.DomainRegistry.ecmwf_ifs, run: OmTime.Timestamp(timeIntervalSince1970: 1789819200))",
        200,
      ),
    };
    expect(fetchModelRun(request)).rejects.toThrow(ModelRunUnavailableError);
  });
});

describe("single runs · backoff is driven by the status alone", () => {
  it("retries a 429 and records how many it absorbed", async () => {
    // The endpoint returns no `X-RateLimit-*` and no `Retry-After`, so there is
    // nothing to read: the status is the whole signal.
    let calls = 0;
    const slept: number[] = [];
    const response = await fetchModelRun({
      runInit: INIT_12Z,
      points: [{ id: "W1", latitude: -11.216, longitude: -41.341 }],
      fetch: (async () => {
        calls += 1;
        return calls <= 2
          ? new Response("", { status: 429 })
          : new Response(UNDEFINED_VARIABLE, { status: 200 });
      }) as typeof fetch,
      backoff: {
        sleep: async (ms) => {
          slept.push(ms);
        },
        random: () => 1,
      },
    });
    expect(calls).toBe(3);
    expect(response.rateLimitRetries).toBe(2);
    expect(slept).toEqual([1000, 2000]);
  });

  it("gives up once the schedule is exhausted, and says why", async () => {
    expect(
      fetchModelRun({
        runInit: INIT_12Z,
        points: [{ id: "W1", latitude: -11.216, longitude: -41.341 }],
        fetch: stubFetch("", 429),
        backoff: { maxRetries: 2, sleep: async () => {}, random: () => 0 },
      }),
    ).rejects.toThrow(WeatherRateLimitError);
  });

  it("backs off exponentially with jitter, capped", () => {
    const full = (attempt: number) => backoffDelayMs(attempt, {}, () => 1);
    expect([full(1), full(2), full(3), full(4)]).toEqual([1000, 2000, 4000, 8000]);
    // Jitter halves the floor, so concurrent workers do not resynchronise.
    expect(backoffDelayMs(3, {}, () => 0)).toBe(2000);
    // And nothing waits longer than the cap, however long the backfill runs.
    expect(backoffDelayMs(20, {}, () => 1)).toBe(60_000);
  });

  it("does not retry anything that is not a 429", async () => {
    let calls = 0;
    const attempt = fetchModelRun({
      runInit: INIT_12Z,
      points: [{ id: "W1", latitude: -11.216, longitude: -41.341 }],
      fetch: (async () => {
        calls += 1;
        return new Response("{}", { status: 500 });
      }) as typeof fetch,
      backoff: { sleep: async () => {} },
    });
    expect(attempt).rejects.toThrow();
    await attempt.catch(() => undefined);
    expect(calls).toBe(1);
  });
});

describe("weather centroids · the frozen geometry", () => {
  it("freezes nineteen points, not the twenty the research's prose claims", () => {
    // The research says "That is 20 points" and then lists nineteen (W1–W12,
    // S1–S7). The list is the measured artefact; the count is the typo.
    expect(CENTROIDS).toHaveLength(19);
    expect(new Set(CENTROIDS.map((c) => c.id)).size).toBe(19);
  });

  it("carries the two coordinates the research flagged as uncomputed", () => {
    const provisional = CENTROIDS.filter((c) => c.provisional).map((c) => c.id);
    expect(provisional.sort()).toEqual(["W11", "W12"]);
  });

  it("resolves ids in set order and refuses an unknown one", () => {
    expect(resolveCentroids(["S5", "W1"]).map((c) => c.id)).toEqual(["W1", "S5"]);
    expect(() => resolveCentroids(["W99"])).toThrow(BadInputError);
  });

  it("treats two points snapping to one grid cell as a build error", () => {
    const centroids = resolveCentroids(["W1", "W3"]);
    expect(() =>
      assertNoGridCollisions(centroids, [
        { latitude: -11.2127, longitude: -41.36 },
        { latitude: -11.2127, longitude: -41.36 },
      ]),
    ).toThrow(GridCellCollisionError);
  });

  it("accepts the distinct cells the fixture centroids actually resolved to", () => {
    // Measured 2026-08-28: all nineteen frozen points land in distinct cells,
    // including the W1/W3 and W7/W8 pairs the research warned might collapse.
    const locations = locationsOf(JSON.parse(RUN_12Z));
    expect(() => assertNoGridCollisions(FIXTURE_CENTROIDS, locations)).not.toThrow();
  });

  it("refuses to pair by index when the counts disagree", () => {
    const one: Centroid[] = resolveCentroids(["W1"]);
    expect(() =>
      assertNoGridCollisions(one, [
        { latitude: -11.21, longitude: -41.36 },
        { latitude: -5.37, longitude: -36.05 },
      ]),
    ).toThrow(BadInputError);
  });

  it("stores the grid cell the API echoed, not the point that was asked for", () => {
    const parsed = parseModelRun(responseOf(RUN_12Z), {
      centroids: FIXTURE_CENTROIDS,
      runInit: INIT_12Z,
    });
    const w1 = parsed.rows.find((row) => row.centroidId === "W1");
    expect(w1?.gridLatitude).not.toBe(-11.216);
    expect(w1?.gridLatitude).toBeCloseTo(-11.2127, 3);
  });
});

describe("weather backfill · the call budget", () => {
  it("enumerates target days inclusively", () => {
    expect(targetDays("2024-04-01", "2024-04-03")).toEqual([
      "2024-04-01",
      "2024-04-02",
      "2024-04-03",
    ]);
    expect(targetDays("2024-04-01", "2024-04-01")).toHaveLength(1);
    expect(() => targetDays("2024-04-03", "2024-04-01")).toThrow(BadInputError);
  });

  it("matches the documented backfill cost for the full window", () => {
    // 2024-04-01 → 2026-08-28 is 880 days. One D−1 12Z run per target day, all
    // centroids batched into a single request, is 880 HTTP requests — ~2.6 h
    // serial, ~30 min at 3-way concurrency.
    const days = targetDays("2024-04-01", "2026-08-28").length;
    expect(days).toBe(880);
    const single = callBudget({ days, cycles: 1, centroids: 20 });
    expect(single.requests).toBe(880);
    // Pessimistically counting each location separately and applying the
    // >10-variable multiplier: ~21,000 units, three days of the free tier's
    // 10,000/day or 2% of a Professional month.
    expect(single.weightedUnits).toBe(21_120);
    // Both cycles doubles it, which is still 2 requests a day thereafter.
    expect(callBudget({ days, cycles: 2, centroids: 20 }).requests).toBe(1760);
  });
});

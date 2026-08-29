import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createForecastRoutes, toForecastDayAhead } from "../src/api/forecast.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { gateAt } from "../src/forecast/gate.js";
import { parsePublication } from "../src/forecast/publication.js";
import type { PublishedForecast } from "../src/forecast/reads.js";

/**
 * The day-ahead route, without a database.
 *
 * What is provable here is everything that is not a row: the refusals, the
 * shaping, the gate arithmetic that separates "not published yet" from "the
 * publication failed", and the structural properties — no crossing to the
 * modelling service, no day figure reduced from the hours, no origin kind a
 * parameter can widen. The round trip through `AsOf` is
 * `database-forecast.test.ts`, which needs real Postgres and says so.
 */

const SOURCE = (path: string): string =>
  readFileSync(join(import.meta.dir, "..", "src", path), "utf8");

/** The `import` lines of a module, so a structural test reads code and not prose. */
const importsOf = (source: string): string[] =>
  source.split("\n").filter((line) => line.startsWith("import "));

/** The rows of a payload array, so a mutation reads without a non-null assertion. */
const rowsOf = (value: unknown): Record<string, unknown>[] =>
  value as Record<string, unknown>[];

const NOW = new Date("2026-08-28T18:00:00.000Z");

/**
 * A route with no database — every refusal below is reachable without one.
 *
 * Mounted behind `errorHandler`, because the envelope is what a client sees: a
 * `CodedError` that never reached the handler would be a 500 with no code, and
 * the code is the only field a client is allowed to branch on.
 */
const routes = new Elysia()
  .use(errorHandler)
  .use(createForecastRoutes({ db: undefined, now: () => NOW }));

const get = (query: string): Promise<Response> =>
  routes.handle(new Request(`http://localhost/v1/forecast/day-ahead${query}`));

const body = async (response: Response): Promise<{ error: { code: string } }> =>
  (await response.json()) as { error: { code: string } };

/**
 * One published day, as `readForecastDayAhead` would return it.
 *
 * The day figures are deliberately **not** consistent with any sum of the
 * hours: the day band's P90 is below the summed hourly P90 and its P50 is above
 * it, which is a shape no componentwise reduction of these hours can produce.
 * A shaping bug that reached for the hours would have to change these numbers
 * to pass, which is the point of choosing them.
 */
function published(): PublishedForecast {
  const hours = Array.from({ length: 24 }, (_value, hour) => ({
    validTime: new Date(Date.UTC(2026, 7, 29, 3 + hour)),
    localHour: hour,
    band: { p10: 0, p50: hour === 14 ? 40 : 0, p90: hour === 14 ? 120 : 10 },
    expectedMwh: hour === 14 ? 30 : 2,
    occurrenceProbability: hour === 14 ? 0.72 : 0.08,
    split: {
      windMwh: hour === 14 ? 24 : 1.6,
      solarMwh: hour === 14 ? 6 : 0.4,
    },
    p50Split: { windMwh: hour === 14 ? 32 : 0, solarMwh: hour === 14 ? 8 : 0 },
  }));
  return {
    day: {
      subsystem: "NE",
      targetDate: "2026-08-29",
      gateProfile: "gate_late",
      thresholdMw: 5,
      artifactId: "2026-08-28T03:11:07Z",
      featureSet: "dessem_free_v1",
      trainedThrough: "2026-06-30",
      correctionRegime: "conformal_v1_partial_upper",
      publishedAt: new Date("2026-08-28T22:00:00.000Z"),
      ingestedAt: new Date("2026-08-28T22:10:00.000Z"),
      dataVersion: 1,
      dayTotalMwh: { p10: 12, p50: 260, p90: 300 },
      peakPowerMw: { p10: 4, p50: 96, p90: 180 },
      dayOccurrenceProbability: 0.89,
      dayExpectedMwh: 76,
      split: { windMwh: 60.8, solarMwh: 15.2 },
      hoursP50Nonzero: 1,
      derivation: "path_ensemble",
      riskBinElevatedFrom: 0.25,
      riskBinHighFrom: 0.6,
    },
    hours,
    vintageFidelity: "point_in_time",
  };
}

describe("the day-ahead route refuses rather than inventing", () => {
  it("refuses a subsystem ONS does not publish, before touching anything", async () => {
    const response = await get("?subsystem=SIN");
    expect(response.status).toBe(422);
    expect((await body(response)).error.code).toBe("SUBSYSTEM_UNKNOWN");
  });

  it("refuses a gate profile that is not published", async () => {
    const response = await get("?subsystem=NE&gate_profile=gate_middle");
    expect(response.status).toBe(422);
    expect((await body(response)).error.code).toBe("GATE_PROFILE_UNKNOWN");
  });

  it("refuses a target date beyond tomorrow and one before the window", async () => {
    for (const date of ["2026-09-30", "2023-01-01", "not-a-date"]) {
      const response = await get(`?subsystem=NE&target_date=${date}`);
      expect(response.status).toBe(422);
      expect((await body(response)).error.code).toBe("TARGET_DATE_OUT_OF_RANGE");
    }
  });

  it("answers DATA_UNAVAILABLE when there is no database, not an empty band", async () => {
    const response = await get("?subsystem=NE");
    expect(response.status).toBe(503);
    const answered = await body(response);
    expect(answered.error.code).toBe("DATA_UNAVAILABLE");
    expect(JSON.stringify(answered)).not.toContain("p10");
  });

  it("has no technology parameter", () => {
    expect(SOURCE("api/forecast.ts")).not.toContain("query.technology");
  });
});

describe("the gate decides which refusal a caller gets", () => {
  it("puts the late gate at D−1 19:00 Brasília, as the SQL function does", () => {
    // `drizzle/0016_the_feature_gate.sql`: D−1 19:00 America/Sao_Paulo, which
    // is 22:00Z while Brazil observes no summer time.
    expect(gateAt("2026-08-29", "gate_late").toISOString()).toBe(
      "2026-08-28T22:00:00.000Z",
    );
    expect(gateAt("2026-08-29", "gate_early").toISOString()).toBe(
      "2026-08-28T12:00:00.000Z",
    );
  });

  it("is strictly ordered: the early gate of a day precedes its late gate", () => {
    expect(gateAt("2026-08-29", "gate_early").getTime()).toBeLessThan(
      gateAt("2026-08-29", "gate_late").getTime(),
    );
  });
});

describe("the response shape", () => {
  const shaped = toForecastDayAhead(published(), new Date("2026-08-29T00:00:00.000Z"));

  it("reads the day figures from the day row and never from the hours", () => {
    const summed = shaped.hours.reduce(
      (total, hour) => ({
        p10: total.p10 + hour.constrainedOffMwh.p10,
        p50: total.p50 + hour.constrainedOffMwh.p50,
        p90: total.p90 + hour.constrainedOffMwh.p90,
      }),
      { p10: 0, p50: 0, p90: 0 },
    );
    expect(shaped.dayEnergyMwh).toEqual({ p10: 12, p50: 260, p90: 300 });
    expect(shaped.dayEnergyMwh.p90).not.toBe(summed.p90);
    expect(shaped.dayEnergyMwh.p50).not.toBe(summed.p50);
    // The peak is a band of the drawn maxima, not the largest hourly P90.
    expect(shaped.peakPowerMw.p90).not.toBe(
      Math.max(...shaped.hours.map((hour) => hour.constrainedOffMwh.p90)),
    );
  });

  it("keeps the expectation a sibling of the band at both grains", () => {
    expect(shaped.dayExpectedMwh).toBe(76);
    expect(Object.keys(shaped.dayEnergyMwh)).toEqual(["p10", "p50", "p90"]);
    for (const hour of shaped.hours) {
      expect(Object.keys(hour.constrainedOffMwh)).toEqual(["p10", "p50", "p90"]);
      expect(hour).toHaveProperty("expectedMwh");
    }
  });

  it("splits the expectation into two scalars, with no quantile anywhere in it", () => {
    expect(shaped.split.windMwh + shaped.split.solarMwh).toBeCloseTo(
      shaped.dayExpectedMwh,
      6,
    );
    for (const hour of shaped.hours) {
      expect(Object.keys(hour.split).sort()).toEqual(["solarMwh", "windMwh"]);
      expect(hour.split.windMwh + hour.split.solarMwh).toBeCloseTo(hour.expectedMwh, 6);
    }
  });

  it("is monotone in every hour", () => {
    for (const hour of shaped.hours) {
      expect(hour.constrainedOffMwh.p10).toBeLessThanOrEqual(hour.constrainedOffMwh.p50);
      expect(hour.constrainedOffMwh.p50).toBeLessThanOrEqual(hour.constrainedOffMwh.p90);
    }
  });

  it("names its artifact, its origin, its threshold and its gate profile", () => {
    expect(shaped.artifact.artifactId).toBe("2026-08-28T03:11:07Z");
    expect(shaped.forecastOrigin).toMatchObject({
      producer: "wattsteer",
      runLabel: "2026-08-28T03:11:07Z",
      originKind: "served",
      gateProfile: "gate_late",
      publishedAt: "2026-08-28T22:00:00.000Z",
    });
    expect(shaped.thresholdMw).toBe(5);
    expect(shaped.vintageFidelity).toBe("point_in_time");
  });

  it("derives age_hours rather than making a screen difference two clocks", () => {
    expect(shaped.forecastOrigin.ageHours).toBe(2);
  });

  it("reads the risk class off the published edges", () => {
    expect(shaped.riskBins).toEqual({
      low: [0, 0.25],
      elevated: [0.25, 0.6],
      high: [0.6, 1],
    });
    expect(shaped.riskClass).toBe("high");
    const quiet = published();
    quiet.day.dayOccurrenceProbability = 0.3;
    expect(toForecastDayAhead(quiet, NOW).riskClass).toBe("elevated");
    quiet.day.dayOccurrenceProbability = 0.1;
    expect(toForecastDayAhead(quiet, NOW).riskClass).toBe("low");
  });
});

describe("the publication payload is parsed, never assumed", () => {
  const payload = (): Record<string, unknown> => ({
    lane: "dessem_free_v1__gate_late__thr5",
    feature_set: "dessem_free_v1",
    threshold_mw: 5,
    target_date: "2026-08-29",
    correction_regime: "conformal_v1_partial_upper",
    forecast_origin: {
      producer: "wattsteer",
      run_label: "2026-08-28T03:11:07Z",
      published_at: "2026-08-28T22:00:00Z",
      origin_kind: "served",
      gate_profile: "gate_late",
    },
    artifact: {
      artifact_id: "2026-08-28T03:11:07Z",
      feature_set: "dessem_free_v1",
      trained_through: "2026-06-30",
    },
    risk_bins: { low: [0, 0.25], elevated: [0.25, 0.6], high: [0.6, 1] },
    hours: [
      {
        subsystem: "NE",
        valid_time: "2026-08-29T03:00:00Z",
        target_date: "2026-08-29",
        local_hour: 0,
        threshold_mw: 5,
        occurrence_probability: 0.1,
        p10_mwh: 0,
        p50_mwh: 0,
        p90_mwh: 8,
        expected_mwh: 2,
        p50_wind_mwh: 0,
        p50_solar_mwh: 0,
        expected_wind_mwh: 1.6,
        expected_solar_mwh: 0.4,
        crossed: false,
        derivation: "hurdle_mixture",
        correction_regime: "conformal_v1_partial_upper",
      },
    ],
    days: [
      {
        subsystem: "NE",
        target_date: "2026-08-29",
        threshold_mw: 5,
        day_total: { p10: 12, p50: 260, p90: 300 },
        peak_power: { p10: 4, p50: 96, p90: 180 },
        day_occurrence_probability: 0.89,
        expected_mwh: 76,
        expected_wind_mwh: 60.8,
        expected_solar_mwh: 15.2,
        hours_p50_nonzero: 1,
        derivation: "path_ensemble",
        ensemble_draws: 500,
        ensemble_seed: 20_260_828,
        ensemble_calibration_days: 90,
        correction_regime: "conformal_v1_partial_upper",
      },
    ],
  });

  it("accepts the modelling service's own shape", () => {
    const parsed = parsePublication(payload());
    expect(parsed.artifactId).toBe("2026-08-28T03:11:07Z");
    expect(parsed.publishedAt.toISOString()).toBe("2026-08-28T22:00:00.000Z");
    expect(parsed.correctionRegime).toBe("conformal_v1_partial_upper");
    expect(parsed.days[0]?.dayTotal.p50).toBe(260);
    expect(parsed.riskBinElevatedFrom).toBe(0.25);
  });

  it("refuses a day figure that was not drawn from the path ensemble", () => {
    const summed = payload();
    const [day] = rowsOf(summed.days);
    Object.assign(day ?? {}, { derivation: "sum_of_hourly_band" });
    expect(() => parsePublication(summed)).toThrow(/path_ensemble/);
  });

  it("refuses a publication with no day rows rather than storing hours alone", () => {
    const hoursOnly = payload();
    hoursOnly.days = [];
    expect(() => parsePublication(hoursOnly)).toThrow(/day/);
  });

  it("refuses a band that is not monotone", () => {
    const crossed = payload();
    const [day] = rowsOf(crossed.days);
    Object.assign(day ?? {}, { day_total: { p10: 300, p50: 260, p90: 12 } });
    expect(() => parsePublication(crossed)).toThrow(/monotone/);
  });

  it("refuses a producer that does not produce WattSteer forecasts", () => {
    const wrong = payload();
    (wrong.forecast_origin as Record<string, unknown>).producer = "open_meteo";
    expect(() => parsePublication(wrong)).toThrow(/wattsteer/);
  });

  it("defaults nothing: a missing figure is a refusal, never a zero", () => {
    const short = payload();
    const [day] = rowsOf(short.days);
    // The absence is what is under test: a field that is not there must be a
    // refusal and never a zero.
    Object.assign(day ?? {}, { expected_mwh: undefined });
    expect(() => parsePublication(short)).toThrow(/expected_mwh/);
  });
});

describe("the cross-language vector", () => {
  /**
   * `test/fixtures/forecast/publication.json` is a real payload, produced by
   * `wattsteer_ml.publication.build_publication` on the modelling side's own
   * shared fit and checked in. It is the seam between two languages that no
   * type system spans: the gateway parses what Python emits, and the two
   * spellings drift the moment nothing reads both.
   *
   * `apps/ml/tests/test_publication.py` asserts the other direction — that the
   * payload the code emits still has exactly this file's keys — so a field
   * renamed on either side fails on that side rather than in production.
   */
  const vector = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures", "forecast", "publication.json"),
      "utf8",
    ),
  ) as unknown;

  it("is accepted by the gateway's parser, whole", () => {
    const parsed = parsePublication(vector);
    expect(parsed.hours.length).toBe(96);
    expect(parsed.days.length).toBe(4);
    expect(parsed.correctionRegime).toBe("conformal_v1_partial_upper");
    expect(parsed.publishedAt.getTime()).toBeLessThan(
      parsed.hours[0]?.validTime.getTime() as number,
    );
  });

  it("carries a day figure the hours cannot produce", () => {
    const parsed = parsePublication(vector);
    for (const day of parsed.days) {
      const hours = parsed.hours.filter((hour) => hour.subsystem === day.subsystem);
      expect(hours.length).toBe(24);
      const summed = hours.reduce((total, hour) => total + hour.p90Mwh, 0);
      expect(day.dayTotal.p90).not.toBe(summed);
      expect(day.derivation).toBe("path_ensemble");
    }
  });

  it("splits the expectation into two scalars that add back to it", () => {
    const parsed = parsePublication(vector);
    for (const day of parsed.days) {
      expect(day.expectedWindMwh + day.expectedSolarMwh).toBeCloseTo(day.expectedMwh, 6);
    }
    for (const hour of parsed.hours) {
      expect(hour.expectedWindMwh + hour.expectedSolarMwh).toBeCloseTo(
        hour.expectedMwh,
        6,
      );
      expect(hour.p10Mwh).toBeLessThanOrEqual(hour.p50Mwh);
      expect(hour.p50Mwh).toBeLessThanOrEqual(hour.p90Mwh);
    }
  });
});

describe("the boundary, asserted structurally", () => {
  it("does not call the modelling service for a forecast", () => {
    // The *imports*, not the prose: the route's own docstring says the words
    // "ml-proxy" while arguing that it must never import it.
    for (const module of ["api/forecast.ts", "forecast/reads.ts"]) {
      expect(importsOf(SOURCE(module)).some((line) => line.includes("ml-proxy"))).toBe(
        false,
      );
    }
    const route = SOURCE("api/forecast.ts");
    expect(route).not.toContain("callMl(");
    expect(route).not.toContain("postMl(");
  });

  it("filters origin_kind = served in the query, not in a branch", () => {
    const reads = SOURCE("forecast/reads.ts");
    const filters = reads.match(/origin_kind = 'served'::forecast_origin_kind/g) ?? [];
    // Once per read: the day row, the hour rows, and the meta listing.
    expect(filters.length).toBe(3);
    // No parameter reaches it — a widened filter is what would let a
    // `backfilled_holdout` row out of this route.
    expect(reads).not.toContain("query.originKind");
    expect(reads).not.toContain("originKind:");
  });

  it("has no aggregate that could reduce the hourly band into a day figure", () => {
    const reads = SOURCE("forecast/reads.ts");
    const forbidden = /(sum|avg|max|min)\s*\(\s*(p10|p50|p90|expected)/i;
    expect(forbidden.test(reads)).toBe(false);
    expect(SOURCE("api/forecast.ts")).not.toContain("reduce(");
  });

  it("keeps the publication write out of the request path", () => {
    // The route imports the read and nothing that writes.
    const route = SOURCE("api/forecast.ts");
    expect(route).not.toContain("writePublication");
    expect(route).not.toContain("publishForecast");
  });
});

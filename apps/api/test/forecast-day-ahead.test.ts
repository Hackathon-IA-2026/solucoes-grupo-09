import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_FORECAST_STATES } from "@wattsteer/core/errors";
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

/**
 * A module with its comments stripped.
 *
 * Several claims below are about what a module *does*, and every one of these
 * modules argues its own case in prose that necessarily quotes the thing it
 * refuses to do — `forecast.ts` explains why it cannot answer
 * `MODEL_UNAVAILABLE`, `ml-proxy.ts` explains the route it no longer carries.
 * A `toContain` over the whole file would read the argument and call it the
 * defect.
 */
const codeOf = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

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

  /** The national block the modelling service emits beside `days`. */
  const national = (): Record<string, unknown> => ({
    target_date: "2026-08-29",
    grain: "national",
    threshold_mw: 5,
    day_total: { p10: 220, p50: 340, p90: 470 },
    peak_power: { p10: 40, p50: 88, p90: 150 },
    day_occurrence_probability: 0.93,
    expected_mwh: 310,
    subsystems: ["N", "NE", "SE", "S"],
    ensemble_draws: 500,
    ensemble_seed: 20_260_828,
    ensemble_calibration_days: 90,
    derivation: "joint_path_ensemble",
    correction_regime: "conformal_v1_partial_upper",
  });

  /** A publication carrying all four day rows, so a national block is legal. */
  const wholeGrid = (): Record<string, unknown> => {
    const whole = payload();
    const [day] = rowsOf(whole.days);
    whole.days = ["N", "NE", "SE", "S"].map((subsystem) => ({
      ...(day as Record<string, unknown>),
      subsystem,
    }));
    whole.national = national();
    return whole;
  };

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

  it("accepts a publication with no national block, and defaults nothing", () => {
    // A three-subsystem publication has no national figure — a total over
    // three is a different quantity — and `undefined` is that absence rather
    // than a zero the route would render as a band.
    expect(parsePublication(payload()).national).toBeUndefined();
    const nulled = payload();
    nulled.national = null;
    expect(parsePublication(nulled).national).toBeUndefined();
  });

  it("accepts the national block when the four day rows are there", () => {
    const parsed = parsePublication(wholeGrid());
    expect(parsed.national?.dayTotal).toEqual({ p10: 220, p50: 340, p90: 470 });
    expect(parsed.national?.derivation).toBe("joint_path_ensemble");
    expect(parsed.national?.subsystems).toEqual(["N", "NE", "SE", "S"]);
  });

  it("refuses a national figure that was not drawn from the shared index", () => {
    // The refusal `days` gets for `sum_of_hourly_band`, at the grain above it.
    // `path_ensemble` is refused too: that names a draw over one subsystem's
    // whole days, and a national band standing on one is a sum of quantiles
    // wearing a legitimate derivation's name.
    for (const derivation of ["sum_of_subsystem_bands", "path_ensemble"]) {
      const summed = wholeGrid();
      Object.assign(summed.national as Record<string, unknown>, { derivation });
      expect(() => parsePublication(summed)).toThrow(/joint_path_ensemble/);
    }
  });

  it("refuses a national figure that does not cover the four subsystems", () => {
    const partial = wholeGrid();
    Object.assign(partial.national as Record<string, unknown>, {
      subsystems: ["N", "NE", "SE"],
    });
    expect(() => parsePublication(partial)).toThrow(/national/);
  });

  it("refuses SIN as a member of the national figure's coverage", () => {
    const sin = wholeGrid();
    Object.assign(sin.national as Record<string, unknown>, {
      subsystems: ["SIN", "NE", "SE", "S"],
    });
    expect(() => parsePublication(sin)).toThrow(/SIN/);
  });

  it("refuses a national band that is not monotone", () => {
    const crossed = wholeGrid();
    Object.assign(crossed.national as Record<string, unknown>, {
      day_total: { p10: 470, p50: 340, p90: 220 },
    });
    expect(() => parsePublication(crossed)).toThrow(/monotone/);
  });

  it("refuses a national figure whose components are not in the publication", () => {
    // The national row and the four subsystem rows are one transaction. A band
    // summed over four subsystems, three of which the publication carries no
    // day row for, is a figure whose components are not in the table.
    const orphan = payload();
    orphan.national = national();
    expect(() => parsePublication(orphan)).toThrow(/one transaction/);
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

  it("carries a national figure narrower than the four bands added", () => {
    const parsed = parsePublication(vector);
    const national = parsed.national;
    if (national === undefined) {
      throw new Error("the checked-in vector covers all four subsystems");
    }
    expect(national.derivation).toBe("joint_path_ensemble");
    expect(national.subsystems.sort()).toEqual(["N", "NE", "S", "SE"]);
    const summed = parsed.days.reduce(
      (band, day) => ({
        p10: band.p10 + day.dayTotal.p10,
        p90: band.p90 + day.dayTotal.p90,
      }),
      { p10: 0, p90: 0 },
    );
    // Measured on the modelling side's own seeded fit: roughly half the width.
    expect(national.dayTotal.p10).toBeGreaterThan(summed.p10);
    expect(national.dayTotal.p90).toBeLessThan(summed.p90);
    // And the peak is a peak of the sum, so it is below the sum of the peaks.
    const summedPeaks = parsed.days.reduce((total, day) => total + day.peakPower.p90, 0);
    expect(national.peakPower.p90).toBeLessThan(summedPeaks);
    // The expectation is the one national quantity that does add exactly.
    const summedExpectations = parsed.days.reduce(
      (total, day) => total + day.expectedMwh,
      0,
    );
    expect(national.expectedMwh).toBeCloseTo(summedExpectations, 6);
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
    // Once per read: the day row, the hour rows, the meta listing, and the two
    // reads `/v1/grid/outlook` is — the four subsystem rows and the national
    // row beside them.
    expect(filters.length).toBe(5);
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

describe("the provisional proxy route is gone", () => {
  it("leaves no unversioned forecast route on the gateway", () => {
    // The public surface is `/v1/forecast/day-ahead`, from Postgres. The
    // stopgap it replaced was `GET /forecast/day-ahead` — unversioned, against
    // a modelling service whose own path *was* versioned, which is exactly
    // backwards: the public surface is the one that needs the version.
    //
    // Asserted on the code and not the prose, as the boundary test above is:
    // the module's comment now explains the deletion, so it necessarily says
    // the words. Prose is where the argument lives; code is where the route
    // would have to be.
    const proxy = codeOf(SOURCE("api/ml-proxy.ts"));
    expect(proxy).not.toContain("/forecast/day-ahead");
    expect(proxy).not.toContain("new Elysia(");
    expect(proxy).not.toContain("mlProxy");
  });

  it("keeps the module, its six failure branches and the two calls that share them", () => {
    // The deletion is a route, not a module. `callMl` and `postMl` are the
    // gateway's edge onto the solver, and `mapUpstreamFailure` is the reason
    // the module deserves to exist: an ML outage must not be filed as a
    // WattSteer bug. `ml-proxy.test.ts` asserts each branch's status and code.
    const proxy = SOURCE("api/ml-proxy.ts");
    for (const survivor of [
      "export async function callMl",
      "export async function postMl",
      "export async function mapUpstreamFailure",
      "export interface MlEndpoint",
    ]) {
      expect(proxy).toContain(survivor);
    }
    for (const code of [
      "OPTIMIZER_NOT_CONFIGURED",
      "OPTIMIZER_UNAVAILABLE",
      "OPTIMIZER_TIMEOUT",
      "OPTIMIZER_NOT_READY",
      "UPSTREAM_REJECTED",
      "UPSTREAM_FAILED",
    ]) {
      expect(proxy).toContain(code);
    }
  });

  it("is not mounted, and the importers that remain want the calls, not a route", () => {
    const index = SOURCE("api/index.ts");
    expect(index).not.toContain("mlProxy");
    // The three modules that still cross the boundary do so for a solve, for
    // self-description, and for a publication — never for a page view.
    for (const module of ["api/optimize.ts", "api/meta.ts", "forecast/publish.ts"]) {
      const line = importsOf(SOURCE(module)).find((entry) => entry.includes("ml-proxy"));
      expect(line).toBeDefined();
      expect(line).not.toContain("mlProxy");
    }
  });
});

describe("the four absence states stay four different sentences", () => {
  it("is four states in the shared table, and stale is the 200 among them", () => {
    expect(NO_FORECAST_STATES.length).toBe(4);
    const stale = NO_FORECAST_STATES.find((entry) => entry.state === "stale");
    // The one that is not an error: rows from an earlier gate are a real
    // forecast, and refusing them would be the same lie in the other direction.
    expect(stale?.status).toBe(200);
    expect(stale?.code).toBeNull();
    // No two of the four agree on both the status and the code — a pair shared
    // by two states is the defect this table exists to prevent.
    const pairs = NO_FORECAST_STATES.map((entry) => `${entry.status}:${entry.code}`);
    expect(new Set(pairs).size).toBe(4);
  });

  it("builds 'the gate has not passed' from the schedule, not from a literal", () => {
    // The state itself needs rows to be *absent from a database that exists*,
    // so the live 404 is `database-forecast.test.ts`; what is provable without
    // one is that the instant a screen renders is computed. The sentence — the
    // Overview's "tomorrow's view publishes at 19:00 BRT" — is data, and the
    // datum is `publishes_at`, which the handler fills from `gateAt` rather
    // than from a hardcoded time.
    const route = codeOf(SOURCE("api/forecast.ts"));
    expect(route).toContain("FORECAST_NOT_YET_PUBLISHED");
    expect(route).toContain("publishes_at: gate.toISOString()");
    expect(route).toContain("gateAt(targetDate, gateProfile)");
    // `gateAt` is the schedule's, and it agrees with the SQL the publication
    // jobs run — asserted above against `drizzle/0016_the_feature_gate.sql`.
    expect(gateAt("2026-08-29", "gate_late").toISOString()).toBe(
      "2026-08-28T22:00:00.000Z",
    );
  });

  it("says 'the database is down' with the generic code, and only there", async () => {
    // The only one of the four that gets a generic message, and the only one
    // carrying a `Retry-After`.
    const response = await get("?subsystem=NE");
    expect(response.status).toBe(503);
    expect((await body(response)).error.code).toBe("DATA_UNAVAILABLE");
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("does not answer MODEL_UNAVAILABLE, and points at the surface that can", () => {
    // Honest rather than convenient. Which lane state holds is a fact about the
    // artifact volume, mounted into the modelling service; this route reaching
    // for it per request is the boundary crossing the spec closed — and that
    // crossing is what made the old proxy route a liability. So with the gate
    // passed and no rows it answers `FORECAST_UNAVAILABLE` — "the gate passed
    // and no rows exist — a publication failure" — which is true whether the
    // publication failed because nothing was promoted or because the job never
    // ran, and it names `/v1/meta`, which carries `model.lanes[].state`.
    const route = codeOf(SOURCE("api/forecast.ts"));
    expect(route).not.toContain("MODEL_UNAVAILABLE");
    expect(route).toContain("FORECAST_UNAVAILABLE");
    // The pointer is in the message a client renders, not only in a comment.
    expect(route).toContain("/v1/meta");
    // And `/v1/meta` really does carry the lane states, so the pointer resolves.
    expect(codeOf(SOURCE("api/meta.ts"))).toContain("LANE_STATES");
  });

  it("never zero-fills: no refusal carries a band, and none is a spinner", async () => {
    for (const query of [
      "?subsystem=NE", // no database
      "?subsystem=NE&target_date=2026-08-29", // an explicit day, still no database
      "?subsystem=SIN", // not one of the four subsystems
      "?subsystem=NE&gate_profile=gate_middle", // not a published gate
    ]) {
      const text = await (await get(query)).text();
      for (const field of ["p10", "p50", "p90", "hours", "expected_mwh"]) {
        expect(text).not.toContain(field);
      }
    }
  });
});

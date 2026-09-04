import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBSYSTEMS } from "@wattsteer/core/constants";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia } from "elysia";
import { createGridRoutes, toGridOutlook } from "../src/api/grid.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import type { ForecastDayRow } from "../src/forecast/reads.js";

/**
 * `/v1/grid/outlook`, without a database.
 *
 * What is provable here is everything that is not a row: the refusals, the
 * shaping, and — the reason this ticket exists — that the national figure is
 * **not** a componentwise sum of the four subsystem medians. The round trip
 * through `AsOf` and the origin-kind filter are `database-grid-outlook.test.ts`,
 * which needs real Postgres and says so.
 */

const SOURCE = (path: string): string =>
  readFileSync(join(import.meta.dir, "..", "src", path), "utf8");

const NOW = new Date("2026-08-28T23:00:00.000Z");

const routes = new Elysia()
  .use(errorHandler)
  .use(createGridRoutes({ db: undefined, now: () => NOW }));

const get = (query: string): Promise<Response> =>
  routes.handle(new Request(`http://localhost/v1/grid/outlook${query}`));

const body = async (response: Response): Promise<{ error: { code: string } }> =>
  (await response.json()) as { error: { code: string } };

/**
 * Four published day rows, one per subsystem.
 *
 * The occurrence probabilities are chosen to land one subsystem in each of
 * `high` and `elevated` and two in `low`, so `risk_class_counts` is a real
 * count rather than a constant that would pass whatever the classifier did.
 *
 * The magnitudes matter more: `dayExpectedMwh` is deliberately **not** equal to
 * `dayTotalMwh.p50` on any row — for a mixture the expectation exceeds the
 * median whenever `p < 0.5` and falls below it otherwise — so a national figure
 * that had been built from the medians would come out at a different number.
 */
function rows(): ForecastDayRow[] {
  const base = {
    targetDate: "2026-08-29",
    gateProfile: "gate_late" as const,
    thresholdMw: 5,
    artifactId: "2026-08-28T03:11:07Z",
    featureSet: "dessem_free_v1",
    trainedThrough: "2026-06-30",
    correctionRegime: "conformal_v1_partial_upper",
    publishedAt: new Date("2026-08-28T22:00:00.000Z"),
    ingestedAt: new Date("2026-08-28T22:10:00.000Z"),
    derivation: "path_ensemble",
    riskBinElevatedFrom: 0.25,
    riskBinHighFrom: 0.6,
    hoursP50Nonzero: 9,
  };
  return [
    {
      ...base,
      subsystem: "NE" as const,
      dataVersion: 1,
      dayTotalMwh: { p10: 1720, p50: 2780, p90: 4260 },
      peakPowerMw: { p10: 118, p50: 186, p90: 271 },
      dayOccurrenceProbability: 0.89,
      dayExpectedMwh: 2960,
      split: { windMwh: 2410, solarMwh: 550 },
    },
    {
      ...base,
      subsystem: "N" as const,
      dataVersion: 3,
      dayTotalMwh: { p10: 0, p50: 140, p90: 610 },
      peakPowerMw: { p10: 0, p50: 18, p90: 74 },
      dayOccurrenceProbability: 0.21,
      dayExpectedMwh: 196,
      split: { windMwh: 171, solarMwh: 25 },
    },
    {
      ...base,
      subsystem: "S" as const,
      dataVersion: 2,
      dayTotalMwh: { p10: 0, p50: 310, p90: 980 },
      peakPowerMw: { p10: 0, p50: 41, p90: 118 },
      dayOccurrenceProbability: 0.44,
      dayExpectedMwh: 402,
      split: { windMwh: 388, solarMwh: 14 },
    },
    {
      ...base,
      subsystem: "SE" as const,
      dataVersion: 1,
      dayTotalMwh: { p10: 0, p50: 520, p90: 1410 },
      peakPowerMw: { p10: 0, p50: 63, p90: 162 },
      dayOccurrenceProbability: 0.18,
      dayExpectedMwh: 760,
      split: { windMwh: 402, solarMwh: 358 },
    },
  ];
}

describe("the outlook route refuses rather than inventing", () => {
  it("refuses a gate profile that is not published", async () => {
    const response = await get("?gate_profile=gate_middle");
    expect(response.status).toBe(422);
    expect((await body(response)).error.code).toBe("GATE_PROFILE_UNKNOWN");
  });

  it("refuses a target date beyond tomorrow and one before the window", async () => {
    for (const date of ["2026-09-30", "2023-01-01", "not-a-date"]) {
      const response = await get(`?target_date=${date}`);
      expect(response.status).toBe(422);
      expect((await body(response)).error.code).toBe("TARGET_DATE_OUT_OF_RANGE");
    }
  });

  it("answers DATA_UNAVAILABLE with no database, and never an empty band", async () => {
    const response = await get("");
    expect(response.status).toBe(503);
    const answered = await body(response);
    expect(answered.error.code).toBe("DATA_UNAVAILABLE");
    expect(JSON.stringify(answered)).not.toContain("p10");
    expect(JSON.stringify(answered)).not.toContain("expected_mwh");
  });

  it("parses the axes before it reaches for the database", async () => {
    // A bad gate profile is a 422 even though there is no database to answer a
    // good one from: the parse happens first, so a caller learns which of the
    // two things is wrong.
    expect((await get("?gate_profile=nope")).status).toBe(422);
  });

  it("takes no subsystem parameter — four subsystems is the whole point", () => {
    expect(SOURCE("api/grid.ts")).not.toContain("query.subsystem");
  });
});

describe("the national figure survives aggregation", () => {
  const shaped = toGridOutlook(rows(), NOW);

  it("is the summed expectation, exactly", () => {
    // 2960 + 196 + 402 + 760. Expectations add with no assumption at all about
    // how the four subsystems move together.
    expect(shaped.national.expectedMwh).toBe(4318);
    const summed = shaped.subsystems.reduce(
      (total, entry) => total + entry.dayExpectedMwh,
      0,
    );
    expect(shaped.national.expectedMwh).toBe(summed);
  });

  it("is NOT the componentwise sum of the four medians", () => {
    // The defect this ticket exists to remove: the hero's old headline summed
    // four P50s. The median of a sum is the sum of the medians only for
    // comonotone components, which is the assumption the rest of the page
    // refuses to make.
    const sumOfMedians = shaped.subsystems.reduce(
      (total, entry) => total + entry.dayEnergyMwh.p50,
      0,
    );
    expect(sumOfMedians).toBe(3750);
    expect(shaped.national.expectedMwh).not.toBe(sumOfMedians);
  });

  it("publishes no national band, and says why", () => {
    expect(shaped.national.band).toBeNull();
    expect(shaped.national.bandUnavailableReason).toBe("no_joint_ensemble");
  });

  it("carries no national quantile under any name", () => {
    const wire = encodeWire("GridOutlook", shaped) as Record<string, unknown>;
    const national = wire.national as Record<string, unknown>;
    expect(Object.keys(national).sort()).toEqual([
      "band",
      "band_unavailable_reason",
      "expected_mwh",
      "risk_class_counts",
    ]);
    // Not even under a different spelling: no key of the national object holds
    // a p10/p50/p90, because none of those three can be added.
    expect(JSON.stringify(national)).not.toContain("p50");
  });

  it("counts subsystems per risk class, which needs no joint distribution", () => {
    expect(shaped.national.riskClassCounts).toEqual({ low: 2, elevated: 1, high: 1 });
    const total =
      shaped.national.riskClassCounts.low +
      shaped.national.riskClassCounts.elevated +
      shaped.national.riskClassCounts.high;
    expect(total).toBe(4);
  });

  it("has no SIN row: the national figure is a key, never a fifth subsystem", () => {
    expect(shaped.subsystems.length).toBe(4);
    expect(shaped.subsystems.map((entry) => entry.subsystem)).not.toContain(
      "SIN" as never,
    );
  });
});

describe("the response shape", () => {
  const shaped = toGridOutlook(rows(), NOW);

  it("carries all four subsystems, in the published order", () => {
    expect(shaped.subsystems.map((entry) => entry.subsystem)).toEqual(
      SUBSYSTEMS.map((entry) => entry.code),
    );
    expect(shaped.subsystems.map((entry) => entry.onsDisplayName)).toEqual(
      SUBSYSTEMS.map((entry) => entry.onsDisplayName),
    );
  });

  it("keeps the two run labels as two fields", () => {
    // The artifact version is what WattSteer ran; the weather run label is what
    // it ran on. The screen renders "D−1 12Z" and must not have to read it out
    // of the artifact id.
    expect(shaped.forecastOrigin.runLabel).toBe("2026-08-28T03:11:07Z");
    expect(shaped.forecastOrigin.weatherRunLabel).toBe("D−1 12Z");
    expect(shaped.forecastOrigin.weatherRunLabel).not.toBe(
      shaped.forecastOrigin.runLabel,
    );
    expect(shaped.forecastOrigin.producer).toBe("wattsteer");
  });

  it("names the early gate's weather run as the early run", () => {
    const early = rows().map((row) => ({ ...row, gateProfile: "gate_early" as const }));
    expect(toGridOutlook(early, NOW).forecastOrigin.weatherRunLabel).toBe("D−1 00Z");
  });

  it("keeps the expectation a sibling of the band, never its centre", () => {
    for (const entry of shaped.subsystems) {
      expect(Object.keys(entry.dayEnergyMwh)).toEqual(["p10", "p50", "p90"]);
      expect(entry.dayExpectedMwh).not.toBe(entry.dayEnergyMwh.p50);
    }
  });

  it("splits the expectation into two scalars that add back to it", () => {
    for (const entry of shaped.subsystems) {
      expect(Object.keys(entry.split).sort()).toEqual(["solarMwh", "windMwh"]);
      expect(entry.split.windMwh + entry.split.solarMwh).toBeCloseTo(
        entry.dayExpectedMwh,
        6,
      );
    }
  });

  it("reads the risk class off the published edges, which travel with it", () => {
    expect(shaped.riskBins).toEqual({
      low: [0, 0.25],
      elevated: [0.25, 0.6],
      high: [0.6, 1],
    });
    const byCode = new Map(
      shaped.subsystems.map((entry) => [entry.subsystem, entry.riskClass]),
    );
    expect(byCode.get("NE")).toBe("high");
    expect(byCode.get("S")).toBe("elevated");
    expect(byCode.get("N")).toBe("low");
    expect(byCode.get("SE")).toBe("low");
  });

  it("names the origin, the threshold, the gate and the vintage fidelity", () => {
    expect(shaped.forecastOrigin.originKind).toBe("served");
    expect(shaped.forecastOrigin.gateProfile).toBe("gate_late");
    expect(shaped.forecastOrigin.publishedAt).toBe("2026-08-28T22:00:00.000Z");
    expect(shaped.thresholdMw).toBe(5);
    expect(shaped.targetDate).toBe("2026-08-29");
    expect(shaped.vintageFidelity).toBe("point_in_time");
  });

  it("derives age_hours rather than making a screen difference two clocks", () => {
    expect(shaped.forecastOrigin.ageHours).toBe(1);
  });

  it("carries no hourly detail and no drivers", () => {
    const wire = encodeWire("GridOutlook", shaped) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual([
      "forecast_origin",
      "national",
      "risk_bins",
      "subsystems",
      "target_date",
      "threshold_mw",
      "vintage_fidelity",
    ]);
    expect(JSON.stringify(wire)).not.toContain("valid_time");
    expect(JSON.stringify(wire)).not.toContain("contribution");
  });
});

describe("the boundary, asserted structurally", () => {
  const route = SOURCE("api/grid.ts");

  it("does not call the modelling service for a forecast", () => {
    const imports = route.split("\n").filter((line) => line.startsWith("import "));
    expect(imports.some((line) => line.includes("ml-proxy"))).toBe(false);
    expect(route).not.toContain("callMl(");
    expect(route).not.toContain("postMl(");
  });

  it("adds expectations and nothing else — no quantile is ever summed", () => {
    // The one reduction in the file is over `dayExpectedMwh`. A reduction that
    // touched p10/p50/p90 is the national band nobody may synthesise.
    const reductions = route.match(/reduce\(\s*\(([^)]*)\)\s*=>\s*([^\n]*)/g) ?? [];
    expect(reductions.length).toBeGreaterThan(0);
    for (const reduction of reductions) {
      expect(/\bp10\b|\bp50\b|\bp90\b/.test(reduction)).toBe(false);
    }
  });

  it("has no aggregate over the subsystems' bands in the read either", () => {
    const reads = SOURCE("forecast/reads.ts");
    expect(/(sum|avg|max|min)\s*\(\s*(p10|p50|p90|expected)/i.test(reads)).toBe(false);
    // Nor a `sum(...)` over any day-grain column: the outlook read selects the
    // four rows and adds nothing, so there is no SQL path to a national band.
    expect(/sum\s*\(/i.test(reads)).toBe(false);
  });

  it("parses its axes with params.ts and not with a third copy", () => {
    expect(route).toContain('from "./params.js"');
    expect(route).not.toContain("GATE_PROFILES");
    expect(route).not.toContain("latestTargetDate(");
  });
});

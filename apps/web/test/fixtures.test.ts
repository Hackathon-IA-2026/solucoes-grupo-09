import { describe, expect, test } from "bun:test";
import { DATA_WINDOW } from "@wattsteer/core";
import { parseAppParams, technologyParam } from "../src/components/app/params";
import {
  buildForecast,
  DEFAULT_LOAD,
  FORECAST_ORIGINS,
  INGESTION_GO_LIVE,
  REPLAY_DAYS,
  RUN_LABELS,
  riskClass,
  roundProbability,
} from "../src/lib/fixtures";

describe("forecast fixtures", () => {
  const forecast = buildForecast("NE", "12Z");

  test("emits 24 hours", () => {
    expect(forecast.hours).toHaveLength(24);
  });

  test("every hour's band is ordered P10 <= P50 <= P90", () => {
    for (const hour of forecast.hours) {
      expect(hour.constrainedOff.p10).toBeLessThanOrEqual(hour.constrainedOff.p50);
      expect(hour.constrainedOff.p50).toBeLessThanOrEqual(hour.constrainedOff.p90);
    }
  });

  test("the day band is not the componentwise sum of the hourly bands", () => {
    // Quantiles do not add — and neither do medians, which is the half of the
    // rule the fixture used to break by setting the day P50 to the sum of the
    // hourly P50s. The day figures are read from the path ensemble, so *no*
    // component of the band may equal its componentwise sum.
    //
    // The inequality is asserted rather than its direction. Under the strong
    // intra-day dependence a path ensemble preserves, the day P90 sits below
    // the sum of the hourly P90s on a busy subsystem and can sit above it on a
    // rare-event one, where almost every hour's own P90 is zero and the whole
    // day either fires together or not at all. Pinning a direction here would
    // pin an assumption about the dependence structure instead of the rule.
    for (const code of ["N", "NE", "SE", "S"] as const) {
      const each = buildForecast(code, "12Z");
      const sum = (key: "p10" | "p50" | "p90") =>
        Math.round(each.hours.reduce((acc, h) => acc + h.constrainedOff[key], 0));
      expect(each.dailyEnergy.p90).not.toBe(sum("p90"));
      // The median is checked only where the componentwise sum is not zero.
      // On the two quiet subsystems every hour is under an even chance, so
      // every hourly median is zero and so is their sum — the two agree at 0
      // because there is nothing to disagree about, not because a median was
      // added, and asserting inequality there would assert noise.
      if (sum("p50") > 0) {
        expect(each.dailyEnergy.p50).not.toBe(sum("p50"));
      }
    }
    // NE is the busy subsystem, so it is where the whole rule has teeth.
    const busy = buildForecast("NE", "12Z");
    const summed = (key: "p10" | "p50" | "p90") =>
      Math.round(busy.hours.reduce((acc, h) => acc + h.constrainedOff[key], 0));
    expect(summed("p50")).toBeGreaterThan(0);
    expect(busy.dailyEnergy).not.toEqual({
      p10: summed("p10"),
      p50: summed("p50"),
      p90: summed("p90"),
    });
  });

  test("the peak-power band is drawn, not the largest hourly band", () => {
    // A day's peak is a property of a *path*: the biggest hour of a drawn day,
    // not the componentwise extreme of 24 marginals. Reducing it from the
    // hours reports the P90 of the worst hour as if the day were certain to
    // contain that hour.
    const hourlyMaxP90 = Math.max(...forecast.hours.map((h) => h.constrainedOff.p90));
    expect(forecast.peakPower.p90).not.toBe(Math.round(hourlyMaxP90));
    expect(forecast.peakPower.p10).toBeLessThanOrEqual(forecast.peakPower.p50);
    expect(forecast.peakPower.p50).toBeLessThanOrEqual(forecast.peakPower.p90);
  });

  test("the forecast carries no technology, and needs none to build", () => {
    // Contract change 5: one object per subsystem-day. A `technology` key here
    // would be claiming a per-technology head the forecaster does not have,
    // and `buildForecast` taking one would let a screen ask for it.
    expect(Object.keys(forecast)).not.toContain("technology");
    expect(forecast.subsystem).toBe("NE");
    expect(buildForecast.length).toBe(2);
  });

  test("the split is two scalars at both grains, and they sum to E[Y]", () => {
    const day = forecast.split;
    expect(Object.keys(day).sort()).toEqual(["solarMwh", "windMwh"]);
    expect(typeof day.windMwh).toBe("number");
    expect(typeof day.solarMwh).toBe("number");
    expect(day.windMwh + day.solarMwh).toBe(forecast.dayExpectedMwh);
    for (const hour of forecast.hours) {
      // `split` is optional on the shape because a *replayed* day's forecast
      // hours carry none — the replay contract has no technology division on
      // them. Every hour a day-ahead forecast builds carries one, and that is
      // what is asserted here.
      const hourly = hour.split;
      expect(hourly).toBeDefined();
      if (hourly === undefined) {
        throw new Error("asserted above");
      }
      expect(Object.keys(hourly).sort()).toEqual(["solarMwh", "windMwh"]);
      expect(hourly.windMwh + hourly.solarMwh).toBeCloseTo(hour.expectedMwh, 6);
    }
  });

  test("the expectation is a sibling of the band, never its centre", () => {
    // For a hurdle mixture the expectation exceeds the median whenever the
    // occurrence probability is below an even chance, so a screen reading the
    // P50 as "the expected figure" under-reports every quiet day — by all of
    // it, where the median is zero.
    expect(forecast.dayExpectedMwh).not.toBe(forecast.dailyEnergy.p50);
    const quiet = buildForecast("S", "12Z");
    expect(quiet.occurrenceProbability).toBeLessThan(0.5);
    expect(quiet.dailyEnergy.p50).toBe(0);
    expect(quiet.dayExpectedMwh).toBeGreaterThan(quiet.dailyEnergy.p50);
    for (const hour of quiet.hours) {
      expect(hour.expectedMwh).toBeGreaterThanOrEqual(hour.constrainedOff.p50);
    }
  });

  test("the 12Z run carries a narrower band than 00Z", () => {
    const early = buildForecast("NE", "00Z");
    const width = (f: typeof forecast) => f.dailyEnergy.p90 - f.dailyEnergy.p10;
    expect(width(forecast)).toBeLessThan(width(early));
  });
});

describe("risk classification", () => {
  test("bins rather than reporting a point probability", () => {
    expect(riskClass(0.08)).toBe("low");
    expect(riskClass(0.31)).toBe("elevated");
    expect(riskClass(0.89)).toBe("high");
  });

  test("probabilities round to the nearest 5 points", () => {
    expect(roundProbability(0.31)).toBe(30);
    expect(roundProbability(0.89)).toBe(90);
  });
});

describe("the replay day catalogue", () => {
  /**
   * What is left of the Time Machine's fixture, and what is deliberately not.
   *
   * The forecast, the settled profile, the integrity statement and every figure
   * on the screen now come from `GET /v1/replay` — `docs/specs/replay.md`
   * requires exactly one implementation of the execution rule in the
   * repository, so a fixture that produced a recovered number would have had
   * to be a second one, and `test/one-execution-rule.test.ts` walks the whole
   * repository to say so. What an endpoint could not supply is the list of days
   * worth opening on, which is what this fixture is now.
   *
   * The contract-level honesty properties those tests used to assert did not
   * go away: they moved to `replay-screen.test.ts`, where they are asserted
   * against the **published** example of the contract rather than against a
   * fixture that could restate it.
   */

  test("the catalogue is dates and nothing else", () => {
    // A verdict here would be a second opinion about the thing the endpoint
    // answers, and the two would eventually disagree with nothing failing.
    for (const day of REPLAY_DAYS) {
      expect(Object.keys(day).sort()).toEqual(["date", "id", "subsystem"]);
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(day.id).toContain(day.date);
    }
  });

  test("the days span the three ranges the window partitions into", () => {
    // Not a restatement of the fold calendar — the boundaries come from the
    // published constants — but the property that matters for a screen: all
    // three of its arms are reachable from the picker, so it cannot be built
    // having only ever seen the flattering one.
    const dates = REPLAY_DAYS.map((day) => day.date);
    const holdoutStart = DATA_WINDOW.firstHoldoutFoldStart;
    // Pre-F1: refused as a replay, rendered observed-only.
    expect(dates.some((date) => date < holdoutStart)).toBe(true);
    // Held out by a frozen fold, and still pre-go-live.
    expect(dates.some((date) => date >= holdoutStart && date < INGESTION_GO_LIVE)).toBe(
      true,
    );
    // Post-go-live: what WattSteer actually published, scored point-in-time.
    expect(dates.some((date) => date >= INGESTION_GO_LIVE)).toBe(true);
  });

  test("the fixture's window dates are the published ones", () => {
    // `/v1/meta` returns it. A fixture that restated it could put the screen a
    // quarter out of step with the API with nothing failing.
    expect(INGESTION_GO_LIVE).toBe(DATA_WINDOW.ingestionGoLive);
  });

  test("every day the picker offers is one a link can address", () => {
    // `parseAppParams` falls back rather than crashing, so a catalogue entry
    // whose id the parser rejects would silently redirect the reader to the
    // first day. Asserted both ways: the ids round-trip, and an unknown one
    // does not.
    for (const day of REPLAY_DAYS) {
      expect(parseAppParams({ episode: day.id }).episode).toBe(day.id);
    }
    expect(parseAppParams({ episode: "1999-01-01-ne" }).episode).toBe(REPLAY_DAYS[0].id);
  });

  test("the forecast origin names two artifacts, in two fields", () => {
    // The defect `docs/specs/api-surface.md` found on the landing hero: the
    // WattSteer run label with the weather run glued onto it as
    // " · weather 12Z". One string cannot be filtered, compared or superseded
    // on either fact, and a screen reading it has no way to say which artifact
    // it is naming.
    for (const run of RUN_LABELS) {
      const origin = FORECAST_ORIGINS[run];
      expect(origin.producer).toBe("wattsteer");
      expect(origin.runLabel).not.toContain("weather");
      expect(origin.weatherRunLabel).toMatch(/^D−1 (00Z|12Z)$/);
    }
    // Both 00Z and 12Z are present, so the weather run is a real field with
    // two values rather than a constant that happens to parse.
    expect(new Set(RUN_LABELS.map((r) => FORECAST_ORIGINS[r].weatherRunLabel)).size).toBe(
      2,
    );
  });
});

describe("URL params", () => {
  test("defaults hold for an empty query", () => {
    const params = parseAppParams({});
    expect(params.subsystem).toBe("NE");
    expect(params.technology).toBe("WIND");
    expect(params.run).toBe("12Z");
  });

  test("a hand-edited URL falls back rather than crashing", () => {
    const params = parseAppParams({ subsystem: "SIN", technology: "hydro", run: "18Z" });
    expect(params.subsystem).toBe("NE");
    expect(params.technology).toBe("WIND");
    expect(params.run).toBe("12Z");
  });

  test("valid values survive", () => {
    const params = parseAppParams({ subsystem: "S", technology: "solar", run: "00Z" });
    expect(params.subsystem).toBe("S");
    expect(params.technology).toBe("SOLAR");
    expect(params.run).toBe("00Z");
  });

  test("the URL keeps its own lowercase spelling of technology", () => {
    // The domain, the database enum and the API all say WIND / SOLAR. A URL
    // reads better lowercase, so params.ts owns the translation — the same
    // shape of boundary as the ONS carga API calling SE "SECO". The transport
    // spelling must never leak inward, and the domain spelling must never
    // appear in a query string.
    expect(parseAppParams({ technology: "wind" }).technology).toBe("WIND");
    expect(technologyParam("SOLAR")).toBe("solar");
    // An uppercase value in the URL is not the transport form. Asserted with
    // SOLAR so the expectation cannot be satisfied by the WIND default.
    expect(parseAppParams({ technology: "SOLAR" }).technology).toBe("WIND");
  });
});

describe("defects the specs found in this prototype", () => {
  /**
   * The replay day band's "joint, never a sum" property is asserted in
   * `replay-screen.test.ts`, against the **published** example of the contract
   * rather than against a fixture. It used to be checked here on a day this
   * module built; the screen now reads `forecast.day_total` off the payload, so
   * the property belongs to the contract and the fixture has no band to check.
   */

  test("the reference flexible load can actually shed what it claims", () => {
    // flex-optimizer.md rejects max_shift_mw above the implied baseline as
    // SHIFT_EXCEEDS_BASELINE — a load cannot shed more than it was drawing.
    const baselineMw = DEFAULT_LOAD.dailyEnergyMwh / 24;
    expect(DEFAULT_LOAD.maxShiftMw).toBeLessThanOrEqual(baselineMw);
  });

  /**
   * The battery that cannot fill on energy it never received used to be
   * asserted here, against the web app's own `evaluatePlan`. There is one
   * implementation of the execution rule now and it is Python's, so the
   * assertion moved to where the rule lives —
   * `apps/ml/tests/test_optimizer_simulator.py`, and to the golden vectors in
   * `packages/core/fixtures/execution-rule/`, one of which — `the-day-that-
   * never-came.json` — is exactly that: a plan built for a median day and
   * executed against a realisation of nothing at all.
   */
});

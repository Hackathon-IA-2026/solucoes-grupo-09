import { describe, expect, it } from "bun:test";
import { config } from "../src/config.js";
import { callBudget, plannedSlots, targetDays } from "../src/ingest/index.js";
import { REFRESH_CADENCE } from "../src/ingest/refresh.js";
import { CENTROIDS } from "../src/ingest/weather/centroids.js";
import { RUN_CYCLES, WEATHER_VARIABLES } from "../src/ingest/weather/single-runs.js";

/**
 * Open-Meteo's published free-tier allowance. A constant here because it is
 * upstream's number, not ours, and the derivation below has to be re-checkable
 * against it rather than against a figure this file chose.
 */
const FREE_TIER_CALLS_PER_DAY = 10_000;

describe("weather · the serving day is fetched before the backfill", () => {
  const days = targetDays("2026-09-09", "2026-09-13");
  const cycles = [...RUN_CYCLES];

  it("plans the newest run first", () => {
    const slots = plannedSlots(days, cycles);
    expect(slots).toHaveLength(days.length * cycles.length);
    const times = slots.map((slot) => slot.scheduled.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // The head of the plan is a run for the last target day, which is the one
    // a forecast for tomorrow needs.
    expect(slots[0]?.day).toBe(days.at(-1) as string);
  });

  /**
   * Non-vacuity, and it is the whole point of the ticket: under the order this
   * replaced, the serving day was *last*, so a sweep that ran out of allowance
   * on the first slot never reached it.
   */
  it("chronological order — what this replaced — puts the serving day last", () => {
    const chronological = [...plannedSlots(days, cycles)].sort(
      (a, b) => a.scheduled.getTime() - b.scheduled.getTime(),
    );
    expect(chronological[0]?.day).toBe(days[0] as string);
    expect(chronological.at(-1)?.day).toBe(days.at(-1) as string);
    expect(chronological[0]?.day).not.toBe(plannedSlots(days, cycles)[0]?.day);
  });

  it("every slot is still planned — the order changed, not the coverage", () => {
    const slots = plannedSlots(days, cycles);
    expect(new Set(slots.map((s) => `${s.day}:${s.cycle}`)).size).toBe(slots.length);
    expect(new Set(slots.map((s) => s.day))).toEqual(new Set(days));
  });
});

describe("weather · the free tier's allowance is counted, not discovered", () => {
  it("the per-invocation ceiling is derived from the published allowance", () => {
    // Hourly sweep (`REFRESH_CADENCE.live`), a third of the allowance, 24 of
    // them in a day. Recomputed rather than asserted as a literal, so moving
    // the cadence moves the bound.
    const [minute, hour] = REFRESH_CADENCE.live.split(" ");
    expect(hour).toBe("*");
    expect(minute).not.toBe("*");
    const sweepsPerDay = 24;
    expect(config.openMeteoMaxWeightedUnits).toBe(
      Math.floor(FREE_TIER_CALLS_PER_DAY / 3 / sweepsPerDay),
    );
  });

  it("the ceiling admits at least one slot, or it could never make progress", () => {
    const perSlot = callBudget({
      days: 1,
      cycles: 1,
      centroids: CENTROIDS.length,
    }).weightedUnits;
    expect(config.openMeteoMaxWeightedUnits).toBeGreaterThanOrEqual(perSlot);
  });

  /**
   * Non-vacuity: the sweep forecaster 37 measured — five target days over both
   * cycles — costs more than the ceiling, so the bound is one that actually
   * binds rather than a number that never fires.
   */
  it("the sweep that exhausted the quota does not fit inside the ceiling", () => {
    const measured = callBudget({
      days: targetDays("2026-09-09", "2026-09-13").length,
      cycles: RUN_CYCLES.length,
      centroids: CENTROIDS.length,
    });
    expect(measured.weightedUnits).toBeGreaterThan(
      config.openMeteoMaxWeightedUnits as number,
    );
  });

  it("twelve variables are billed above the ten-variable threshold", () => {
    expect(WEATHER_VARIABLES.length).toBeGreaterThan(10);
    const weighted = callBudget({ days: 1, cycles: 1, centroids: 10 });
    const unweighted = callBudget({ days: 1, cycles: 1, centroids: 10, variables: 9 });
    expect(weighted.weightedUnits).toBeGreaterThan(unweighted.weightedUnits);
  });
});

describe("a backfill walks its window oldest first", () => {
  // `writeWeatherForecast` never lets a key's publication time go backwards,
  // so the order slots are fetched in decides which runs survive: newest
  // first keeps one run per hour and drops every older vintage the gate would
  // read. The backfill therefore asks for the other order, and the default
  // stays the live sweep's.
  it("puts the oldest scheduled run first and the newest last", () => {
    const days = targetDays("2026-07-01", "2026-07-03");
    const slots = plannedSlots(days, ["00Z", "12Z"], "oldest_first");
    const times = slots.map((slot) => slot.scheduled.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(slots.at(0)?.scheduled.getTime()).toBeLessThan(slots.at(-1)?.scheduled.getTime() ?? 0);
  });

  it("is the exact reverse of the live sweep's order", () => {
    const days = targetDays("2026-07-01", "2026-07-03");
    const newest = plannedSlots(days, ["00Z", "12Z"]);
    const oldest = plannedSlots(days, ["00Z", "12Z"], "oldest_first");
    expect(oldest.map((slot) => slot.scheduled.getTime())).toEqual(
      [...newest].reverse().map((slot) => slot.scheduled.getTime()),
    );
  });
});

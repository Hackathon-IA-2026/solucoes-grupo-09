import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_WINDOW_OPENS_ON, GRID_TIME_ZONE } from "../src/scenario-validation.js";
import { DATA_WINDOW, GATES, localWallClock, nextPublication } from "../src/schedule.js";

/**
 * The gate table is data, and this is what stops it becoming a hardcoded
 * sentence.
 *
 * `docs/specs/api-surface.md` puts the gates on `/v1/meta` so that the
 * Overview's "tomorrow's view publishes at 19:00 BRT" is derived rather than
 * typed. That only helps if the table here is the same table the *feature
 * layer* resolves against, which lives in SQL — `gate_at(target_date,
 * gate_profile)` in `apps/api/drizzle/0016_the_feature_gate.sql`, where it has
 * to live so that no caller can pass a cutoff in. Two spellings of one schedule
 * is the drift this file is here to catch.
 */

const GATE_SQL = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "apps",
  "api",
  "drizzle",
  "0016_the_feature_gate.sql",
);

describe("the gate table and the SQL that resolves it agree", () => {
  const sql = readFileSync(GATE_SQL, "utf8");

  test("both gates, at the hours the migration branches on", () => {
    // The migration writes the hours as integers in a CASE; this file writes
    // them as wall-clock strings. Neither can move without the other.
    for (const gate of GATES) {
      const hour = Number(gate.publishesAtLocal.slice(0, 2));
      expect(sql).toContain(`WHEN '${gate.profile}' THEN ${hour}`);
    }
    expect(GATES.map((gate) => gate.profile).sort()).toEqual(["gate_early", "gate_late"]);
  });

  test("one timezone, and it is the one the migration resolves in", () => {
    expect(sql).toContain(GRID_TIME_ZONE);
    for (const gate of GATES) {
      expect(gate.timezone).toBe(GRID_TIME_ZONE);
    }
  });

  test("the late gate is the one that sees the newer weather run", () => {
    // `gate_late` at D−1 19:00 BRT is 22:00Z, which is after the 12Z run has
    // published; `gate_early` at 09:00 BRT can only have seen 00Z. Stated here
    // because it is the pairing a screen would otherwise get backwards.
    const byProfile = new Map(GATES.map((gate) => [gate.profile, gate]));
    expect(byProfile.get("gate_late")?.weatherRun).toBe("12Z");
    expect(byProfile.get("gate_early")?.weatherRun).toBe("00Z");
  });
});

describe("the window is published rather than restated", () => {
  test("it opens on the same date a scenario is refused before", () => {
    // One constant, referenced. A second spelling of the window's start is a
    // deployment where `/v1/meta` and `TARGET_DATE_OUT_OF_RANGE` disagree.
    expect(DATA_WINDOW.opensOn).toBe(DATA_WINDOW_OPENS_ON);
  });

  test("the three bounds are civil dates in order", () => {
    for (const date of Object.values(DATA_WINDOW)) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // The window opens, then the first out-of-sample fold starts inside it,
    // then WattSteer's own ingestion goes live — which is why everything before
    // that last date is a reconstructed vintage rather than an observed one.
    expect(DATA_WINDOW.opensOn < DATA_WINDOW.firstHoldoutFoldStart).toBe(true);
    expect(DATA_WINDOW.firstHoldoutFoldStart < DATA_WINDOW.ingestionGoLive).toBe(true);
  });
});

describe("the next publication is an instant, not a duration", () => {
  test("19:00 in Brasília is 22:00Z, which is what the gate resolves to", () => {
    expect(localWallClock("2026-08-28", "19:00").toISOString()).toBe(
      "2026-08-28T22:00:00.000Z",
    );
    expect(localWallClock("2026-08-28", "09:00").toISOString()).toBe(
      "2026-08-28T12:00:00.000Z",
    );
  });

  test("the morning gate is next from the middle of the night", () => {
    const next = nextPublication(new Date("2026-08-28T06:00:00Z"));
    expect(next.profile).toBe("gate_early");
    expect(next.at.toISOString()).toBe("2026-08-28T12:00:00.000Z");
  });

  test("the evening gate is next from the middle of the day", () => {
    const next = nextPublication(new Date("2026-08-28T15:00:00Z"));
    expect(next.profile).toBe("gate_late");
    expect(next.at.toISOString()).toBe("2026-08-28T22:00:00.000Z");
  });

  test("after the last gate of a local day it is tomorrow's first", () => {
    // Not "plus fourteen hours": the answer is a different civil date, resolved
    // through the zone rather than by adding an offset to the previous one.
    const next = nextPublication(new Date("2026-08-28T23:00:00Z"));
    expect(next.profile).toBe("gate_early");
    expect(next.at.toISOString()).toBe("2026-08-29T12:00:00.000Z");
  });

  test("at the instant a gate publishes, the next one is the one after", () => {
    // Strictly after. A client that polls on the instant it was handed and is
    // handed the same instant back polls forever.
    const next = nextPublication(new Date("2026-08-28T22:00:00Z"));
    expect(next.at.toISOString()).toBe("2026-08-29T12:00:00.000Z");
  });

  test("it is always ahead of now, at every hour of a day", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const now = new Date(Date.UTC(2026, 7, 28, hour, 30));
      expect(nextPublication(now).at.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

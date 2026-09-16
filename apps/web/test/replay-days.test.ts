import { describe, expect, it } from "bun:test";
import { DATA_WINDOW } from "@wattsteer/core";
import {
  LANDING_SCENARIO,
  stepDetail,
  stepLabel,
} from "../src/components/landing/fixtures";
import { en } from "../src/i18n/copy.en";
import { pt } from "../src/i18n/copy.pt";
import { formattersFor } from "../src/i18n/format";
import { INGESTION_GO_LIVE, REPLAY_DAYS, replayDay } from "../src/lib/fixtures/replay";

/**
 * The Time Machine's day catalogue, and the property its comment claims.
 *
 * The module says what the four days are *for*, and it is not decoration:
 *
 *   "The four days span the three ranges the window partitions into, so the
 *   screen cannot be built having only ever seen one of them."
 *
 * One before the first fold, which the endpoint refuses and the screen renders
 * observed-only; two inside walk-forward folds; one past ingestion go-live,
 * which is the only arm scored point-in-time. Those verdicts belong to the
 * server and are deliberately not restated here — but the **spread** is this
 * fixture's own job, and nothing was checking it.
 *
 * A catalogue that drifted to four days all past go-live would pass every
 * rendering test in the repo while making two of the screen's three arms
 * unreachable. That is the same failure the model-card fixture guards against:
 * a fixture is data until it encodes a finding, and then it is an assertion
 * nobody is checking.
 */

describe("the catalogue spans the ranges the screen has arms for", () => {
  it("has days on both sides of ingestion go-live", () => {
    const before = REPLAY_DAYS.filter((day) => day.date < INGESTION_GO_LIVE);
    const after = REPLAY_DAYS.filter((day) => day.date >= INGESTION_GO_LIVE);
    // Point-in-time scoring exists only after go-live; before it, vintage is
    // unrecoverable and the screen says so instead of scoring.
    expect(after.length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
  });

  it("reaches back before the first holdout fold, where a replay is refused", () => {
    // The observed-only arm. Every artifact was fitted on this block, so the
    // endpoint refuses to replay it — and a catalogue with nothing this old
    // would leave that arm undrawable.
    const trained = REPLAY_DAYS.filter(
      (day) => day.date < DATA_WINDOW.firstHoldoutFoldStart,
    );
    expect(trained.length).toBeGreaterThan(0);
  });

  it("reads the published go-live rather than restating it", () => {
    // A copy here could put the screen a quarter out of step with `/v1/meta`
    // without anything failing.
    expect(INGESTION_GO_LIVE).toBe(DATA_WINDOW.ingestionGoLive);
  });

  it("offers the days in the order it lists them, oldest first", () => {
    const dates = REPLAY_DAYS.map((day) => day.date);
    expect([...dates].sort()).toEqual([...dates]);
  });

  it("every id agrees with the date and subsystem beside it", () => {
    // The id is the URL's `episode` value. An id that disagreed with its own
    // row would make a shared link open a different day than it names.
    for (const day of REPLAY_DAYS) {
      expect(day.id).toBe(`${day.date}-${day.subsystem.toLowerCase()}`);
    }
  });

  it("no two days share an id", () => {
    // `replayDay` resolves by `find`, so a duplicate would silently shadow the
    // second and make one chip unreachable.
    const ids = REPLAY_DAYS.map((day) => day.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a hand-edited episode never throws", () => {
  it("resolves an id it knows", () => {
    const wanted = REPLAY_DAYS[1];
    if (wanted === undefined) {
      throw new Error("the catalogue needs at least two days");
    }
    expect(replayDay(wanted.id)).toBe(wanted);
  });

  it("falls back to the first day for anything it does not", () => {
    /*
      The module's own promise: "Never a throw on a hand-edited URL." The
      `episode` parameter is in the address bar, so the inputs here are the
      real ones — a stale link, a typo, a truncated copy-paste, an empty value.
    */
    for (const id of [
      "",
      "nope",
      "2026-08-11-se",
      "2026-08-11",
      "../../etc/passwd",
      "2026-08-11-ne ",
    ]) {
      expect(replayDay(id)).toBe(REPLAY_DAYS[0]);
    }
  });

  it("the fallback is a real day, not an empty shape", () => {
    // Non-vacuity: `?? REPLAY_DAYS[0]` is only a safe landing if there is a
    // first day to land on, and the screen reads all three fields off it.
    const fallback = replayDay("nope");
    expect(fallback.id.length).toBeGreaterThan(0);
    expect(fallback.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fallback.subsystem.length).toBeGreaterThan(0);
  });
});

describe("every mitigation step has a name in both locales", () => {
  const KEYS = ["no_action", "battery", "battery_and_load"] as const;

  it("resolves all three keys, in both", () => {
    for (const copy of [pt, en]) {
      for (const key of KEYS) {
        expect(stepLabel(copy, key).length).toBeGreaterThan(0);
      }
    }
  });

  it("the three are distinct, so the ladder reads as three steps", () => {
    // Non-vacuity: a `stepLabel` that returned the baseline for everything
    // would satisfy the assertion above and turn the ladder into one repeated
    // row.
    for (const copy of [pt, en]) {
      expect(new Set(KEYS.map((key) => stepLabel(copy, key))).size).toBe(3);
    }
  });

  it("and they differ between locales", () => {
    for (const key of KEYS) {
      expect(stepLabel(pt, key)).not.toBe(stepLabel(en, key));
    }
  });
});

describe("the asset line under a step", () => {
  const f = { pt: formattersFor("pt"), en: formattersFor("en") } as const;

  it("the baseline has none, because it has no assets", () => {
    // `null` rather than an empty string: the caller omits the row, and a blank
    // line under "no action" would read as a missing value rather than none.
    for (const locale of ["pt", "en"] as const) {
      expect(stepDetail(locale === "pt" ? pt : en, f[locale], "no_action")).toBeNull();
    }
  });

  it("names the battery's power, energy and efficiency", () => {
    /*
      Every one of the three is interpolated, and a template that dropped a
      placeholder would still render a plausible sentence. So the assertion is
      that each figure reaches the string, formatted — which is also what
      catches a scenario edited here without the copy following.
    */
    const line = stepDetail(pt, f.pt, "battery");
    expect(line).not.toBeNull();
    expect(line).toContain(f.pt.number(LANDING_SCENARIO.batteryPowerMw));
    expect(line).toContain(f.pt.number(LANDING_SCENARIO.batteryEnergyMwh));
    expect(line).toContain(f.pt.percent(LANDING_SCENARIO.roundTripEfficiency));
    // And no placeholder survived unfilled.
    expect(line).not.toContain("{");
  });

  it("names the load shift and its window", () => {
    const line = stepDetail(en, f.en, "battery_and_load");
    expect(line).not.toBeNull();
    expect(line).toContain(f.en.number(LANDING_SCENARIO.loadShiftMw));
    expect(line).toContain(f.en.number(LANDING_SCENARIO.shiftWindowHours));
    expect(line).not.toContain("{");
  });

  it("the two described steps say different things", () => {
    // Non-vacuity: a `stepDetail` that returned the battery line for both would
    // pass every assertion above.
    expect(stepDetail(pt, f.pt, "battery")).not.toBe(
      stepDetail(pt, f.pt, "battery_and_load"),
    );
  });
});

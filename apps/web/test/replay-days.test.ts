/**
 * The picker's days come from the gateway, and a body it cannot read is a list
 * it states in words rather than a throw.
 *
 * The four hand-written dates in `fixtures/replay.ts` are what the screen lands
 * on; they are no longer the set of ids that exist, so `replayDay` has to
 * round-trip any date the deployment can answer.
 */

import { describe, expect, it } from "bun:test";
import { isReplayDayId, replayDay, replayDayId } from "../src/lib/fixtures";
import { offeredDays, REPLAY_WINDOW_DAYS, windowStart } from "../src/lib/replay-days";

const calendar = (...days: unknown[]) => ({ days });

describe("the days the picker offers", () => {
  it("offers a replayable day and a pre-holdout one, newest first", () => {
    const offered = offeredDays(
      calendar(
        { date: "2026-07-02", replayable: true },
        { date: "2026-09-19", replayable: true },
        // Inside every artifact's training block: refused as a replay, and the
        // refusal is the route to its observed-only view.
        {
          date: "2024-11-05",
          replayable: false,
          refusal: { code: "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW" },
        },
      ),
      "NE",
    );
    expect(offered.map((day) => day.date)).toEqual([
      "2026-09-19",
      "2026-07-02",
      "2024-11-05",
    ]);
    expect(offered[0]).toEqual({ id: "2026-09-19-ne", date: "2026-09-19", subsystem: "NE" });
  });

  it("leaves out the dead ends, which is the point of asking", () => {
    // Press, wait, read a code. The old picker listed these because the list
    // was written by hand.
    const offered = offeredDays(
      calendar(
        { date: "2026-09-20", replayable: false, refusal: { code: "REPLAY_FORECAST_UNAVAILABLE" } },
        { date: "2026-09-21", replayable: false, refusal: { code: "REPLAY_DAY_NOT_SETTLED" } },
        { date: "2026-09-18", replayable: true },
      ),
      "S",
    );
    expect(offered.map((day) => day.id)).toEqual(["2026-09-18-s"]);
  });

  it("reads a shape it did not expect as no days at all", () => {
    for (const body of [null, undefined, {}, { days: "soon" }, { days: [{}, { date: 7 }] }]) {
      expect(offeredDays(body, "NE")).toEqual([]);
    }
  });

  it("asks for a window that the gateway can answer inside its budget", () => {
    // 902 days took 21.4 s against a 5 s budget; 111 days took 2.4 s. The
    // window is a page size, and the measurement is in the module header.
    expect(REPLAY_WINDOW_DAYS).toBeLessThanOrEqual(180);
    expect(windowStart(new Date("2026-09-20T12:00:00Z"), 120)).toBe("2026-05-23");
    // A Brasília civil date, so a UTC instant just after midnight is still the
    // day before in São Paulo.
    expect(windowStart(new Date("2026-09-20T02:00:00Z"), 0)).toBe("2026-09-19");
  });
});

describe("an episode id", () => {
  it("round-trips any date the gateway can answer", () => {
    const id = replayDayId("2026-08-05", "SE");
    expect(id).toBe("2026-08-05-se");
    expect(isReplayDayId(id)).toBe(true);
    expect(replayDay(id)).toEqual({ id, date: "2026-08-05", subsystem: "SE" });
  });

  it("falls back to the first fixture on anything that is not an id", () => {
    for (const bad of ["", "yesterday", "2026-08-05", "2026-08-05-sin", "2026-13-99-ne"]) {
      expect(isReplayDayId(bad)).toBe(false);
      expect(replayDay(bad).id).toBe("2024-11-05-ne");
    }
  });
});

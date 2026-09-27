import { describe, expect, it } from "bun:test";
import { latestTargetDate } from "@wattsteer/core";
import { openingDate, parseAppParams } from "../src/components/app/params";

/**
 * `DEMO_DATE` — the day `/app` opens on when a deployment's tomorrow is empty.
 *
 * The Overview opens on `latestTargetDate`, which is tomorrow, because that is
 * the day a forecast is about. When the publication has been interrupted,
 * tomorrow has nothing and the screen states four absences — honest, and
 * useless in front of a room.
 *
 * Two properties are worth holding, and they pull in opposite directions:
 *
 *  - the flag has to **actually move the opening day**, or it is a setting that
 *    looks set and does nothing;
 *  - a malformed value has to be **ignored**, not forwarded. A demonstration is
 *    not a reason to ask the gateway for a date that cannot exist, and the URL
 *    parser already refuses one for the same reason — `params.ts` validates by
 *    shape there and this is the same shape test.
 *
 * The rule is exercised through `openingDate`'s parameter rather than through
 * the constant: `DEMO_DATE` resolves once at import, exactly as `API_URL`
 * does, so a test that set the global afterwards would be testing something
 * the bundle never does — and a first attempt that re-imported the module per
 * case silently shared the cache and passed on the wrong value.
 */

const AT = new Date("2026-09-27T15:00:00Z");

describe("the day the Overview opens on", () => {
  it("is tomorrow when nothing is pinned", () => {
    expect(openingDate(AT, null)).toBe(latestTargetDate(AT));
  });

  it("is the pinned day when one is set", () => {
    // The whole point: a deployment whose tomorrow is empty can be shown on a
    // day that was published, without anybody editing a URL in front of people.
    expect(openingDate(AT, "2026-09-26")).toBe("2026-09-26");
    expect(openingDate(AT, "2026-09-26")).not.toBe(latestTargetDate(AT));
  });

  it("ignores a value that is not a civil date", () => {
    // Shape, not calendar — the same test the URL's own `date` gets, and for
    // the reason stated there: a day the gateway has nothing for answers with
    // absences, which is a screen, while a malformed one is an invalid request
    // on every read. `2026-13-40` is deliberately absent from this list: it
    // passes the shape test, exactly as it does in a pasted URL, and a flag
    // stricter than the parameter it defaults would be a second rule.
    for (const bad of ["ontem", "26/09/2026", "2026-09-26T00:00:00Z", "2026-9-26", ""]) {
      expect(openingDate(AT, bad)).toBe(latestTargetDate(AT));
    }
  });

  it("still lets the URL win, so a link names its own day", () => {
    // The flag is a default, not an override. A shared link has to keep
    // meaning what it said, pinned deployment or not.
    expect(
      parseAppParams({ subsystem: "NE", run: "00Z", date: "2026-09-18" }, AT).date,
    ).toBe("2026-09-18");
  });
});

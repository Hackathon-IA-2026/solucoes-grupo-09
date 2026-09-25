/**
 * Walking a civil date, which is the axis the two day arrows move.
 *
 * `lib/civil-date.ts` makes a claim in its own header — parsing at **UTC**
 * midnight is exact for ±1 whole days, and parsing at *local* midnight is what
 * would break — and nothing held it. That is the shape this repository calls a
 * guard that was never written: the module states the property it was built
 * for, and the property is the test surface.
 *
 * The sharp half is the ambient zone. `addDays` is reached from the app bar and
 * from the map's scope bar, in a browser whose zone is the reader's and not
 * Brasília's, so "the answer does not depend on where the reader is" is the
 * thing that actually has to be true. `process.env.TZ` moves the ambient zone
 * under the test, and the extremes are real: Kiritimati is UTC+14 and Niue is
 * UTC−11, twenty-five hours apart, so a date computed through a local midnight
 * would land on a different day in one of them.
 *
 * The rest is arithmetic a reader can check by eye — month ends, a leap day,
 * a year boundary — plus two properties over a whole year, because the defect
 * this file exists to catch is an off-by-one that only shows up on the days
 * nobody writes a case for.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { addDays } from "../src/lib/civil-date";

const AMBIENT = process.env.TZ;

afterAll(() => {
  // Restored explicitly: the suite shares a process, and a leaked zone would
  // make some *other* file's dates wrong in a way that looks like its own bug.
  if (AMBIENT === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = AMBIENT;
  }
});

describe("stepping a civil date by whole days", () => {
  it("moves one day, forwards and backwards", () => {
    expect(addDays("2026-09-24", 1)).toBe("2026-09-25");
    expect(addDays("2026-09-24", -1)).toBe("2026-09-23");
    expect(addDays("2026-09-24", 0)).toBe("2026-09-24");
  });

  it("crosses a month, a year and a leap day", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    // 2028 is a leap year; 2026 is not.
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("takes a step of more than one day", () => {
    // The app bar steps by one; the signature takes any whole number and the
    // callers are free to, so the general case is pinned rather than assumed.
    expect(addDays("2026-09-24", 7)).toBe("2026-10-01");
    expect(addDays("2026-09-24", -30)).toBe("2026-08-25");
  });
});

describe("the answer does not depend on where the reader is", () => {
  /*
    The zones are chosen to break a local-midnight implementation rather than to
    look thorough: the two Pacific extremes bracket the whole offset range, and
    New York and Sao Paulo are the plausible ones. The date is the second Sunday
    in March — a US daylight-saving transition — because a local day that is 23
    hours long is where `+ 86_400_000` against a local midnight overshoots into
    the wrong date.
  */
  const ZONES = [
    "UTC",
    "America/Sao_Paulo",
    "America/New_York",
    "Pacific/Kiritimati",
    "Pacific/Niue",
  ];

  it("gives the same date in every zone, across a DST transition", () => {
    for (const zone of ZONES) {
      process.env.TZ = zone;
      expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
      expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
      expect(addDays("2026-03-09", -1)).toBe("2026-03-08");
      // And the autumn transition, where a local day is 25 hours long.
      expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
      expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
    }
  });

  it("agrees with itself across zones over a whole year", () => {
    const walk = (zone: string) => {
      process.env.TZ = zone;
      const out: string[] = [];
      let date = "2026-01-01";
      for (let step = 0; step < 365; step += 1) {
        date = addDays(date, 1);
        out.push(date);
      }
      return out;
    };
    const reference = walk("UTC");
    for (const zone of ZONES) {
      expect(walk(zone)).toEqual(reference);
    }
  });
});

describe("a year of steps is the calendar and nothing else", () => {
  it("visits every date of 2026 exactly once, in order", () => {
    // The bijection is the property an off-by-one breaks without any single
    // hand-written case noticing: a repeated or skipped date shows up as a
    // length or a duplicate rather than as a wrong-looking string.
    process.env.TZ = "UTC";
    const seen: string[] = [];
    let date = "2026-01-01";
    seen.push(date);
    for (let step = 0; step < 364; step += 1) {
      date = addDays(date, 1);
      seen.push(date);
    }
    expect(seen).toHaveLength(365);
    expect(new Set(seen).size).toBe(365);
    expect(seen[0]).toBe("2026-01-01");
    expect(seen.at(-1)).toBe("2026-12-31");
    expect([...seen].sort()).toEqual(seen);
  });

  it("is reversible on every day of the year", () => {
    process.env.TZ = "Pacific/Kiritimati";
    let date = "2026-01-01";
    for (let step = 0; step < 365; step += 1) {
      expect(addDays(addDays(date, 1), -1)).toBe(date);
      date = addDays(date, 1);
    }
  });
});

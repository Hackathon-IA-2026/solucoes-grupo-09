/**
 * The window the dashboard states in words, and the cases that decide it.
 *
 * The operator brief's question 4 is "quando?", and a curve is not an answer to
 * it in thirty seconds. What makes this worth its own test is the choice of
 * *which* number decides membership — the occurrence probability rather than
 * the band — and the way the summary admits it is one.
 */

import { describe, expect, it } from "bun:test";
import { criticalWindow, type WindowHour } from "../src/lib/critical-window";

function hour(hourLocal: number, p: number, mwh = 10): WindowHour {
  return { hourLocal, occurrenceProbability: p, expectedMwh: mwh };
}

describe("which hours are in the window", () => {
  it("a day nobody expects to curtail has no window at all", () => {
    // Not `0h–0h`, and not the whole day. "No hours to act in" is the answer,
    // and the caller says it in words.
    expect(criticalWindow([hour(10, 0.1), hour(11, 0.2)])).toBeNull();
  });

  it("an even chance is in, because that is where 'no' stops", () => {
    const window = criticalWindow([hour(12, 0.5)]);
    expect(window?.fromHour).toBe(12);
    expect(window?.toHour).toBe(12);
  });

  it("membership is the occurrence probability, never the band", () => {
    /*
      The hurdle model puts real mass at zero, so an unlikely hour still has a
      positive expectation and a `p90` well above the threshold. A window drawn
      from the band would stretch across the whole day and say nothing — this
      hour has a big expectation and a one-in-ten chance, and it is out.
    */
    expect(criticalWindow([hour(3, 0.1, 900)])).toBeNull();
  });
});

describe("which run the window reports", () => {
  it("the longest, when a day has more than one", () => {
    const window = criticalWindow([
      hour(2, 0.8),
      hour(10, 0.9),
      hour(11, 0.9),
      hour(12, 0.9),
    ]);
    expect(window?.fromHour).toBe(10);
    expect(window?.toHour).toBe(12);
  });

  it("and says how many hours the day has, so the summary admits it is one", () => {
    // Four qualifying hours reported as a three-hour window. A reader who sees
    // the mismatch knows to look at the chart, which is the point of carrying
    // the count at all.
    const window = criticalWindow([
      hour(2, 0.8),
      hour(10, 0.9),
      hour(11, 0.9),
      hour(12, 0.9),
    ]);
    expect(window?.hoursInDay).toBe(4);
  });

  it("a gap of one hour breaks the run", () => {
    const window = criticalWindow([hour(10, 0.9), hour(12, 0.9), hour(13, 0.9)]);
    expect(window?.fromHour).toBe(12);
    expect(window?.toHour).toBe(13);
  });

  it("hours out of order still make one run", () => {
    // The contract orders them, but a window that depended on arrival order
    // would be a window that broke silently the day something reordered them.
    const window = criticalWindow([hour(12, 0.9), hour(10, 0.9), hour(11, 0.9)]);
    expect(window?.fromHour).toBe(10);
    expect(window?.toHour).toBe(12);
  });
});

describe("the peak inside the window", () => {
  it("is the largest expectation, not the middle of the run", () => {
    const window = criticalWindow([
      hour(10, 0.9, 20),
      hour(11, 0.9, 80),
      hour(12, 0.9, 30),
    ]);
    expect(window?.peakHour).toBe(11);
    expect(window?.peakMwh).toBe(80);
  });

  it("is inside the reported run, not the day", () => {
    // The isolated hour is bigger and is not in the window. Reporting it as the
    // peak would put a number outside the range printed beside it.
    const window = criticalWindow([
      hour(2, 0.9, 500),
      hour(10, 0.9, 20),
      hour(11, 0.9, 80),
      hour(12, 0.9, 30),
    ]);
    expect(window?.peakHour).toBe(11);
  });
});

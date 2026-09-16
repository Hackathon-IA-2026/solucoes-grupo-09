import { describe, expect, it } from "bun:test";
import type { SubsystemCode } from "@wattsteer/core";
import type { Band } from "@wattsteer/core/api";
import { SUBSYSTEM_DISPLAY_ORDER } from "../src/lib/fixtures";
import {
  forecastHours,
  forecastRow,
  observedRows,
  outlookRows,
} from "../src/lib/network";

/**
 * `lib/network.ts`'s shape translators, asserted on the claims their docstrings
 * make rather than on field-copying.
 *
 * The module was at 71% of functions. Testing "does it copy `subsystem` to
 * `subsystem`" would have raised that number and proved nothing — the compiler
 * already holds those. What the compiler does *not* hold is the three sentences
 * this module is built on, each of which is a decision that could be reversed
 * by an edit that still type-checks:
 *
 *  1. The outlook's order is the **gateway's ranking**, and the observed rows'
 *     order is the **product's**. Two functions with the same signature and
 *     deliberately opposite rules about order.
 *  2. Two different responses reduce to the **same row**, so a screen need not
 *     know which call a figure came from.
 *  3. `expectedMwh` is a **sibling** of the band and never a member of it.
 */

const band = (p10: number, p50: number, p90: number): Band => ({ p10, p50, p90 }) as Band;

const split = { windMwh: 60, solarMwh: 40 };

/** One subsystem of `GET /v1/grid/outlook`. */
const outlookSubsystem = (subsystem: string, probability: number) =>
  ({
    subsystem,
    onsDisplayName: `name-${subsystem}`,
    dayOccurrenceProbability: probability,
    riskClass: probability > 0.6 ? "high" : "low",
    dayEnergyMwh: band(10, 50, 90),
    peakPowerMw: band(1, 5, 9),
    dayExpectedMwh: 55,
    split,
  }) as never;

describe("order is a decision, and the two readers make opposite ones", () => {
  it("the outlook keeps the gateway's ranking, untouched", () => {
    // "in the order the gateway ranked them" — a ranked list re-sorted into
    // display order would silently discard the ranking the gateway computed.
    // Typed as the enum rather than `string[]`: the assertion below compares
    // against `row.subsystem`, so an untyped literal made the comparison
    // `string[]` vs `SubsystemCode[]` and a typo here would have been a type
    // error nobody saw while the gate was red at another package.
    const scrambled: SubsystemCode[] = ["S", "NE", "N", "SE"];
    const rows = outlookRows({
      subsystems: scrambled.map((code, i) => outlookSubsystem(code, 0.9 - i * 0.2)),
    } as never);
    expect(rows.map((row) => row.subsystem)).toEqual(scrambled);
  });

  it("the observed rows are re-sorted into the product's display order", () => {
    // "Ordering a response is a rendering decision and this is where it is
    // made." The opposite rule, in a function with the same shape — which is
    // exactly why both are worth pinning.
    const scrambled = ["S", "NE", "N", "SE"].map((code) => ({
      subsystem: code,
      onsDisplayName: `name-${code}`,
      last24hConstrainedOffMwh: 10,
      latestHourConstrainedOffMwh: 1,
      split,
    })) as never[];
    const rows = observedRows(scrambled, SUBSYSTEM_DISPLAY_ORDER);
    expect(rows.map((row) => row.subsystem)).toEqual([...SUBSYSTEM_DISPLAY_ORDER]);
  });

  it("a subsystem the response omits is dropped, not padded", () => {
    // "Padding a response to fit a component is how an empty array becomes a
    // flat line at zero."
    const partial = [
      {
        subsystem: "NE",
        onsDisplayName: "NE",
        last24hConstrainedOffMwh: 7,
        latestHourConstrainedOffMwh: 1,
        split,
      },
    ] as never[];
    const rows = observedRows(partial, SUBSYSTEM_DISPLAY_ORDER);
    expect(rows.map((row) => row.subsystem)).toEqual(["NE"]);
  });
});

describe("two responses, one row — so a screen need not know which call it came from", () => {
  it("the outlook's row and the day-ahead's row are equal for the same figures", () => {
    const fromOutlook = outlookRows({
      subsystems: [outlookSubsystem("NE", 0.8)],
    } as never)[0];
    const fromDayAhead = forecastRow({
      subsystem: "NE",
      riskClass: "high",
      dayOccurrenceProbability: 0.8,
      dayEnergyMwh: band(10, 50, 90),
      peakPowerMw: band(1, 5, 9),
      dayExpectedMwh: 55,
      split,
      hours: [],
    } as never);
    // The claim in full: "the deeper response reduces to the same row". If one
    // of these ever gains a field the other lacks, a panel fed by the shallow
    // call renders `undefined` where the deep call renders a number.
    expect(fromDayAhead).toEqual(fromOutlook as never);
  });

  it("the row is narrower than the response it came from", () => {
    // "Narrower than a `SubsystemDayForecast` on purpose" — `hours` must not
    // ride along, or `GET /v1/grid/outlook`'s answer would have to be padded
    // with an empty one to fit the same shape.
    const row = forecastRow({
      subsystem: "NE",
      riskClass: "high",
      dayOccurrenceProbability: 0.8,
      dayEnergyMwh: band(10, 50, 90),
      peakPowerMw: band(1, 5, 9),
      dayExpectedMwh: 55,
      split,
      hours: [{ validTime: "x", hourLocal: 0 }],
      forecastOrigin: { producer: "wattsteer" },
      targetDate: "2026-09-16",
    } as never);
    for (const absent of ["hours", "forecastOrigin", "targetDate", "onsDisplayName"]) {
      expect({ field: absent, present: absent in row }).toEqual({
        field: absent,
        present: false,
      });
    }
  });
});

describe("the expectation is a sibling of the band, never inside it", () => {
  it("`constrainedOff` carries the three quantiles and nothing else", () => {
    const hours = forecastHours({
      hours: [
        {
          validTime: "2026-09-16T03:00:00Z",
          hourLocal: 0,
          constrainedOffMwh: band(0, 12, 80),
          expectedMwh: 21,
          occurrenceProbability: 0.35,
          split,
        },
      ],
    } as never);
    const first = hours[0];
    expect(Object.keys(first?.constrainedOff ?? {}).sort()).toEqual([
      "p10",
      "p50",
      "p90",
    ]);
    // The whole argument of the docstring: a fourth number inside the band
    // would invite reading the expectation as a quantile. On a hurdle model the
    // expectation sits *above* the median whenever the hour is less than an
    // even chance — as it does here, 21 against a P50 of 12 — so a reader who
    // took it for a quantile would have the order wrong, not merely the label.
    expect(first?.expectedMwh).toBe(21);
    expect(first?.expectedMwh).toBeGreaterThan(first?.constrainedOff.p50 ?? 0);
    expect(first?.occurrenceProbability).toBeLessThan(0.5);
  });

  it("an empty day is an empty list, not an hour of zeroes", () => {
    expect(forecastHours({ hours: [] } as never)).toEqual([]);
  });
});

/**
 * The answer to "por quê?" that the product can actually make.
 *
 * The brief asks for a *predicted* cause. There is no such model — the
 * forecaster has one head per subsystem and produces a quantity. So the
 * question is answered from the settled record, and the two rules that keep
 * that honest are pinned here: energy rather than rows, and `conjunto` grain
 * only.
 */

import { describe, expect, it } from "bun:test";
import { dominantReason, rankedReasons } from "../src/lib/dominant-reason";
import type { ObservedReason } from "../src/lib/fixtures";

function row(
  reason: ObservedReason["reason"],
  mwh: number,
  grain: ObservedReason["grain"] = "conjunto",
): ObservedReason {
  return {
    grain,
    entityLabel: "CJ",
    reason,
    origin: "SIS",
    constrainedOffMwh: mwh,
    description: null,
  };
}

describe("which reason carried the day", () => {
  it("is decided by energy, not by how finely ONS itemised it", () => {
    // Forty rows of REL moving almost nothing against two of ENE moving most
    // of the day. Counting rows would report the record's shape rather than
    // the day's.
    const rows = [
      ...Array.from({ length: 40 }, () => row("REL", 1)),
      row("ENE", 300),
      row("ENE", 300),
    ];
    const dominant = dominantReason(rows);
    expect(dominant?.reason).toBe("ENE");
    expect(dominant?.mwh).toBe(600);
  });

  it("reports a share of the attributed energy", () => {
    const dominant = dominantReason([row("CNF", 750), row("ENE", 250)]);
    expect(dominant?.reason).toBe("CNF");
    expect(dominant?.share).toBeCloseTo(0.75, 6);
  });
});

describe("the grain rule, which a screen could quietly break", () => {
  it("counts conjunto rows and ignores a plant's own account of itself", () => {
    /*
      A plant that sits inside a conjunto ONS also reported would otherwise be
      counted twice, and the double-counted code would win. The specs state the
      grain rule; this is the place a summary could silently violate it.
    */
    const dominant = dominantReason([
      row("ENE", 100),
      row("REL", 400, "self_reporting_plant"),
    ]);
    expect(dominant?.reason).toBe("ENE");
    expect(dominant?.share).toBe(1);
  });

  it("a day of only self-reported rows has no dominant reason", () => {
    expect(dominantReason([row("REL", 400, "self_reporting_plant")])).toBeNull();
  });
});

describe("days with nothing to attribute", () => {
  it("an empty record is null, not a reason at zero percent", () => {
    expect(dominantReason([])).toBeNull();
  });

  it("a day of zeroes is null too", () => {
    // "REL, 0%" is worse than saying nothing: it names a cause for a day that
    // had no curtailment to explain.
    expect(dominantReason([row("REL", 0), row("ENE", 0)])).toBeNull();
  });
});

describe("the ranked list, which is what the card reads", () => {
  /*
    `dominantReason` is the head of this list and the only thing the older tests
    above exercise — but production reads `rankedReasons`, because "Por quê?"
    names a second reason where ONS split the day. The sort and the shares were
    shipping untested.
  */
  const rows = (
    entries: [string, number, "conjunto" | "self_reporting_plant"][],
  ): ObservedReason[] =>
    entries.map(([reason, mwh, grain]) => ({
      reason,
      constrainedOffMwh: mwh,
      grain,
    })) as unknown as ObservedReason[];

  it("is largest first, and the shares are of the attributed total", () => {
    const ranked = rankedReasons(
      rows([
        ["CNF", 200, "conjunto"],
        ["ENE", 700, "conjunto"],
        ["REL", 100, "conjunto"],
      ]),
    );
    expect(ranked.map((entry) => entry.reason)).toEqual(["ENE", "CNF", "REL"]);
    expect(ranked.map((entry) => entry.share)).toEqual([0.7, 0.2, 0.1]);
  });

  it("sums a reason that ONS itemised more than once", () => {
    // The record is a list of rows, not a list of reasons: a code can appear
    // several times in one day and the share is of the energy, not the rows.
    const ranked = rankedReasons(
      rows([
        ["ENE", 300, "conjunto"],
        ["CNF", 500, "conjunto"],
        ["ENE", 400, "conjunto"],
      ]),
    );
    expect(ranked[0]).toMatchObject({ reason: "ENE", mwh: 700 });
  });

  it("counts `conjunto` rows only, and the head agrees with `dominantReason`", () => {
    // A plant inside a conjunto ONS also reported would be counted twice, so a
    // larger plant row must not win.
    const input = rows([
      ["ENE", 400, "conjunto"],
      ["CNF", 900, "self_reporting_plant"],
    ]);
    expect(rankedReasons(input).map((entry) => entry.reason)).toEqual(["ENE"]);
    expect(dominantReason(input)?.reason).toBe("ENE");
  });

  it("a day with no attributed energy has no reasons at all", () => {
    expect(rankedReasons(rows([["ENE", 0, "conjunto"]]))).toEqual([]);
    expect(rankedReasons(rows([["ENE", 900, "self_reporting_plant"]]))).toEqual([]);
  });
});

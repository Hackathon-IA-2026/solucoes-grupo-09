import { describe, expect, it } from "bun:test";
import {
  dayCandidates,
  mergeCandidates,
  pdpVectors,
  vectorKey,
} from "../src/ingest/ons/pdp-fingerprint.js";
import type {
  ProgrammedVsForecastHalfHour,
  ProgrammePlantVector,
} from "../src/ingest/types.js";

const flat = (value: number): number[] => Array.from({ length: 48 }, () => value);
const ramp = (start: number): number[] =>
  Array.from({ length: 48 }, (_u, i) => start + i);

const plant = (
  code: string,
  subsystem: ProgrammePlantVector["subsystem"],
  technology: ProgrammePlantVector["technology"],
  vector: number[],
): ProgrammePlantVector => ({
  plantCode: code,
  subsystem,
  technology,
  programmedMw: vector,
});

const entity = (pdpCode: string, vector: number[]) => ({ pdpCode, programmedMw: vector });

describe("vectorKey", () => {
  it("is exact at two decimals and equal for equal vectors", () => {
    expect(vectorKey([1.001, 2])).toBe(vectorKey([1, 2]));
    expect(vectorKey([1.01, 2])).not.toBe(vectorKey([1, 2]));
  });

  it("keeps a missing patamar in its place, so a gap is not a shift", () => {
    expect(vectorKey([null, 1, 2])).not.toBe(vectorKey([1, 2, null]));
  });
});

describe("dayCandidates", () => {
  const plants = [
    plant("P1", "NE", "WIND", ramp(10)),
    plant("P2", "SE", "SOLAR", ramp(500)),
    // Two plants flat at zero in different subsystems: a fingerprint collision.
    plant("Z1", "NE", "SOLAR", flat(0)),
    plant("Z2", "S", "SOLAR", flat(0)),
  ];

  it("determines an entity whose vector only one plant carries", () => {
    const result = dayCandidates([entity("E1", ramp(10))], plants).get("E1");
    expect([...(result?.subsystems ?? [])]).toEqual(["NE"]);
    expect([...(result?.technologies ?? [])]).toEqual(["WIND"]);
    expect(result?.matchedPlants).toBe(1);
  });

  it("returns every subsystem a colliding vector fits, and does not choose", () => {
    const result = dayCandidates([entity("E2", flat(0))], plants).get("E2");
    expect([...(result?.subsystems ?? [])].sort()).toEqual(["NE", "S"]);
    expect(result?.matchedPlants).toBe(2);
  });

  it("omits an entity no plant carries, rather than reporting an empty match", () => {
    expect(dayCandidates([entity("E3", ramp(999))], plants).has("E3")).toBe(false);
  });
});

describe("pdpVectors", () => {
  it("places each half hour by its time, not by row order", () => {
    const midnight = Date.parse("2026-09-17T03:00:00.000Z");
    const rows: ProgrammedVsForecastHalfHour[] = [2, 0, 1].map((slot) => ({
      pdpCode: "E",
      pdpName: "E",
      validTime: new Date(midnight + slot * 1_800_000),
      referenceDay: "2026-09-17",
      forecastMw: 0,
      programmedMw: slot + 1,
    }));
    const [vector] = pdpVectors(rows, 48, midnight);
    expect(vector?.programmedMw.slice(0, 3)).toEqual([1, 2, 3]);
    expect(vector?.programmedMw[3]).toBeNull();
  });
});

describe("mergeCandidates — a day narrows, never widens, and a conflict never overwrites", () => {
  const day = (subsystems: string[], technologies: string[] = ["SOLAR"]) => ({
    subsystems: new Set(subsystems) as never,
    technologies: new Set(technologies) as never,
    matchedPlants: subsystems.length,
  });

  it("takes the first informative day when nothing is stored", () => {
    expect(mergeCandidates(undefined, day(["NE", "S"]))).toEqual({
      kind: "set",
      subsystems: ["NE", "S"],
      technologies: ["SOLAR"],
    });
  });

  it("takes the first informative day when what is stored is an empty set", () => {
    expect(mergeCandidates({ subsystems: [], technologies: [] }, day(["NE"]))?.kind).toBe(
      "set",
    );
  });

  it("narrows an ambiguous belief with a later, more informative day", () => {
    expect(
      mergeCandidates({ subsystems: ["NE", "S"], technologies: ["SOLAR"] }, day(["NE"])),
    ).toEqual({ kind: "narrowed", subsystems: ["NE"], technologies: ["SOLAR"] });
  });

  it("does not widen a determined belief when a quiet day matches everything", () => {
    expect(
      mergeCandidates(
        { subsystems: ["NE"], technologies: ["SOLAR"] },
        day(["N", "NE", "S", "SE"]),
      ),
    ).toEqual({ kind: "unchanged" });
  });

  it("treats a day with no match as saying nothing", () => {
    expect(
      mergeCandidates({ subsystems: ["NE"], technologies: ["SOLAR"] }, undefined),
    ).toEqual({
      kind: "unchanged",
    });
  });

  it("reports a disjoint informative day as a conflict and leaves the stored belief standing", () => {
    const result = mergeCandidates(
      { subsystems: ["NE"], technologies: ["SOLAR"] },
      day(["S"]),
    );
    expect(result.kind).toBe("conflict");
    // There is no `subsystems` on a conflict: nothing to write over the belief.
    expect("subsystems" in result).toBe(false);
  });

  it("treats a technology contradiction as a conflict even when the subsystem agrees", () => {
    const result = mergeCandidates(
      { subsystems: ["NE"], technologies: ["SOLAR"] },
      day(["NE"], ["WIND"]),
    );
    expect(result.kind).toBe("conflict");
  });
});

import { describe, expect, it } from "bun:test";
import { payloadRefusal } from "../src/errors.js";
import { programmeFilePublishedAt } from "../src/ingest/ons/programme.js";
import { parseProgrammeDailyCsv } from "../src/ingest/ons/programme-daily.js";
import { dailyCsv, type FixturePlant, wholeFleet } from "./support/programme-fixtures.js";

const DAY = "2026-09-17";

const refusalOf = (text: string) => {
  try {
    parseProgrammeDailyCsv(text);
  } catch (error) {
    return payloadRefusal(error);
  }
  return null;
};

describe("programacao_diaria · aggregation at the adapter", () => {
  const parsed = parseProgrammeDailyCsv(dailyCsv(DAY, wholeFleet()));

  it("collapses 16 plants x 48 half hours into 16 groups x 48 rows, one per (subsystem, technology, half hour)", () => {
    expect(parsed.plantRowsRead).toBe(16 * 48);
    expect(parsed.rows).toHaveLength(16 * 48);
    expect(parsed.rejected).toHaveLength(0);
    expect(parsed.referenceDay).toBe(DAY);
    expect(parsed.halfHoursInCivilDay).toBe(48);
  });

  it("sums the plants of a group — here two thermal plants of one subsystem", () => {
    const fleet = wholeFleet();
    const extra: FixturePlant = {
      code: "T2NE",
      subsystem: "NE",
      tip: "TÉRMICA",
      programmed: (p) => 10 + p,
      availability: (p) => 20 + p,
      thermal: { inflexibility: 1, unitCommitment: 2 },
    };
    const two = parseProgrammeDailyCsv(dailyCsv(DAY, [...fleet, extra]));
    const one = parsed.rows.find(
      (row) =>
        row.subsystem === "NE" &&
        row.technology === "THERMAL" &&
        row.validTime.getTime() === parsed.rows[0]?.validTime.getTime(),
    );
    const both = two.rows.find(
      (row) =>
        row.subsystem === "NE" &&
        row.technology === "THERMAL" &&
        row.validTime.getTime() === one?.validTime.getTime(),
    );
    expect(both?.plantCount).toBe(2);
    expect(both?.programmedMw).toBe((one?.programmedMw ?? 0) + 11);
    expect(both?.inflexibilityMw).toBe((one?.inflexibilityMw ?? 0) + 1);
    expect(both?.unitCommitmentMw).toBe((one?.unitCommitmentMw ?? 0) + 2);
  });

  it("puts patamar 1 at 00:00 Brasília = 03:00Z, the START of the half hour", () => {
    const first = [...parsed.rows].sort(
      (a, b) => a.validTime.getTime() - b.validTime.getTime(),
    )[0];
    expect(first?.validTime.toISOString()).toBe("2026-09-17T03:00:00.000Z");
  });

  it("reads each measure into its own slot, and pads in id_subsistema do not matter", () => {
    // NE is the second subsystem: base 200. Wind programmed = base + patamar + 0.5.
    const wind = parsed.rows.find(
      (row) =>
        row.subsystem === "NE" &&
        row.technology === "WIND" &&
        row.validTime.toISOString() === "2026-09-17T03:00:00.000Z",
    );
    expect(wind?.programmedMw).toBe(201.5);
    expect(wind?.availabilityMw).toBe(201.25);
    // The fixture writes id_subsistema padded to three characters.
    expect(wind?.subsystem).toBe("NE");
  });

  it("leaves components null, never zero, where no plant reported one", () => {
    const wind = parsed.rows.find((row) => row.technology === "WIND");
    expect(wind?.inflexibilityMw).toBeNull();
    expect(wind?.unitCommitmentMw).toBeNull();
    expect(wind?.exportMw).toBeNull();
    const thermal = parsed.rows.find((row) => row.technology === "THERMAL");
    expect(thermal?.inflexibilityMw).not.toBeNull();
    expect(thermal?.exportMw).toBe(0);
  });

  it("keeps a plant-grain vector for wind and solar only, and never for anything stored", () => {
    expect(parsed.plantVectors).toHaveLength(8);
    expect(new Set(parsed.plantVectors.map((entry) => entry.technology))).toEqual(
      new Set(["WIND", "SOLAR"]),
    );
    const vector = parsed.plantVectors.find((entry) => entry.plantCode === "WNE");
    expect(vector?.programmedMw).toHaveLength(48);
    expect(vector?.programmedMw[0]).toBe(201.5);
    expect(vector?.programmedMw[47]).toBe(248.5);
  });
});

describe("programacao_diaria · val_ordemmerito is not stored", () => {
  it("a 999.00 sentinel and an empty merit order produce identical rows", () => {
    // 999.00 was measured on 612 thermal rows, and on 595 of them it exceeds the
    // plant's whole programmed generation: a sum of it would be fabricated
    // megawatts, so no output field may depend on it.
    const withSentinel = wholeFleet().map((plant) =>
      plant.thermal
        ? { ...plant, thermal: { ...plant.thermal, meritOrder: 999 } }
        : plant,
    );
    const a = parseProgrammeDailyCsv(dailyCsv(DAY, wholeFleet()));
    const b = parseProgrammeDailyCsv(dailyCsv(DAY, withSentinel));
    expect(b.rows).toEqual(a.rows);
  });
});

describe("programacao_diaria · an empty availability is not a defect", () => {
  it("counts the plants that reported it, and does not refuse", () => {
    // 14 thermal plants publish an empty val_disponibilidade on the real
    // 2026-09-17 file. The first version of this adapter required it, and
    // refused the real file.
    const fleet = wholeFleet().map((plant) =>
      plant.code === "TSE" ? { ...plant, availability: () => null } : plant,
    );
    const parsed = parseProgrammeDailyCsv(dailyCsv(DAY, fleet));
    const se = parsed.rows.find(
      (row) => row.subsystem === "SE" && row.technology === "THERMAL",
    );
    expect(se?.plantCount).toBe(1);
    expect(se?.reportingPlantCount).toBe(0);
    expect(se?.availabilityMw).toBeNull();
    const ne = parsed.rows.find(
      (row) => row.subsystem === "NE" && row.technology === "THERMAL",
    );
    expect(ne?.reportingPlantCount).toBe(1);
  });
});

describe("programacao_diaria · refusals", () => {
  it("refuses a renamed required column as schema", () => {
    const text = dailyCsv(DAY, wholeFleet()).replace(
      "val_geracaoprogramada",
      "val_geracao_programada",
    );
    expect(refusalOf(text)?.refusal).toBe("schema");
  });

  it("refuses a value that is not a number, because dropping a plant understates its group silently", () => {
    const text = dailyCsv(DAY, wholeFleet()).replace(";201.50;", ";abc;");
    expect(refusalOf(text)?.refusal).toBe("coverage");
  });

  it("refuses an empty programmed value", () => {
    const text = dailyCsv(DAY, wholeFleet()).replace(";201.50;", ";;");
    expect(refusalOf(text)?.refusal).toBe("coverage");
  });

  it("refuses a group that is not present for the whole civil day", () => {
    const text = dailyCsv(DAY, wholeFleet(), {
      skip: (plant, patamar) => plant === "WNE" && patamar === 30,
    });
    const refusal = refusalOf(text);
    expect(refusal?.refusal).toBe("coverage");
    expect(refusal?.message).toContain("NE/WIND 47/48");
  });

  it("refuses a file that carries no rows for one of the four subsystems", () => {
    const fleet = wholeFleet().filter((plant) => plant.subsystem !== "N");
    const refusal = refusalOf(dailyCsv(DAY, fleet));
    expect(refusal?.refusal).toBe("coverage");
    expect(refusal?.message).toContain("subsystem N");
  });

  it("refuses a repeated plant patamar", () => {
    const text = dailyCsv(DAY, wholeFleet());
    const lines = text.trimEnd().split("\n");
    expect(refusalOf(`${text.trimEnd()}\n${lines[1]}\n`)?.refusal).toBe("coverage");
  });

  it("refuses two reference days in one file", () => {
    const text = `${dailyCsv(DAY, wholeFleet()).trimEnd()}\n${
      dailyCsv("2026-09-18", wholeFleet()).split("\n")[1]
    }\n`;
    expect(refusalOf(text)?.refusal).toBe("coverage");
  });

  it("refuses a patamar outside the civil day", () => {
    const text = dailyCsv(DAY, wholeFleet()).replace(`${DAY};7;WNE`, `${DAY};49;WNE`);
    expect(refusalOf(text)?.refusal).toBe("time_axis");
  });

  it("rejects an unknown technology as a row, and it belongs to no group", () => {
    const text = `${dailyCsv(DAY, wholeFleet()).trimEnd()}\n${[
      DAY,
      1,
      "ZZ",
      "USINA ZZ",
      "NUCLEAR",
      "TIPO I",
      "SE ",
      "S",
      "XX",
      "E",
      "5.00",
      "5.00",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ].join(";")}\n`;
    const parsed = parseProgrammeDailyCsv(text);
    expect(parsed.rejected.map((row) => row.reason)).toEqual(["unknown_technology"]);
    expect(parsed.rows).toHaveLength(16 * 48);
  });
});

describe("the programme publication stamp", () => {
  it("falls before the first half hour of the day it programmes, for every patamar", () => {
    const stamp = programmeFilePublishedAt("2026-09-18");
    // 23:00 on D-1 Brasília = 02:00Z on D.
    expect(stamp.toISOString()).toBe("2026-09-18T02:00:00.000Z");
    const parsed = parseProgrammeDailyCsv(dailyCsv("2026-09-18", wholeFleet()));
    for (const row of parsed.rows) {
      expect(stamp.getTime()).toBeLessThan(row.validTime.getTime());
    }
  });

  it("holds on the first day of the history, where the file's own Last-Modified would not", () => {
    // That file is stamped 2024-10-01T04:08Z by S3 — after patamar 1 began at
    // 03:00Z, which the published_at < valid_time constraint forbids.
    const stamp = programmeFilePublishedAt("2024-10-01");
    expect(stamp.getTime()).toBeLessThan(new Date("2024-10-01T03:00:00.000Z").getTime());
    expect(new Date("2024-10-01T04:08:05.000Z").getTime()).toBeGreaterThan(
      new Date("2024-10-01T03:00:00.000Z").getTime(),
    );
  });
});

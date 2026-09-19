import { describe, expect, it } from "bun:test";
import { payloadRefusal } from "../src/errors.js";
import { patamarStart, referenceDayAnchor } from "../src/ingest/ons/dessem-balance.js";
import { parseDessemGeneralCsv } from "../src/ingest/ons/dessem-general.js";
import {
  DESSEM_PATAMAR_DICTIONARY,
  PATAMAR_RESOLUTION,
} from "../src/ingest/ons/patamar.js";

const HEADER =
  "din_programacaodia;num_patamar;cod_subsistema;val_demanda;val_geracao_renovavel;" +
  "val_geracao_hidraulica;val_geracao_termica;val_cons_elevatoria";
const DAY = "2026-09-17";
const SUBSYSTEMS = ["N", "NE", "S", "SE"];

/**
 * A whole generated day. Every field is a different number so a column read
 * into the wrong slot shows up — the values are not physical on purpose.
 */
function wholeDay(
  options: { skip?: (subsystem: string, patamar: number) => boolean } = {},
) {
  const lines: string[] = [];
  for (let patamar = 1; patamar <= 48; patamar += 1) {
    for (const [index, subsystem] of SUBSYSTEMS.entries()) {
      if (options.skip?.(subsystem, patamar)) {
        continue;
      }
      const base = (index + 1) * 1000 + patamar;
      lines.push(
        `${DAY};${patamar};${subsystem};${base}.5;${base + 1}.25;${base + 2}.125;${base + 3}.75;${base + 4}.5`,
      );
    }
  }
  return `${HEADER}\n${lines.join("\n")}\n`;
}

const refusalOf = (text: string) => {
  try {
    parseDessemGeneralCsv(text);
  } catch (error) {
    return payloadRefusal(error);
  }
  return null;
};

describe("the num_patamar dictionary", () => {
  it("names 48 half hours and closes the day at 24:00", () => {
    expect(DESSEM_PATAMAR_DICTIONARY).toHaveLength(48);
    expect(DESSEM_PATAMAR_DICTIONARY[0]).toEqual({
      patamar: 1,
      from: "00:00",
      to: "00:30",
    });
    expect(DESSEM_PATAMAR_DICTIONARY[24]).toEqual({
      patamar: 25,
      from: "12:00",
      to: "12:30",
    });
    expect(DESSEM_PATAMAR_DICTIONARY[47]).toEqual({
      patamar: 48,
      from: "23:30",
      to: "24:00",
    });
  });

  it("agrees with patamarStart for every patamar, so the two cannot drift", () => {
    const { midnightUtc } = referenceDayAnchor(DAY);
    for (const entry of DESSEM_PATAMAR_DICTIONARY) {
      const start = patamarStart(midnightUtc, entry.patamar);
      // Brasília is UTC−3 with no DST in this window.
      const local = new Date(start.getTime() - 3 * 3_600_000);
      const hhmm = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
      expect(hhmm).toBe(entry.from);
    }
  });

  it("does not claim a resolution for programacao_x_previsao", () => {
    expect(PATAMAR_RESOLUTION.dessem_general.kind).toBe("half_hour");
    expect(PATAMAR_RESOLUTION.programacao_x_previsao.kind).toBe("unverified");
  });
});

describe("parseDessemGeneralCsv", () => {
  it("reads a whole day: 4 subsystems x 48 patamares, MW stored as published", () => {
    const parsed = parseDessemGeneralCsv(wholeDay());
    expect(parsed.rows).toHaveLength(192);
    expect(parsed.referenceDay).toBe(DAY);
    expect(parsed.halfHoursInCivilDay).toBe(48);
    const first = parsed.rows.find(
      (row) => row.subsystem === "N" && row.demandMw === 1001.5,
    );
    expect(first).toBeDefined();
    // Patamar 1 is 00:00 Brasília = 03:00Z, the START of the half hour.
    expect(first?.validTime.toISOString()).toBe("2026-09-17T03:00:00.000Z");
    // Each measure lands in its own slot.
    expect(first?.renewableGenerationMw).toBe(1002.25);
    expect(first?.hydroGenerationMw).toBe(1003.125);
    expect(first?.thermalGenerationMw).toBe(1004.75);
    expect(first?.pumpingConsumptionMw).toBe(1005.5);
  });

  it("filters the SIN aggregate row and says how many", () => {
    const parsed = parseDessemGeneralCsv(
      `${wholeDay()}${DAY};1;SIN;1.0;1.0;1.0;1.0;1.0\n`,
    );
    expect(parsed.aggregateRowsFiltered).toBe(1);
    expect(parsed.rows).toHaveLength(192);
  });

  it("refuses a short day as coverage rather than storing a shortfall", () => {
    const refusal = refusalOf(wholeDay({ skip: (_s, patamar) => patamar > 46 }));
    expect(refusal?.refusal).toBe("coverage");
    expect(refusal?.message).toContain("not a whole civil day");
  });

  it("refuses a day with one subsystem missing, naming it", () => {
    const refusal = refusalOf(wholeDay({ skip: (subsystem) => subsystem === "S" }));
    expect(refusal?.refusal).toBe("coverage");
    expect(refusal?.message).toContain("subsystem S");
  });

  it("refuses a day with an interior hole in one subsystem", () => {
    const refusal = refusalOf(
      wholeDay({ skip: (s, patamar) => s === "NE" && patamar === 20 }),
    );
    expect(refusal?.refusal).toBe("coverage");
    expect(refusal?.message).toContain("NE 47/48");
  });

  it("refuses the day when a measure is blank, instead of storing a hole", () => {
    const text = wholeDay().replace(`${DAY};7;SE;4007.5;`, `${DAY};7;SE;;`);
    const refusal = refusalOf(text);
    expect(refusal?.refusal).toBe("coverage");
  });

  it("refuses a patamar outside the civil day as time_axis", () => {
    expect(refusalOf(`${wholeDay()}${DAY};49;N;1;1;1;1;1\n`)?.refusal).toBe("time_axis");
  });

  it("refuses a repeated patamar", () => {
    expect(refusalOf(`${wholeDay()}${DAY};3;N;1;1;1;1;1\n`)?.refusal).toBe("coverage");
  });

  it("refuses a file that mixes two reference days", () => {
    const other = wholeDay().split("\n")[1]?.replace(DAY, "2026-09-18");
    expect(refusalOf(`${wholeDay()}${other}\n`)?.refusal).toBe("coverage");
  });

  it("fails loudly on a renamed column instead of storing nulls", () => {
    const text = wholeDay().replace("val_geracao_hidraulica", "val_ger_hidraulica");
    const refusal = refusalOf(text);
    expect(refusal?.refusal).toBe("schema");
    expect(refusal?.message).toContain("val_geracao_hidraulica");
  });
});

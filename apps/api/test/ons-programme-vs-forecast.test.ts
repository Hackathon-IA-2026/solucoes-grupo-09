import { describe, expect, it } from "bun:test";
import { payloadRefusal } from "../src/errors.js";
import { parseProgrammeVsForecastCsv } from "../src/ingest/ons/programme-vs-forecast.js";
import { type FixtureEntity, pxpCsv } from "./support/programme-fixtures.js";

const DAY = "2026-09-17";

const entities: FixtureEntity[] = [
  { code: "AAAA", programmed: (p) => 100 + p, forecast: (p) => 200 + p },
  {
    code: "BBBB",
    name: "Vento Meridional Oeste I",
    programmed: (p) => 300 + p,
    forecast: (p) => 400 + p,
  },
];

const refusalOf = (text: string) => {
  try {
    parseProgrammeVsForecastCsv(text);
  } catch (error) {
    return payloadRefusal(error);
  }
  return null;
};

describe("programacao_x_previsao · parsing", () => {
  const parsed = parseProgrammeVsForecastCsv(pxpCsv(DAY, entities));

  it("reads YYYYMMDD as the reference day and gives 48 half hours per entity", () => {
    expect(parsed.referenceDay).toBe(DAY);
    expect(parsed.rows).toHaveLength(2 * 48);
    expect(parsed.rejected).toHaveLength(0);
  });

  it("trims the padded code and name, and keeps forecast and programmed in their own slots", () => {
    const first = parsed.rows.find(
      (row) =>
        row.pdpCode === "BBBB" &&
        row.validTime.toISOString() === "2026-09-17T03:00:00.000Z",
    );
    expect(first?.pdpName).toBe("Vento Meridional Oeste I");
    expect(first?.forecastMw).toBe(401);
    expect(first?.programmedMw).toBe(301);
  });

  it("carries no subsystem and no technology — the file has neither", () => {
    expect(Object.keys(parsed.rows[0] ?? {}).sort()).toEqual(
      [
        "forecastMw",
        "pdpCode",
        "pdpName",
        "programmedMw",
        "referenceDay",
        "validTime",
      ].sort(),
    );
  });
});

describe("programacao_x_previsao · refusals", () => {
  it("refuses an entity with a short series — a hole, not a half-sized series", () => {
    const refusal = refusalOf(
      pxpCsv(DAY, entities, { skip: (code, p) => code === "AAAA" && p === 12 }),
    );
    expect(refusal?.refusal).toBe("coverage");
    expect(refusal?.message).toContain("AAAA 47/48");
  });

  it("refuses a day when a value cannot be read, because the entity is then short", () => {
    const text = pxpCsv(DAY, entities).replace(";101.00\n", ";\n");
    expect(refusalOf(text)?.refusal).toBe("coverage");
  });

  it("refuses a repeated entity patamar", () => {
    const text = pxpCsv(DAY, entities);
    expect(refusalOf(`${text.trimEnd()}\n${text.split("\n")[1]}\n`)?.refusal).toBe(
      "coverage",
    );
  });

  it("refuses a reference day that is neither YYYYMMDD nor YYYY-MM-DD", () => {
    expect(
      refusalOf(pxpCsv(DAY, entities).replaceAll("20260917", "17/09/2026"))?.refusal,
    ).toBe("time_axis");
  });

  it("refuses two reference days in one file", () => {
    const text = `${pxpCsv(DAY, entities).trimEnd()}\n${pxpCsv("2026-09-18", entities).split("\n")[1]}\n`;
    expect(refusalOf(text)?.refusal).toBe("coverage");
  });

  it("refuses a renamed column", () => {
    expect(
      refusalOf(pxpCsv(DAY, entities).replace("val_previsao", "val_previsto"))?.refusal,
    ).toBe("schema");
  });
});

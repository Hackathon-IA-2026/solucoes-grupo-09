import { describe, expect, it } from "bun:test";
import { payloadRefusal } from "../src/errors.js";
import { parseDelimited } from "../src/ingest/csv.js";
import {
  availableResourceDays,
  type CatalogueResource,
  selectResourceForDay,
} from "../src/ingest/ons/catalogue.js";
import {
  parseControlledFlowCsv,
  parseControlledFlowTable,
} from "../src/ingest/ons/controlled-flow.js";
import {
  parseProgrammeDailyCsv,
  parseProgrammeDailyTable,
} from "../src/ingest/ons/programme-daily.js";
import { cellOf, tableFromObjects } from "../src/ingest/ons/programme-parquet.js";
import {
  parseProgrammeVsForecastCsv,
  parseProgrammeVsForecastTable,
} from "../src/ingest/ons/programme-vs-forecast.js";
import { dailyCsv, flowCsv, pxpCsv, wholeFleet } from "./support/programme-fixtures.js";

const DAY = "2026-09-17";

/**
 * A CSV as the objects `hyparquet` returns for its Parquet twin, typed the way
 * the real files were measured on 2026-09-19: strings for every value (padding
 * intact), numbers for `num_patamar` and `tip_terminal`, and — in
 * `programacao_diaria` only — a `Date` at UTC midnight for the reference day.
 */
function asParquetObjects(csv: string, options: { dateColumn?: string } = {}) {
  const { columns, rows } = parseDelimited(csv);
  return rows.map((cells) => {
    const object: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const cell = cells[index] ?? "";
      if (column === "num_patamar" || column === "tip_terminal") {
        object[column] = Number(cell);
      } else if (column === options.dateColumn) {
        object[column] = new Date(`${cell}T00:00:00.000Z`);
      } else {
        object[column] = cell;
      }
    });
    return object;
  });
}

describe("Parquet cells read as the string the CSV would have carried", () => {
  it("renders a Date as its UTC calendar day, which is the reference day", () => {
    expect(cellOf(new Date("2026-02-25T00:00:00.000Z"))).toBe("2026-02-25");
  });

  it("keeps a string exactly, padding included", () => {
    expect(cellOf("SE ")).toBe("SE ");
    expect(cellOf("CLUEIC      ")).toBe("CLUEIC      ");
  });

  it("renders numbers, and an absent value as the empty string, never as 0", () => {
    expect(cellOf(48)).toBe("48");
    expect(cellOf(-274.5)).toBe("-274.5");
    expect(cellOf(null)).toBe("");
    expect(cellOf(undefined)).toBe("");
  });

  it("refuses a cell type it has no reading for", () => {
    let refusal: ReturnType<typeof payloadRefusal> = null;
    try {
      cellOf({ nested: true });
    } catch (error) {
      refusal = payloadRefusal(error);
    }
    expect(refusal?.refusal).toBe("schema");
  });

  it("gives an empty table for no rows", () => {
    expect(tableFromObjects([])).toEqual({ columns: [], rows: [] });
  });
});

describe("the Parquet rendition parses to exactly what the CSV does", () => {
  it("programacao_diaria, with its reference day as a Date and patamar as a number", () => {
    const csv = dailyCsv(DAY, wholeFleet());
    const viaParquet = parseProgrammeDailyTable(
      tableFromObjects(asParquetObjects(csv, { dateColumn: "din_programacaodia" })),
    );
    expect(viaParquet).toEqual(parseProgrammeDailyCsv(csv));
  });

  it("programacao_x_previsao", () => {
    const csv = pxpCsv(DAY, [
      { code: "AAAA", programmed: (p) => 100 + p },
      { code: "BBBB", programmed: (p) => 300 + p },
    ]);
    expect(
      parseProgrammeVsForecastTable(tableFromObjects(asParquetObjects(csv))),
    ).toEqual(parseProgrammeVsForecastCsv(csv));
  });

  it("programacao_fluxo_controlado, with the terminal as a number", () => {
    const csv = flowCsv(DAY, [
      { name: "BtB 1", submarket: "SE", load: (p) => -275 + p },
      { name: "Boa Vista", terminal: 2, submarket: "RR", load: (p) => 40 + p },
    ]);
    expect(parseControlledFlowTable(tableFromObjects(asParquetObjects(csv)))).toEqual(
      parseControlledFlowCsv(csv),
    );
  });

  it("a Date that arrived a day early is refused by the file-day check, not stored a day early", async () => {
    // The INT96 hazard, as it would appear here: the same file with the day read
    // as the previous UTC date. `soleReferenceDay` accepts it — it is a valid day —
    // so it is `assertFileIsForDay`, comparing against the day the resource is
    // named for, that refuses it.
    const { assertFileIsForDay } = await import("../src/ingest/ons/programme.js");
    const csv = dailyCsv(DAY, wholeFleet());
    const shifted = asParquetObjects(csv, { dateColumn: "din_programacaodia" }).map(
      (row) => ({
        ...row,
        din_programacaodia: new Date(
          (row.din_programacaodia as Date).getTime() - 24 * 3_600_000,
        ),
      }),
    );
    const parsed = parseProgrammeDailyTable(tableFromObjects(shifted));
    expect(parsed.referenceDay).toBe("2026-09-16");
    expect(() =>
      assertFileIsForDay("programacao_diaria", DAY, parsed.referenceDay),
    ).toThrow(/carries reference day 2026-09-16/);
  });
});

describe("a day that exists only as Parquet is found, and CSV is preferred where both exist", () => {
  const resource = (name: string, format: "CSV" | "PARQUET"): CatalogueResource => ({
    name,
    url: `https://example.invalid/dataset/x/${name}`,
    format,
    lastModified: null,
    firstPublishedAt: null,
    size: null,
  });
  const resources = [
    resource("PROGRAMACAO_X_PREVISAO_2025_04_29.csv", "CSV"),
    resource("PROGRAMACAO_X_PREVISAO_2025_04_29.parquet", "PARQUET"),
    // 2025-04-30 is one of the seven real days published as Parquet only.
    resource("PROGRAMACAO_X_PREVISAO_2025_04_30.parquet", "PARQUET"),
  ];
  const formats = ["CSV", "PARQUET"] as const;
  const prefix = "PROGRAMACAO_X_PREVISAO_";

  it("offers the Parquet-only day; a CSV-only listing would not", () => {
    expect(availableResourceDays(resources, formats, prefix)).toEqual([
      "2025-04-29",
      "2025-04-30",
    ]);
    expect(availableResourceDays(resources, ["CSV"], prefix)).toEqual(["2025-04-29"]);
  });

  it("selects the Parquet file for that day", () => {
    expect(selectResourceForDay(resources, 2025, 4, 30, formats, prefix).format).toBe(
      "PARQUET",
    );
  });

  it("selects the CSV, not the Parquet, for a day that has both", () => {
    expect(selectResourceForDay(resources, 2025, 4, 29, formats, prefix).format).toBe(
      "CSV",
    );
  });
});

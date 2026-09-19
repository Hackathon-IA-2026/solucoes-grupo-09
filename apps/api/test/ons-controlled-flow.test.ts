import { describe, expect, it } from "bun:test";
import { payloadRefusal } from "../src/errors.js";
import {
  availableResourceDays,
  type CatalogueResource,
  selectResourceForDay,
} from "../src/ingest/ons/catalogue.js";
import {
  CONTROLLED_FLOW_FILE_PREFIX,
  parseControlledFlowCsv,
} from "../src/ingest/ons/controlled-flow.js";
import { type FixtureElement, flowCsv } from "./support/programme-fixtures.js";

const DAY = "2026-09-17";

const elements: FixtureElement[] = [
  { name: "BtB 1 CPV - T1", submarket: "SE", load: (p) => -275 + p },
  { name: "Boa Vista", submarket: "RR", load: (p) => 40 + p },
  { name: "LT Norte", terminal: 2, submarket: "N", load: (p) => 1000 + p + 0.5 },
];

const refusalOf = (text: string) => {
  try {
    parseControlledFlowCsv(text);
  } catch (error) {
    return payloadRefusal(error);
  }
  return null;
};

describe("programacao_fluxo_controlado · parsing", () => {
  const parsed = parseControlledFlowCsv(flowCsv(DAY, elements));

  it("reads 3 elements x 48 half hours, element grain", () => {
    expect(parsed.rows).toHaveLength(3 * 48);
    expect(parsed.rejected).toHaveLength(0);
  });

  it("keeps the sign, because it is the direction across the element", () => {
    const first = parsed.rows.find((row) => row.element === "BtB 1 CPV - T1");
    expect(first?.loadMw).toBe(-274);
    expect(first?.validTime.toISOString()).toBe("2026-09-17T03:00:00.000Z");
  });

  it("keeps RR as the submarket it is rather than dropping or forcing it into a subsystem", () => {
    expect(new Set(parsed.rows.map((row) => row.submarket))).toEqual(
      new Set(["SE", "RR", "N"]),
    );
  });

  it("trims the padded submarket code and reads the terminal as a number", () => {
    const north = parsed.rows.find((row) => row.element === "LT Norte");
    expect(north?.submarket).toBe("N");
    expect(north?.terminal).toBe(2);
  });
});

describe("programacao_fluxo_controlado · refusals", () => {
  it("rejects an unknown submarket as a row, and the element is then short so the day is refused", () => {
    const text = flowCsv(DAY, [
      ...elements,
      { name: "Mystery", submarket: "XX", load: () => 1 },
    ]);
    const refusal = refusalOf(text);
    expect(refusal?.refusal).toBe("coverage");
    expect(refusal?.message).toContain("Mystery|1 0/48");
  });

  it("refuses a repeated element patamar", () => {
    const text = flowCsv(DAY, elements);
    expect(refusalOf(`${text.trimEnd()}\n${text.split("\n")[1]}\n`)?.refusal).toBe(
      "coverage",
    );
  });

  it("refuses an element with a short series", () => {
    const lines = flowCsv(DAY, elements).split("\n");
    const cut = lines
      .filter((line) => !line.startsWith(`${DAY};20;Boa Vista`))
      .join("\n");
    expect(refusalOf(cut)?.refusal).toBe("coverage");
  });

  it("refuses a renamed column", () => {
    expect(
      refusalOf(flowCsv(DAY, elements).replace("val_carga", "val_load"))?.refusal,
    ).toBe("schema");
  });
});

/**
 * The resource list of `programacao_fluxo_controlado` really does carry a stray
 * `PROGRAMACAO_DIARIA_2026_07_21.parquet`. That one is a Parquet and the adapter
 * reads CSV only, so it is already excluded by format — which makes it a poor
 * test of the prefix. The stray here is a CSV, the case the prefix exists for.
 */
describe("the file prefix keeps another dataset's file out of the selection", () => {
  const resource = (name: string, format: "CSV" | "PARQUET"): CatalogueResource => ({
    name,
    url: `https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/programacao_fluxo_controlado/${name}`,
    format,
    lastModified: null,
    firstPublishedAt: null,
    size: null,
  });
  const resources = [
    resource("PROGRAMACAO_FLUXO_CONTROLADO_2026_07_20.csv", "CSV"),
    resource("PROGRAMACAO_DIARIA_2026_07_21.csv", "CSV"),
    resource("PROGRAMACAO_DIARIA_2026_07_21.parquet", "PARQUET"),
  ];

  it("does not offer the stray day as available", () => {
    expect(
      availableResourceDays(resources, ["CSV"], CONTROLLED_FLOW_FILE_PREFIX),
    ).toEqual(["2026-07-20"]);
  });

  it("does not select the stray file for its day", () => {
    expect(() =>
      selectResourceForDay(resources, 2026, 7, 21, ["CSV"], CONTROLLED_FLOW_FILE_PREFIX),
    ).toThrow(/No CSV resource found for 2026-07-21/);
  });

  it("would have, without the prefix — so the guard is the thing under test", () => {
    expect(availableResourceDays(resources, ["CSV"])).toEqual([
      "2026-07-20",
      "2026-07-21",
    ]);
    expect(selectResourceForDay(resources, 2026, 7, 21, ["CSV"]).name).toBe(
      "PROGRAMACAO_DIARIA_2026_07_21.csv",
    );
  });
});

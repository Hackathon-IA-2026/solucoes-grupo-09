import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  availableResourceDays,
  readResources,
  selectResourceForDay,
} from "../src/ingest/ons/catalogue.js";
import {
  DESSEM_COVERAGE_START,
  parseDessemBalanceCsv,
  patamarStart,
  referenceDayAnchor,
} from "../src/ingest/ons/dessem-balance.js";

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

// All fixtures captured 2026-08-28/29 from the live sources; see FIXTURES.md.
const DAY = read("BALANCO_DESSEM_DETALHE_2026_08_29.csv");
const FIRST_DAY = read("BALANCO_DESSEM_DETALHE_2025_05_23.head.csv");
const PACKAGE = read("package-show-balanco-dessem-detalhe.trimmed.json");
const HEAD = JSON.parse(read("head-BALANCO_DESSEM_DETALHE_2026_08_29.csv.json")) as {
  headers: Record<string, string>;
};

/** Header plus the rows matching a predicate on the parsed cells. */
const filterRows = (csv: string, keep: (cells: string[]) => boolean): string => {
  const [header, ...lines] = csv.trim().split("\n");
  const kept = lines.filter((line) => keep(line.split(";")));
  return `${header}\n${kept.join("\n")}\n`;
};

/** The one row starting with `prefix`, with its cells rewritten. */
const editRow = (
  csv: string,
  prefix: string,
  edit: (cells: string[]) => string[],
): string => {
  const [header, ...lines] = csv.trim().split("\n");
  const matched = lines.filter((line) => line.startsWith(prefix));
  if (matched.length !== 1) {
    throw new Error(
      `expected exactly one row starting ${prefix}, found ${matched.length}`,
    );
  }
  const rewritten = lines.map((line) =>
    line.startsWith(prefix) ? edit(line.split(";")).join(";") : line,
  );
  return `${header}\n${rewritten.join("\n")}\n`;
};

describe("DESSEM · the published header wins over the data dictionary", () => {
  it("reads val_ger_hidraulica, the name the file actually uses", () => {
    const parse = parseDessemBalanceCsv(DAY);
    expect(parse.columns).toContain("val_ger_hidraulica");
    expect(parse.columns).toContain("val_ger_termica");
    // The dictionary's spelling. If ONS ever "fixes" the file to match it, the
    // adapter must fail loudly rather than store nulls for hydro and thermal.
    expect(parse.columns).not.toContain("val_geracao_hidraulica");
    expect(parse.rows.every((row) => row.hydroGenerationMw > 0)).toBe(true);
  });

  it("fails loudly if the dictionary spelling ever replaces the published one", () => {
    const renamed = DAY.replace("val_ger_hidraulica", "val_geracao_hidraulica");
    expect(() => parseDessemBalanceCsv(renamed)).toThrow(/missing required columns/);
  });

  it("has carried the same header since the first published day", () => {
    // 2025-05-23 is the start of coverage; there is nothing before it. The
    // fixture is a head rather than a whole reference day — it cannot be
    // parsed (an incomplete day is a rejection, by design), so the header is
    // compared as bytes.
    expect(DESSEM_COVERAGE_START).toBe("2025-05-23");
    expect(FIRST_DAY.split("\n")[0]).toBe(DAY.split("\n")[0]);
    expect(() => parseDessemBalanceCsv(FIRST_DAY)).toThrow(/patamares for subsystem/);
  });
});

describe("DESSEM · num_patamar maps to wall-clock time, and it is asserted", () => {
  const parse = parseDessemBalanceCsv(DAY);

  it("puts patamar 1 at the start of the reference day, Brasília", () => {
    const { midnightUtc, halfHours } = referenceDayAnchor("2026-08-29");
    expect(halfHours).toBe(48);
    // 2026-08-29T00:00 in America/Sao_Paulo is 03:00Z — Brazil has had no DST
    // since 2019, and the day length is measured rather than assumed.
    expect(midnightUtc.toISOString()).toBe("2026-08-29T03:00:00.000Z");
    expect(patamarStart(midnightUtc, 1).toISOString()).toBe("2026-08-29T03:00:00.000Z");
    // Patamar k is the half hour *ending* 00:00 + k×30 min local, so it starts
    // half an hour earlier: patamar 48 is 23:30–00:00 local on the reference day.
    expect(patamarStart(midnightUtc, 48).toISOString()).toBe("2026-08-30T02:30:00.000Z");
  });

  it("stores the START of each half hour, as every other adapter does", () => {
    const se = parse.rows
      .filter((row) => row.subsystem === "SE")
      .sort((a, b) => a.validTime.getTime() - b.validTime.getTime());
    expect(se).toHaveLength(48);
    expect(se[0]?.validTime.toISOString()).toBe("2026-08-29T03:00:00.000Z");
    expect(se.at(-1)?.validTime.toISOString()).toBe("2026-08-30T02:30:00.000Z");
  });

  it("agrees with /cargaprogramada for the same day, half hour by half hour", () => {
    // The mapping is ONS-undocumented and was inferred from one day. This is the
    // independent numeric check, on a *different* day from the research's, and
    // it is what the daylight assertion inside the adapter cannot do: the carga
    // API labels the interval END, so a DESSEM row's valid time plus 30 minutes
    // must be the carga row's `din_referenciautc`.
    const programmed = JSON.parse(read("carga-programada-SECO-2026-08-29.json")) as {
      din_referenciautc: string;
      val_cargaglobalprogramada: number;
    }[];
    const byEnd = new Map(
      programmed.map((row) => [
        new Date(row.din_referenciautc).toISOString(),
        row.val_cargaglobalprogramada,
      ]),
    );

    const compared = parse.rows
      .filter((row) => row.subsystem === "SE")
      .map((row) => {
        const end = new Date(row.validTime.getTime() + 30 * 60_000).toISOString();
        const carga = byEnd.get(end);
        expect(carga).toBeDefined();
        return Math.abs(row.demandMw - (carga as number)) / (carga as number);
      });

    expect(compared).toHaveLength(48);
    // Measured agreement across the whole day: worst half hour 0.07%. A
    // half-hour slip would show as a step change between neighbours, which at
    // dawn is several percent.
    expect(Math.max(...compared)).toBeLessThan(0.001);
  });

  it("rejects a file whose solar sits outside daylight", () => {
    // Shift every patamar by six hours: solar noon lands at 18:00 local, and
    // the night window fills with generation. This is the failure mode the
    // inferred mapping has — an offset — and the adapter must not store it.
    const shifted = DAY.replace(
      /^(2026-08-29;)(\d+)(;)/gm,
      (_match, prefix: string, patamar: string, suffix: string) =>
        `${prefix}${((Number(patamar) + 11) % 48) + 1}${suffix}`,
    );
    expect(() => parseDessemBalanceCsv(shifted)).toThrow(
      /photovoltaic generation in local night hours/,
    );
  });

  it("accepts MMGD running after dark, because MMGD is not photovoltaic", () => {
    // The three days this recovers, in miniature. `val_ger_mmgd` is micro and
    // mini distributed generation — mostly rooftop PV, but carrying small
    // hydro, biogas and cogeneration that run at night — so 6 MW of it at
    // local 21:00 says nothing about the patamar mapping. Measured on
    // 2025-10-18, 2025-12-03 and 2025-12-24, each a complete 48-patamar day
    // with `val_ger_fotovoltaica` exactly 0.000 all evening and a lone 3–6 MW
    // MMGD blip with zeros on both sides of it (data-platform 25). The old
    // assertion summed the two columns and refused all three.
    const mmgdAtNight = editRow(DAY, "2026-08-29;43;N;", (cells) => {
      cells[10] = "6.000";
      return cells;
    });
    const parse = parseDessemBalanceCsv(mmgdAtNight);
    expect(parse.rows).toHaveLength(192);
    const night = parse.rows.find(
      (row) =>
        row.subsystem === "N" &&
        row.validTime.toISOString() === "2026-08-30T00:00:00.000Z",
    );
    expect(night?.mmgdGenerationMw).toBe(6);
    expect(night?.solarGenerationMw).toBe(0);
  });

  it("still refuses photovoltaic output in the same half hour", () => {
    // The guard got sharper, not looser: the column that must be zero at night
    // still is, and putting anything in it refuses the day.
    const pvAtNight = editRow(DAY, "2026-08-29;43;N;", (cells) => {
      cells[9] = "6.000";
      return cells;
    });
    expect(() => parseDessemBalanceCsv(pvAtNight)).toThrow(
      /6 MW of photovoltaic generation in local night hours/,
    );
  });
});

describe("DESSEM · a reference day with the wrong number of periods is rejected", () => {
  it("takes 48 patamares × 4 subsystems as the whole day", () => {
    const parse = parseDessemBalanceCsv(DAY);
    expect(parse.rows).toHaveLength(192);
    expect(parse.patamaresPerSubsystem).toBe(48);
    expect(parse.referenceDay).toBe("2026-08-29");
    expect(parse.rejected).toEqual([]);
    expect(parse.aggregateRowsFiltered).toBe(0);
  });

  it("throws when a subsystem is one patamar short", () => {
    const short = filterRows(DAY, (cells) => !(cells[2] === "SE" && cells[1] === "17"));
    expect(() => parseDessemBalanceCsv(short)).toThrow(/47 patamares for subsystem SE/);
  });

  it("throws when a patamar falls outside the local civil day", () => {
    const beyond = DAY.replace("2026-08-29;48;SE;", "2026-08-29;49;SE;");
    expect(() => parseDessemBalanceCsv(beyond)).toThrow(/outside the 48 half hours/);
  });

  it("throws when a patamar is repeated", () => {
    const repeated = DAY.replace("2026-08-29;2;SE;", "2026-08-29;1;SE;");
    expect(() => parseDessemBalanceCsv(repeated)).toThrow(/repeats patamar 1/);
  });

  it("throws when one file carries more than one reference day", () => {
    const twoDays = DAY.replace("2026-08-29;1;N;", "2026-08-30;1;N;");
    expect(() => parseDessemBalanceCsv(twoDays)).toThrow(/covers 2 reference days/);
  });
});

describe("DESSEM · values are power, not average power", () => {
  it("stores MW verbatim — no MWmed conversion", () => {
    const parse = parseDessemBalanceCsv(DAY);
    const first = parse.rows.find(
      (row) =>
        row.subsystem === "N" &&
        row.validTime.toISOString() === "2026-08-29T03:00:00.000Z",
    );
    // The file's first data row, read straight across: 10129.730 MW of demand.
    // Halving it (the MWmed→MWh rule the hourly adapters apply) would be wrong.
    expect(first?.demandMw).toBe(10_129.73);
    expect(first?.hydroGenerationMw).toBe(2986.36);
    expect(first?.windGenerationMw).toBe(395);
    expect(first?.pumpingConsumptionMw).toBe(0);
  });

  it("carries the wind and solar expectation that exists in no other source", () => {
    const parse = parseDessemBalanceCsv(DAY);
    const wind = parse.rows.filter((row) => row.windGenerationMw > 0);
    const solar = parse.rows.filter((row) => row.solarGenerationMw > 0);
    expect(wind.length).toBe(192);
    expect(solar.length).toBeGreaterThan(0);
  });

  it("rejects an empty measure as a row rather than reading it as zero", () => {
    const blanked = DAY.replace("2026-08-29;1;N;10129.730;", "2026-08-29;1;N;;");
    const parse = parseDessemBalanceCsv(blanked);
    expect(parse.rows).toHaveLength(191);
    expect(parse.rejected).toEqual([
      { reason: "empty_value", rowNumber: 1, detail: "val_demanda is present but empty" },
    ]);
  });
});

describe("DESSEM · it is a forecast, and the file says so", () => {
  it("was published before every half hour it describes", () => {
    // The captured S3 HEAD is the row's `published_at`: file-grained, because
    // ONS stamps no DESSEM row individually.
    const publishedAt = new Date(HEAD.headers["last-modified"] as string);
    expect(publishedAt.toISOString()).toBe("2026-08-28T19:42:43.000Z");

    const parse = parseDessemBalanceCsv(DAY);
    const earliest = Math.min(...parse.rows.map((row) => row.validTime.getTime()));
    expect(publishedAt.getTime()).toBeLessThan(earliest);

    // Lead time to the first half hour of the reference day: derived, never
    // stored. ~7.3 h, which is what puts DESSEM inside `gate_late`
    // (D−1 19:00 BRT = 22:00Z) and outside `gate_early` (D−1 09:00 BRT).
    const leadMinutes = (earliest - publishedAt.getTime()) / 60_000;
    expect(leadMinutes).toBeGreaterThan(60);
    const gateLate = new Date("2026-08-28T22:00:00.000Z");
    expect(publishedAt.getTime()).toBeLessThan(gateLate.getTime());
    const gateEarly = new Date("2026-08-28T12:00:00.000Z");
    expect(publishedAt.getTime()).toBeGreaterThan(gateEarly.getTime());
  });

  it("labels every row with the reference day that produced it", () => {
    const parse = parseDessemBalanceCsv(DAY);
    expect(parse.rows.every((row) => row.referenceDay === "2026-08-29")).toBe(true);
  });
});

describe("DESSEM · daily-split discovery", () => {
  const resources = readResources(JSON.parse(PACKAGE));

  it("lists reference days rather than constructing them", () => {
    const days = availableResourceDays(resources, ["CSV"]);
    expect(days).toEqual(["2025-05-23", "2025-05-24", "2026-08-28", "2026-08-29"]);
    expect(days[0]).toBe(DESSEM_COVERAGE_START);
  });

  it("selects the resource for one day, from the URL CKAN published", () => {
    const resource = selectResourceForDay(resources, 2026, 8, 29, ["CSV"]);
    expect(resource.url).toContain("BALANCO_DESSEM_DETALHE_2026_08_29.csv");
    expect(resource.format).toBe("CSV");
  });

  it("throws for a day ONS never published rather than fabricating a URL", () => {
    expect(() => selectResourceForDay(resources, 2025, 5, 22, ["CSV"])).toThrow(
      /No CSV resource found for 2025-05-22/,
    );
  });
});

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { payloadRefusal } from "../src/errors.js";
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

/** The refusal a throw declared, or null when the throw was not a refusal. */
const refusalOf = (run: () => unknown): string | null => {
  try {
    run();
  } catch (error) {
    return payloadRefusal(error)?.refusal ?? null;
  }
  return null;
};

/** Keep only the patamares in `[first, last]`, in **every** subsystem. */
const truncateTo = (csv: string, first: number, last: number): string =>
  filterRows(csv, (cells) => {
    const patamar = Number(cells[1]);
    return patamar >= first && patamar <= last;
  });

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
    // Two patamares is a truncation, and since data-platform 29 a truncation is
    // admissible — but only one that reaches midday, which two patamares of
    // local night cannot. The refusal names that, and stays `coverage`.
    expect(() => parseDessemBalanceCsv(FIRST_DAY)).toThrow(/midday window/);
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
    expect(parse.halfHoursInCivilDay).toBe(48);
    expect(parse.complete).toBe(true);
    expect(parse.referenceDay).toBe("2026-08-29");
    expect(parse.rejected).toEqual([]);
    expect(parse.aggregateRowsFiltered).toBe(0);
  });

  it("throws when a subsystem has an interior hole", () => {
    // The shape that has never been observed in 470 published days, and the
    // one the whole change rests on not existing: a truncation is readable
    // because patamar k means the same half hour either way, a day with a hole
    // in it establishes nothing about the patamares on either side of it.
    const holed = filterRows(DAY, (cells) => cells[1] !== "17");
    expect(() => parseDessemBalanceCsv(holed)).toThrow(/not one contiguous run/);
    expect(() => parseDessemBalanceCsv(holed)).toThrow(/interior hole/);
    expect(refusalOf(() => parseDessemBalanceCsv(holed))).toBe("coverage");
  });

  it("throws when subsystems disagree by more than the ragged edge", () => {
    // One half hour at an end is a patamar ONS half wrote, and is dropped as a
    // fragment below. Four is not: this file's subsystems stop two hours apart,
    // which nothing about a truncation explains, and reading only the shared
    // run would silently discard four whole half hours of three subsystems.
    const lopsided = filterRows(
      DAY,
      (cells) => !(cells[2] === "SE" && Number(cells[1]) > 44),
    );
    expect(() => parseDessemBalanceCsv(lopsided)).toThrow(
      /disagrees between subsystems by more than one half hour/,
    );
    expect(refusalOf(() => parseDessemBalanceCsv(lopsided))).toBe("coverage");
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

  it("throws on a file with a header and no rows at all", () => {
    const headerOnly = `${DAY.trim().split("\n")[0]}\n`;
    expect(() => parseDessemBalanceCsv(headerOnly)).toThrow(/covers 0 reference days/);
    expect(refusalOf(() => parseDessemBalanceCsv(headerOnly))).toBe("coverage");
  });

  it("throws when every row is filtered away at the boundary", () => {
    // The coverage rule's own empty input: a file that names a reference day
    // and leaves nothing to count once the aggregate rows are dropped. A
    // permissive reading here would admit a day with no half hours in it.
    const aggregateOnly = filterRows(
      DAY,
      (cells) => cells[1] === "1" && cells[2] === "SE",
    ).replace(";SE;", ";SIN;");
    expect(() => parseDessemBalanceCsv(aggregateOnly)).toThrow(
      /carries no subsystem rows/,
    );
    expect(refusalOf(() => parseDessemBalanceCsv(aggregateOnly))).toBe("coverage");
  });
});

/**
 * The 29 days this platform used to throw away.
 *
 * Data-platform 25 measured the shape of all 34 short days ONS has published
 * and 29 of them are readable: a contiguous prefix or suffix, short in every
 * subsystem, with the solar profile sitting exactly where the daylight
 * assertion requires. The fixtures here are that shape, cut from a real whole
 * day, and the refusals that remain are the three that are not that shape.
 */
describe("DESSEM · a day ONS published short is admitted, and says so", () => {
  it("admits a contiguous prefix and states how short it is", () => {
    // 2026-01-14's shape, on 2026-08-29's numbers: patamares 1…46 in all four
    // subsystems, which is 34 of the 34 measured days' defining property.
    const prefix = truncateTo(DAY, 1, 46);
    const parse = parseDessemBalanceCsv(prefix);

    expect(parse.rows).toHaveLength(46 * 4);
    expect(parse.patamaresPerSubsystem).toBe(46);
    expect(parse.halfHoursInCivilDay).toBe(48);
    expect(parse.complete).toBe(false);
    // The pair is on every row, because the row is where the read filters.
    expect(
      parse.rows.every(
        (row) => row.referenceDayPatamares === 46 && row.referenceDayHalfHours === 48,
      ),
    ).toBe(true);
    // A truncation, not a shift: patamar 1 is still local midnight.
    expect(parse.rows[0]?.validTime.toISOString()).toBe("2026-08-29T03:00:00.000Z");
  });

  it("admits a contiguous suffix", () => {
    // 2025-09-18's shape: 15…48, a publication that starts partway through.
    const suffix = truncateTo(DAY, 15, 48);
    const parse = parseDessemBalanceCsv(suffix);

    expect(parse.patamaresPerSubsystem).toBe(34);
    expect(parse.complete).toBe(false);
    expect(parse.rows).toHaveLength(34 * 4);
    // Patamar 15 is 07:00–07:30 local, and it is still patamar 15.
    const earliest = parse.rows.map((row) => row.validTime.toISOString()).toSorted()[0];
    expect(earliest).toBe("2026-08-29T10:00:00.000Z");
  });

  it("leaves a whole day's rows saying they are whole", () => {
    const parse = parseDessemBalanceCsv(DAY);
    expect(
      parse.rows.every(
        (row) => row.referenceDayPatamares === 48 && row.referenceDayHalfHours === 48,
      ),
    ).toBe(true);
  });

  it("refuses a run that never reaches midday, and keeps calling it coverage", () => {
    // The five days that stay refused, by shape. Their index cannot be pinned:
    // nothing in the file says what half hour its rows belong to, so admitting
    // them would be admitting values whose meaning is a guess. `time_axis`
    // would be the wrong name — the axis is not known to be wrong, it is
    // unknowable — so the reason stays `coverage`.
    for (const [first, last] of [
      [1, 13], // 2025-08-16
      [32, 48], // 2025-08-27
      [42, 48], // 2025-08-09
      [44, 48], // 2026-01-09
      [45, 48], // 2025-09-03
    ] as const) {
      const cut = truncateTo(DAY, first, last);
      expect(() => parseDessemBalanceCsv(cut)).toThrow(/midday window/);
      expect(refusalOf(() => parseDessemBalanceCsv(cut))).toBe("coverage");
    }
  });

  it("admits the shortest run that does reach midday, and no shorter", () => {
    // Patamares 19…30 are the midday window itself. One patamar on either side
    // of it is the boundary, and the boundary is where an off-by-one would sit.
    expect(parseDessemBalanceCsv(truncateTo(DAY, 19, 19)).patamaresPerSubsystem).toBe(1);
    expect(parseDessemBalanceCsv(truncateTo(DAY, 30, 30)).patamaresPerSubsystem).toBe(1);
    expect(() => parseDessemBalanceCsv(truncateTo(DAY, 1, 18))).toThrow(/midday window/);
    expect(() => parseDessemBalanceCsv(truncateTo(DAY, 31, 48))).toThrow(/midday window/);
  });

  it("drops the half-written last patamar and counts the day without it", () => {
    // 2025-07-19's real shape, measured from the retained payload: N and NE
    // stop at 26, S and SE carry a 27th whose small hydro, small thermal and
    // wind have collapsed while demand and hydro continue. Eleven of the 34
    // short days are ragged exactly like this. The day is the run every
    // subsystem carries, and the fragment is rejected rather than stored —
    // storing it would make one reference day 26 half hours in two subsystems
    // and 27 in the other two, and would feed a fabricated near-zero wind half
    // hour to the series this dataset exists for.
    const ragged = filterRows(DAY, (cells) => {
      const patamar = Number(cells[1]);
      const subsystem = cells[2] as string;
      return (
        patamar <= 26 || (patamar === 27 && (subsystem === "S" || subsystem === "SE"))
      );
    });
    const parse = parseDessemBalanceCsv(ragged);

    expect(parse.patamaresPerSubsystem).toBe(26);
    expect(parse.complete).toBe(false);
    expect(parse.rows).toHaveLength(26 * 4);
    expect(parse.rows.every((row) => row.referenceDayPatamares === 26)).toBe(true);
    // Rejected, not silently dropped: two rows, both naming patamar 27.
    expect(parse.rejected).toHaveLength(2);
    expect(parse.rejected.every((row) => row.reason === "incomplete_patamar")).toBe(true);
    expect(parse.rejected[0]?.detail).toContain("num_patamar=27");
    expect(parse.rejected[0]?.detail).toContain("1…26");
    // And no row of the stored day is in the 27th half hour.
    const latest = Math.max(...parse.rows.map((row) => row.validTime.getTime()));
    expect(new Date(latest).toISOString()).toBe("2026-08-29T15:30:00.000Z");
  });

  it("drops a ragged edge at the start of a suffix day too", () => {
    const ragged = filterRows(DAY, (cells) => {
      const patamar = Number(cells[1]);
      const subsystem = cells[2] as string;
      return patamar >= 16 || (patamar === 15 && subsystem === "N");
    });
    const parse = parseDessemBalanceCsv(ragged);
    expect(parse.patamaresPerSubsystem).toBe(33);
    expect(parse.rows).toHaveLength(33 * 4);
    expect(parse.rejected).toEqual([
      {
        reason: "incomplete_patamar",
        rowNumber: 1,
        detail:
          "num_patamar=15 is carried by subsystem N and not by every subsystem; " +
          "reference day 2026-08-29 is the run 16…48",
      },
    ]);
  });

  it("still holds the daylight assertion over a partial day", () => {
    // Admission is not a waiver. A short day whose midday carries no solar at
    // all fails the same assertion a whole day would, for `time_axis` — which
    // is the right name there, because the profile *is* present and *is* wrong.
    const noon = truncateTo(DAY, 1, 46);
    const dark = noon
      .split("\n")
      .map((line) => {
        const cells = line.split(";");
        const patamar = Number(cells[1]);
        if (patamar >= 19 && patamar <= 30) {
          cells[9] = "0.000";
          cells[10] = "0.000";
          return cells.join(";");
        }
        return line;
      })
      .join("\n");
    expect(() => parseDessemBalanceCsv(dark)).toThrow(
      /no solar generation in local midday hours/,
    );
    expect(refusalOf(() => parseDessemBalanceCsv(dark))).toBe("time_axis");
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

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readResources, selectResourceForYear } from "../src/ingest/ons/catalogue.js";
import {
  DAILY_LOAD_FORMATS,
  LOAD_METHODOLOGY_REGIMES,
  parseDailyLoadCsv,
  regimeForDate,
} from "../src/ingest/ons/daily-load.js";
import { localDayInterval } from "../src/ingest/time.js";
import packageShow from "./fixtures/ons/package-show-carga-energia.json" with {
  type: "json",
};

// Seam 1 — the daily-load adapter, driven by real payloads captured from ONS on
// 2026-08-28. Provenance is in `fixtures/ons/FIXTURES.md`.
//
// The finding this file exists to defend: ONS redefined what this series
// *means* on 2021-03-01 and again on 2023-04-29, with no column change either
// time. The numbers either side of a boundary are not comparable, and nothing
// in the file says so.

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const csv = (name: string) => Bun.file(join(FIXTURES, name)).text();

describe("carga-energia · catalogue", () => {
  const resources = readResources(packageShow);

  it("picks the CSV rendition for a year", () => {
    const chosen = selectResourceForYear(resources, 2026, DAILY_LOAD_FORMATS);
    expect(chosen.format).toBe("CSV");
    expect(chosen.url).toEndWith("CARGA_ENERGIA_2026.csv");
    // `carga-energia` → `carga_energia_di`: the S3 segment is not the slug.
    expect(chosen.url).toContain("/dataset/carga_energia_di/");
  });
});

describe("carga-energia · the definitional regimes", () => {
  it("names three regimes, newest first", () => {
    expect(LOAD_METHODOLOGY_REGIMES.map((r) => r.regime)).toEqual([
      "WITH_MMGD",
      "WITH_NON_DISPATCHED",
      "DISPATCHED_ONLY",
    ]);
    expect(LOAD_METHODOLOGY_REGIMES.at(-1)?.startsOn).toBeNull();
  });

  it("puts the boundaries exactly where ONS's notes put them", () => {
    expect(regimeForDate("2021-02-28")).toBe("DISPATCHED_ONLY");
    expect(regimeForDate("2021-03-01")).toBe("WITH_NON_DISPATCHED");
    expect(regimeForDate("2023-04-28")).toBe("WITH_NON_DISPATCHED");
    // The second break is mid-month, which is exactly why it is a date and not
    // a year or a month.
    expect(regimeForDate("2023-04-29")).toBe("WITH_MMGD");
    expect(regimeForDate("2000-01-01")).toBe("DISPATCHED_ONLY");
  });

  it("stamps the regime on every row across the 2021 break", async () => {
    const parsed = parseDailyLoadCsv(await csv("CARGA_ENERGIA_2021.regime.csv"));
    expect(parsed.rejected).toEqual([]);
    const byDay = new Map(
      parsed.rows.map((row) => [
        `${row.subsystem}|${row.validTime.toISOString()}`,
        row.methodologyRegime,
      ]),
    );
    expect(byDay.get("SE|2021-02-28T03:00:00.000Z")).toBe("DISPATCHED_ONLY");
    expect(byDay.get("SE|2021-03-01T03:00:00.000Z")).toBe("WITH_NON_DISPATCHED");
  });

  it("stamps the regime on every row across the 2023 break", async () => {
    const parsed = parseDailyLoadCsv(await csv("CARGA_ENERGIA_2023.regime.csv"));
    expect(parsed.rejected).toEqual([]);
    const byDay = new Map(
      parsed.rows.map((row) => [
        `${row.subsystem}|${row.validTime.toISOString()}`,
        row.methodologyRegime,
      ]),
    );
    expect(byDay.get("N|2023-04-28T03:00:00.000Z")).toBe("WITH_NON_DISPATCHED");
    expect(byDay.get("N|2023-04-29T03:00:00.000Z")).toBe("WITH_MMGD");
    // The level shift is real and visible in the fixture: SE drops from
    // 41 438 to 38 139 MWmed on the day MMGD entered the definition. A model
    // that reads that as the grid changing is wrong, and the stamp is what
    // makes the alternative reading available.
    const before = parsed.rows.find(
      (row) =>
        row.subsystem === "SE" &&
        row.validTime.toISOString() === "2023-04-28T03:00:00.000Z",
    );
    const after = parsed.rows.find(
      (row) =>
        row.subsystem === "SE" &&
        row.validTime.toISOString() === "2023-04-29T03:00:00.000Z",
    );
    expect(before?.methodologyRegime).not.toBe(after?.methodologyRegime);
  });
});

describe("carga-energia · interval labelling and the local day", () => {
  it("labels a bare date as the first instant of that local day, UTC", async () => {
    const parsed = parseDailyLoadCsv(await csv("CARGA_ENERGIA_2000.head.csv"));
    // 2000-01-01 is inside horário de verão: UTC−2, not −3. A fixed offset
    // would put this an hour out, exactly as it would for the balanço.
    expect(parsed.rows[0]?.validTime.toISOString()).toBe("2000-01-01T02:00:00.000Z");
    expect(parsed.rows[0]?.subsystem).toBe("N");
  });

  it("converts MWmed with the length the local day actually had", async () => {
    const parsed = parseDailyLoadCsv(await csv("CARGA_ENERGIA_2018.dst.csv"));
    expect(parsed.rejected).toEqual([]);

    const short = parsed.rows.find(
      (row) => row.subsystem === "N" && row.dayMinutes === 1380,
    );
    // 2018-11-04 is the spring-forward day: local midnight never happened, the
    // day is 23 hours long, and ONS's own value is a mean over 46 half-hours —
    // visible in its repeating decimal, 4838.64947826. The row is stamped at
    // 01:00 BRT, the first instant the day existed.
    expect(short?.validTime.toISOString()).toBe("2018-11-04T03:00:00.000Z");
    expect(short?.loadMwh).toBeCloseTo(4838.649_478_26 * 23, 6);

    // 2018-02-17 is the fall-back day: 23:00 happened twice, so it ran 25 hours.
    const long = parsed.rows.find(
      (row) => row.subsystem === "N" && row.dayMinutes === 1500,
    );
    expect(long?.validTime.toISOString()).toBe("2018-02-17T02:00:00.000Z");
    expect(long?.loadMwh).toBeCloseTo(5325.914_958_33 * 25, 6);

    // The day is kept, not rejected. Rejecting a DST gap here would throw away
    // a real day of load for four subsystems.
    expect(parsed.rows.filter((row) => row.dayMinutes === 1380)).toHaveLength(4);
    expect(parsed.irregularDays).toBe(8);
  });

  it("distinguishes the 23-hour day from the 25-hour one", () => {
    // Brazil moved its clocks at midnight, so the transition lands *inside* the
    // day before: 2018-02-17 ran 25 hours (23:00 happened twice) and
    // 2018-11-04 ran 23 (midnight never happened).
    const long = localDayInterval({ year: 2018, month: 2, day: 17 });
    expect(long?.minutes).toBe(1500);
    expect(long?.midnightSkipped).toBe(false);
    expect(long?.start.toISOString()).toBe("2018-02-17T02:00:00.000Z");

    const short = localDayInterval({ year: 2018, month: 11, day: 4 });
    expect(short?.minutes).toBe(1380);
    expect(short?.midnightSkipped).toBe(true);
    expect(short?.start.toISOString()).toBe("2018-11-04T03:00:00.000Z");
  });

  it("is a plain 1440 in the modern fixed-offset era", () => {
    const day = localDayInterval({ year: 2026, month: 1, day: 1 });
    expect(day).toEqual({
      start: new Date("2026-01-01T03:00:00.000Z"),
      minutes: 1440,
      midnightSkipped: false,
    });
  });

  it("rolls the month and the year without calendar arithmetic", () => {
    expect(localDayInterval({ year: 2024, month: 2, day: 29 })?.minutes).toBe(1440);
    expect(
      localDayInterval({ year: 2025, month: 12, day: 31 })?.start.toISOString(),
    ).toBe("2025-12-31T03:00:00.000Z");
  });
});

describe("carga-energia · the negative cases", () => {
  const header = "id_subsistema;nom_subsistema;din_instante;val_cargaenergiamwmed";

  it("fails the whole file when a required column is absent", () => {
    expect(() =>
      parseDailyLoadCsv("id_subsistema;nom_subsistema;din_instante\nN;Norte;2026-01-01"),
    ).toThrow(/val_cargaenergiamwmed/);
  });

  it("rejects a din_instante that is not a bare date", () => {
    // A grain change must not be read as a midnight.
    const parsed = parseDailyLoadCsv(`${header}\nN;Norte;2026-01-01 00:00:00;1000`);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.rejected[0]?.reason).toBe("unparsable_timestamp");
    expect(parsed.rejected[0]?.detail).toContain("bare date");
  });

  it("rejects an empty value, never reading it as zero", () => {
    const parsed = parseDailyLoadCsv(`${header}\nN;Norte;2026-01-01;`);
    expect(parsed.rejected[0]).toEqual({
      reason: "empty_value",
      rowNumber: 1,
      detail: "val_cargaenergiamwmed is present but empty",
    });
  });

  it("rejects a SIN row rather than filtering it, because none has ever appeared", () => {
    // The balanço filters `SIN` as an aggregate; this dataset has never
    // published one, so its arrival is a change worth surfacing.
    const parsed = parseDailyLoadCsv(`${header}\nSIN;SIN;2026-01-01;1000`);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.rejected[0]?.reason).toBe("unknown_subsystem");
  });

  it("rejects a repeated subsystem-day rather than losing it to the primary key", () => {
    const parsed = parseDailyLoadCsv(
      `${header}\nN;Norte;2026-01-01;1000\nN;Norte;2026-01-01;2000`,
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rejected[0]?.reason).toBe("duplicate_key");
  });

  it("reads title-case names without ever keying on them", async () => {
    // `nom_subsistema` is `Norte` here, `NORTE` in the interchange files and
    // `SUDESTE/CENTRO-OESTE` in the balanço. Three dialects, no join key.
    const text = await csv("CARGA_ENERGIA_2000.head.csv");
    expect(text).toContain("Sudeste/Centro-Oeste");
    const parsed = parseDailyLoadCsv(text);
    expect(new Set(parsed.rows.map((row) => row.subsystem))).toEqual(
      new Set(["N", "NE", "S", "SE"]),
    );
  });
});

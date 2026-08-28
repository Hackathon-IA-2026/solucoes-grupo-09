import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadInputError } from "../src/errors.js";
import {
  AREA_CODE_FOR_SUBSYSTEM,
  assertCoverage,
  chunkDateRange,
  EmptyLoadResponseError,
  fetchLoadRange,
  LOAD_AREA_CODES,
  type LoadAreaCode,
  loadRequestUrl,
  parseTolerantJson,
  type RawLoadRow,
  resolveAreaCode,
  TruncatedLoadResponseError,
} from "../src/ingest/ons/carga-api.js";
import { parseProgrammedLoad, parseVerifiedLoad } from "../src/ingest/ons/load.js";

// Seam 1 — the source adapter, fixture-driven. Every fixture is a real captured
// payload from `https://apicarga.ons.org.br/prd`, dated 2026-08-28; see
// `fixtures/ons/FIXTURES.md` for the exact URLs.
//
// This adapter's whole risk profile is silence: every trap below returns HTTP
// 200 and something that looks like an answer.
const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const VERIFIED = read("carga-verificada-SECO-2026-08-01.json");
const VERIFIED_MALFORMED = read("carga-verificada-SECO-2018-06-01.malformed.json");
const VERIFIED_EMPTY = read("carga-verificada-SE-2026-08-01.empty.json");
const VERIFIED_AREA = read("carga-verificada-RJ-2026-08-01.json");
const PROGRAMMED = read("carga-programada-SECO-2026-08-01.json");

const rowsOf = (text: string): RawLoadRow[] =>
  parseTolerantJson(text).value as RawLoadRow[];

/** A fetch that answers every call with one canned body. */
const stubFetch = (body: string, status = 200): typeof fetch =>
  (async () => new Response(body, { status })) as typeof fetch;

describe("carga API · SECO is not SE, and SE is not an error", () => {
  it("addresses the south-east as SECO", () => {
    expect(AREA_CODE_FOR_SUBSYSTEM.SE).toBe("SECO");
    const url = loadRequestUrl("VERIFIED", AREA_CODE_FOR_SUBSYSTEM.SE, {
      from: "2026-08-01",
      to: "2026-08-01",
    });
    expect(url).toContain("cod_areacarga=SECO");
    expect(url).not.toContain("cod_areacarga=SE&");
  });

  it("refuses SE before it can be sent, and says why", () => {
    // The familiar code from every other ONS dataset. It is not in this API's
    // domain, and the API answers it with a 200 rather than a 400.
    expect(() => resolveAreaCode("SE")).toThrow(BadInputError);
    expect(() => resolveAreaCode("SE")).toThrow(/'SECO'/);
  });

  it("proves the trap on the recorded payload: SE returned 200 and no rows", () => {
    // This is the captured response to `cod_areacarga=SE`, not a stand-in.
    const rows = rowsOf(VERIFIED_EMPTY);
    expect(rows).toEqual([]);
    // Parsed happily, and would have been "a quarter of the country has no load".
    expect(parseVerifiedLoad(rows).rows).toEqual([]);
  });

  it("treats an empty response for a covered period as a failure", async () => {
    const request = {
      series: "VERIFIED" as const,
      areaCode: "SECO" as LoadAreaCode,
      range: { from: "2026-08-01", to: "2026-08-01" },
      fetch: stubFetch(VERIFIED_EMPTY),
    };
    expect(fetchLoadRange(request)).rejects.toThrow(EmptyLoadResponseError);
  });

  it("does not treat an empty response before the series began as a failure", () => {
    // `/cargaverificada` starts 2016-01-01; nothing before it is a silent miss.
    expect(() =>
      assertCoverage(
        {
          series: "VERIFIED",
          areaCode: "SECO",
          range: { from: "2015-01-01", to: "2015-01-31" },
        },
        [],
        "https://example.invalid",
      ),
    ).not.toThrow();
  });

  it("carries all 33 published area codes, and SE is not among them", () => {
    expect(LOAD_AREA_CODES).toHaveLength(33);
    expect(LOAD_AREA_CODES).toContain("SECO");
    expect([...LOAD_AREA_CODES]).not.toContain("SE");
  });
});

describe("carga API · the three-month limit", () => {
  it("splits a year into four calls, none longer than three months", () => {
    const chunks = chunkDateRange({ from: "2026-01-01", to: "2026-12-31" });
    expect(chunks).toEqual([
      { from: "2026-01-01", to: "2026-03-31" },
      { from: "2026-04-01", to: "2026-06-30" },
      { from: "2026-07-01", to: "2026-09-30" },
      { from: "2026-10-01", to: "2026-12-31" },
    ]);
  });

  it("leaves a short range as a single call and never overshoots the end", () => {
    expect(chunkDateRange({ from: "2026-08-01", to: "2026-08-01" })).toEqual([
      { from: "2026-08-01", to: "2026-08-01" },
    ]);
    const chunks = chunkDateRange({ from: "2024-04-01", to: "2024-07-15" });
    expect(chunks.at(-1)?.to).toBe("2024-07-15");
  });

  it("covers a range contiguously, with no gap and no overlap", () => {
    const chunks = chunkDateRange({ from: "2016-01-01", to: "2026-08-28" });
    expect(chunks[0]?.from).toBe("2016-01-01");
    expect(chunks.at(-1)?.to).toBe("2026-08-28");
    for (let i = 1; i < chunks.length; i += 1) {
      const previousEnd = Date.parse(`${chunks[i - 1]?.to}T00:00:00Z`);
      const thisStart = Date.parse(`${chunks[i]?.from}T00:00:00Z`);
      expect(thisStart - previousEnd).toBe(86_400_000);
    }
  });

  it("detects the silent truncation an over-long range produces", () => {
    // Measured 2026-08-28: dat_inicio=2026-01-01&dat_fim=2026-06-30 returns
    // HTTP 200 with 4944 rows ending at 2026-04-13 — 103 days of 181 requested,
    // with no error. The fixture stands in for the tail: a response whose last
    // dat_referencia falls short of dat_fim is a truncation, not data.
    expect(() =>
      assertCoverage(
        {
          series: "VERIFIED",
          areaCode: "SECO",
          range: { from: "2026-08-01", to: "2026-08-31" },
          now: new Date("2026-09-15T00:00:00Z"),
        },
        rowsOf(VERIFIED),
        "https://example.invalid",
      ),
    ).toThrow(TruncatedLoadResponseError);
  });

  it("does not call a range reaching into today truncated", () => {
    // The series legitimately stops at the last settled day.
    expect(() =>
      assertCoverage(
        {
          series: "VERIFIED",
          areaCode: "SECO",
          range: { from: "2026-08-01", to: "2026-08-28" },
          now: new Date("2026-08-28T09:00:00Z"),
        },
        rowsOf(VERIFIED),
        "https://example.invalid",
      ),
    ).not.toThrow();
  });
});

describe("carga API · older responses are not valid JSON", () => {
  it("the fixture really is malformed — a strict parser aborts on it", () => {
    // Guards the guard: if ONS ever fixes the defect and this fixture is
    // recaptured, this test says so rather than passing vacuously.
    expect(() => JSON.parse(VERIFIED_MALFORMED)).toThrow();
    expect(VERIFIED_MALFORMED).toContain('"val_cargammgd": ,');
  });

  it("parses it tolerantly rather than aborting the backfill", () => {
    const parsed = parseTolerantJson(VERIFIED_MALFORMED);
    expect(parsed.repaired).toBe(true);
    expect(parsed.value).toHaveLength(48);
  });

  it("renders a missing value as null, never as zero", () => {
    const parse = parseVerifiedLoad(rowsOf(VERIFIED_MALFORMED));
    expect(parse.rows).toHaveLength(48);
    expect(parse.rejected).toEqual([]);
    const first = parse.rows[0];
    // ONS published no value for these two fields in 2018.
    expect(first?.loadNetOfMmgdMwh).toBeNull();
    expect(first?.mmgdLoadMwh).toBeNull();
    // And the fields it did publish are unaffected.
    expect(first?.loadMwh).toBeCloseTo(30_392.07 / 2, 6);
    expect(first?.consistencyAdjustmentMwh).toBe(0);
  });

  it("does not repair a payload that parses, and does not hide a new defect", () => {
    expect(parseTolerantJson(VERIFIED).repaired).toBe(false);
    // A different malformation is still an error rather than an empty result.
    expect(() => parseTolerantJson('[{"a": 1,,}]')).toThrow();
  });

  it("never rewrites a colon inside a string literal", () => {
    const text = '[{"dsc": "reason: ,", "val": }]';
    expect(parseTolerantJson(text).value).toEqual([{ dsc: "reason: ,", val: null }]);
  });
});

describe("carga API · timestamps are UTC and label the end of the half hour", () => {
  const parse = parseVerifiedLoad(rowsOf(VERIFIED));

  it("shifts the end label to the start of the interval", () => {
    // The first row of local day 2026-08-01 is stamped 03:30Z, which is the
    // half-hour *ending* then — i.e. 00:00–00:30 Brasília.
    expect(parse.rows[0]?.validTime.toISOString()).toBe("2026-08-01T03:00:00.000Z");
    expect(parse.rows.at(-1)?.validTime.toISOString()).toBe("2026-08-02T02:30:00.000Z");
  });

  it("does not convert an already-UTC instant a second time", () => {
    // The failure this guards: running din_referenciautc through the
    // America/Sao_Paulo conversion din_instante needs. That would land on
    // 06:00Z (or 00:00Z the other way) rather than 03:00Z.
    const first = parse.rows[0]?.validTime.toISOString();
    expect(first).not.toBe("2026-08-01T06:00:00.000Z");
    expect(first).not.toBe("2026-08-01T00:00:00.000Z");
    expect(first).toBe("2026-08-01T03:00:00.000Z");
  });

  it("yields 48 contiguous half-hours for a day", () => {
    expect(parse.rows).toHaveLength(48);
    for (let i = 1; i < parse.rows.length; i += 1) {
      const step =
        (parse.rows[i]?.validTime.getTime() ?? 0) -
        (parse.rows[i - 1]?.validTime.getTime() ?? 0);
      expect(step).toBe(1_800_000);
    }
  });

  it("rejects a timestamp that lost its UTC designator rather than guessing", () => {
    const parsed = parseVerifiedLoad([
      {
        cod_areacarga: "SECO",
        din_referenciautc: "2026-08-01 03:30:00",
        val_cargaglobal: 1,
      },
    ]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.rejected[0]?.reason).toBe("non_utc_timestamp");
  });
});

describe("carga API · MWmed becomes MWh over the half hour", () => {
  const parse = parseVerifiedLoad(rowsOf(VERIFIED));

  it("halves a half-hourly MWmed value", () => {
    // 41637.23 MWmed sustained for 30 minutes is 20818.615 MWh.
    expect(parse.rows[0]?.loadMwh).toBeCloseTo(41_637.23 / 2, 6);
    expect(parse.rows[0]?.supervisedLoadMwh).toBeCloseTo(38_118.35 / 2, 6);
  });

  it("reads the live field name, not the dictionary's", () => {
    // The CKAN dictionary says `val_cargaglobalsmmg`; the live response says
    // `val_cargaglobalsmmgd`. The live response wins.
    expect(parse.rows[0]?.loadNetOfMmgdMwh).toBeCloseTo(41_519.25 / 2, 6);
    const dictionarySpelling = parseVerifiedLoad([
      {
        cod_areacarga: "SECO",
        din_referenciautc: "2026-08-01T03:30:00.000Z",
        val_cargaglobal: 100,
        val_cargaglobalsmmg: 99,
      },
    ]);
    // Reading the dictionary spelling would be reading a field ONS does not
    // send; a null says "absent" and cannot be mistaken for a measurement.
    expect(dictionarySpelling.rows[0]?.loadNetOfMmgdMwh).toBeNull();
  });
});

describe("carga API · the row-level vintage marker", () => {
  it("captures din_atualizacao off the verified row", () => {
    const parse = parseVerifiedLoad(rowsOf(VERIFIED));
    expect(parse.rows[0]?.publishedAt?.toISOString()).toBe("2026-08-28T03:19:10.800Z");
    expect(parse.rowsWithoutVintage).toBe(0);
  });

  it("keeps the 2018 rows' much older stamp, which is the whole point", () => {
    // Valid time 2018-06; ONS asserted it in 2020. The two axes are genuinely
    // independent, at years of distance, and only this API says so per row.
    const parse = parseVerifiedLoad(rowsOf(VERIFIED_MALFORMED));
    expect(parse.rows[0]?.publishedAt?.toISOString()).toBe("2020-09-24T12:52:27.000Z");
  });

  it("counts a row that arrived without one rather than assuming it away", () => {
    const parse = parseVerifiedLoad([
      {
        cod_areacarga: "SECO",
        din_referenciautc: "2026-08-01T03:30:00.000Z",
        val_cargaglobal: 100,
      },
    ]);
    expect(parse.rows[0]?.publishedAt).toBeNull();
    expect(parse.rowsWithoutVintage).toBe(1);
  });

  it("has none on the programmed series, and says so", () => {
    const parse = parseProgrammedLoad(rowsOf(PROGRAMMED));
    expect(parse.rows).toHaveLength(48);
    expect(parse.rowsWithoutVintage).toBe(48);
  });
});

describe("carga API · the area domain is finer than a subsystem", () => {
  it("labels a subsystem area with WattSteer's canonical code", () => {
    const row = parseVerifiedLoad(rowsOf(VERIFIED)).rows[0];
    expect(row?.areaCode).toBe("SECO");
    expect(row?.areaKind).toBe("SUBSYSTEM");
    // `SECO` never escapes the adapter.
    expect(row?.subsystem).toBe("SE");
  });

  it("gives a geoelectric area no subsystem rather than a guessed one", () => {
    const row = parseVerifiedLoad(rowsOf(VERIFIED_AREA)).rows[0];
    expect(row?.areaCode).toBe("RJ");
    expect(row?.areaKind).toBe("GEOELECTRIC");
    // ONS publishes no area → subsystem assignment. RJ is obviously in the
    // south-east; PA and TON are not obvious, and one rule covers all 25.
    expect(row?.subsystem).toBeNull();
  });

  it("classifies the loss areas as their own kind", () => {
    const parse = parseVerifiedLoad([
      {
        cod_areacarga: "PESE",
        din_referenciautc: "2026-08-01T03:30:00.000Z",
        val_cargaglobal: 10,
      },
    ]);
    expect(parse.rows[0]?.areaKind).toBe("LOSSES");
    expect(parse.rows[0]?.subsystem).toBeNull();
  });

  it("rejects an area outside the published domain rather than storing it", () => {
    const parse = parseVerifiedLoad([
      {
        cod_areacarga: "ZZ",
        din_referenciautc: "2026-08-01T03:30:00.000Z",
        val_cargaglobal: 10,
      },
    ]);
    expect(parse.rows).toEqual([]);
    expect(parse.rejected[0]?.reason).toBe("unknown_load_area");
  });
});

describe("carga API · the programmed series", () => {
  const parse = parseProgrammedLoad(rowsOf(PROGRAMMED));

  it("normalises exactly like the verified one", () => {
    expect(parse.rejected).toEqual([]);
    expect(parse.rows[0]?.validTime.toISOString()).toBe("2026-08-01T03:00:00.000Z");
    expect(parse.rows[0]?.programmedLoadMwh).toBeCloseTo(40_992.41 / 2, 6);
  });

  it("rejects a half-hour with no programmed value rather than writing zero", () => {
    const empty = parseProgrammedLoad([
      { cod_areacarga: "SECO", din_referenciautc: "2026-08-01T03:30:00.000Z" },
    ]);
    expect(empty.rows).toEqual([]);
    expect(empty.rejected[0]?.reason).toBe("empty_value");
  });
});

describe("carga API · transport", () => {
  it("surfaces a non-2xx as an upstream error", () => {
    expect(
      fetchLoadRange({
        series: "VERIFIED",
        areaCode: "SECO",
        range: { from: "2026-08-01", to: "2026-08-01" },
        fetch: stubFetch("nope", 500),
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("returns the raw body alongside the rows, for the archive", async () => {
    const response = await fetchLoadRange({
      series: "VERIFIED",
      areaCode: "SECO",
      range: { from: "2026-08-01", to: "2026-08-01" },
      fetch: stubFetch(VERIFIED),
      now: new Date("2026-08-03T00:00:00Z"),
    });
    expect(response.rows).toHaveLength(48);
    expect(response.body).toBe(VERIFIED);
    expect(response.repaired).toBe(false);
    expect(response.url).toContain("/cargaverificada");
  });
});

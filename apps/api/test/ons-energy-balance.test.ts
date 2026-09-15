import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mwmedToMwh, resolveSubsystem, trimmed } from "../src/ingest/normalise.js";
import {
  fingerprintFromHeaders,
  readResources,
  selectResourceForYear,
} from "../src/ingest/ons/catalogue.js";
import {
  parseEnergyBalanceCsv,
  parseEnergyBalanceParquet,
} from "../src/ingest/ons/energy-balance.js";
import { valueDigest } from "../src/ingest/repository.js";
import { zonedWallClockToUtc } from "../src/ingest/time.js";
import headHeaders from "./fixtures/ons/head-BALANCO_ENERGIA_SUBSISTEMA_2026.parquet.json" with {
  type: "json",
};
import packageShow from "./fixtures/ons/package-show-balanco-energia-subsistema.json" with {
  type: "json",
};

// Seam 1 — the source adapter, driven by real payloads captured from ONS on
// 2026-08-28. Provenance and capture dates are in `fixtures/ons/FIXTURES.md`.
//
// These tests exist to defend findings that were expensive to obtain and are
// invisible in the code: that `id_subsistema` is padded in one vintage and not
// another, that a `SIN` row would double every subsystem sum, that
// `din_instante` is Brasília local civil time documented nowhere. A future
// refactor has no way to know any of that from reading the adapter.

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const csv = (name: string) => Bun.file(join(FIXTURES, name)).text();
const bytes = (name: string) => Bun.file(join(FIXTURES, name)).arrayBuffer();

describe("ons catalogue · resources are read, never constructed", () => {
  const resources = readResources(packageShow);

  it("keeps only the formats WattSteer ingests", () => {
    expect(resources.length).toBeGreaterThan(0);
    expect(new Set(resources.map((r) => r.format))).toEqual(new Set(["PARQUET", "CSV"]));
  });

  it("prefers Parquet for a year that has both", () => {
    const chosen = selectResourceForYear(resources, 2026);
    expect(chosen.format).toBe("PARQUET");
    expect(chosen.url).toEndWith("BALANCO_ENERGIA_SUBSISTEMA_2026.parquet");
    // The S3 path segment is not the CKAN slug — proof the URL came from CKAN.
    expect(chosen.url).toContain("/dataset/balanco_energia_subsistema_ho/");
  });

  it("falls back to CSV when Parquet is absent for that year", () => {
    const csvOnly = resources.filter((r) => r.format === "CSV");
    const chosen = selectResourceForYear(csvOnly, 2000);
    expect(chosen.format).toBe("CSV");
    expect(chosen.url).toEndWith("BALANCO_ENERGIA_SUBSISTEMA_2000.csv");
  });

  it("throws rather than fabricating a URL for a year that is not published", () => {
    expect(() => selectResourceForYear(resources, 1999)).toThrow();
  });

  it("carries CKAN's own last_modified, read as UTC", () => {
    const chosen = selectResourceForYear(resources, 2026);
    expect(chosen.lastModified?.toISOString()).toBe("2026-08-28T15:00:51.691Z");
  });
});

describe("ons catalogue · change detection without a download", () => {
  const fingerprint = fingerprintFromHeaders(new Headers(headHeaders.headers));

  it("folds Last-Modified, Content-Length and ETag into one change key", () => {
    expect(fingerprint.contentLength).toBe(1_393_352);
    expect(fingerprint.etag).toBe('"591d0f65d881b5bb016cc7e0d83aec19"');
    expect(fingerprint.lastModified?.toISOString()).toBe("2026-08-28T15:00:33.000Z");
    expect(fingerprint.changeKey).toContain("1393352");
  });

  it("changes when any one of the three moves", () => {
    const moved = fingerprintFromHeaders(
      new Headers({ ...headHeaders.headers, "content-length": "1393353" }),
    );
    expect(moved.changeKey).not.toBe(fingerprint.changeKey);
  });

  it("records that ONS exposes no object version to ask for", () => {
    // If this ever gains a version id, the bitemporal archive stops being the
    // only way back to a prior vintage — worth noticing.
    expect(headHeaders.headers).not.toHaveProperty("x-amz-version-id");
  });
});

describe("normalisation rules", () => {
  it("trims unconditionally", () => {
    expect(trimmed("SE ")).toBe("SE");
    expect(trimmed(" SUDESTE")).toBe("SUDESTE");
  });

  it("resolves padded and unpadded subsystem codes to the same member", () => {
    expect(resolveSubsystem("SE ")).toEqual({ kind: "subsystem", code: "SE" });
    expect(resolveSubsystem("SE")).toEqual({ kind: "subsystem", code: "SE" });
    expect(resolveSubsystem("N  ")).toEqual({ kind: "subsystem", code: "N" });
  });

  it("classifies SIN as the aggregate, never as a fifth subsystem", () => {
    expect(resolveSubsystem("SIN")).toEqual({ kind: "aggregate" });
  });

  it("rejects an unknown code rather than defaulting it", () => {
    expect(resolveSubsystem("SECO")).toEqual({ kind: "unknown", raw: "SECO" });
  });

  it("converts MWmed to MWh using the source interval length", () => {
    expect(mwmedToMwh(100, 60)).toBe(100);
    expect(mwmedToMwh(100, 30)).toBe(50);
  });

  it("parses din_instante as Brasília local civil time, not UTC", () => {
    // 2026 is post-DST-abolition: fixed UTC−3.
    const modern = zonedWallClockToUtc({
      year: 2026,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
    expect(modern).toEqual({
      kind: "ok",
      instant: new Date("2026-01-01T03:00:00.000Z"),
    });

    // 2000 is inside horário de verão: UTC−2. A fixed −3 offset would be an
    // hour out here, which is why the full IANA zone is required.
    const dst = zonedWallClockToUtc({
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
    expect(dst).toEqual({ kind: "ok", instant: new Date("2000-01-01T02:00:00.000Z") });
  });
});

describe("balanco-energia-subsistema · CSV, 2026 (padded codes, SIN row)", () => {
  it("filters the SIN aggregate at the boundary", async () => {
    const parsed = parseEnergyBalanceCsv(
      await csv("BALANCO_ENERGIA_SUBSISTEMA_2026.head.csv"),
    );
    expect(parsed.aggregateRowsFiltered).toBe(5);
    expect(parsed.rows).toHaveLength(20);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.rows.every((row) => row.subsystem !== ("SIN" as never))).toBe(true);
  });

  it("no subsystem sum can double-count", async () => {
    const parsed = parseEnergyBalanceCsv(
      await csv("BALANCO_ENERGIA_SUBSISTEMA_2026.head.csv"),
    );
    const firstHour = parsed.rows.filter(
      (row) => row.validTime.toISOString() === "2026-01-01T03:00:00.000Z",
    );
    expect(firstHour).toHaveLength(4);
    const total = firstHour.reduce((sum, row) => sum + row.loadMwh, 0);
    // The SIN row for this hour reads 72 695.81; the four subsystems sum to it.
    expect(total).toBeCloseTo(72_695.81, 1);
  });

  it("normalises the padded code and the start-labelled local hour", async () => {
    const parsed = parseEnergyBalanceCsv(
      await csv("BALANCO_ENERGIA_SUBSISTEMA_2026.head.csv"),
    );
    expect(parsed.rows[0]).toEqual({
      subsystem: "N",
      validTime: new Date("2026-01-01T03:00:00.000Z"),
      loadMwh: 7622.605_999_999_999,
      hydroGenerationMwh: 11_587.045_999_999_998,
      thermalGenerationMwh: 1864.907,
      windGenerationMwh: 263.019,
      solarGenerationMwh: 0,
      netExchangeMwh: 6094.172,
    });
  });
});

describe("balanco-energia-subsistema · CSV, 2000 (unpadded codes)", () => {
  it("resolves the unpadded vintage identically", async () => {
    const parsed = parseEnergyBalanceCsv(
      await csv("BALANCO_ENERGIA_SUBSISTEMA_2000.head.csv"),
    );
    expect(parsed.aggregateRowsFiltered).toBe(5);
    expect(parsed.rows).toHaveLength(20);
    expect(new Set(parsed.rows.map((row) => row.subsystem))).toEqual(
      new Set(["N", "NE", "S", "SE"]),
    );
  });

  it("reads 0E-8 as a real zero and applies the DST-era offset", async () => {
    const parsed = parseEnergyBalanceCsv(
      await csv("BALANCO_ENERGIA_SUBSISTEMA_2000.head.csv"),
    );
    const first = parsed.rows[0];
    expect(first?.validTime.toISOString()).toBe("2000-01-01T02:00:00.000Z");
    expect(first?.windGenerationMwh).toBe(0);
  });
});

describe("balanco-energia-subsistema · the negative cases", () => {
  it("rejects the DST spring-forward placeholder rows with a reason", async () => {
    const parsed = parseEnergyBalanceCsv(
      await csv("BALANCO_ENERGIA_SUBSISTEMA_2018.dst-gap.csv"),
    );
    expect(parsed.rejected).toHaveLength(4);
    expect(new Set(parsed.rejected.map((r) => r.reason))).toEqual(new Set(["dst_gap"]));
    // All four placeholder rows are caught, including the one whose values are
    // 0E-8 rather than empty — emptiness alone would miss it.
    expect(parsed.rows.every((row) => row.validTime.getTime() > 0)).toBe(true);
    expect(parsed.rows).toHaveLength(8);
  });

  it("rejects the ambiguous fall-back hour rather than guessing", async () => {
    const parsed = parseEnergyBalanceCsv(
      await csv("BALANCO_ENERGIA_SUBSISTEMA_2018.dst-overlap.csv"),
    );
    expect(parsed.rejected).toHaveLength(4);
    expect(parsed.rejected[0]?.reason).toBe("dst_ambiguous");
    expect(parsed.rejected[0]?.detail).toContain("2018-02-17 23:00:00");
  });

  it("fails the whole file when a required column is absent", async () => {
    const text = await csv("BALANCO_ENERGIA_SUBSISTEMA_2026.head.csv");
    const withoutLoad = text
      .split("\n")
      .map((line) => line.split(";").slice(0, 7).join(";"))
      .join("\n");
    expect(() => parseEnergyBalanceCsv(withoutLoad)).toThrow(/val_carga/);
  });

  it("rejects a row whose column is present but empty, never reading it as zero", () => {
    const header =
      "id_subsistema;nom_subsistema;din_instante;val_gerhidraulica;val_gertermica;" +
      "val_gereolica;val_gersolar;val_carga;val_intercambio";
    const parsed = parseEnergyBalanceCsv(
      `${header}\nSE ;SUDESTE/CENTRO-OESTE;2026-01-01 00:00:00;1;2;3;4;;6`,
    );
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.rejected[0]).toEqual({
      reason: "empty_value",
      rowNumber: 1,
      detail: "val_carga is present but empty",
    });
  });

  it("rejects a non-numeric value rather than coercing it", () => {
    const header =
      "id_subsistema;nom_subsistema;din_instante;val_gerhidraulica;val_gertermica;" +
      "val_gereolica;val_gersolar;val_carga;val_intercambio";
    const parsed = parseEnergyBalanceCsv(
      `${header}\nSE ;SUDESTE/CENTRO-OESTE;2026-01-01 00:00:00;1;2;3;4;n/a;6`,
    );
    expect(parsed.rejected[0]?.reason).toBe("unparsable_value");
  });

  it("rejects an unrecognised subsystem code", () => {
    const header =
      "id_subsistema;nom_subsistema;din_instante;val_gerhidraulica;val_gertermica;" +
      "val_gereolica;val_gersolar;val_carga;val_intercambio";
    const parsed = parseEnergyBalanceCsv(
      `${header}\nSECO;SUDESTE;2026-01-01 00:00:00;1;2;3;4;5;6`,
    );
    expect(parsed.rejected[0]?.reason).toBe("unknown_subsystem");
  });
});

describe("balanco-energia-subsistema · Parquet is the preferred path", () => {
  it("produces the same canonical rows as the CSV for the shared hours", async () => {
    const fromParquet = await parseEnergyBalanceParquet(
      await bytes("BALANCO_ENERGIA_SUBSISTEMA_2026.parquet"),
    );
    const fromCsv = parseEnergyBalanceCsv(
      await csv("BALANCO_ENERGIA_SUBSISTEMA_2026.head.csv"),
    );

    expect(fromParquet.aggregateRowsFiltered).toBe(5712);
    expect(fromParquet.rejected).toEqual([]);
    // The digest is what the store compares, so agreeing on it is the strongest
    // statement that the two paths are interchangeable.
    expect(fromParquet.rows.slice(0, 20).map(valueDigest)).toEqual(
      fromCsv.rows.map(valueDigest),
    );
  });

  it("reads INT96 din_instante as a wall clock, not as an instant", async () => {
    // The Parquet reader hands back `2026-01-01T00:00:00Z` for a row the CSV
    // writes as `2026-01-01 00:00:00`. Both are the same Brasília wall clock,
    // and both must land on 03:00Z. Trusting the Date would be a silent
    // three-hour error — this is the trap the research file does not record.
    const parsed = await parseEnergyBalanceParquet(
      await bytes("BALANCO_ENERGIA_SUBSISTEMA_2026.parquet"),
    );
    expect(parsed.rows[0]?.validTime.toISOString()).toBe("2026-01-01T03:00:00.000Z");
  });
});

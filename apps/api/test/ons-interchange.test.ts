import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SUBSYSTEM_DECLARATION_ORDER } from "@wattsteer/core/domain";
import {
  fingerprintFromHeaders,
  readResources,
  selectResourceForYear,
} from "../src/ingest/ons/catalogue.js";
import {
  INTERCHANGE_FORMATS,
  parseInterchangeCsv,
} from "../src/ingest/ons/interchange.js";
import headHeaders from "./fixtures/ons/head-INTERCAMBIO_NACIONAL_2000.csv.json" with {
  type: "json",
};
import packageShow from "./fixtures/ons/package-show-intercambio-nacional.json" with {
  type: "json",
};

// Seam 1 — the interchange adapter, driven by real payloads captured from ONS
// on 2026-08-28. Provenance is in `fixtures/ons/FIXTURES.md`.
//
// Two findings are defended here that no future reader could recover from the
// code: that ONS added `val_intercambioprogmwmed` in 2026 and did *not*
// backfill it (the opposite of `dsc_restricao`), and that it flipped the
// direction convention at the same moment without saying so.

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const csv = (name: string) => Bun.file(join(FIXTURES, name)).text();

describe("intercambio-nacional · catalogue", () => {
  const resources = readResources(packageShow);

  it("asks for CSV only, because Parquet does not cover the history", () => {
    expect(INTERCHANGE_FORMATS).toEqual(["CSV"]);
    // Parquet exists — for four years out of twenty-seven. Preferring it would
    // ingest a different rendition for 2023→ than for everything before.
    const parquet = resources.filter((r) => r.format === "PARQUET");
    const csvs = resources.filter((r) => r.format === "CSV");
    expect(parquet).toHaveLength(4);
    expect(csvs).toHaveLength(27);

    const chosen = selectResourceForYear(resources, 2026, INTERCHANGE_FORMATS);
    expect(chosen.format).toBe("CSV");
    expect(chosen.url).toEndWith("INTERCAMBIO_NACIONAL_2026.csv");
    // The S3 path segment is not the CKAN slug — proof the URL came from CKAN.
    expect(chosen.url).toContain("/dataset/intercambio_nacional_ho/");
  });

  it("still resolves a year CKAN reports no last_modified for", () => {
    // 15 of the 27 CSVs carry `last_modified: null`. Selection must not depend
    // on it, and `created` is the fallback stamp.
    const chosen = selectResourceForYear(resources, 2000, INTERCHANGE_FORMATS);
    expect(chosen.url).toEndWith("INTERCAMBIO_NACIONAL_2000.csv");
    expect(chosen.lastModified?.toISOString()).toBe("2023-10-13T13:45:53.808Z");

    const withoutStamp = resources.filter(
      (r) => r.format === "CSV" && r.lastModified === null,
    );
    // Nothing is null after `readResources` — every one fell back to `created`.
    expect(withoutStamp).toHaveLength(0);
  });

  it("detects change from the S3 HEAD alone, with no catalogue stamp", () => {
    // The authoritative detector was never CKAN's `last_modified`. This is the
    // HEAD of the very file CKAN reports none for.
    const fingerprint = fingerprintFromHeaders(new Headers(headHeaders.headers));
    expect(fingerprint.contentLength).toBe(1_367_327);
    expect(fingerprint.etag).toBe('"b81b0e64e99bde0abb7c2da0937560c5"');
    expect(fingerprint.lastModified?.toISOString()).toBe("2023-10-13T13:45:52.000Z");

    const moved = fingerprintFromHeaders(
      new Headers({ ...headHeaders.headers, etag: '"different"' }),
    );
    expect(moved.changeKey).not.toBe(fingerprint.changeKey);
  });

  it("throws rather than fabricating a URL for an unpublished year", () => {
    expect(() => selectResourceForYear(resources, 1999, INTERCHANGE_FORMATS)).toThrow();
  });
});

describe("intercambio-nacional · 2025, before the column was added", () => {
  it("ingests six columns cleanly, without failing and without defaulting", async () => {
    const parsed = parseInterchangeCsv(await csv("INTERCAMBIO_NACIONAL_2025.head.csv"));
    expect(parsed.columns).toHaveLength(6);
    expect(parsed.columns).not.toContain("val_intercambioprogmwmed");
    expect(parsed.hasProgrammedColumn).toBe(false);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.rows).toHaveLength(20);
    // Absent, not zero. A zero programmed exchange is a real statement ONS did
    // not make about any hour of 2025.
    expect(parsed.rows.every((row) => row.programmedExchangeMwh === null)).toBe(true);
  });

  it("carries the direction in the sign, as every file before 2026 does", async () => {
    const parsed = parseInterchangeCsv(await csv("INTERCAMBIO_NACIONAL_2025.head.csv"));
    const first = parsed.rows[0];
    expect(first).toEqual({
      fromSubsystem: "N",
      toSubsystem: "NE",
      // 2025 is post-DST-abolition: fixed UTC−3, start-of-interval.
      validTime: new Date("2025-01-01T03:00:00.000Z"),
      verifiedExchangeMwh: -1606.789,
      programmedExchangeMwh: null,
    });
    // Nothing needed flipping: 2025's four published pairs are already the
    // canonical orientation, apart from SE→S.
    expect(parsed.reorientedRows).toBe(5);
  });
});

describe("intercambio-nacional · 2026, after the column was added", () => {
  it("reads the seventh column where it exists", async () => {
    const parsed = parseInterchangeCsv(await csv("INTERCAMBIO_NACIONAL_2026.head.csv"));
    expect(parsed.columns).toHaveLength(7);
    expect(parsed.hasProgrammedColumn).toBe(true);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.rows[0]).toEqual({
      fromSubsystem: "N",
      toSubsystem: "NE",
      validTime: new Date("2026-01-01T03:00:00.000Z"),
      verifiedExchangeMwh: 1728.325,
      programmedExchangeMwh: 2643.612,
    });
  });

  it("handles the leading space in nom_subsistema", async () => {
    // The 2026 file writes `N; NORTE;NE; NORDESTE`. The 2025 file does not.
    const text = await csv("INTERCAMBIO_NACIONAL_2026.head.csv");
    expect(text.split("\n")[1]).toContain("; NORTE;");
    const parsed = parseInterchangeCsv(text);
    expect(parsed.rejected).toEqual([]);
    // Every one of the four codes resolves despite the padding on the name
    // beside it. `SE` is absent from the `from` side by construction: it is
    // last in the canonical order, so it is always the `to` end.
    expect(new Set(parsed.rows.map((row) => row.fromSubsystem))).toEqual(
      new Set(["N", "NE", "S"]),
    );
    expect(new Set(parsed.rows.map((row) => row.toSubsystem))).toEqual(
      new Set(["NE", "SE"]),
    );
  });

  it("normalises the flipped orientation into the canonical one", async () => {
    // ONS publishes `SE; SUDESTE;NE; NORDESTE;431.794;-504.500` for 04:00 —
    // the same NE–SE link the 00:00 row states the other way round. Left as
    // published, the two would be one column holding two opposite conventions.
    const parsed = parseInterchangeCsv(await csv("INTERCAMBIO_NACIONAL_2026.head.csv"));
    const flipped = parsed.rows.find(
      (row) =>
        row.validTime.toISOString() === "2026-01-01T07:00:00.000Z" &&
        row.fromSubsystem === "NE" &&
        row.toSubsystem === "SE",
    );
    expect(flipped).toEqual({
      fromSubsystem: "NE",
      toSubsystem: "SE",
      validTime: new Date("2026-01-01T07:00:00.000Z"),
      verifiedExchangeMwh: -431.794,
      programmedExchangeMwh: 504.5,
    });
    expect(parsed.reorientedRows).toBeGreaterThan(0);

    // Every stored link is canonically oriented — the property the database
    // check constraint also enforces. The basis is read from the published
    // constant rather than typed out again: a test that restates the order it
    // is checking cannot catch the order changing.
    const order: readonly string[] = SUBSYSTEM_DECLARATION_ORDER;
    expect(
      parsed.rows.every(
        (row) => order.indexOf(row.fromSubsystem) < order.indexOf(row.toSubsystem),
      ),
    ).toBe(true);
  });

  it("makes the two vintages comparable on the same link", async () => {
    const older = parseInterchangeCsv(await csv("INTERCAMBIO_NACIONAL_2000.head.csv"));
    const newer = parseInterchangeCsv(await csv("INTERCAMBIO_NACIONAL_2026.head.csv"));
    const links = (rows: { fromSubsystem: string; toSubsystem: string }[]) =>
      new Set(rows.map((row) => `${row.fromSubsystem}→${row.toSubsystem}`));
    // 2000 states three links, 2026 states four, and every one of them is in
    // the same basis. Before normalisation the 2026 file names eight.
    expect([...links(newer.rows)].sort()).toEqual(["NE→SE", "N→NE", "N→SE", "S→SE"]);
    expect([...links(older.rows)].every((link) => links(newer.rows).has(link))).toBe(
      true,
    );
  });
});

describe("intercambio-nacional · the orientation basis is declaration order", () => {
  // This is the one link the two published orders disagree about, and the
  // reason `SUBSYSTEM_ORDER` may not be `SUBSYSTEM_DISPLAY_ORDER`.
  //
  // Declaration order is `N, NE, S, SE`, so `S` precedes `SE` and the canonical
  // row is `S→SE`. Display order is `N, NE, SE, S`, so `SE` would precede `S`
  // and every one of these rows would be stated `SE→S` with its sign flipped —
  // in a column where the sign *is* the direction of the flow. Nothing else in
  // the suite distinguishes the two orders on a single row, so it is asserted
  // here directly rather than left to the four-link set assertion above.
  const header =
    "din_instante;id_subsistema_origem;nom_subsistema_origem;" +
    "id_subsistema_destino;nom_subsistema_destino;val_intercambiomwmed";

  it("puts S before SE, which display order does not", () => {
    expect([...SUBSYSTEM_DECLARATION_ORDER]).toEqual(["N", "NE", "S", "SE"]);
    expect(SUBSYSTEM_DECLARATION_ORDER.indexOf("S")).toBeLessThan(
      SUBSYSTEM_DECLARATION_ORDER.indexOf("SE"),
    );
    // The basis is not empty and is the whole enum, so the ranking below is
    // total rather than a pair of -1s comparing equal.
    expect(SUBSYSTEM_DECLARATION_ORDER).toHaveLength(4);
  });

  it("states an S→SE row as published, and negates nothing", () => {
    const parsed = parseInterchangeCsv(
      `${header}\n2026-03-01 00:00:00;S;SUL;SE; SUDESTE;250.5\n`,
    );
    expect(parsed.rejected).toEqual([]);
    expect(parsed.reorientedRows).toBe(0);
    expect(parsed.rows[0]).toEqual({
      fromSubsystem: "S",
      toSubsystem: "SE",
      validTime: new Date("2026-03-01T03:00:00.000Z"),
      verifiedExchangeMwh: 250.5,
      programmedExchangeMwh: null,
    });
  });

  it("flips an SE→S row into S→SE and carries the direction in the sign", () => {
    const parsed = parseInterchangeCsv(
      `${header}\n2026-03-01 00:00:00;SE; SUDESTE;S;SUL;250.5\n`,
    );
    expect(parsed.rejected).toEqual([]);
    expect(parsed.reorientedRows).toBe(1);
    expect(parsed.rows[0]).toEqual({
      fromSubsystem: "S",
      toSubsystem: "SE",
      validTime: new Date("2026-03-01T03:00:00.000Z"),
      verifiedExchangeMwh: -250.5,
      programmedExchangeMwh: null,
    });
  });

  it("reads the same physical flow out of both spellings", () => {
    // The property that makes the normalisation lossless: the two rows above
    // describe opposite flows of the same magnitude, and after normalisation
    // they are one link with opposite signs. Under display order both would
    // still be one link — `SE→S` — with both signs inverted, which is why
    // "the links agree" is not on its own enough to pin the basis.
    const asPublished = parseInterchangeCsv(
      `${header}\n2026-03-01 00:00:00;S;SUL;SE; SUDESTE;250.5\n`,
    ).rows[0];
    const flipped = parseInterchangeCsv(
      `${header}\n2026-03-01 00:00:00;SE; SUDESTE;S;SUL;250.5\n`,
    ).rows[0];
    expect(asPublished?.fromSubsystem).toBe(flipped?.fromSubsystem);
    expect(asPublished?.toSubsystem).toBe(flipped?.toSubsystem);
    expect(asPublished?.fromSubsystem).toBe("S");
    expect(asPublished?.verifiedExchangeMwh).toBe(
      -(flipped?.verifiedExchangeMwh ?? Number.NaN),
    );
  });
});

describe("intercambio-nacional · the negative cases", () => {
  const header =
    "din_instante;id_subsistema_origem;nom_subsistema_origem;" +
    "id_subsistema_destino;nom_subsistema_destino;val_intercambiomwmed";

  it("rejects the ambiguous fall-back hour rather than guessing", async () => {
    const parsed = parseInterchangeCsv(
      await csv("INTERCAMBIO_NACIONAL_2018.dst-overlap.csv"),
    );
    expect(parsed.rejected).toHaveLength(4);
    expect(new Set(parsed.rejected.map((r) => r.reason))).toEqual(
      new Set(["dst_ambiguous"]),
    );
    expect(parsed.rejected[0]?.detail).toContain("2018-02-17 23:00:00");
  });

  it("has no spring-forward placeholder to reject — the hour is simply absent", async () => {
    // Unlike `balanco-energia-subsistema`, which emits a placeholder row for
    // the local hour that never happened, this dataset omits it. Measured on
    // the whole 2018 file: 8759 distinct hours, no row for 2018-11-04 00:00.
    const parsed = parseInterchangeCsv(
      await csv("INTERCAMBIO_NACIONAL_2018.dst-gap.csv"),
    );
    expect(parsed.rejected).toEqual([]);
    const hours = parsed.rows.map((row) => row.validTime.toISOString());
    expect(new Set(hours)).toEqual(
      new Set([
        "2018-11-04T02:00:00.000Z", // 2018-11-03 23:00 BRT, still UTC−3
        "2018-11-04T03:00:00.000Z", // 2018-11-04 01:00 BRT, now UTC−2
        "2018-11-04T04:00:00.000Z", // 2018-11-04 02:00 BRT
      ]),
    );
  });

  it("fails the whole file when a required column is absent", () => {
    const withoutValue = header.split(";").slice(0, 5).join(";");
    expect(() =>
      parseInterchangeCsv(`${withoutValue}\n2026-01-01 00:00:00;N;N;NE;NE`),
    ).toThrow(/val_intercambiomwmed/);
  });

  it("rejects a row whose value is present but empty, never reading it as zero", () => {
    const parsed = parseInterchangeCsv(
      `${header}\n2026-01-01 00:00:00;N; NORTE;NE; NORDESTE;`,
    );
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.rejected[0]).toEqual({
      reason: "empty_value",
      rowNumber: 1,
      detail: "val_intercambiomwmed is present but empty",
    });
  });

  it("rejects an unrecognised subsystem code at either end", () => {
    const parsed = parseInterchangeCsv(
      `${header}\n2026-01-01 00:00:00;IV;ITAIPU;SE; SUDESTE;1\n` +
        "2026-01-01 00:00:00;N; NORTE;SIN;SIN;1",
    );
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.rejected.map((r) => r.reason)).toEqual([
      "unknown_subsystem",
      "unknown_subsystem",
    ]);
    expect(parsed.rejected[1]?.detail).toContain("id_subsistema_destino");
  });

  it("rejects a link from a subsystem to itself", () => {
    const parsed = parseInterchangeCsv(
      `${header}\n2026-01-01 00:00:00;N; NORTE;N; NORTE;1`,
    );
    expect(parsed.rejected[0]?.reason).toBe("self_directed_exchange");
  });

  it("rejects a mirrored pair rather than letting the primary key eat it", () => {
    // Never observed — zero occurrences across the whole 2018 and 2026 files —
    // but an append-only write resolves a within-file collision with
    // `onConflictDoNothing`, which would drop the second row in silence.
    const parsed = parseInterchangeCsv(
      `${header}\n2026-01-01 00:00:00;N; NORTE;NE; NORDESTE;10\n` +
        "2026-01-01 00:00:00;NE; NORDESTE;N; NORTE;10",
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rejected[0]?.reason).toBe("duplicate_key");
    expect(parsed.rejected[0]?.detail).toContain("N→NE");
  });

  it("rejects a non-numeric programmed value rather than coercing it", () => {
    const parsed = parseInterchangeCsv(
      `${header};val_intercambioprogmwmed\n2026-01-01 00:00:00;N; NORTE;NE; NORDESTE;1;n/a`,
    );
    expect(parsed.rejected[0]?.reason).toBe("unparsable_value");
  });

  it("reads a programmed column that is present but empty as absent, not zero", () => {
    const parsed = parseInterchangeCsv(
      `${header};val_intercambioprogmwmed\n2026-01-01 00:00:00;N; NORTE;NE; NORDESTE;1;`,
    );
    // The file *has* the column, so `hasProgrammedColumn` stays true; the row
    // has no value, so the measure is null. Both facts survive.
    expect(parsed.hasProgrammedColumn).toBe(true);
    expect(parsed.rows[0]?.programmedExchangeMwh).toBeNull();
  });
});

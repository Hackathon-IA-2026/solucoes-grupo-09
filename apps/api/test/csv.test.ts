import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDelimited, toRecord } from "../src/ingest/csv.js";

const FIXTURES = join(import.meta.dir, "fixtures", "ons");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("csv · quoting", () => {
  it("keeps a quoted field containing the delimiter in one cell", () => {
    const { rows } = parseDelimited('a;b\n1;"x;y"\n');
    expect(rows[0]).toEqual(["1", "x;y"]);
  });

  it("keeps a quoted field containing a newline in one cell", () => {
    const { rows } = parseDelimited('a;b\n1;"line one\nline two"\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[1]).toBe("line one\nline two");
  });

  it("unescapes a doubled quote", () => {
    const { rows } = parseDelimited('a\n"he said ""no"""\n');
    expect(rows[0]?.[0]).toBe('he said "no"');
  });

  it("distinguishes a short row from one with empty cells", () => {
    const { columns, rows } = parseDelimited("a;b;c\n1;;3\n1\n");
    expect(toRecord(columns, rows[0] ?? [])).toEqual({ a: "1", b: "", c: "3" });
    // The short row omits b and c entirely — "not there", not "empty".
    expect(toRecord(columns, rows[1] ?? [])).toEqual({ a: "1" });
  });

  it("tolerates CRLF and ignores blank lines", () => {
    const { rows } = parseDelimited("a;b\r\n1;2\r\n\r\n3;4\r\n");
    expect(rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("csv · the real constrained-off wrap", () => {
  // Captured 2026-08-28. This is the trap: dsc_restricao is free text that
  // contains newlines, so one logical row spans two physical lines. A
  // newline-splitting parser emits a short misaligned row instead.
  const text = read("RESTRICAO_COFF_EOLICA_2026_08.restricted.csv");

  it("reads the wrapped row as one row with the full description", () => {
    const { columns, rows } = parseDelimited(text);
    expect(columns).toHaveLength(16);
    // Three logical rows from four physical lines after the header: the
    // first row's description wraps onto a line of its own.
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toHaveLength(16);
    }

    const wrapped = toRecord(columns, rows[0] ?? []);
    expect(wrapped.id_ons).toBe("CJU_BABBS");
    expect(wrapped.cod_razaorestricao).toBe("CNF");
    // The description survives across the physical line break.
    expect(wrapped.dsc_restricao).toContain("Controle de inequação");
    expect(wrapped.dsc_restricao).toContain("MOP 442-S/2025");
    expect(wrapped.dsc_restricao).toContain("\n");
  });

  it("a naive newline split would corrupt it — the reason this reader exists", () => {
    const naive = text.split("\n").filter((line) => line.trim() !== "");
    // Four physical lines after the header for three logical rows, and the
    // orphaned continuation parses as a one-field row.
    expect(naive.length - 1).toBe(4);
    expect((naive[2] ?? "").split(";")).toHaveLength(1);
  });
});

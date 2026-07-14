import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSV_HEADER, createCsvSink, csvRow, writeCsv, writeJson } from "../src/output.js";
import type { Review } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "zalytix-out-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const review = (over: Partial<Review> = {}): Review => ({
  store: "google",
  id: "1",
  userName: "Ann",
  title: "",
  body: "nice",
  rating: 5,
  date: "2025-01-01T00:00:00.000Z",
  developerResponse: null,
  appId: "com.x.y",
  country: "us",
  ...over,
});

describe("output · csvRow", () => {
  test("emits one cell per header column in order", () => {
    const cols = CSV_HEADER.split(",");
    expect(csvRow(review()).split(",").length).toBe(cols.length);
  });

  test("pulls the developer response body into its own column", () => {
    const row = csvRow(review({ developerResponse: { body: "thanks", modified: "x" } }));
    expect(row).toContain("thanks");
  });

  test("quotes a body containing commas, quotes and newlines", () => {
    const row = csvRow(review({ body: 'a,b "c"\nd' }));
    expect(row).toContain('"a,b ""c""\nd"');
  });
});

describe("output · writeCsv / writeJson", () => {
  test("writeCsv writes a header plus one row per review", async () => {
    const path = join(dir, "out.csv");
    await writeCsv(path, [review({ id: "1" }), review({ id: "2" })]);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(3); // header + 2 rows
  });

  test("writeJson round-trips any serializable value", async () => {
    const path = join(dir, "app.json");
    await writeJson(path, { name: "Spotify", averageRating: 4.33 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      name: "Spotify",
      averageRating: 4.33,
    });
  });

  test("creates missing parent directories", async () => {
    const path = join(dir, "nested/deep/out.json");
    await writeJson(path, [1, 2, 3]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([1, 2, 3]);
  });
});

describe("output · createCsvSink (streaming)", () => {
  test("writes the header then appends rows, and close() flushes", async () => {
    const path = join(dir, "stream.csv");
    const sink = createCsvSink(path);
    sink.write(review({ id: "a" }));
    sink.write(review({ id: "b" }));
    await sink.close();
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",a,");
    expect(lines[2]).toContain(",b,");
  });
});

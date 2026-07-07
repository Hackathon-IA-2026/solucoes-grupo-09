import { describe, expect, test } from "bun:test";
import { exportFilename, reviewsToCsv, reviewsToJson } from "../src/csv";
import type { Review } from "../src/types";

const base: Review = {
  store: "apple",
  id: "1",
  userName: "alice",
  title: "Nice",
  body: "Works well",
  rating: 5,
  date: "2026-01-02T03:04:05Z",
  developerResponse: null,
  appId: "42",
  country: "us",
};

describe("reviewsToCsv", () => {
  test("emits header + rows with CRLF", () => {
    const csv = reviewsToCsv([base]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "store,appId,country,id,userName,rating,title,body,date,thumbsUp,appVersion,isEdited,developerResponse,developerResponseDate",
    );
    expect(lines[1]).toBe(
      "apple,42,us,1,alice,5,Nice,Works well,2026-01-02T03:04:05Z,,,,,",
    );
  });

  test("escapes commas, quotes and newlines per RFC 4180", () => {
    const tricky: Review = {
      ...base,
      userName: 'Bob "The Builder"',
      title: "Good, but",
      body: "line one\nline two",
    };
    const row = reviewsToCsv([tricky]).split("\r\n")[1];
    expect(row).toContain('"Bob ""The Builder"""');
    expect(row).toContain('"Good, but"');
    expect(row).toContain('"line one\nline two"');
  });

  test("includes store-specific extras and developer responses", () => {
    const google: Review = {
      ...base,
      store: "google",
      thumbsUp: 12,
      appVersion: "9.1.0",
      developerResponse: { body: "Thanks!", modified: "2026-01-03T00:00:00Z" },
    };
    const row = reviewsToCsv([google]).split("\r\n")[1];
    expect(row).toContain("12");
    expect(row).toContain("9.1.0");
    expect(row).toContain("Thanks!");
  });

  test("empty input still yields a valid header-only file", () => {
    expect(reviewsToCsv([]).split("\r\n")).toHaveLength(1);
  });

  test("neutralizes spreadsheet formula injection in scraped text", () => {
    const hostile: Review = {
      ...base,
      userName: '=HYPERLINK("http://evil.example","click")',
      title: "+1234567890",
      body: "@SUM(A1:A9)",
    };
    const row = reviewsToCsv([hostile]).split("\r\n")[1];
    // Each formula-leading cell gains a leading apostrophe so Excel/Sheets
    // treat it as text, and quoting still applies where RFC 4180 demands it.
    expect(row).toContain("'=HYPERLINK(");
    expect(row).toContain("'+1234567890");
    expect(row).toContain("'@SUM(A1:A9)");
  });

  test("does not touch numeric fields or benign text", () => {
    const negative: Review = { ...base, rating: 1, thumbsUp: -1 as number };
    const row = reviewsToCsv([negative]).split("\r\n")[1];
    expect(row).toContain(",-1,"); // numbers are never apostrophe-prefixed
    expect(row).toContain("Works well"); // plain text unchanged
  });

  test("round-trips through a strict CSV parse (quoted fields intact)", () => {
    const tricky: Review = { ...base, body: 'has "quotes", commas\nand newlines' };
    const csv = reviewsToCsv([tricky]);
    // Minimal RFC-4180 field walker over the data row.
    const dataRow = csv.slice(csv.indexOf("\r\n") + 2);
    const fields: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < dataRow.length; i++) {
      const char = dataRow[i];
      if (inQuotes) {
        if (char === '"' && dataRow[i + 1] === '"') {
          field += '"';
          i++;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        fields.push(field);
        field = "";
      } else {
        field += char;
      }
    }
    fields.push(field);
    expect(fields[7]).toBe('has "quotes", commas\nand newlines');
    expect(fields).toHaveLength(14);
  });
});

describe("reviewsToJson", () => {
  test("pretty-prints the review array", () => {
    const json = reviewsToJson([base]);
    expect(JSON.parse(json)).toEqual([base]);
    expect(json).toContain("\n  ");
  });
});

describe("exportFilename", () => {
  test("keeps safe characters, replaces the rest", () => {
    expect(exportFilename("com.spotify.music", "us", "csv")).toBe(
      "noviq-reviews-com.spotify.music-us.csv",
    );
    expect(exportFilename("we/ird id", "gb", "json")).toBe(
      "noviq-reviews-we_ird_id-gb.json",
    );
  });
});

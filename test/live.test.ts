import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { getReviews, streamReviews } from "../src/scrape.js";
import { createCsvSink } from "../src/output.js";
import type { Review } from "../src/types.js";

// Live tests hit the real stores via cloakbrowser. Opt in with NOVIQ_LIVE=1
// (the `test:live` script does this). They are skipped by default so the unit
// + pipeline suite stays fast and network-free.
const LIVE = process.env.NOVIQ_LIVE === "1";
const live = LIVE ? test : test.skip;
const TIMEOUT = 120_000;

function assertHealthy(reviews: Review[], store: Review["store"]) {
  expect(reviews.length).toBeGreaterThanOrEqual(20);
  expect(new Set(reviews.map((r) => r.id)).size).toBe(reviews.length); // unique
  expect(reviews.every((r) => r.store === store)).toBe(true);
  expect(reviews.every((r) => r.rating >= 1 && r.rating <= 5)).toBe(true);
  expect(reviews.every((r) => /^\d{4}-\d{2}-\d{2}T/.test(r.date))).toBe(true);
}

// Quote-aware logical-row counter (review bodies contain newlines).
function countCsvRows(csv: string): number {
  let rows = 0;
  let inQuote = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (inQuote && csv[i + 1] === '"') i++;
      else inQuote = !inQuote;
    } else if (c === "\n" && !inQuote) rows++;
  }
  return rows;
}

describe("live · apple", () => {
  live(
    "fetches real App Store reviews",
    async () => {
      const reviews = await getReviews({
        appId: "284882215", // Facebook
        store: "apple",
        limit: 40,
        stealth: "fast",
      });
      assertHealthy(reviews, "apple");
    },
    TIMEOUT,
  );
});

describe("live · google", () => {
  live(
    "fetches real Google Play reviews",
    async () => {
      const reviews = await getReviews({
        appId: "com.spotify.music",
        store: "google",
        limit: 60,
        stealth: "fast",
      });
      assertHealthy(reviews, "google");
    },
    TIMEOUT,
  );
});

describe("live · csv end-to-end", () => {
  live(
    "streams reviews to a CSV file with correct row count",
    async () => {
      const path = join(tmpdir(), `noviq-e2e-${process.pid}.csv`);
      const sink = createCsvSink(path);
      let n = 0;
      try {
        for await (const r of streamReviews({
          appId: "284882215",
          store: "apple",
          limit: 25,
          stealth: "fast",
        })) {
          sink.write(r);
          n++;
        }
        await sink.close();
        const csv = readFileSync(path, "utf8");
        expect(countCsvRows(csv)).toBe(n + 1); // + header
        expect(csv.startsWith("store,id,date,rating")).toBe(true);
      } finally {
        rmSync(path, { force: true });
      }
    },
    TIMEOUT,
  );
});

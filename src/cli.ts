#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join } from "node:path";
import { streamAppleReviews } from "./apple.js";
import { writeJson, createCsvSink } from "./output.js";
import type { AppleReview, ReviewSort, StealthPreset } from "./types.js";

const HELP = `
noviq — humanized Apple App Store review scraper (powered by cloakbrowser)

Usage:
  noviq <app-id|app-store-url> [options]

Options:
  --country <cc>      Storefront country code (default: us)
  --lang <tag>        Review language, BCP-47 (default: en-US)
  --sort <order>      mostRecent | mostHelpful (default: mostRecent)
  --limit <n>         Stop after n reviews (default: all available)
  --since <date>      Stop at reviews older than this date (mostRecent only)
  --stealth <preset>  max | balanced | fast (default: max)
  --headed            Show the browser window
  --proxy <url>       Upstream proxy, e.g. http://user:pass@host:8080
  --geoip             Align browser geo/locale with the proxy exit IP
  --profile-dir <p>   Reuse a persistent browser profile directory
  --out <dir>         Output directory (default: ./output)
  --format <fmt>      json | csv | both (default: both)
  -h, --help          Show this help

Examples:
  noviq 284882215 --country us --limit 500
  noviq https://apps.apple.com/us/app/instagram/id389801252 --sort mostHelpful
  noviq 284882215 --since 2025-01-01 --format csv --headed
`;

/** Accept a raw numeric id or any apps.apple.com URL containing /id<digits>. */
function parseAppId(input: string): string {
  if (/^\d+$/.test(input)) return input;
  const m = input.match(/id(\d+)/);
  if (m) return m[1];
  throw new Error(`Could not find an app id in "${input}"`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      country: { type: "string" },
      lang: { type: "string" },
      sort: { type: "string" },
      limit: { type: "string" },
      since: { type: "string" },
      stealth: { type: "string" },
      headed: { type: "boolean", default: false },
      proxy: { type: "string" },
      geoip: { type: "boolean", default: false },
      "profile-dir": { type: "string" },
      out: { type: "string", default: "output" },
      format: { type: "string", default: "both" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const appId = parseAppId(positionals[0]);
  const country = (values.country ?? "us").toLowerCase();
  const format = values.format as "json" | "csv" | "both";
  const wantCsv = format === "csv" || format === "both";
  const wantJson = format === "json" || format === "both";

  const base = join(values.out!, `apple-${appId}-${country}`);
  const csvSink = wantCsv ? createCsvSink(`${base}.csv`) : null;
  const buffer: AppleReview[] = [];

  const startedAt = Date.now();
  console.error(`Scraping App Store reviews for app ${appId} (${country})…`);

  for await (const review of streamAppleReviews({
    appId,
    country,
    lang: values.lang,
    sort: values.sort as ReviewSort | undefined,
    limit: values.limit ? Number(values.limit) : undefined,
    since: values.since,
    stealth: values.stealth as StealthPreset | undefined,
    headed: values.headed,
    proxy: values.proxy,
    geoip: values.geoip,
    profileDir: values["profile-dir"],
    onProgress: ({ collected }) => {
      process.stderr.write(`\r  collected ${collected} reviews…`);
    },
  })) {
    csvSink?.write(review);
    if (wantJson) buffer.push(review);
  }

  process.stderr.write("\n");
  await csvSink?.close();
  if (wantJson) await writeJson(`${base}.json`, buffer);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  const total = wantJson ? buffer.length : "(streamed)";
  console.error(`Done in ${secs}s. ${total} reviews written to ${values.out}/`);
  if (wantCsv) console.error(`  ${base}.csv`);
  if (wantJson) console.error(`  ${base}.json`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "./config.js";
import { createCsvSink, writeJson } from "./output.js";
import { resolveTarget } from "./resolve.js";
import { streamReviews } from "./scrape.js";
import type { AppInfo, ReviewSort, StealthPreset, Store } from "./types.js";

const HELP = `
zalytix — humanized App Store & Google Play review scraper (powered by cloakbrowser)

Usage:
  zalytix <app-id|package|store-url> [options]

The store is auto-detected: numeric id → Apple, package name (com.x.y) → Google.
Override with --store.

Options:
  --store <name>      apple | google (default: inferred from the app id)
  --country <cc>      Storefront country code (default: us)
  --lang <tag>        Language — Apple BCP-47 (en-US), Google short (en)
  --sort <order>      mostRecent | mostHelpful | rating (default: mostRecent)
  --limit <n>         Stop after n reviews (default: all available)
  --since <date>      Stop at reviews older than this date (mostRecent only)
  --stealth <preset>  max | balanced | fast (default: max)
  --headed            Show the browser window
  --proxy <url>       Upstream proxy, e.g. http://user:pass@host:8080
  --geoip             Align browser geo/locale with the proxy exit IP
  --profile-dir <p>   Reuse a persistent browser profile directory
  --out <dir>         Output directory (default: ./output)
  -h, --help          Show this help

Examples:
  zalytix 284882215 --country us --limit 500
  zalytix com.facebook.katana --store google --sort mostRecent --limit 500
  zalytix https://apps.apple.com/us/app/instagram/id389801252 --sort mostHelpful
  zalytix com.spotify.music --since 2025-01-01 --headed
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      store: { type: "string" },
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
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  // One Chain-of-Responsibility pass turns the id/package/URL into a target;
  // an explicit --store overrides the inferred store.
  const resolved = resolveTarget(positionals[0]);
  const appId = resolved.appId;
  if (values.store && values.store !== "apple" && values.store !== "google") {
    console.error(`Error: --store must be "apple" or "google" (got "${values.store}")`);
    process.exit(1);
  }
  const store = (values.store as Store | undefined) ?? resolved.store;
  // Precedence: explicit --country > the country in a store URL > default "us".
  // Without this, pasting a regional URL (…/gb/… or gl=gb) silently scraped US.
  const country = (values.country ?? resolved.country ?? "us").toLowerCase();

  // Reject unparseable numbers/dates up front — a NaN limit would silently
  // mean "unlimited" and a NaN since would silently be ignored.
  const limit = values.limit ? Number(values.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error(`Error: --limit must be a positive integer (got "${values.limit}")`);
    process.exit(1);
  }
  if (values.since && Number.isNaN(Date.parse(values.since))) {
    console.error(`Error: --since is not a valid date (got "${values.since}")`);
    process.exit(1);
  }

  // CSV only — rows are streamed to disk as reviews arrive, so a run uses
  // constant memory no matter how many reviews it pulls.
  const path = join(values.out ?? "output", `${store}-${appId}-${country}.csv`);
  const csvSink = createCsvSink(path);

  const startedAt = Date.now();
  const label = store === "apple" ? "App Store" : "Google Play";
  console.error(`Scraping ${label} reviews for ${appId} (${country})…`);

  let total = 0;
  let appInfo: AppInfo | null = null;
  try {
    for await (const review of streamReviews({
      appId,
      store,
      country,
      lang: values.lang,
      sort: values.sort as ReviewSort | undefined,
      limit,
      since: values.since,
      stealth: (values.stealth as StealthPreset | undefined) ?? config.defaultStealth,
      headed: values.headed,
      proxy: values.proxy ?? config.defaultProxy,
      geoip: values.geoip || config.geoip,
      profileDir: values["profile-dir"],
      onProgress: ({ collected }) => {
        process.stderr.write(`\r  collected ${collected} reviews…`);
      },
      onAppInfo: (info) => {
        appInfo = info;
      },
    })) {
      csvSink.write(review);
      total++;
    }
  } finally {
    // Flush buffered rows even if the stream dies mid-pull — what was
    // collected is on disk, not lost in the write buffer.
    process.stderr.write("\n");
    await csvSink.close();
  }

  // Write the app's metadata beside the CSV (one record → a small JSON sidecar).
  if (appInfo) {
    const app = appInfo as AppInfo;
    const appPath = join(values.out ?? "output", `${store}-${appId}-${country}.app.json`);
    await writeJson(appPath, app);
    const rating =
      app.averageRating == null
        ? "no rating"
        : `${app.averageRating}★${app.ratingCount == null ? "" : ` (${app.ratingCount})`}`;
    console.error(
      `App: ${app.name ?? appId}${app.developer ? ` by ${app.developer}` : ""} — ${rating}` +
        `${app.version ? `, v${app.version}` : ""} → ${appPath}`,
    );
  }

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`Done in ${secs}s. ${total} reviews streamed to ${path}`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});

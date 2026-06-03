#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "./config.js";
import { createCsvSink } from "./output.js";
import { inferStore, streamReviews } from "./scrape.js";
import type { ReviewSort, StealthPreset, Store } from "./types.js";

const HELP = `
noviq — humanized App Store & Google Play review scraper (powered by cloakbrowser)

Usage:
  noviq <app-id|package|store-url> [options]

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
  noviq 284882215 --country us --limit 500
  noviq com.facebook.katana --store google --sort mostRecent --limit 500
  noviq https://apps.apple.com/us/app/instagram/id389801252 --sort mostHelpful
  noviq com.spotify.music --since 2025-01-01 --headed
`;

/**
 * Resolve the app id from a raw id, package name, or store URL.
 * - apps.apple.com URL → numeric id
 * - play.google.com URL → ?id=<package>
 * - otherwise returned as-is (numeric id or package name)
 */
function parseAppId(input: string): string {
  if (/^\d+$/.test(input)) return input; // apple numeric id
  if (/^[a-z][\w.]+\.[\w.]+$/i.test(input)) return input; // google package
  const apple = input.match(/\/id(\d+)/);
  if (apple) return apple[1];
  const google = input.match(/[?&]id=([\w.]+)/);
  if (google) return google[1];
  throw new Error(`Could not find an app id or package in "${input}"`);
}

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

  const appId = parseAppId(positionals[0]);
  const store = (values.store as Store | undefined) ?? inferStore(appId);
  const country = (values.country ?? "us").toLowerCase();

  // CSV only — rows are streamed to disk as reviews arrive, so a run uses
  // constant memory no matter how many reviews it pulls.
  const path = join(values.out ?? "output", `${store}-${appId}-${country}.csv`);
  const csvSink = createCsvSink(path);

  const startedAt = Date.now();
  const label = store === "apple" ? "App Store" : "Google Play";
  console.error(`Scraping ${label} reviews for ${appId} (${country})…`);

  let total = 0;
  for await (const review of streamReviews({
    appId,
    store,
    country,
    lang: values.lang,
    sort: values.sort as ReviewSort | undefined,
    limit: values.limit ? Number(values.limit) : undefined,
    since: values.since,
    stealth: (values.stealth as StealthPreset | undefined) ?? config.defaultStealth,
    headed: values.headed,
    proxy: values.proxy ?? config.defaultProxy,
    geoip: values.geoip || config.geoip,
    profileDir: values["profile-dir"],
    onProgress: ({ collected }) => {
      process.stderr.write(`\r  collected ${collected} reviews…`);
    },
  })) {
    csvSink.write(review);
    total++;
  }

  process.stderr.write("\n");
  await csvSink.close();

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`Done in ${secs}s. ${total} reviews streamed to ${path}`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});

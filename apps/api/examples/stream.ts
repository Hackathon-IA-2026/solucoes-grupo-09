/**
 * Streaming example: pipe reviews into your own sink as they arrive,
 * without buffering the whole dataset in memory. Works for either store —
 * the unified `Review` shape is identical.
 *
 * Run with:  bun run examples/stream.ts [appId-or-package]
 */

import { streamReviews } from "../src/index.js";

// Apple numeric id, or a Google package name — the store is auto-detected.
const APP = process.argv[2] ?? "284882215"; // Facebook (Apple)

let count = 0;
for await (const review of streamReviews({
  appId: APP,
  country: "us",
  sort: "mostRecent",
  limit: 100,
  stealth: "max",
})) {
  count++;
  // Replace this with a DB insert, queue publish, etc.
  console.log(
    `[${count}] (${review.store}) ` +
      `${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)} ` +
      `${review.userName} — ${review.date.slice(0, 10)}: ` +
      `${(review.title || review.body).slice(0, 60)}`,
  );
}

console.log(`\nStreamed ${count} reviews.`);

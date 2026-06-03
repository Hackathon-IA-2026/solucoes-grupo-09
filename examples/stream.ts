/**
 * Streaming example: pipe reviews into your own sink as they arrive,
 * without buffering the whole dataset in memory.
 *
 * Run with:  npx tsx examples/stream.ts
 */
import { streamAppleReviews } from "../src/index.js";

const APP_ID = "284882215"; // Facebook

let count = 0;
for await (const review of streamAppleReviews({
  appId: APP_ID,
  country: "us",
  sort: "mostRecent",
  limit: 100,
  stealth: "max",
})) {
  count++;
  // Replace this with a DB insert, queue publish, etc.
  console.log(
    `[${count}] ${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)} ` +
      `${review.title} — ${review.userName} (${review.date.slice(0, 10)})`,
  );
}

console.log(`\nStreamed ${count} reviews.`);

import type { Page } from "playwright-core";
import type { Review, ScrapeOptions, Store } from "./types.js";
import { STEALTH, jitter, openSession, sleep } from "./browser.js";

/** Outcome of fetching a single page of reviews from a store. */
export type FetchResult<C> =
  | { kind: "page"; reviews: Review[]; next: C | null }
  | { kind: "end" } // no more reviews
  | { kind: "rateLimited" }; // HTTP 429 — back off and retry the same cursor

/**
 * A store-specific plug-in. Everything that differs between Apple and Google
 * lives behind this interface; the engine below handles session management,
 * de-duplication, limit/since cutoffs, delays and backoff generically.
 *
 * `C` is the pagination cursor type — a numeric offset for Apple, a token
 * object for Google.
 */
export interface StoreAdapter<C> {
  store: Store;
  /** The page to navigate to first (establishes a real session). */
  landingUrl(opts: ScrapeOptions): string;
  /** Cursor for the first page. Must not be `null`. */
  initialCursor: C;
  /** Fetch one page of reviews at `cursor`. */
  fetchBatch(page: Page, opts: ScrapeOptions, cursor: C): Promise<FetchResult<C>>;
}

/** A fetch outcome with rate-limiting already resolved away (retried/given up). */
type SettledResult<C> =
  | { kind: "page"; reviews: Review[]; next: C | null }
  | { kind: "end" };

async function fetchWithRetry<C>(
  adapter: StoreAdapter<C>,
  page: Page,
  opts: ScrapeOptions,
  cursor: C,
  backoffBaseMs: number,
  maxRetries: number,
): Promise<SettledResult<C>> {
  for (let attempt = 1; ; attempt++) {
    const res = await adapter.fetchBatch(page, opts, cursor);
    if (res.kind !== "rateLimited") return res;
    if (attempt > maxRetries) return { kind: "end" }; // give up gracefully
    await sleep(backoffBaseMs * attempt);
  }
}

/**
 * The shared scraping engine. Streams reviews one at a time, de-duplicated by
 * id, honoring `limit` and `since`, with jittered delays and 429 backoff. Both
 * the Apple and Google scrapers are just thin adapters over this.
 */
export async function* runScraper<C>(
  adapter: StoreAdapter<C>,
  opts: ScrapeOptions,
): AsyncGenerator<Review, void, unknown> {
  if (!opts.appId) throw new Error("appId is required");
  const profile = STEALTH[opts.stealth ?? "max"];
  const since = opts.since ? new Date(opts.since).getTime() : null;

  const session = await openSession(adapter.landingUrl(opts), opts, profile);
  // Offset/token pagination can return the same review twice (e.g. when new
  // reviews arrive mid-scrape and shift later pages). Emit each id once.
  const seen = new Set<string>();
  let collected = 0;
  let dryPages = 0; // consecutive pages that added nothing new
  let cursor: C | null = adapter.initialCursor;

  try {
    while (cursor !== null) {
      const res: SettledResult<C> = await fetchWithRetry(
        adapter,
        session.page,
        opts,
        cursor,
        profile.backoffBaseMs,
        profile.maxRetries,
      );
      if (res.kind === "end") break;

      let stop = false;
      const before = collected;
      for (const review of res.reviews) {
        if (seen.has(review.id)) continue; // drop cross-page duplicates
        seen.add(review.id);

        if (since && review.date && new Date(review.date).getTime() < since) {
          stop = true;
          break;
        }

        yield review;
        opts.onReview?.(review, collected);
        collected++;

        if (opts.limit && collected >= opts.limit) {
          stop = true;
          break;
        }
      }

      // If a whole page was duplicates, the feed has wrapped or bottomed out.
      dryPages = collected === before ? dryPages + 1 : 0;

      const hasMore = !stop && res.next !== null && dryPages < 2;
      opts.onProgress?.({ collected, batch: res.reviews.length, hasMore });
      if (!hasMore) break;

      cursor = res.next;
      await jitter(profile.pageDelayMs);
    }
  } finally {
    await session.close();
  }
}

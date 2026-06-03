import { jitter, openSession, type Page, STEALTH, sleep } from "./browser.js";
import { Paginator } from "./pagination.js";
import { dedupe, limit, notOlderThan, ReviewPipeline } from "./pipeline.js";
import type { Review, ScrapeOptions, Store } from "./types.js";

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
 * The shared scraping engine, composed from three patterns so the loop stays
 * flat and every policy is independently testable:
 * - **Strategy** — the `StoreAdapter` decides how to fetch/paginate a store.
 * - **Pipeline + Chain of Responsibility** — `ReviewPipeline` runs each review
 *   through `dedupe → notOlderThan → limit`, short-circuiting on drop/stop.
 * - **State Machine** — `Paginator` owns the cursor and the keep-going decision.
 *
 * Streams reviews one at a time, with jittered delays and 429 backoff. The
 * Apple and Google scrapers are just thin adapters over this.
 */
export async function* runScraper<C>(
  adapter: StoreAdapter<C>,
  opts: ScrapeOptions,
): AsyncGenerator<Review, void, unknown> {
  if (!opts.appId) throw new Error("appId is required");
  const profile = STEALTH[opts.stealth ?? "max"];

  const pipeline = new ReviewPipeline([
    dedupe(),
    notOlderThan(opts.since ? new Date(opts.since) : null),
    limit(opts.limit),
  ]);
  const paginator = new Paginator<C>(adapter.initialCursor);

  const session = await openSession(adapter.landingUrl(opts), opts, profile);
  let collected = 0;

  try {
    while (paginator.state === "fetch") {
      const res: SettledResult<C> = await fetchWithRetry(
        adapter,
        session.page,
        opts,
        paginator.cursor,
        profile.backoffBaseMs,
        profile.maxRetries,
      );
      if (res.kind === "end") break;

      let added = 0;
      let halted = false;
      for (const review of res.reviews) {
        const verdict = pipeline.run(review);
        if (verdict === "stop") {
          halted = true;
          break;
        }
        if (verdict === "drop") continue;
        yield review;
        opts.onReview?.(review, collected);
        collected++;
        added++;
      }

      paginator.advance({ added, next: res.next, halted });
      opts.onProgress?.({
        collected,
        batch: res.reviews.length,
        hasMore: paginator.state === "fetch",
      });
      if (paginator.state === "fetch") await jitter(profile.pageDelayMs);
    }
  } finally {
    await session.close();
  }
}

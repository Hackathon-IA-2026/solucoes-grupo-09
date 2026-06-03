import { Semaphore } from "../../concurrency.js";
import { config } from "../../config.js";
import { BadInputError, ScrapeTimeoutError } from "../../errors.js";
import { resolveTarget } from "../../resolve.js";
import { streamReviews } from "../../scrape.js";
import type { Review, ScrapeOptions, Store } from "../../types.js";

export interface ScrapeResult {
  store: Store;
  appId: string;
  country: string;
  count: number;
  /** True if the scrape was cut short (timeout / mid-stream error). */
  partial: boolean;
  reviews: Review[];
}

// Each scrape launches a real Chromium, so bound concurrency (excess requests
// queue, then 503) — protects the host from OOM under load.
const gate = new Semaphore(config.maxConcurrency, config.maxQueue);

/** Live concurrency stats for the health endpoint. */
export function scrapeStats() {
  return gate.stats;
}

/**
 * Business logic for the reviews endpoint. Validates input up front, then runs
 * the scrape under a concurrency gate with a hard time budget. On timeout or a
 * mid-stream failure it returns whatever was collected (`partial: true`) rather
 * than throwing away good data — only a total failure (zero reviews) errors.
 */
export const ReviewService = {
  async scrape(query: ScrapeOptions): Promise<ScrapeResult> {
    const store = resolveStore(query);
    const country = (query.country ?? "us").toLowerCase();
    if (query.since !== undefined && Number.isNaN(Date.parse(String(query.since)))) {
      throw new BadInputError(`Invalid 'since' date: ${query.since}`);
    }

    return gate.run(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), config.scrapeTimeoutMs);
      const reviews: Review[] = [];
      try {
        for await (const review of streamReviews({
          ...query,
          store,
          country,
          signal: ac.signal,
          // Operator-controlled defaults from .env (proxy/geoip aren't client-settable).
          stealth: query.stealth ?? config.defaultStealth,
          proxy: query.proxy ?? config.defaultProxy,
          geoip: query.geoip ?? config.geoip,
        })) {
          reviews.push(review);
        }
      } catch (err) {
        // Keep partial results on a mid-stream blip; surface a total failure.
        if (reviews.length === 0) throw err;
      } finally {
        clearTimeout(timer);
      }

      if (ac.signal.aborted && reviews.length === 0) throw new ScrapeTimeoutError();
      const partial = ac.signal.aborted;
      return {
        store,
        appId: query.appId,
        country,
        count: reviews.length,
        partial,
        reviews,
      };
    });
  },
};

function resolveStore(query: ScrapeOptions): Store {
  if (query.store) return query.store;
  try {
    return resolveTarget(query.appId).store;
  } catch (err) {
    throw new BadInputError(err instanceof Error ? err.message : "Invalid app id");
  }
}

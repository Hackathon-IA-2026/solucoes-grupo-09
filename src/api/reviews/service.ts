import { getReviews, inferStore } from "../../scrape.js";
import type { Review, ScrapeOptions } from "../../types.js";

export interface ScrapeResult {
  store: Review["store"];
  appId: string;
  country: string;
  count: number;
  reviews: Review[];
}

/**
 * Business logic for the reviews endpoint. Scraping doesn't depend on the HTTP
 * request lifecycle, so per Elysia best practice this is a plain, stateless
 * service module (no per-request allocation, no Context coupling) — kept as a
 * namespace object so call sites read as `ReviewService.scrape(...)`.
 */
export const ReviewService = {
  async scrape(query: ScrapeOptions): Promise<ScrapeResult> {
    // Throws on un-inferable ids; the controller maps that to a 400.
    const store = query.store ?? inferStore(query.appId);
    const country = (query.country ?? "us").toLowerCase();
    const reviews = await getReviews({ ...query, store, country });
    return { store, appId: query.appId, country, count: reviews.length, reviews };
  },
};

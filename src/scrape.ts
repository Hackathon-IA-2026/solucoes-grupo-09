import { appleAdapter } from "./apple.js";
import { runScraper } from "./engine.js";
import { googleAdapter } from "./google.js";
import type { Review, ScrapeOptions, Store } from "./types.js";

/** Infer the store from the appId shape: all-digits → Apple, has a dot → Google. */
export function inferStore(appId: string): Store {
  if (/^\d+$/.test(appId)) return "apple";
  if (/[a-z]/i.test(appId) && appId.includes(".")) return "google";
  throw new Error(
    `Cannot infer store from appId "${appId}". Pass { store: "apple" | "google" }.`,
  );
}

/**
 * Stream reviews from either store, one at a time, de-duplicated. This is the
 * core entry point — array and file helpers are thin wrappers over it.
 */
export function streamReviews(
  opts: ScrapeOptions,
): AsyncGenerator<Review, void, unknown> {
  const store = opts.store ?? inferStore(opts.appId);
  const resolved = { ...opts, store };
  // Dispatch per-store so each runScraper call binds a concrete adapter type
  // (StoreAdapter<number> vs StoreAdapter<Cursor>) without an `any` cast.
  return store === "apple"
    ? runScraper(appleAdapter, resolved)
    : runScraper(googleAdapter, resolved);
}

/** Collect every matching review into an array. */
export async function getReviews(opts: ScrapeOptions): Promise<Review[]> {
  const out: Review[] = [];
  for await (const review of streamReviews(opts)) out.push(review);
  return out;
}

// --- store-specific convenience wrappers ---

export function streamAppleReviews(opts: Omit<ScrapeOptions, "store">) {
  return streamReviews({ ...opts, store: "apple" });
}
export function getAppleReviews(opts: Omit<ScrapeOptions, "store">) {
  return getReviews({ ...opts, store: "apple" });
}
export function streamGoogleReviews(opts: Omit<ScrapeOptions, "store">) {
  return streamReviews({ ...opts, store: "google" });
}
export function getGoogleReviews(opts: Omit<ScrapeOptions, "store">) {
  return getReviews({ ...opts, store: "google" });
}

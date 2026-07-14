import { fetchAppInfoFast } from "./appinfo-fast.js";
import { appleAdapter } from "./apple.js";
import { fetchAppInfo, runScraper } from "./engine.js";
import { googleAdapter } from "./google.js";
import { resolveTarget } from "./resolve.js";
import type { AppInfo, Review, ScrapeOptions, Store } from "./types.js";

/** Infer the store from an app id / package / store URL (Chain of Responsibility). */
export function inferStore(appId: string): Store {
  return resolveTarget(appId).store;
}

/**
 * Stream reviews from either store, one at a time, de-duplicated. This is the
 * core entry point — array and file helpers are thin wrappers over it.
 */
export function streamReviews(
  opts: ScrapeOptions,
): AsyncGenerator<Review, void, unknown> {
  const store = opts.store ?? resolveTarget(opts.appId).store;
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
  for await (const review of streamReviews(opts)) {
    out.push(review);
  }
  return out;
}

/**
 * Fetch only the app's metadata (no reviews) — one landing-page visit. Returns
 * `null` if the page exposes no structured data. The store is inferred from the
 * appId unless given.
 */
export async function getAppInfo(opts: ScrapeOptions): Promise<AppInfo | null> {
  const store = opts.store ?? resolveTarget(opts.appId).store;
  const resolved = { ...opts, store };
  // Fast path first: public HTTP metadata (no browser) — instant, and it gives
  // Apple its name/icon that the store page's JSON-LD omits. Falls back to the
  // browser path if the fast lookup misses (e.g. a Google consent wall).
  const fast = await fetchAppInfoFast(resolved, store).catch(() => null);
  if (fast?.name) {
    return fast;
  }
  return store === "apple"
    ? fetchAppInfo(appleAdapter, resolved)
    : fetchAppInfo(googleAdapter, resolved);
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

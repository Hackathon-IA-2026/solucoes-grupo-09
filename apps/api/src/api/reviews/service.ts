import { Semaphore } from "../../concurrency.js";
import { config } from "../../config.js";
import { reviewRepository } from "../../database/repository.js";
import { BadInputError, ScrapeTimeoutError } from "../../errors.js";
import { resolveTarget } from "../../resolve.js";
import { getAppInfo, streamReviews } from "../../scrape.js";
import type {
  AppInfo,
  AppInfoResult,
  Review,
  ScrapeOptions,
  ScrapeResult,
  Store,
} from "../../types.js";

export type { AppInfoResult, ScrapeResult } from "../../types.js";

// Each scrape launches a real Chromium, so bound concurrency (excess requests
// queue, then 503) — protects the host from OOM under load.
const gate = new Semaphore(config.maxConcurrency, config.maxQueue);

/** Live concurrency stats for the health endpoint. */
export function scrapeStats() {
  return gate.stats;
}

/** Validate + resolve a request up front (throws BadInputError). */
export function validate(query: ScrapeOptions): { store: Store; country: string } {
  let store: Store;
  try {
    store = query.store ?? resolveTarget(query.appId).store;
  } catch (err) {
    throw new BadInputError(err instanceof Error ? err.message : "Invalid app id");
  }
  // `since` is optional — only validate a non-blank value (an empty string,
  // e.g. from Swagger UI, means "not provided").
  const since = typeof query.since === "string" ? query.since.trim() : query.since;
  if (since && Number.isNaN(Date.parse(String(since)))) {
    throw new BadInputError(`Invalid 'since' date: ${query.since}`);
  }
  return { store, country: (query.country ?? "us").toLowerCase() };
}

/**
 * Run a scrape under a hard time budget, streaming into an array. On timeout or
 * a mid-stream failure it returns whatever was collected (`partial: true`)
 * rather than discarding good data; only a total failure (zero reviews) errors.
 */
async function streamWithBudget(
  query: ScrapeOptions,
  store: Store,
  country: string,
): Promise<ScrapeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.scrapeTimeoutMs);
  const reviews: Review[] = [];
  let appInfo: AppInfo | null = null;
  let failed = false;
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
      // Capture the app's metadata from the landing page in the same session.
      onAppInfo: (info) => {
        appInfo = info;
      },
    })) {
      reviews.push(review);
    }
  } catch (err) {
    if (reviews.length === 0) {
      throw err; // total failure → surfaced to caller
    }
    failed = true; // mid-stream failure → keep what we have, flag it partial
  } finally {
    clearTimeout(timer);
  }

  if (ac.signal.aborted && reviews.length === 0) {
    throw new ScrapeTimeoutError();
  }
  return {
    store,
    appId: query.appId,
    country,
    count: reviews.length,
    partial: ac.signal.aborted || failed,
    reviews,
    appInfo,
  };
}

/** Fetch app metadata under the same gate + time budget as a scrape. */
async function appInfoWithBudget(
  query: ScrapeOptions,
  store: Store,
  country: string,
): Promise<AppInfo | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.scrapeTimeoutMs);
  try {
    return await getAppInfo({
      ...query,
      store,
      country,
      signal: ac.signal,
      stealth: query.stealth ?? config.defaultStealth,
      proxy: query.proxy ?? config.defaultProxy,
      geoip: query.geoip ?? config.geoip,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Business logic for the reviews endpoint. Validates input, then runs the
 * scrape under the concurrency gate with a hard time budget. Shared by the
 * synchronous route and the background job workers.
 */
export const ReviewService = {
  validate,
  scrapeStats,
  async scrape(query: ScrapeOptions): Promise<ScrapeResult> {
    const { store, country } = validate(query);
    const result = await gate.run(() => streamWithBudget(query, store, country));
    await persist(result);
    return result;
  },
  async appInfo(query: ScrapeOptions): Promise<AppInfoResult> {
    const { store, country } = validate(query);
    const appInfo = await gate.run(() => appInfoWithBudget(query, store, country));
    await persistApp(appInfo);
    return { store, appId: query.appId, country, appInfo };
  },
};

/**
 * Persist scraped reviews durably (best-effort): a DB blip must not fail the
 * scrape — the caller still gets its results. No-op when no DATABASE_URL.
 */
async function persist(result: ScrapeResult): Promise<void> {
  if (!reviewRepository) {
    return;
  }
  try {
    if (result.reviews.length > 0) {
      await reviewRepository.saveReviews(result.reviews);
    }
    if (result.appInfo) {
      await reviewRepository.saveApp(result.appInfo);
    }
    await reviewRepository.recordRun({ id: crypto.randomUUID(), ...result });
  } catch (err) {
    console.error("persist failed (results still returned):", err);
  }
}

/** Best-effort persistence of app metadata (no-op without a database). */
async function persistApp(info: AppInfo | null): Promise<void> {
  if (!(reviewRepository && info)) {
    return;
  }
  try {
    await reviewRepository.saveApp(info);
  } catch (err) {
    console.error("app persist failed (result still returned):", err);
  }
}

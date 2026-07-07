import { parseAppInfo } from "./appinfo.js";
import {
  jitter,
  openSession,
  type Page,
  readJsonLdScripts,
  STEALTH,
  sleep,
} from "./browser.js";
import { Paginator } from "./pagination.js";
import { dedupe, limit, notOlderThan, ReviewPipeline } from "./pipeline.js";
import type { AppInfo, Review, ScrapeOptions, Store } from "./types.js";

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
  /**
   * Optional second pass after the landing page loads: pull store-specific
   * extras (histogram, version history, installs…) from surfaces the
   * JSON-LD doesn't carry. Best-effort — throwing here must never fail the
   * scrape, so the engine swallows errors.
   */
  fetchAppExtras?(page: Page, opts: ScrapeOptions): Promise<Partial<AppInfo>>;
  /** Cursor for the first page. Must not be `null`. */
  initialCursor: C;
  /** Fetch one page of reviews at `cursor`. */
  fetchBatch(page: Page, opts: ScrapeOptions, cursor: C): Promise<FetchResult<C>>;
}

/** A fetch outcome with rate-limiting already resolved away (retried/given up). */
type SettledResult<C> =
  | { kind: "page"; reviews: Review[]; next: C | null }
  | { kind: "end" };

/** Storefront country, normalized the same way the adapters build their URLs. */
function countryOf(opts: ScrapeOptions): string {
  return (opts.country ?? "us").toLowerCase();
}

/**
 * Read the app's metadata from the already-loaded landing page. Best-effort: a
 * read/parse failure resolves to `null` rather than throwing, so metadata never
 * jeopardizes the reviews. Shared by `runScraper` and `fetchAppInfo`.
 */
async function extractAppInfo<C>(
  adapter: StoreAdapter<C>,
  page: Page,
  opts: ScrapeOptions,
): Promise<AppInfo | null> {
  const prov = { store: adapter.store, appId: opts.appId, country: countryOf(opts) };
  let base: AppInfo | null = null;
  try {
    const scripts = await readJsonLdScripts(page);
    base = parseAppInfo(scripts, prov);
  } catch {
    base = null;
  }
  // Store-specific extras (histogram, version history, installs…). Strictly
  // best-effort on top of the JSON-LD base — never let it break metadata.
  if (adapter.fetchAppExtras) {
    try {
      const extras = await adapter.fetchAppExtras(page, opts);
      base = mergeAppInfo(base, extras, prov);
    } catch {
      // extras are a bonus; keep whatever the base pass produced
    }
  }
  return base;
}

/** All-null AppInfo scaffold for extras-only results. */
function emptyAppInfo(prov: { store: Store; appId: string; country: string }): AppInfo {
  return {
    ...prov,
    name: null,
    developer: null,
    category: null,
    description: null,
    averageRating: null,
    ratingCount: null,
    price: null,
    currency: null,
    version: null,
    contentRating: null,
    operatingSystem: null,
    icon: null,
    url: null,
    histogram: null,
    installs: null,
    installsText: null,
    released: null,
    updated: null,
    versionHistory: null,
  };
}

/**
 * Overlay adapter extras on the JSON-LD base. Extras only fill fields they
 * actually carry (non-null/undefined); a base with no extras and no fields
 * stays `null` so callers keep the "no metadata found" signal.
 */
export function mergeAppInfo(
  base: AppInfo | null,
  extras: Partial<AppInfo>,
  prov: { store: Store; appId: string; country: string },
): AppInfo | null {
  const carried = Object.entries(extras).filter(([, v]) => v != null);
  if (carried.length === 0) {
    return base;
  }
  const merged = base ?? emptyAppInfo(prov);
  for (const [key, value] of carried) {
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/**
 * Open a session, read the app's metadata from the landing page, and close —
 * no review pagination. Powers `getAppInfo` / `GET /app` for callers that want
 * the aggregate context without pulling reviews.
 */
export async function fetchAppInfo<C>(
  adapter: StoreAdapter<C>,
  opts: ScrapeOptions,
): Promise<AppInfo | null> {
  if (!opts.appId) {
    throw new Error("appId is required");
  }
  const profile = STEALTH[opts.stealth ?? "max"];
  const session = await openSession(adapter.landingUrl(opts), opts, profile);
  try {
    return await extractAppInfo(adapter, session.page, opts);
  } finally {
    await session.close();
  }
}

async function fetchWithRetry<C>(
  adapter: StoreAdapter<C>,
  page: Page,
  opts: ScrapeOptions,
  cursor: C,
  backoffBaseMs: number,
  maxRetries: number,
): Promise<SettledResult<C>> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await adapter.fetchBatch(page, opts, cursor);
      if (res.kind !== "rateLimited") {
        return res;
      }
      // Aborted mid-backoff there's no point retrying — stop cleanly.
      if (attempt > maxRetries || opts.signal?.aborted) {
        return { kind: "end" };
      }
    } catch (err) {
      // Transient blip (network/timeout/parse) — retry a bounded number of
      // times, then surface the error so the caller can keep partial results.
      if (attempt > maxRetries || opts.signal?.aborted) {
        throw err;
      }
    }
    await sleep(backoffBaseMs * attempt, opts.signal);
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
  if (!opts.appId) {
    throw new Error("appId is required");
  }
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
    // Opt-in: read the app's metadata from the loaded landing page before
    // paginating. Best-effort and one-shot — never blocks the reviews.
    if (opts.onAppInfo && !opts.signal?.aborted) {
      opts.onAppInfo(await extractAppInfo(adapter, session.page, opts));
    }

    while (paginator.state === "fetch") {
      if (opts.signal?.aborted) {
        break; // timeout/cancel — stop and close cleanly
      }
      const res: SettledResult<C> = await fetchWithRetry(
        adapter,
        session.page,
        opts,
        paginator.cursor,
        profile.backoffBaseMs,
        profile.maxRetries,
      );
      if (res.kind === "end") {
        break;
      }

      let added = 0;
      let halted = false;
      for (const review of res.reviews) {
        const verdict = pipeline.run(review);
        if (verdict === "stop") {
          halted = true;
          break;
        }
        if (verdict === "drop") {
          continue;
        }
        yield review;
        opts.onReview?.(review, collected);
        collected++;
        added++;
      }

      // Limit reached exactly at a page boundary — halt now instead of paying
      // another page delay + fetch just to have the limit stage say "stop".
      if (!halted && opts.limit && collected >= opts.limit) {
        halted = true;
      }

      paginator.advance({ added, next: res.next, halted });
      opts.onProgress?.({
        collected,
        batch: res.reviews.length,
        hasMore: paginator.state === "fetch",
      });
      if (paginator.state === "fetch") {
        await jitter(profile.pageDelayMs, opts.signal);
      }
    }
  } finally {
    await session.close();
  }
}

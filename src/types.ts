/** Which app store a review came from. */
export type Store = "apple" | "google";

/**
 * A single normalized review, unified across stores. Store-specific extras are
 * optional and only populated where the source provides them.
 */
export interface Review {
  /** Which store this came from. */
  store: Store;
  /** Store's review id (numeric string for Apple, uuid for Google). */
  id: string;
  /** Reviewer display name. */
  userName: string;
  /** Review title/headline. Always "" for Google (Play has no titles). */
  title: string;
  /** Review body text. */
  body: string;
  /** Star rating, 1-5. */
  rating: number;
  /** ISO-8601 timestamp of the review. */
  date: string;
  /** Developer's public response, if any. */
  developerResponse: {
    body: string;
    /** ISO-8601 timestamp of the response. */
    modified: string;
  } | null;
  // --- store-specific extras ---
  /** Helpful/thumbs-up count. Google only. */
  thumbsUp?: number;
  /** App version the review was written against. Google only. */
  appVersion?: string;
  /** Whether the user edited the review after posting. Apple only. */
  isEdited?: boolean;
  // --- provenance, attached by the scraper ---
  /** App identifier: numeric id (Apple) or package name (Google). */
  appId: string;
  /** Two-letter storefront country code (e.g. "us"). */
  country: string;
}

/**
 * Unified sort order. Not every store supports every value:
 * - `mostRecent`  — both (Apple `mostRecent`, Google NEWEST)
 * - `mostHelpful` — both (Apple `mostHelpful`, Google HELPFULNESS)
 * - `rating`      — Google only (falls back to `mostRecent` on Apple)
 */
export type ReviewSort = "mostRecent" | "mostHelpful" | "rating";

/** A preset that trades speed for stealth. */
export type StealthPreset = "max" | "balanced" | "fast";

export interface ScrapeOptions {
  /** App id: numeric (Apple, e.g. "284882215") or package (Google, e.g. "com.x.y"). */
  appId: string;
  /** Force a store. If omitted it is inferred from the appId shape. */
  store?: Store;
  /** Storefront country code. Default "us". */
  country?: string;
  /**
   * Language. Apple expects BCP-47 (`en-US`); Google expects a short code
   * (`en`). Each store applies its own default if omitted.
   */
  lang?: string;
  /** Sort order. Default "mostRecent". */
  sort?: ReviewSort;
  /** Stop after collecting this many reviews. Default: all available. */
  limit?: number;
  /**
   * Stop once a review older than this date is seen (most meaningful with
   * sort="mostRecent"). Accepts anything `new Date()` understands.
   */
  since?: string | Date;
  /** Stealth preset controlling delays and humanization. Default "max". */
  stealth?: StealthPreset;
  /** Run the browser with a visible window. Default false. */
  headed?: boolean;
  /** Optional upstream proxy, e.g. "http://user:pass@host:8080". */
  proxy?: string;
  /** Match the browser's geo/timezone/locale to the proxy exit IP. */
  geoip?: boolean;
  /** Reuse a persistent browser profile dir so cookies/fingerprint survive runs. */
  profileDir?: string;
  /** Called with each review as it is collected (streaming/callback mode). */
  onReview?: (review: Review, index: number) => void;
  /** Called once per fetched page with progress info. */
  onProgress?: (info: ProgressInfo) => void;
  /** Abort the scrape early (timeout/cancel); the browser is closed cleanly. */
  signal?: AbortSignal;
}

export interface ProgressInfo {
  /** Reviews collected so far (after de-duplication). */
  collected: number;
  /** Reviews returned by the page just fetched. */
  batch: number;
  /** Whether another page will be fetched. */
  hasMore: boolean;
}

/** Internal tuning derived from a StealthPreset. */
export interface StealthProfile {
  /** cloakbrowser human-like mouse/keyboard/scroll emulation. */
  humanize: boolean;
  /** cloakbrowser humanize preset (only meaningful when `humanize` is true). */
  humanPreset?: "default" | "careful";
  /** Auto-match timezone/locale to the (proxy) exit IP via cloakbrowser geoip. */
  geoip: boolean;
  /** [min, max] ms to wait between review-page fetches. */
  pageDelayMs: [number, number];
  /** Scroll the landing page before fetching to mimic a real visit. */
  warmupScroll: boolean;
  /** Max retries on HTTP 429 / transient errors. */
  maxRetries: number;
  /** Base backoff (ms) multiplied by attempt number on 429. */
  backoffBaseMs: number;
}

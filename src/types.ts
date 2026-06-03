/** A single normalized App Store review. */
export interface AppleReview {
  /** Apple's review id. */
  id: string;
  /** Reviewer display name. */
  userName: string;
  /** Review title / headline. */
  title: string;
  /** Review body text. */
  body: string;
  /** Star rating, 1-5. */
  rating: number;
  /** ISO-8601 timestamp of the review. */
  date: string;
  /** Whether the user edited the review after posting. */
  isEdited: boolean;
  /** Developer's public response, if any. */
  developerResponse: {
    body: string;
    /** ISO-8601 timestamp the response was last modified. */
    modified: string;
  } | null;
  // --- provenance, attached by the scraper ---
  /** Numeric App Store app id this review belongs to. */
  appId: string;
  /** Two-letter storefront country code (e.g. "us"). */
  country: string;
}

export type ReviewSort = "mostRecent" | "mostHelpful";

/** A preset that trades speed for stealth. */
export type StealthPreset = "max" | "balanced" | "fast";

export interface ScrapeOptions {
  /** Numeric app id, e.g. "284882215" (Facebook). Required. */
  appId: string;
  /** Storefront country code. Default "us". */
  country?: string;
  /** BCP-47 language tag for review content. Default "en-US". */
  lang?: string;
  /** Sort order. Default "mostRecent". */
  sort?: ReviewSort;
  /** Stop after collecting this many reviews. Default: all available. */
  limit?: number;
  /**
   * Stop once a review older than this date is seen (only meaningful with
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
  /**
   * Reuse a persistent browser profile dir so cookies/fingerprint survive
   * between runs (looks even more like a returning human).
   */
  profileDir?: string;
  /** Called with each review as it is collected (streaming/callback mode). */
  onReview?: (review: AppleReview, index: number) => void;
  /** Called once per fetched page with progress info. */
  onProgress?: (info: ProgressInfo) => void;
}

export interface ProgressInfo {
  /** Reviews collected so far. */
  collected: number;
  /** Reviews returned by the page just fetched. */
  batch: number;
  /** Next offset, or null when pagination is exhausted. */
  nextOffset: number | null;
}

/** Internal tuning derived from a StealthPreset. */
export interface StealthProfile {
  humanize: boolean;
  /** [min, max] ms to wait between review-page fetches. */
  pageDelayMs: [number, number];
  /** Scroll the landing page before fetching to mimic a real visit. */
  warmupScroll: boolean;
  /** Max retries on HTTP 429 / transient errors. */
  maxRetries: number;
  /** Base backoff (ms) multiplied by attempt number on 429. */
  backoffBaseMs: number;
}

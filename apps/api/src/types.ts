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
  /** Reviewer avatar URL. Google only (Apple never exposes one). */
  avatar?: string;
  // --- provenance, attached by the scraper ---
  /** App identifier: numeric id (Apple) or package name (Google). */
  appId: string;
  /** Two-letter storefront country code (e.g. "us"). */
  country: string;
}

/**
 * App-level metadata, unified across stores. Sourced from the schema.org
 * `SoftwareApplication` JSON-LD that both stores embed in their landing page —
 * a stable, standard format (not reverse-engineered internals), and free to
 * read since the session already loads that page. Best-effort: any field the
 * page omits is `null`, and the whole object is `null` if no structured data
 * is found, so it never blocks a scrape.
 */
export interface AppInfo {
  store: Store;
  /** App identifier: numeric id (Apple) or package name (Google). */
  appId: string;
  /** Two-letter storefront country code (e.g. "us"). */
  country: string;
  /** Display name of the app. */
  name: string | null;
  /** Developer / publisher name. */
  developer: string | null;
  /** Primary category (e.g. "Music", "Social Networking"). */
  category: string | null;
  /** Short marketing description, when present. */
  description: string | null;
  /** Aggregate star rating across all reviews (e.g. 4.7). */
  averageRating: number | null;
  /** Number of ratings behind `averageRating`. */
  ratingCount: number | null;
  /** Price in `currency`; `0` means free, `null` means unknown. */
  price: number | null;
  /** ISO-4217 currency code for `price` (e.g. "USD"). */
  currency: string | null;
  /** Latest published version string, when the page exposes it. */
  version: string | null;
  /** Age / content rating (e.g. "4+", "Everyone"). */
  contentRating: string | null;
  /** Target platform/OS (e.g. "iOS", "Android"). */
  operatingSystem: string | null;
  /** Icon image URL, when present. */
  icon: string | null;
  /** Canonical store URL for the app, when present. */
  url: string | null;
  /**
   * Store-wide ratings histogram: counts for 1★..5★ (index 0 = 1★). Apple:
   * `userRating.ratingCountList` from the same-origin catalog API; Google:
   * the details page's ds:5 blob. `null` when the surface was unavailable.
   */
  histogram: number[] | null;
  /** Real install count (Google only — Apple has no equivalent). */
  installs: number | null;
  /** Display install bucket, e.g. "1,000,000,000+" (Google only). */
  installsText: string | null;
  /** First release date (ISO). */
  released: string | null;
  /** Last update timestamp (ISO). */
  updated: string | null;
  /**
   * Recent releases, newest first (Apple only — Google doesn't publish
   * history). Lets clients bucket Apple reviews by release windows.
   */
  versionHistory: VersionRelease[] | null;
}

/** One release in an app's version history. */
export interface VersionRelease {
  version: string;
  /** Release timestamp (ISO). */
  released: string;
  notes: string | null;
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
  /**
   * Called once, early in the scrape, with the app's metadata read from the
   * landing page (or `null` if none was found). Setting this opts a scrape into
   * metadata extraction; leaving it unset skips the work entirely.
   */
  onAppInfo?: (info: AppInfo | null) => void;
  /** Abort the scrape early (timeout/cancel); the browser is closed cleanly. */
  signal?: AbortSignal;
}

/** The result of a completed scrape (returned by the API + job runners). */
export interface ScrapeResult {
  store: Store;
  appId: string;
  country: string;
  count: number;
  /** True if results were cut short by a timeout or a mid-stream error. */
  partial: boolean;
  reviews: Review[];
  /** App-level metadata captured alongside the reviews (`null` if unavailable). */
  appInfo?: AppInfo | null;
}

/** Metadata-only result (returned by the standalone app-info endpoint). */
export interface AppInfoResult {
  store: Store;
  appId: string;
  country: string;
  appInfo: AppInfo | null;
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

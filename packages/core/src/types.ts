/**
 * Wire types for the noviq API, mirrored from `apps/api/src/types.ts` and
 * `apps/api/src/api/reviews/model.ts`. The API is the source of truth; keep
 * these in lock-step when the contract changes (the parity fixtures in
 * `test/resolve.test.ts` guard the resolver side).
 */

/** Which app store a review came from. */
export type Store = "apple" | "google";

/** Unified sort order (`rating` is Google-only; Apple falls back to recent). */
export type ReviewSort = "mostRecent" | "mostHelpful" | "rating";

/** A single normalized review, unified across stores. */
export interface Review {
  store: Store;
  id: string;
  userName: string;
  title: string;
  body: string;
  /** 1–5 stars (0 when the store omitted it). */
  rating: number;
  /** ISO-8601 timestamp. */
  date: string;
  developerResponse: { body: string; modified: string } | null;
  /** Google only. */
  thumbsUp?: number;
  /** Google only. */
  appVersion?: string;
  /** Apple only. */
  isEdited?: boolean;
  appId: string;
  country: string;
}

/** App-level metadata (every field best-effort / nullable). */
export interface AppInfo {
  store: Store;
  appId: string;
  country: string;
  name: string | null;
  developer: string | null;
  category: string | null;
  description: string | null;
  averageRating: number | null;
  ratingCount: number | null;
  price: number | null;
  currency: string | null;
  version: string | null;
  contentRating: string | null;
  operatingSystem: string | null;
  icon: string | null;
  url: string | null;
}

/** The result of a completed scrape. */
export interface ScrapeResult {
  store: Store;
  appId: string;
  country: string;
  count: number;
  /** True if results were cut short by a timeout or a mid-stream error. */
  partial: boolean;
  reviews: Review[];
  appInfo?: AppInfo | null;
}

/** Metadata-only result (GET /app). */
export interface AppInfoResult {
  store: Store;
  appId: string;
  country: string;
  appInfo: AppInfo | null;
}

/** Body of POST /reviews/jobs (the API's `reviews.query`). */
export interface ScrapeRequest {
  appId: string;
  store?: Store;
  country?: string;
  lang?: string;
  sort?: ReviewSort;
  limit?: number;
  since?: string;
}

/** Lifecycle states of an async scrape job. */
export type JobStatus = "waiting" | "active" | "completed" | "failed";

/** Live progress of an active scrape (best-effort, drives progress bars). */
export interface JobProgress {
  /** Reviews collected so far (deduplicated). */
  collected: number;
  /** The requested cap, when one was set (denominator for a bar). */
  limit?: number;
}

/** A job's point-in-time record (GET /reviews/jobs/:id). */
export interface JobRecord {
  id: string;
  status: JobStatus;
  result?: ScrapeResult;
  error?: string;
  progress?: JobProgress;
}

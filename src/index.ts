export { appleAdapter } from "./apple.js";
export type { FetchResult, StoreAdapter } from "./engine.js";
export { googleAdapter } from "./google.js";
export { createCsvSink, writeCsv, writeJson } from "./output.js";
export {
  getAppleReviews,
  getGoogleReviews,
  getReviews,
  inferStore,
  streamAppleReviews,
  streamGoogleReviews,
  streamReviews,
} from "./scrape.js";
export type {
  ProgressInfo,
  Review,
  ReviewSort,
  ScrapeOptions,
  StealthPreset,
  Store,
} from "./types.js";

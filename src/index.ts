export { appleAdapter } from "./apple.js";
export type { FetchResult, StoreAdapter } from "./engine.js";
export { googleAdapter } from "./google.js";
export { createCsvSink, writeCsv, writeJson } from "./output.js";
export { Paginator } from "./pagination.js";
export type { Stage, Verdict } from "./pipeline.js";
export { dedupe, limit, notOlderThan, ReviewPipeline } from "./pipeline.js";
export type { Resolver, Target } from "./resolve.js";
export { RESOLVERS, resolveTarget } from "./resolve.js";
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

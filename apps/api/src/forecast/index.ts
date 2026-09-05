/**
 * The published forecast: what was said, when it was said, and how to read it back.
 *
 * Four modules and one direction of flow. `publish.ts` asks the modelling
 * service for a lane's day and hands the payload to `publication.ts`, which
 * parses it and appends it in one transaction; `reads.ts` reads it back through
 * the canonical `AsOf` views for `/v1/forecast/day-ahead` and `/v1/meta`.
 * Nothing in here computes a forecast, and nothing outside `publish.ts` talks to
 * the modelling service.
 *
 * `backfill.ts` is the second writer: a backtest run's out-of-fold
 * reconstructions, which share the table and the `AsOf` machinery with the
 * served rows and are kept apart from them by `origin_kind`. It can mint only
 * `backfilled_holdout`; `reads.ts` returns only `served`.
 */

export {
  BACKFILLED_HOLDOUT,
  type HoldoutBackfill,
  HoldoutBackfillError,
  type HoldoutBackfillResult,
  parseHoldoutBackfill,
  writeHoldoutBackfill,
} from "./backfill.js";
export { gateAt } from "./gate.js";
export {
  type ForecastGateProfile,
  type ForecastOriginKind,
  type ForecastPublication,
  PATH_ENSEMBLE,
  PublicationPayloadError,
  type PublicationWriteResult,
  type PublishedDay,
  type PublishedHour,
  parsePublication,
  writePublication,
} from "./publication.js";
export {
  PUBLISH_PATH,
  PUBLISH_TIMEOUT_MS,
  type PublishForecastRequest,
  type PublishForecastResult,
  publishForecast,
} from "./publish.js";
export {
  type ForecastBand,
  type ForecastDayRow,
  type ForecastHourRow,
  type ForecastQuery,
  type PublishedForecast,
  type PublishedOrigin,
  readForecastDayAhead,
  readLatestPublished,
  SERVED,
} from "./reads.js";
export { riskClass } from "./risk-class.js";

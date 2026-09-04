/**
 * The published attribution: what we explained, when we explained it, and how
 * to read it back.
 *
 * Three modules and one direction of flow. `publication.ts` parses what the
 * modelling service computed and appends it in one transaction; `reads.ts`
 * reads it back through the canonical `AsOf` views for
 * `/v1/diagnosis/day-ahead`; `narration-gate.ts` reads the fired rules and
 * decides which narration surface may render — the whole of what a `withhold`
 * rule does, and the reason a withheld day never reaches the language model.
 * Nothing in here computes an attribution, and
 * nothing in here calls the modelling service — the scheduled `publish-diagnosis`
 * job and the worker's private call into `POST /internal/publish/diagnosis` are
 * `docs/specs/api-surface.md` ticket 10's, and this is the unit of work they
 * will run.
 */

export {
  type NarrationDecision,
  type NarrationRenderers,
  type NarrationSource,
  narrationDecision,
  type RenderedNarration,
  renderNarration,
} from "./narration-gate.js";
export {
  ATTRIBUTION_TARGET_DAY,
  type AttributionGrain,
  AttributionPayloadError,
  type AttributionPublication,
  type AttributionWriteResult,
  attributionDigest,
  DRIVER_GROUP_CODES,
  EXPLAINS_CODE,
  type FiredRule,
  type PublishedAttribution,
  type PublishedDriver,
  parseAttributionPublication,
  type RuleAction,
  writeAttributionPublication,
} from "./publication.js";
export {
  type AttributionDriverRow,
  type AttributionQuery,
  groupingHasChanged,
  type PublishedAttributionRow,
  readAttributionDayAhead,
  SERVED,
} from "./reads.js";

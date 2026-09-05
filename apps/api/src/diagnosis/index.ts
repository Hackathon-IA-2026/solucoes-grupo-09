/**
 * The published attribution: what we explained, when we explained it, and how
 * to read it back.
 *
 * Three modules and one direction of flow. `publication.ts` parses what the
 * modelling service computed and appends it in one transaction; `reads.ts`
 * reads it back through the canonical `AsOf` views for
 * `/v1/diagnosis/day-ahead`; `narration-payload.ts` assembles the one closed
 * JSON document every narration surface is allowed to see and
 * `narration-canonical.ts` gives that document the canonical form the cache
 * key, the numeric whitelist and the snapshot test all read;
 * `narration-gate.ts` reads the fired rules and
 * decides which narration surface may render — the whole of what a `withhold`
 * rule does, and the reason a withheld day never reaches the language model;
 * `narration-template.ts` is the surface that renders when the model may not,
 * and it emits `t()` keys with their values rather than a paragraph, so the
 * decimal separator stays the reader's; `narration-validator.ts` is the three
 * mechanical gates every *generated* paragraph passes before anyone sees it,
 * and the one retry and fall-back-to-template that a failure buys;
 * `narration-prompt.ts` is the standing instruction the model is given, held as
 * a constant so the cached system block is byte-identical on every request; and
 * `narration-client.ts` assembles the call itself — no tools, one user turn, a
 * one-field output schema — and composes the gate, the validator and the
 * template into the one decision the endpoint asks for.
 * Nothing in here computes an attribution, and
 * nothing in here calls the modelling service — the scheduled `publish-diagnosis`
 * job and the worker's private call into `POST /internal/publish/diagnosis` are
 * `docs/specs/api-surface.md` ticket 10's, and this is the unit of work they
 * will run.
 */

export {
  canonicalNarrationJson,
  NARRATION_DISPLAY,
  NARRATION_DISPLAY_PRECISION,
  type NarrationCacheKeyParts,
  type NarrationDisplayStyle,
  type NarrationFieldDisplay,
  narrationCacheKey,
  narrationPayloadDigest,
} from "./narration-canonical.js";
export {
  type DiagnosisNarrationSources,
  NARRATION_EFFORT,
  NARRATION_MAX_TOKENS,
  NARRATION_MODEL_ID,
  type NarrationCallSources,
  type NarrationMessages,
  NarrationModelError,
  type NarrationRequestParts,
  narrationAttempt,
  narrationRequest,
  narrationText,
  type RenderedDiagnosisNarration,
  renderDiagnosisNarration,
} from "./narration-client.js";
export {
  type NarrationDecision,
  type NarrationRenderers,
  type NarrationSource,
  narrationDecision,
  type RenderedNarration,
  renderNarration,
} from "./narration-gate.js";
export {
  buildNarrationPayload,
  DEFAULT_NARRATION_LOCALE,
  NARRATION_LOCALES,
  NARRATION_SCHEMA_VERSION,
  type NarrationLocale,
  NarrationPayloadError,
  type NarrationPayloadSources,
  narrationDocument,
  notableNarrationGroups,
  observedReasonsFromFlags,
  toNarrationDocument,
} from "./narration-payload.js";
export {
  COMPLAINT_BLOCK_KEY,
  DOCUMENT_BLOCK_KEY,
  LOCALE_BLOCK_KEY,
  NARRATION_OUTPUT_FIELD,
  NARRATION_OUTPUT_SCHEMA,
  NARRATION_PROMPT_VERSION,
  NARRATION_SYSTEM_PROMPT,
} from "./narration-prompt.js";
export {
  NarrationTemplateError,
  narrationClauses,
  templateNarration,
} from "./narration-template.js";
export {
  type NarrationAttempt,
  type NarrationFinding,
  type NarrationFindingCode,
  type NarrationGate,
  narrationComplaint,
  narrationNumericWhitelist,
  type RejectedNarration,
  type ValidatedNarration,
  type ValidatedNarrationSources,
  validatedNarration,
  validateNarration,
  writtenLocale,
} from "./narration-validator.js";
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

import type {
  DiagnosisNarrationInput,
  Driver,
  ObservedReasonsLatest,
  ReasonCode,
  RuleFlag,
} from "@wattsteer/core/api";
import { subsystemMeta } from "@wattsteer/core/constants";
import { selectNotableDrivers } from "@wattsteer/core/driver-display";
import type { WireField, WireShape, WireShapeName } from "@wattsteer/core/wire";
import { encodeWire, shapeOf } from "@wattsteer/core/wire";
import { UpstreamError } from "../errors.js";
import type { ForecastDayRow } from "../forecast/reads.js";
import { riskClass } from "../forecast/risk-class.js";
import type { AttributionDriverRow, PublishedAttributionRow } from "./reads.js";

/**
 * The renderer's entire world, assembled and closed.
 *
 * One JSON document is the whole input to every narration surface — the
 * language model's, the deterministic template's, the output validator's
 * numeric whitelist and the cache key. `docs/specs/diagnosis.md` rests the
 * renderer's design on one rule:
 *
 * > **The renderer may not compute.**
 *
 * That rule is only enforceable if nothing the copy could want *requires*
 * computing, which is why `top_two_share` is a field. It looks redundant beside
 * the eight shares and it is not: the prototype's own fixture narration adds
 * two of them together, and a narration performing correct arithmetic is
 * indistinguishable from one that hallucinated a plausible number. Every
 * derived figure is therefore pre-computed into the document, and the validator
 * downstream can then reject *any* number the document does not literally
 * contain — which is a mechanical check, where "is this sum right?" is not.
 *
 * ### Four properties, each made structural rather than promised
 *
 * 1. **Nothing is recomputed at request time.** The inputs are two stored rows
 *    and the fired rules: the persisted attribution (`./reads.ts`) and the
 *    persisted forecast day row (`../forecast/reads.ts`). No artifact is
 *    loaded, no background is drawn, no Shapley game is replayed. The one
 *    derivation is `risk_class`, which is a comparison of a stored probability
 *    against the artifact's two stored bin edges through the *same* classifier
 *    `/v1/forecast/day-ahead` and `/v1/grid/outlook` use — reused rather than
 *    re-derived, for the reason a second regex is never written next to a
 *    first one.
 * 2. **The document is closed.** `assertClosedDocument` walks the generated
 *    `WIRE_SHAPES` table and refuses a key the schema does not name, at every
 *    depth. The schemas are `additionalProperties: false`, so a passthrough
 *    field is a contract violation; it is also a *cache* violation, because the
 *    key is a hash of these bytes and an unnoticed extra field silently
 *    invalidates every cached narration.
 * 3. **Only codes travel, and the one proper noun.** `assertCodesOnly` refuses
 *    any string that is not a code — which is what a preformatted `"310 MW
 *    left"` is, a translated string by another name. The single exception is
 *    `subsystem_display_name`, and it is checked against
 *    `SUBSYSTEMS[].onsDisplayName` rather than merely allowed, so it can only
 *    ever be ONS's own untranslated word. This is also the check that makes the
 *    hardcoded-copy guard's blind spot — copy assembled in a server-side
 *    library module — enforceable for this document: prose cannot reach the
 *    renderer's input at all.
 * 4. **The two rows must be the same publication.** The attribution's bars and
 *    the forecast's band appear in one paragraph, so a mismatched `artifact_id`
 *    or a disagreeing `day_expected_mwh` would let the renderer narrate two
 *    different runs as one day. Both are refused here rather than averaged.
 *
 * ### The boundary of §10
 *
 * Nothing in this document says why the grid curtailed, and nothing in it can:
 * `direction` is `raises` / `lowers` — a statement about the *model's* output —
 * and every other field is a measured quantity or a code. The rule is
 * `docs/domain-model.md` §10's, and the build-time scan reaches this file
 * automatically, because its name matches the narration scope.
 *
 * The canonical form of the document, its digest and the cache key are
 * `./narration-canonical.ts` — built once, there, and never re-derived.
 */

/** The document's own version. Bumping it is a cache invalidation by design. */
export const NARRATION_SCHEMA_VERSION = "diagnosis.narration.v1";

/** The two locales the narration is generated in, never translated into. */
export type NarrationLocale = "pt-BR" | "en-US";

/** Both, in the order the product lists them: Portuguese is the default. */
export const NARRATION_LOCALES: readonly NarrationLocale[] = ["pt-BR", "en-US"];

/** Portuguese. `docs/specs/i18n.md`: the default locale, not the fallback. */
export const DEFAULT_NARRATION_LOCALE: NarrationLocale = "pt-BR";

/** The generated shape this document is closed against. */
const DOCUMENT_SHAPE: WireShapeName = "DiagnosisNarrationInput";

/**
 * The rule whose facts carry the latest settled reason mix.
 *
 * `unmodelled_outage_regime` fires when `REL` — external unavailability — took
 * the largest share of yesterday's constrained-off energy, and it records the
 * settled date, the reason and its share as the facts it fired on. So the
 * `observed_reasons_latest` block is read off a *stored rule flag* rather than
 * queried again, which is what keeps "nothing is recomputed at request time"
 * true of this field too. When the rule did not fire the block is absent, and
 * absence here means only "no rule reported one": it is optional in the schema
 * for exactly that reason.
 */
const OUTAGE_REGIME_RULE = "unmodelled_outage_regime";

/** `Σ_j Φ_j` against `day_expected − baseline`, and the two rows' agreement. */
const MWH_AGREEMENT_TOLERANCE = 1e-6;

/** The eight groups are always eight. `publication.ts` writes no other count. */
const DRIVER_GROUPS = 8;

/**
 * A code, not a sentence.
 *
 * One token: letters, digits and the punctuation that identifiers, ISO
 * instants, civil dates, locale tags, `t()` keys and run labels are written
 * with. **No whitespace**, which is the whole discriminator — prose has spaces
 * and a code does not. A value that needs a space to be readable is a value
 * that needed a translator.
 */
const CODE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

/** A document that cannot be handed to a renderer, and why. */
export class NarrationPayloadError extends UpstreamError {
  constructor(message: string) {
    super(`narration payload: ${message}`);
    this.name = "NarrationPayloadError";
  }
}

/**
 * Everything the document is assembled from. Two stored rows and a locale.
 *
 * There is no `Database` here on purpose: this module reads nothing. The rows
 * arrive already read, which is what lets the whole assembly be tested without
 * a database and what makes "assembled from the persisted rows" checkable by
 * looking at the imports.
 */
export interface NarrationPayloadSources {
  /** The published attribution — the bars, the rules and the peak hour. */
  attribution: PublishedAttributionRow;
  /** The published forecast day row — the risk, the band and the peak power. */
  forecast: ForecastDayRow;
  /** The locale the paragraph is *generated* in, never translated into. */
  locale: NarrationLocale;
  /** The prompt this document will be rendered under. Part of the cache key. */
  promptVersion: string;
  /**
   * The latest settled reason mix, when a caller has a better source than the
   * fired rules. Omitted, it is read off `unmodelled_outage_regime`'s facts.
   */
  observedReasonsLatest?: ObservedReasonsLatest;
}

/**
 * The document, in the app's casing, typed against the generated interface.
 *
 * Typed rather than assembled loosely because the generated interface is what
 * the closed schema produced: a field the contract does not carry is a compile
 * error here, before it is a validation failure downstream.
 */
export function buildNarrationPayload(
  sources: NarrationPayloadSources,
): DiagnosisNarrationInput {
  const { attribution, forecast, locale, promptVersion } = sources;
  assertOnePublication(attribution, forecast);

  const groups = attribution.drivers.map((driver) => toDriver(driver));
  if (groups.length !== DRIVER_GROUPS) {
    throw new NarrationPayloadError(
      `the attribution carries ${groups.length} groups and the document holds all ${DRIVER_GROUPS}; a shortlist on the wire is a share whose denominator is gone`,
    );
  }
  assertQuantileOrder(forecast);

  return {
    schemaVersion: NARRATION_SCHEMA_VERSION,
    promptVersion,
    locale,
    subsystem: attribution.subsystem,
    subsystemDisplayName: subsystemMeta(attribution.subsystem).onsDisplayName,
    targetDate: attribution.targetDate,
    thresholdMw: attribution.thresholdMw,
    forecastOrigin: {
      // The attribution's own origin, not the forecast's: this document
      // restates the attribution's numbers, and `assertOnePublication` has
      // already refused the case where the two disagree.
      runLabel: attribution.artifactId,
      gateProfile: attribution.gateProfile,
      publishedAt: attribution.publishedAt.toISOString(),
    },
    vintageFidelity: attribution.vintageFidelity,
    risk: {
      dayOccurrenceProbability: forecast.dayOccurrenceProbability,
      riskClass: riskClass(
        forecast.dayOccurrenceProbability,
        forecast.riskBinElevatedFrom,
        forecast.riskBinHighFrom,
      ),
      // Stored, never counted here: a re-count would be this module computing.
      hoursP50Nonzero: forecast.hoursP50Nonzero,
    },
    magnitude: {
      dayExpectedMwh: attribution.dayExpectedMwh,
      baselineExpectedMwh: attribution.baselineExpectedMwh,
      dayEnergyP10Mwh: forecast.dayTotalMwh.p10,
      dayEnergyP50Mwh: forecast.dayTotalMwh.p50,
      dayEnergyP90Mwh: forecast.dayTotalMwh.p90,
      peakPowerP50Mw: forecast.peakPowerMw.p50,
      // The peak hour is the attribution's: it is the hour whose `E[Y_t]` was
      // largest *in the game that produced these bars*.
      peakHourLocal: attribution.peakHourLocal,
    },
    attribution: {
      target: "expected_mwh_day",
      totalAttributedMwh: attribution.totalAttributedMwh,
      sumAbsAttributedMwh: attribution.sumAbsAttributedMwh,
      stderrMwh: attribution.attributionStderrMwh,
      // Pre-computed upstream and carried, never added here. See the module
      // note: this field is the worked example of "the renderer may not add",
      // and a payload builder that re-derived it would have moved the
      // arithmetic one layer rather than removed it.
      topTwoShare: attribution.topTwoShare,
      groups,
    },
    ruleFlags: attribution.ruleFlags.map((flag) => toRuleFlag(flag)),
    observedReasonsLatest:
      sources.observedReasonsLatest ?? observedReasonsFromFlags(attribution.ruleFlags),
  };
}

/**
 * The groups the narration is allowed to name.
 *
 * The shared half of the display rule — `share >= 0.03`, top six — computed
 * from `packages/core`'s one predicate over the same published shares the
 * client cuts on. The narration needs it because the spec requires a
 * **displayed** group with `hour_disagreement >= 2.0` to be reported as having
 * acted in both directions, and a server that cannot tell which groups are
 * displayed cannot obey that. The **merge** into `other` and its
 * `direction: "mixed"` are not here and are not anywhere on this side.
 *
 * This selects; it never filters the document. All eight groups stay in it.
 */
export function notableNarrationGroups(payload: DiagnosisNarrationInput): Driver[] {
  return selectNotableDrivers(payload.attribution.groups);
}

/**
 * The document as the renderer sees it: `snake_case`, closed, codes only.
 *
 * `encodeWire` is the repository's single translator between the two casings,
 * so this is not a second one. It carries an unrecognised key through
 * unrenamed by design — the contract test is where an unexpected key is meant
 * to fail — which is exactly why the two assertions run afterwards rather than
 * being assumed away.
 */
export function narrationDocument(
  sources: NarrationPayloadSources,
): Record<string, unknown> {
  return toNarrationDocument(buildNarrationPayload(sources));
}

/** The same, for a payload a caller already holds. */
export function toNarrationDocument(
  payload: DiagnosisNarrationInput,
): Record<string, unknown> {
  const wire = encodeWire(DOCUMENT_SHAPE, payload);
  if (!isRecord(wire)) {
    throw new NarrationPayloadError("the document is not an object");
  }
  assertClosedDocument(DOCUMENT_SHAPE, wire, "");
  assertCodesOnly(wire, "", payload);
  return wire;
}

/**
 * The `observed_reasons_latest` block, off the rule that reported it.
 *
 * Exported because the property worth testing is "this block is a *record* of a
 * rule firing, not a second query", and a test that has to assemble a whole
 * document to say so asserts something weaker.
 */
export function observedReasonsFromFlags(
  ruleFlags: readonly { code: string; facts: Record<string, unknown> }[],
): ObservedReasonsLatest | undefined {
  const flag = ruleFlags.find((one) => one.code === OUTAGE_REGIME_RULE);
  if (flag === undefined) {
    return undefined;
  }
  const date = flag.facts.settled_date;
  const topReason = flag.facts.top_reason;
  const share = flag.facts.top_reason_share;
  if (
    typeof date !== "string" ||
    typeof topReason !== "string" ||
    typeof share !== "number"
  ) {
    throw new NarrationPayloadError(
      `${OUTAGE_REGIME_RULE} fired without the facts it fires on; a rule flag is the record of what a rule read, and an incomplete one cannot be narrated`,
    );
  }
  return { date, topReason: topReason as ReasonCode, topReasonShare: share };
}

/** One stored driver row, as the document carries it. */
function toDriver(driver: AttributionDriverRow): Driver {
  if (driver.hourDisagreement === null) {
    throw new NarrationPayloadError(
      `${driver.code}: a day group with no hour_disagreement; one hour has nothing to disagree with and this document is the day's`,
    );
  }
  return {
    code: driver.code as Driver["code"],
    labelCode: driver.labelCode,
    phiMwh: driver.phiMwh,
    share: driver.share,
    direction: driver.direction,
    headlineFeature: driver.headlineFeature,
    // Numbers with a unit code. `docs/specs/diagnosis.md`: a preformatted
    // reading in the payload is a translated string by another name, and it
    // would also put en-US grouping into a Portuguese paragraph.
    observed: driver.observed,
    typical: driver.typical,
    unit: driver.unit as Driver["unit"],
    hourDisagreement: driver.hourDisagreement,
    demoted: driver.demoted,
  };
}

/** One fired rule, as the document carries it. `action` is named `severity`. */
function toRuleFlag(flag: {
  code: string;
  action: string;
  facts: Record<string, unknown>;
}): RuleFlag {
  return {
    code: flag.code,
    severity: flag.action as RuleFlag["severity"],
    facts: flag.facts as RuleFlag["facts"],
  };
}

/**
 * The bars and the band are the same publication, or there is no document.
 *
 * Two rows, one paragraph. A narration that quoted an attribution computed on
 * one artifact beside a band published by another would be internally
 * consistent, would pass every numeric whitelist — every number really is in
 * the input — and would be a description of no single forecast that ever
 * existed. That failure is invisible downstream, so it is refused here.
 */
function assertOnePublication(
  attribution: PublishedAttributionRow,
  forecast: ForecastDayRow,
): void {
  if (attribution.subsystem !== forecast.subsystem) {
    throw new NarrationPayloadError(
      `the attribution is ${attribution.subsystem}'s and the forecast is ${forecast.subsystem}'s`,
    );
  }
  if (attribution.targetDate !== forecast.targetDate) {
    throw new NarrationPayloadError(
      `the attribution explains ${attribution.targetDate} and the forecast is for ${forecast.targetDate}`,
    );
  }
  if (attribution.gateProfile !== forecast.gateProfile) {
    throw new NarrationPayloadError(
      `the attribution was published at ${attribution.gateProfile} and the forecast at ${forecast.gateProfile}`,
    );
  }
  if (attribution.artifactId !== forecast.artifactId) {
    throw new NarrationPayloadError(
      `the attribution decomposes ${attribution.artifactId} and the band came from ${forecast.artifactId}; one paragraph cannot restate two runs`,
    );
  }
  if (attribution.thresholdMw !== forecast.thresholdMw) {
    throw new NarrationPayloadError(
      `the attribution used a ${attribution.thresholdMw} MW threshold and the forecast a ${forecast.thresholdMw} MW one`,
    );
  }
  const gap = Math.abs(attribution.dayExpectedMwh - forecast.dayExpectedMwh);
  if (gap > MWH_AGREEMENT_TOLERANCE) {
    throw new NarrationPayloadError(
      `the attribution decomposes ${attribution.dayExpectedMwh} MWh and the forecast published ${forecast.dayExpectedMwh} MWh; the bars must add up to the figure beside them`,
    );
  }
}

/**
 * `p10 <= p50 <= p90`, the one thing JSON Schema cannot say.
 *
 * The schema registers `x-quantile-ordering` on this object for the contract
 * test; here it is asserted on the values themselves, because a band with
 * `p10 > p50` is not a wide forecast, it is a bug, and the renderer would
 * narrate it without noticing.
 */
function assertQuantileOrder(forecast: ForecastDayRow): void {
  const { p10, p50, p90 } = forecast.dayTotalMwh;
  if (!(p10 <= p50 && p50 <= p90)) {
    throw new NarrationPayloadError(
      `the day band is ${p10} / ${p50} / ${p90}; a band whose quantiles are out of order is a bug, not a wide forecast`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every key at every depth is a key the schema names.
 *
 * The generated `WIRE_SHAPES` table is the same thing the codec renames
 * against and the same thing the JSON Schema produced, so this walk cannot
 * disagree with the contract without the generator disagreeing with itself.
 * Both directions are checked: an unknown key is refused, and a required one
 * that is missing is refused too — a document short a field is as unrenderable
 * as one carrying an extra.
 */
function assertClosedDocument(
  shapeName: WireShapeName,
  value: Record<string, unknown>,
  path: string,
): void {
  const shape: WireShape = shapeOf(shapeName);
  const byWire = new Map<string, WireField>();
  for (const field of Object.values(shape)) {
    byWire.set(field.wire, field);
  }
  for (const [key, member] of Object.entries(value)) {
    const field = byWire.get(key);
    if (field === undefined) {
      throw new NarrationPayloadError(
        `${at(path, key)} is not a field of ${shapeName}; this document is closed, and a field the schema does not name is a validation failure rather than a passthrough`,
      );
    }
    if (field.const !== undefined && member !== field.const) {
      throw new NarrationPayloadError(
        `${at(path, key)} is ${JSON.stringify(member)} and the contract pins it to ${JSON.stringify(field.const)}`,
      );
    }
    assertClosedMember(field, member, at(path, key));
  }
  for (const [, field] of Object.entries(shape)) {
    if (field.optional === true) {
      continue;
    }
    if (!(field.wire in value)) {
      throw new NarrationPayloadError(
        `${at(path, field.wire)} is missing; every field of ${shapeName} that is not optional is part of what a renderer is promised`,
      );
    }
  }
}

function assertClosedMember(field: WireField, member: unknown, path: string): void {
  if (field.shape === undefined || member === null || member === undefined) {
    return;
  }
  const nested = field.shape as WireShapeName;
  if (field.list === true) {
    if (!Array.isArray(member)) {
      throw new NarrationPayloadError(`${path} is not a list`);
    }
    member.forEach((item, index) => {
      if (!isRecord(item)) {
        throw new NarrationPayloadError(`${path}[${index}] is not an object`);
      }
      assertClosedDocument(nested, item, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(member)) {
    throw new NarrationPayloadError(`${path} is not an object`);
  }
  if (field.map === true) {
    // A map whose *keys* are data — none today, and the branch is here so that
    // one arriving is walked rather than mistaken for a fixed object whose
    // every key is unknown.
    for (const [key, value] of Object.entries(member)) {
      if (!isRecord(value)) {
        throw new NarrationPayloadError(`${at(path, key)} is not an object`);
      }
      assertClosedDocument(nested, value, at(path, key));
    }
    return;
  }
  assertClosedDocument(nested, member, path);
}

/**
 * Nothing in the document is prose, and the one proper noun is ONS's own.
 *
 * This is the runtime half of "codes on the wire, never translated strings",
 * standing where the build-time hardcoded-copy guard cannot: that guard scans
 * the app and component trees, and this document is assembled in a server-side
 * library module, which was recorded as a standing risk when the api-surface
 * graph was written. A sentence cannot reach the renderer's input, in either
 * locale, because a sentence has a space in it and a code does not.
 *
 * `subsystem_display_name` is the single exception and is not merely allowed:
 * it is compared against the published constant, so the only string it can
 * hold is the untranslated name ONS writes in its own files.
 */
function assertCodesOnly(
  value: unknown,
  path: string,
  payload: DiagnosisNarrationInput,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertCodesOnly(item, `${path}[${index}]`, payload);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, member] of Object.entries(value)) {
      assertCodesOnly(member, at(path, key), payload);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  if (path === "subsystem_display_name") {
    const expected = subsystemMeta(payload.subsystem).onsDisplayName;
    if (value !== expected) {
      throw new NarrationPayloadError(
        `subsystem_display_name is ${JSON.stringify(value)} and ${payload.subsystem}'s ONS display name is ${JSON.stringify(expected)}; the one proper noun in this document is ONS's, untranslated`,
      );
    }
    return;
  }
  if (!CODE.test(value)) {
    throw new NarrationPayloadError(
      `${path} is ${JSON.stringify(value)}, which is prose rather than a code; a preformatted value in this document is a translated string by another name`,
    );
  }
}

function at(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

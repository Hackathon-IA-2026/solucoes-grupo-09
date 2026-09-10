import { SUBSYSTEM_CODES } from "@wattsteer/core/constants";
import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import { diagnosisAttribution, diagnosisAttributionDriver } from "../database/schema.js";
import { UpstreamError } from "../errors.js";
import type { ForecastGateProfile, ForecastOriginKind } from "../forecast/publication.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import { digestValues } from "../ingest/versioned-write.js";

/**
 * A published attribution, on its way into Postgres.
 *
 * **The worker writes; the modelling service computes.** The same sentence
 * `../forecast/publication.ts` is built on, and for the same two reasons: the
 * modelling service is read-only against Postgres, and every write belongs to
 * the service that owns the Drizzle schema. `apps/ml` produces the rows;
 * nothing in `apps/ml` inserts one.
 *
 * `docs/specs/diagnosis.md` puts the reason for the table in one line — "what
 * did we say at D−1" must be a **query**, not a re-run against a model that has
 * since been retrained — and that is what fixes everything in this module:
 *
 * 1. **A publication is one transaction.** The attribution row and its sixteen
 *    driver rows go in together or neither goes in. The foreign key makes the
 *    half-written case unrepresentable even outside the transaction.
 * 2. **It is additive, never an update.** A re-publication of the same lane and
 *    target date with different numbers is a new `data_version`; one with
 *    identical numbers writes nothing. A retrain, a new grouping and a
 *    different background all produce different values and therefore a new
 *    vintage, kept beside its predecessor and readable at its own `as_of`.
 * 3. **The eight are always eight.** `parseAttributionPublication` refuses a
 *    payload that is short a driver group at either grain, unconditionally and
 *    whatever any rule did. This is the one-way valve as a property of the
 *    write path: a rule may `annotate`, `demote` or `withhold`, and **no rule
 *    may change a number or delete a driver**. `withhold` acts on the
 *    narration; it never reaches these rows.
 * 4. **Shares are over all eight groups.** Checked here against `Σ_k |Φ_k|`,
 *    because a share taken over the displayed rows is circular — the display
 *    cut is applied to the share itself — and a wrong denominator is
 *    invisible in storage.
 *
 * What this module deliberately does **not** do is compute an attribution.
 * There is no Shapley arithmetic here, no re-ranking, no default for a missing
 * figure. A payload short of a field is refused, because the alternative — a
 * zero — is an invented number in the table whose whole purpose is that nothing
 * in it was invented.
 */

/** What the eight bars decompose. The one value this table may hold. */
export const ATTRIBUTION_TARGET_DAY = "expected_mwh_day";

/** The disclaimer code the screen states once: the bars explain the expectation. */
export const EXPLAINS_CODE = "diagnosis.explains_expectation_not_band";

/** The eight players. A closed set: a ninth is a wire-contract change. */
export const DRIVER_GROUP_CODES = [
  "renewable_resource",
  "demand_level",
  "net_surplus",
  "export_stress",
  "ramp_shape",
  "calendar_season",
  "recent_history",
  "data_conditions",
] as const;

/** The two rankings one publication carries. */
export type AttributionGrain = "day" | "peak_hour";

/** A rule's action — the whole of what a rule is allowed to do. */
export type RuleAction = "annotate" | "demote" | "withhold";

/** Strictest last: `withhold` > `demote` > `annotate`. */
const RULE_ACTION_ORDER: readonly RuleAction[] = ["annotate", "demote", "withhold"];

const RULE_ACTIONS: ReadonlySet<string> = new Set(RULE_ACTION_ORDER);
const SUBSYSTEMS: ReadonlySet<string> = new Set(SUBSYSTEM_CODES);
const GATE_PROFILES: ReadonlySet<string> = new Set(["gate_early", "gate_late"]);
const ORIGIN_KINDS: ReadonlySet<string> = new Set(["served", "backfilled_holdout"]);

/** A Brasília civil day, and the only hour count an attribution may claim. */
const HOURS_PER_DAY = 24;

/**
 * The arithmetic's own bound, not a judgement about how close is close enough.
 * `wattsteer_ml.diagnosis.attribution.LOCAL_ACCURACY_TOLERANCE`, verbatim: a
 * residual above it means some other function was attributed.
 */
const LOCAL_ACCURACY_TOLERANCE = 1e-9;

/** `ForecastOrigin.producer` for a WattSteer attribution. */
const PRODUCER = "wattsteer" as const;

/** One group's contribution, exactly as the modelling service wrote it. */
export interface PublishedDriver {
  grain: AttributionGrain;
  driverGroup: string;
  labelCode: string;
  /** `1` is the largest `|share|`. */
  rank: number;
  phiMwh: number;
  /** `|Φ_j| / Σ_k |Φ_k|` over all eight groups. */
  share: number;
  direction: "raises" | "lowers";
  /** Day rows only. One hour has nothing to disagree with. */
  hourDisagreement: number | null;
  headlineFeature: string;
  observed: number;
  typical: number;
  unit: string;
  /** Whether a `demote` rule pushed the bar below the fold. Never a deletion. */
  demoted: boolean;
}

/** One fired rule, with the inputs that fired it. */
export interface FiredRule {
  code: string;
  action: RuleAction;
  facts: Record<string, unknown>;
}

/** One subsystem's explained day. */
export interface PublishedAttribution {
  subsystem: SubsystemCode;
  targetDate: string;
  hoursAttributed: number;
  baselineExpectedMwh: number;
  dayExpectedMwh: number;
  totalAttributedMwh: number;
  sumAbsAttributedMwh: number;
  localAccuracyResidualMwh: number;
  topTwoShare: number;
  attributionStderrMwh: number;
  baselineStderrMwh: number;
  stderrResamples: number;
  stderrSeed: number;
  peakHourLocal: number;
  peakHourExpectedMwh: number;
  peakHourBaselineExpectedMwh: number;
  driverGroupVersion: string;
  driverGroupHash: string;
  backgroundSource: string;
  backgroundSeed: number;
  backgroundRows: number;
  coalitions: number;
  ruleFlags: FiredRule[];
  /** The strictest action any fired rule took; `null` when none fired. */
  governingRuleAction: RuleAction | null;
  /** Sixteen: the day's eight and the peak hour's eight. */
  drivers: PublishedDriver[];
}

/** One lane's day of attributions, as the modelling service handed them over. */
export interface AttributionPublication {
  lane: string;
  featureSet: string;
  gateProfile: ForecastGateProfile;
  originKind: ForecastOriginKind;
  targetDate: string;
  /** `gate_at(target_date, gate_profile)` — never the request time. */
  publishedAt: Date;
  artifactId: string;
  thresholdMw: number;
  /** The regime that composed the expectation these bars decompose. */
  correctionRegime: string;
  attributions: PublishedAttribution[];
}

/** What one publication actually did — the shape an operator wants in a log. */
export interface AttributionWriteResult {
  attributionsInserted: number;
  attributionsRevised: number;
  attributionsUnchanged: number;
  driversInserted: number;
}

/** A payload that cannot be persisted, and why. Never a partial write. */
export class AttributionPayloadError extends UpstreamError {
  constructor(message: string) {
    super(`attribution payload: ${message}`);
    this.name = "AttributionPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(source: Record<string, unknown>, field: string, where: string): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AttributionPayloadError(`${where}: ${field} is ${String(value)}`);
  }
  return value;
}

function str(source: Record<string, unknown>, field: string, where: string): string {
  const value = source[field];
  if (typeof value !== "string" || value === "") {
    throw new AttributionPayloadError(`${where}: ${field} is ${String(value)}`);
  }
  return value;
}

function instant(value: unknown, where: string): Date {
  if (typeof value !== "string") {
    throw new AttributionPayloadError(`${where} is not an instant`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AttributionPayloadError(`${where} is not an instant: ${value}`);
  }
  return parsed;
}

function civilDate(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AttributionPayloadError(`${where} is not a civil date: ${String(value)}`);
  }
  return value;
}

/**
 * Read the modelling service's payload into rows this gateway can stand behind.
 *
 * Every field is required and nothing is defaulted. The service is internal and
 * trusted to be *correct*, not trusted to be *present*.
 */
export function parseAttributionPublication(payload: unknown): AttributionPublication {
  if (!isRecord(payload)) {
    throw new AttributionPayloadError("the body is not an object");
  }
  const lane = str(payload, "lane", "publication");
  const targetDate = civilDate(payload.target_date, "publication.target_date");
  const origin = payload.forecast_origin;
  if (!isRecord(origin)) {
    throw new AttributionPayloadError("publication carries no forecast_origin");
  }
  if (origin.producer !== PRODUCER) {
    throw new AttributionPayloadError(
      `the producer of a WattSteer attribution is ${PRODUCER}, not ` +
        `${String(origin.producer)}`,
    );
  }
  const gateProfile = str(origin, "gate_profile", "forecast_origin");
  if (!GATE_PROFILES.has(gateProfile)) {
    throw new AttributionPayloadError(`${gateProfile} is not a gate profile`);
  }
  const originKind = str(origin, "origin_kind", "forecast_origin");
  if (!ORIGIN_KINDS.has(originKind)) {
    throw new AttributionPayloadError(`${originKind} is not an origin kind`);
  }

  const attributions = (
    Array.isArray(payload.attributions) ? payload.attributions : []
  ).map((row, index) => parseAttribution(row, `attributions[${index}]`, targetDate));
  if (attributions.length === 0) {
    throw new AttributionPayloadError(
      `${lane} ${targetDate}: a publication with no attribution is not a ` +
        "publication. An absence is refused upstream and is never written as " +
        "an empty explanation",
    );
  }

  return {
    lane,
    featureSet: str(payload, "feature_set", "publication"),
    gateProfile: gateProfile as ForecastGateProfile,
    originKind: originKind as ForecastOriginKind,
    targetDate,
    publishedAt: instant(origin.published_at, "forecast_origin.published_at"),
    artifactId: str(origin, "run_label", "forecast_origin"),
    thresholdMw: num(payload, "threshold_mw", "publication"),
    correctionRegime: str(payload, "correction_regime", "publication"),
    attributions,
  };
}

function parseAttribution(
  raw: unknown,
  where: string,
  targetDate: string,
): PublishedAttribution {
  if (!isRecord(raw)) {
    throw new AttributionPayloadError(`${where} is not an attribution`);
  }
  const subsystem = str(raw, "subsystem", where);
  if (!SUBSYSTEMS.has(subsystem)) {
    throw new AttributionPayloadError(`${where}: ${subsystem} is not a subsystem`);
  }
  const target = str(raw, "target", where);
  if (target !== ATTRIBUTION_TARGET_DAY) {
    // The bars explain the day's *expectation*. A payload that attributed the
    // P90, the band's width or the occurrence probability is a different claim
    // wearing this table's name, and it stops here rather than at the check
    // constraint, where the message would be a constraint name.
    throw new AttributionPayloadError(
      `${where}: an attribution of ${target} is not publishable; this table ` +
        `holds the decomposition of ${ATTRIBUTION_TARGET_DAY}`,
    );
  }
  const rowDate = civilDate(raw.target_date, `${where}.target_date`);
  if (rowDate !== targetDate) {
    throw new AttributionPayloadError(
      `${where}: an attribution of ${rowDate} arrived in a publication of ${targetDate}`,
    );
  }
  const hoursAttributed = num(raw, "hours_attributed", where);
  if (hoursAttributed !== HOURS_PER_DAY) {
    throw new AttributionPayloadError(
      `${where}: the day was summed from ${hoursAttributed} hours and a ` +
        `Brasília civil day is ${HOURS_PER_DAY}; a short day is a smaller ` +
        "number that looks exactly like a smaller day",
    );
  }

  const baselineExpectedMwh = num(raw, "baseline_expected_mwh", where);
  const dayExpectedMwh = num(raw, "day_expected_mwh", where);
  const drivers = [
    ...parseDrivers(raw.groups, `${where}.groups`, "day"),
    ...parseDrivers(raw.peak_hour_groups, `${where}.peak_hour_groups`, "peak_hour"),
  ];
  const ruleFlags = parseRuleFlags(raw.rule_flags, `${where}.rule_flags`);

  const attribution: PublishedAttribution = {
    subsystem: subsystem as SubsystemCode,
    targetDate: rowDate,
    hoursAttributed,
    baselineExpectedMwh,
    dayExpectedMwh,
    totalAttributedMwh: num(raw, "total_attributed_mwh", where),
    sumAbsAttributedMwh: num(raw, "sum_abs_attributed_mwh", where),
    localAccuracyResidualMwh: num(raw, "local_accuracy_residual_mwh", where),
    topTwoShare: num(raw, "top_two_share", where),
    attributionStderrMwh: num(raw, "stderr_mwh", where),
    baselineStderrMwh: num(raw, "baseline_stderr_mwh", where),
    stderrResamples: num(raw, "stderr_resamples", where),
    stderrSeed: num(raw, "stderr_seed", where),
    peakHourLocal: num(raw, "peak_hour_local", where),
    peakHourExpectedMwh: num(raw, "peak_hour_expected_mwh", where),
    peakHourBaselineExpectedMwh: num(raw, "peak_hour_baseline_expected_mwh", where),
    driverGroupVersion: str(raw, "driver_group_version", where),
    driverGroupHash: str(raw, "driver_group_hash", where),
    backgroundSource: str(raw, "background_source", where),
    backgroundSeed: num(raw, "background_seed", where),
    backgroundRows: num(raw, "background_rows", where),
    coalitions: num(raw, "coalitions", where),
    ruleFlags,
    governingRuleAction: strictestAction(ruleFlags),
    drivers,
  };
  assertDecomposes(attribution, where);
  return attribution;
}

/**
 * The eight, at one grain — all of them, ranked, whatever any rule decided.
 *
 * The count is checked before anything else and is not conditional on the rule
 * flags. That unconditionality *is* the valve: `withhold` suppresses the model
 * narration and the template renders instead; it has never been a licence to
 * return `drivers: []`, and a write path that accepted seven groups would make
 * the difference undetectable a day later.
 */
function parseDrivers(
  raw: unknown,
  where: string,
  grain: AttributionGrain,
): PublishedDriver[] {
  if (!Array.isArray(raw)) {
    throw new AttributionPayloadError(`${where} is not a list of driver groups`);
  }
  if (raw.length !== DRIVER_GROUP_CODES.length) {
    throw new AttributionPayloadError(
      `${where} carries ${raw.length} groups and an attribution is all ` +
        `${DRIVER_GROUP_CODES.length} exactly once. A rule may annotate, ` +
        "demote or withhold and may never delete a driver",
    );
  }
  const drivers = raw.map((row, index) => parseDriver(row, `${where}[${index}]`, grain));
  const codes = new Set(drivers.map((driver) => driver.driverGroup));
  const missing = DRIVER_GROUP_CODES.filter((code) => !codes.has(code));
  if (missing.length > 0) {
    throw new AttributionPayloadError(
      `${where} is missing ${missing.join(", ")}; the eight codes are a closed ` +
        "set and a ninth is a wire-contract change",
    );
  }
  return drivers;
}

function parseDriver(
  raw: unknown,
  where: string,
  grain: AttributionGrain,
): PublishedDriver {
  if (!isRecord(raw)) {
    throw new AttributionPayloadError(`${where} is not a driver group`);
  }
  const phiMwh = num(raw, "phi_mwh", where);
  const direction = str(raw, "direction", where);
  if (direction !== "raises" && direction !== "lowers") {
    throw new AttributionPayloadError(`${where}: ${direction} is not a direction`);
  }
  if (direction !== (phiMwh < 0 ? "lowers" : "raises")) {
    throw new AttributionPayloadError(
      `${where}: Φ is ${phiMwh} and the direction is ${direction}; the sign is ` +
        "not a separate decision",
    );
  }
  const share = num(raw, "share", where);
  if (!(share >= 0 && share <= 1)) {
    throw new AttributionPayloadError(`${where}: share is ${share}`);
  }
  const disagreement =
    grain === "day"
      ? num(raw, "hour_disagreement", where)
      : hourDisagreementAbsent(raw, where);
  if (disagreement !== null && disagreement < 1) {
    throw new AttributionPayloadError(
      `${where}: hour_disagreement is ${disagreement}; Σ|φ_t| ≥ |Σ φ_t| is a ` +
        "triangle inequality and a ratio below 1 means the two were computed " +
        "from different hours",
    );
  }
  return {
    grain,
    driverGroup: str(raw, "code", where),
    labelCode: str(raw, "label_code", where),
    rank: num(raw, "rank", where),
    phiMwh,
    share,
    direction,
    hourDisagreement: disagreement,
    headlineFeature: str(raw, "headline_feature", where),
    observed: num(raw, "observed", where),
    typical: num(raw, "typical", where),
    unit: str(raw, "unit", where),
    demoted: raw.demoted === true,
  };
}

/** The peak hour is one hour. A disagreement figure on it would be a fiction. */
function hourDisagreementAbsent(raw: Record<string, unknown>, where: string): null {
  if (raw.hour_disagreement !== undefined && raw.hour_disagreement !== null) {
    throw new AttributionPayloadError(
      `${where}: the peak hour carries hour_disagreement ` +
        `${String(raw.hour_disagreement)}; one hour has nothing to disagree with`,
    );
  }
  return null;
}

/**
 * The fired rules, with their inputs.
 *
 * Stored so that a strange narration can be traced to the rule that shaped it.
 * The action is checked against the closed set of three, because a rule that
 * claimed a fourth action would be claiming a power the valve does not grant.
 */
function parseRuleFlags(raw: unknown, where: string): FiredRule[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new AttributionPayloadError(`${where} is not a list of fired rules`);
  }
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry)) {
      throw new AttributionPayloadError(`${at} is not a fired rule`);
    }
    const action = str(entry, "action", at);
    if (!RULE_ACTIONS.has(action)) {
      throw new AttributionPayloadError(
        `${at}: ${action} is not a rule action. A rule may annotate, demote or ` +
          "withhold, and may do nothing else",
      );
    }
    const facts = entry.facts;
    if (facts !== undefined && !isRecord(facts)) {
      throw new AttributionPayloadError(`${at}: facts is not an object`);
    }
    return {
      code: str(entry, "code", at),
      action: action as RuleAction,
      facts: (facts ?? {}) as Record<string, unknown>,
    };
  });
}

/** `withhold` > `demote` > `annotate`, so two rules cannot both have the last word. */
function strictestAction(flags: readonly FiredRule[]): RuleAction | null {
  let strictest: RuleAction | null = null;
  for (const flag of flags) {
    if (
      strictest === null ||
      RULE_ACTION_ORDER.indexOf(flag.action) > RULE_ACTION_ORDER.indexOf(strictest)
    ) {
      strictest = flag.action;
    }
  }
  return strictest;
}

/**
 * The two arithmetic identities a stored attribution is required to satisfy.
 *
 * **Local accuracy**: the eight contributions add up to
 * `day_expected_mwh − baseline_expected_mwh`. If they do not they are not a
 * decomposition of anything and the bar chart is a picture of nothing.
 *
 * **Shares over all eight**: `share_j = |Φ_j| / Σ_k |Φ_k|`, so the eight shares
 * sum to 1. Checked because the wrong denominator — the displayed rows — is
 * invisible once stored, and produces a chart whose bars are individually
 * plausible and collectively a different quantity.
 */
function assertDecomposes(attribution: PublishedAttribution, where: string): void {
  const day = attribution.drivers.filter((driver) => driver.grain === "day");
  const movement = attribution.dayExpectedMwh - attribution.baselineExpectedMwh;
  const attributed = day.reduce((total, driver) => total + driver.phiMwh, 0);
  const scale = Math.max(
    1,
    Math.abs(attribution.dayExpectedMwh),
    Math.abs(attribution.baselineExpectedMwh),
  );
  if (Math.abs(attributed - movement) > LOCAL_ACCURACY_TOLERANCE * scale) {
    throw new AttributionPayloadError(
      `${where}: the eight day contributions sum to ${attributed} and ` +
        `day_expected_mwh − baseline_expected_mwh is ${movement}; a residual of ` +
        `${attributed - movement} is above the arithmetic's own ` +
        `${LOCAL_ACCURACY_TOLERANCE} × ${scale}`,
    );
  }
  for (const grain of ["day", "peak_hour"] as const) {
    const rows = attribution.drivers.filter((driver) => driver.grain === grain);
    const sumAbs = rows.reduce((total, driver) => total + Math.abs(driver.phiMwh), 0);
    const shares = rows.reduce((total, driver) => total + driver.share, 0);
    const expected = sumAbs === 0 ? 0 : 1;
    if (Math.abs(shares - expected) > 1e-9) {
      throw new AttributionPayloadError(
        `${where}: the ${grain} shares sum to ${shares} rather than ${expected}. ` +
          "A share is |Φ_j| / Σ_k |Φ_k| over all eight groups, never over the " +
          "rows the screen displays",
      );
    }
    for (const driver of rows) {
      const share = sumAbs === 0 ? 0 : Math.abs(driver.phiMwh) / sumAbs;
      if (Math.abs(share - driver.share) > 1e-9) {
        throw new AttributionPayloadError(
          `${where}: ${driver.driverGroup} at ${grain} carries share ` +
            `${driver.share} and |Φ| / Σ|Φ| is ${share}`,
        );
      }
    }
  }
}

/**
 * Digest of one attribution's *values* — never its vintage.
 *
 * The map and the background are values here, not metadata. Re-publishing the
 * same day under a new `driver_group_hash` or against a different background is
 * a different explanation of the same day, and a digest that ignored either
 * would silently decline to record it.
 */
export function attributionDigest(
  publication: AttributionPublication,
  attribution: PublishedAttribution,
): string {
  return digestValues([
    publication.artifactId,
    publication.featureSet,
    publication.correctionRegime,
    publication.thresholdMw,
    attribution.baselineExpectedMwh,
    attribution.dayExpectedMwh,
    attribution.totalAttributedMwh,
    attribution.sumAbsAttributedMwh,
    attribution.localAccuracyResidualMwh,
    attribution.topTwoShare,
    attribution.attributionStderrMwh,
    attribution.baselineStderrMwh,
    attribution.stderrResamples,
    attribution.stderrSeed,
    attribution.peakHourLocal,
    attribution.peakHourExpectedMwh,
    attribution.peakHourBaselineExpectedMwh,
    attribution.driverGroupVersion,
    attribution.driverGroupHash,
    attribution.backgroundSource,
    attribution.backgroundSeed,
    attribution.backgroundRows,
    attribution.coalitions,
    attribution.governingRuleAction,
    JSON.stringify(attribution.ruleFlags),
    ...attribution.drivers
      .slice()
      .sort((left, right) =>
        `${left.grain}|${left.driverGroup}`.localeCompare(
          `${right.grain}|${right.driverGroup}`,
        ),
      )
      .flatMap((driver) => [
        driver.grain,
        driver.driverGroup,
        driver.labelCode,
        driver.rank,
        driver.phiMwh,
        driver.share,
        driver.direction,
        driver.hourDisagreement,
        driver.headlineFeature,
        driver.observed,
        driver.typical,
        driver.unit,
        driver.demoted ? "demoted" : "shown",
      ]),
  ]);
}

interface LatestVersion {
  dataVersion: number;
  valueDigest: string;
}

/**
 * Persist one publication. One transaction, append-only, idempotent.
 *
 * Idempotent by digest rather than by upsert: running the same publication
 * twice writes nothing the second time, which is what makes a retry after a
 * failure safe *and* what stops a re-run inflating `data_version` past the
 * vintages a replay may want to pin.
 */
export async function writeAttributionPublication(
  db: Database,
  publication: AttributionPublication,
  options: { ingestedAt?: Date } = {},
): Promise<AttributionWriteResult> {
  assertPublishedBeforeTheDay(publication);
  const ingestedAt = options.ingestedAt ?? new Date();

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const latest = await latestVersions(scoped, publication);

    const result: AttributionWriteResult = {
      attributionsInserted: 0,
      attributionsRevised: 0,
      attributionsUnchanged: 0,
      driversInserted: 0,
    };

    const parents: (typeof diagnosisAttribution.$inferInsert)[] = [];
    const children: (typeof diagnosisAttributionDriver.$inferInsert)[] = [];

    for (const attribution of publication.attributions) {
      const valueDigest = attributionDigest(publication, attribution);
      const current = latest.get(attribution.subsystem);
      if (current?.valueDigest === valueDigest) {
        result.attributionsUnchanged += 1;
        continue;
      }
      if (current) {
        result.attributionsRevised += 1;
      } else {
        result.attributionsInserted += 1;
      }
      const dataVersion = (current?.dataVersion ?? 0) + 1;
      parents.push({
        subsystem: attribution.subsystem,
        targetDate: attribution.targetDate,
        originKind: publication.originKind,
        gateProfile: publication.gateProfile,
        forecastProducer: PRODUCER,
        runLabel: publication.artifactId,
        featureSet: publication.featureSet,
        correctionRegime: publication.correctionRegime,
        thresholdMw: publication.thresholdMw,
        target: ATTRIBUTION_TARGET_DAY,
        explains: EXPLAINS_CODE,
        hoursAttributed: attribution.hoursAttributed,
        baselineExpectedMwh: attribution.baselineExpectedMwh,
        dayExpectedMwh: attribution.dayExpectedMwh,
        totalAttributedMwh: attribution.totalAttributedMwh,
        sumAbsAttributedMwh: attribution.sumAbsAttributedMwh,
        localAccuracyResidualMwh: attribution.localAccuracyResidualMwh,
        topTwoShare: attribution.topTwoShare,
        attributionStderrMwh: attribution.attributionStderrMwh,
        baselineStderrMwh: attribution.baselineStderrMwh,
        stderrResamples: attribution.stderrResamples,
        stderrSeed: attribution.stderrSeed,
        peakHourLocal: attribution.peakHourLocal,
        peakHourExpectedMwh: attribution.peakHourExpectedMwh,
        peakHourBaselineExpectedMwh: attribution.peakHourBaselineExpectedMwh,
        driverGroupVersion: attribution.driverGroupVersion,
        driverGroupHash: attribution.driverGroupHash,
        backgroundSource: attribution.backgroundSource,
        backgroundSeed: attribution.backgroundSeed,
        backgroundRows: attribution.backgroundRows,
        coalitions: attribution.coalitions,
        ruleFlags: attribution.ruleFlags,
        governingRuleAction: attribution.governingRuleAction,
        dataVersion,
        publishedAt: publication.publishedAt,
        ingestedAt,
        valueDigest,
      });
      for (const driver of attribution.drivers) {
        children.push({
          subsystem: attribution.subsystem,
          targetDate: attribution.targetDate,
          originKind: publication.originKind,
          gateProfile: publication.gateProfile,
          dataVersion,
          grain: driver.grain,
          driverGroup: driver.driverGroup,
          labelCode: driver.labelCode,
          rank: driver.rank,
          phiMwh: driver.phiMwh,
          share: driver.share,
          direction: driver.direction,
          hourDisagreement: driver.hourDisagreement,
          headlineFeature: driver.headlineFeature,
          observed: driver.observed,
          typical: driver.typical,
          unit: driver.unit,
          demoted: driver.demoted,
        });
      }
      result.driversInserted += attribution.drivers.length;
    }

    // Both, inside one transaction, or neither. An attribution row without its
    // eight bars — or eight bars with no row saying what they decompose — is
    // the half-written publication the table's foreign key already refuses.
    if (parents.length > 0) {
      await scoped.insert(diagnosisAttribution).values(parents).onConflictDoNothing();
      await scoped
        .insert(diagnosisAttributionDriver)
        .values(children)
        .onConflictDoNothing();
    }
    return result;
  });
}

/**
 * The publication instant precedes the day it explains.
 *
 * The table's own constraint is the guarantee; this is the diagnosis. A
 * violation arriving at Postgres is a constraint name and a row, and the
 * question an operator actually has is which lane explained a day it had
 * already lived through.
 */
function assertPublishedBeforeTheDay(publication: AttributionPublication): void {
  for (const attribution of publication.attributions) {
    if (attribution.targetDate !== publication.targetDate) {
      throw new AttributionPayloadError(
        `${publication.lane}: an attribution of ${attribution.targetDate} arrived ` +
          `in a publication of ${publication.targetDate}`,
      );
    }
  }
  // Brasília midnight at the standard offset. Deliberately the *permissive*
  // reading: Brazil abolished summer time in 2019, and on the historical days
  // that had it the true midnight is an hour earlier, so this admits an instant
  // the table's `at time zone 'America/Sao_Paulo'` constraint would still
  // refuse. The constraint is the guarantee; this is the message.
  const dayStart = Date.parse(`${publication.targetDate}T03:00:00.000Z`);
  if (publication.publishedAt.getTime() >= dayStart) {
    throw new AttributionPayloadError(
      `${publication.lane} published at ${publication.publishedAt.toISOString()}, ` +
        `at or after the Brasília day ${publication.targetDate} it explains. An ` +
        "attribution is published with the forecast it explains, at its gate.",
    );
  }
  const seen = new Set<string>();
  for (const attribution of publication.attributions) {
    if (seen.has(attribution.subsystem)) {
      throw new AttributionPayloadError(
        `${publication.lane}: ${attribution.subsystem} appears twice in one ` +
          "publication, and one subsystem-day has one explanation",
      );
    }
    seen.add(attribution.subsystem);
  }
}

async function latestVersions(
  db: Database,
  publication: AttributionPublication,
): Promise<Map<string, LatestVersion>> {
  const rows = await db.execute<{
    subsystem: string;
    data_version: number;
    value_digest: string;
  }>(sql`
    select distinct on (subsystem)
      subsystem, data_version, value_digest
    from diagnosis_attribution
    where target_date = ${publication.targetDate}::date
      and origin_kind = ${publication.originKind}::forecast_origin_kind
      and gate_profile = ${publication.gateProfile}::forecast_gate_profile
    order by subsystem, data_version desc
  `);
  const latest = new Map<string, LatestVersion>();
  for (const row of rows) {
    latest.set(String(row.subsystem), {
      dataVersion: Number(row.data_version),
      valueDigest: String(row.value_digest),
    });
  }
  return latest;
}

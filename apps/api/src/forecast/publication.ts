import { sql } from "drizzle-orm";
import type { Database } from "../database/connection.js";
import {
  curtailmentForecastDay,
  curtailmentForecastHour,
  curtailmentForecastNationalDay,
} from "../database/schema.js";
import { UpstreamError } from "../errors.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import { digestValues } from "../ingest/versioned-write.js";

/**
 * A publication, on its way into Postgres.
 *
 * **The worker writes; the modelling service computes.**
 * `docs/specs/api-surface.md`'s boundary decision puts the inference ten minutes
 * after each gate on the worker, calls `POST /internal/publish/forecast` over
 * the private network, and has the *worker* write what comes back — because the
 * modelling service is read-only against Postgres and because every write in
 * this product belongs to the service that owns the Drizzle schema. This module
 * is the second half of that sentence.
 *
 * Three properties, each of which the shape here is what enforces:
 *
 * 1. **A publication is one transaction.** The hour rows and the day rows go in
 *    together or neither goes in. A half-written publication would be a day
 *    whose band came from one artifact and whose hours came from another, and
 *    the day-ahead route would serve it without being able to tell.
 * 2. **It is additive, never an update.** A re-publication of the same key with
 *    different numbers is a new `data_version`; one with identical numbers
 *    writes nothing at all. Nothing is ever overwritten, so `AsOf(t)` keeps
 *    working and an older replay stays reconstructible at its own instant.
 * 3. **The publication instant is the gate**, and it is checked here before the
 *    first insert as well as by the table's own constraint. Both on purpose:
 *    the constraint is the guarantee, this is the diagnosis — a violation
 *    arriving at Postgres is a constraint name and a row, and the question an
 *    operator actually has is which lane published too late.
 *
 * What this module deliberately does **not** do is compute. There is no
 * arithmetic here on a band, no day total assembled from hours, and no default
 * for a missing figure: a payload that is short of a field is refused, because
 * the alternative — a zero — is the invented number the whole spec is against.
 */

/** `ForecastOrigin.origin_kind`: a record, or a reconstruction. */
export type ForecastOriginKind = "served" | "backfilled_holdout";

/** Which decision gate produced the row. */
export type ForecastGateProfile = "gate_early" | "gate_late";

/** One published hour, exactly as `wattsteer_ml.publication.HourRow` writes it. */
export interface PublishedHour {
  subsystem: SubsystemCode;
  validTime: Date;
  targetDate: string;
  localHour: number;
  thresholdMw: number;
  occurrenceProbability: number;
  p10Mwh: number;
  p50Mwh: number;
  p90Mwh: number;
  expectedMwh: number;
  p50WindMwh: number;
  p50SolarMwh: number;
  expectedWindMwh: number;
  expectedSolarMwh: number;
  crossed: boolean;
  derivation: string;
}

/** One published day — the companion row, and the figures that are only on it. */
export interface PublishedDay {
  subsystem: SubsystemCode;
  targetDate: string;
  thresholdMw: number;
  dayTotal: { p10: number; p50: number; p90: number };
  peakPower: { p10: number; p50: number; p90: number };
  dayOccurrenceProbability: number;
  expectedMwh: number;
  expectedWindMwh: number;
  expectedSolarMwh: number;
  hoursP50Nonzero: number;
  /** `path_ensemble`. Stored, and refused here if it says anything else. */
  derivation: string;
  ensembleDraws: number;
  ensembleSeed: number;
  ensembleCalibrationDays: number;
}

/**
 * The one national day of a publication — forecaster ticket 22.
 *
 * Beside `days`, never inside it: `SIN` is not a `Subsystem`
 * (`docs/domain-model.md`, vocabulary rule 6), so the national figure has its
 * own grain and its own table rather than a fifth row of the subsystem one.
 *
 * Optional, and `undefined` is a real state rather than a defaulting bug: a
 * publication short of a subsystem has no national figure — a total over three
 * is a different quantity wearing the same name — and so does one produced by
 * an artifact trained before the shared draw index landed. The route renders
 * that absence with a stated reason and never as a zero.
 */
export interface PublishedNationalDay {
  targetDate: string;
  thresholdMw: number;
  /** Quantiles of the four day totals added draw by draw. Never a sum of bands. */
  dayTotal: { p10: number; p50: number; p90: number };
  /** Quantiles of `max_t Σ_s`. Peak of the sum, never a sum of peaks. */
  peakPower: { p10: number; p50: number; p90: number };
  /** The share of draws in which some subsystem had some hour above τ. */
  dayOccurrenceProbability: number;
  /** `Σ_s E[Y_s]` — the one national quantity that adds exactly. */
  expectedMwh: number;
  /** The four this was summed over, in canonical order. */
  subsystems: SubsystemCode[];
  /** `joint_path_ensemble`. Refused here if it says anything else. */
  derivation: string;
  ensembleDraws: number;
  ensembleSeed: number;
  ensembleCalibrationDays: number;
}

/** One lane's day, as the modelling service handed it over. */
export interface ForecastPublication {
  lane: string;
  featureSet: string;
  gateProfile: ForecastGateProfile;
  originKind: ForecastOriginKind;
  targetDate: string;
  /** `gate_at(target_date, gate_profile)` — never the request time. */
  publishedAt: Date;
  artifactId: string;
  trainedThrough: string;
  thresholdMw: number;
  riskBinElevatedFrom: number;
  riskBinHighFrom: number;
  correctionRegime: string;
  hours: PublishedHour[];
  days: PublishedDay[];
  /** The national day, when the publication covered all four subsystems. */
  national?: PublishedNationalDay;
}

/** What one publication actually did — the shape an operator wants in a log. */
export interface PublicationWriteResult {
  hoursInserted: number;
  hoursRevised: number;
  hoursUnchanged: number;
  daysInserted: number;
  daysRevised: number;
  daysUnchanged: number;
  nationalInserted: number;
  nationalRevised: number;
  nationalUnchanged: number;
}

/** The one derivation a published day figure may claim. */
export const PATH_ENSEMBLE = "path_ensemble";

/**
 * The one derivation a published *national* figure may claim.
 *
 * Deliberately not `path_ensemble`: that names a draw over one subsystem's
 * whole days, and this names four of them added on one shared row index of `U`.
 * A national figure stamped `path_ensemble` would be a national band standing
 * on a per-subsystem draw, which is the arithmetic this grain exists to remove.
 */
export const JOINT_PATH_ENSEMBLE = "joint_path_ensemble";

/** `ForecastOrigin.producer` for a WattSteer curtailment forecast. */
const PRODUCER = "wattsteer" as const;

const SUBSYSTEMS: ReadonlySet<string> = new Set(["N", "NE", "S", "SE"]);
const GATE_PROFILES: ReadonlySet<string> = new Set(["gate_early", "gate_late"]);
const ORIGIN_KINDS: ReadonlySet<string> = new Set(["served", "backfilled_holdout"]);

/** A payload that cannot be persisted, and why. Never a partial write. */
export class PublicationPayloadError extends UpstreamError {
  constructor(message: string) {
    super(`publication payload: ${message}`);
    this.name = "PublicationPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(source: Record<string, unknown>, field: string, where: string): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PublicationPayloadError(`${where}: ${field} is ${String(value)}`);
  }
  return value;
}

function str(source: Record<string, unknown>, field: string, where: string): string {
  const value = source[field];
  if (typeof value !== "string" || value === "") {
    throw new PublicationPayloadError(`${where}: ${field} is ${String(value)}`);
  }
  return value;
}

function band(
  source: Record<string, unknown>,
  field: string,
  where: string,
): { p10: number; p50: number; p90: number } {
  const raw = source[field];
  if (!isRecord(raw)) {
    throw new PublicationPayloadError(`${where}: ${field} is not a band`);
  }
  const parsed = {
    p10: num(raw, "p10", `${where}.${field}`),
    p50: num(raw, "p50", `${where}.${field}`),
    p90: num(raw, "p90", `${where}.${field}`),
  };
  if (!(parsed.p10 <= parsed.p50 && parsed.p50 <= parsed.p90)) {
    throw new PublicationPayloadError(
      `${where}: ${field} is not monotone (${parsed.p10}, ${parsed.p50}, ${parsed.p90})`,
    );
  }
  return parsed;
}

function instant(value: unknown, where: string): Date {
  if (typeof value !== "string") {
    throw new PublicationPayloadError(`${where} is not an instant`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new PublicationPayloadError(`${where} is not an instant: ${value}`);
  }
  return parsed;
}

function civilDate(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PublicationPayloadError(`${where} is not a civil date: ${String(value)}`);
  }
  return value;
}

function subsystemOf(source: Record<string, unknown>, where: string): SubsystemCode {
  const value = str(source, "subsystem", where);
  if (!SUBSYSTEMS.has(value)) {
    throw new PublicationPayloadError(`${where}: ${value} is not a subsystem`);
  }
  return value as SubsystemCode;
}

/**
 * Read the modelling service's payload into rows this gateway can stand behind.
 *
 * Every field is required and nothing is defaulted. The service is internal and
 * trusted to be *correct*, not trusted to be *present*: a field that silently
 * became a zero here would put an invented number in a table whose whole
 * purpose is that nothing in it was invented.
 */
export function parsePublication(payload: unknown): ForecastPublication {
  if (!isRecord(payload)) {
    throw new PublicationPayloadError("the body is not an object");
  }
  const lane = str(payload, "lane", "publication");
  const targetDate = civilDate(payload.target_date, "publication.target_date");
  const origin = payload.forecast_origin;
  if (!isRecord(origin)) {
    throw new PublicationPayloadError("publication carries no forecast_origin");
  }
  if (origin.producer !== PRODUCER) {
    throw new PublicationPayloadError(
      `the producer of a WattSteer curtailment forecast is ${PRODUCER}, not ` +
        `${String(origin.producer)}`,
    );
  }
  const gateProfile = str(origin, "gate_profile", "forecast_origin");
  if (!GATE_PROFILES.has(gateProfile)) {
    throw new PublicationPayloadError(`${gateProfile} is not a gate profile`);
  }
  const originKind = str(origin, "origin_kind", "forecast_origin");
  if (!ORIGIN_KINDS.has(originKind)) {
    throw new PublicationPayloadError(`${originKind} is not an origin kind`);
  }
  const artifact = isRecord(payload.artifact) ? payload.artifact : {};
  const riskBins = isRecord(payload.risk_bins) ? payload.risk_bins : {};
  const elevated = riskBins.elevated;
  const high = riskBins.high;
  if (!(Array.isArray(elevated) && Array.isArray(high))) {
    throw new PublicationPayloadError(
      "publication carries no risk_bins; a risk class the response cannot " +
        "publish the edges of is asserted rather than checkable",
    );
  }

  const hours = (Array.isArray(payload.hours) ? payload.hours : []).map((row, index) =>
    parseHour(row, `hours[${index}]`),
  );
  const days = (Array.isArray(payload.days) ? payload.days : []).map((row, index) =>
    parseDay(row, `days[${index}]`),
  );
  if (hours.length === 0 || days.length === 0) {
    throw new PublicationPayloadError(
      `${lane} ${targetDate}: a publication with no ${
        hours.length === 0 ? "hour" : "day"
      } rows is not a publication. An absence is refused upstream and is never ` +
        "written as an empty forecast",
    );
  }

  const national = parseNational(payload.national, targetDate);
  if (national !== undefined) {
    const covered = new Set(days.map((day) => day.subsystem));
    const missing = national.subsystems.filter((code) => !covered.has(code));
    if (missing.length > 0) {
      throw new PublicationPayloadError(
        `the national figure is summed over ${missing.join(", ")}, which this ` +
          "publication carries no day row for. The national row and the four " +
          "subsystem rows are one transaction, so a national band whose " +
          "components are absent is not a state",
      );
    }
  }

  return {
    lane,
    featureSet: str(payload, "feature_set", "publication"),
    gateProfile: gateProfile as ForecastGateProfile,
    originKind: originKind as ForecastOriginKind,
    targetDate,
    publishedAt: instant(origin.published_at, "forecast_origin.published_at"),
    artifactId: str(origin, "run_label", "forecast_origin"),
    trainedThrough: civilDate(artifact.trained_through, "artifact.trained_through"),
    thresholdMw: num(payload, "threshold_mw", "publication"),
    riskBinElevatedFrom: Number(elevated[0]),
    riskBinHighFrom: Number(high[0]),
    correctionRegime: str(payload, "correction_regime", "publication"),
    hours,
    days,
    ...(national === undefined ? {} : { national }),
  };
}

/**
 * The national block, or its absence.
 *
 * `null`/absent is accepted, because it is a real state and not a missing
 * field: the modelling service emits `national: null` for a publication short
 * of a subsystem, and an artifact trained before the shared draw index has no
 * national figure at all. What is refused is a national block whose
 * `derivation` is not the shared-draw ensemble — the same refusal `days` gets
 * for anything but `path_ensemble`, and for the same reason: a national band
 * that was not drawn jointly was arrived at by adding four quantiles, which is
 * the defect this grain exists to remove.
 */
function parseNational(
  raw: unknown,
  targetDate: string,
): PublishedNationalDay | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const where = "national";
  if (!isRecord(raw)) {
    throw new PublicationPayloadError(`${where} is not a row`);
  }
  const derivation = str(raw, "derivation", where);
  if (derivation !== JOINT_PATH_ENSEMBLE) {
    throw new PublicationPayloadError(
      `${where}: a national figure derived by ${derivation} is not publishable; ` +
        "the national band is a quantile of the four subsystems' paths added " +
        `draw by draw under one shared index (${JOINT_PATH_ENSEMBLE}), and never ` +
        "a sum of the four subsystem bands",
    );
  }
  const subsystems = raw.subsystems;
  if (!Array.isArray(subsystems)) {
    throw new PublicationPayloadError(
      `${where}: no subsystems array, so nothing says the figure covered the ` +
        "whole grid rather than three of it",
    );
  }
  const covered = subsystems.map((code, index) => {
    if (typeof code !== "string" || !SUBSYSTEMS.has(code)) {
      throw new PublicationPayloadError(
        `${where}.subsystems[${index}]: ${String(code)} is not a subsystem. ` +
          "`SIN` is not one either — the national figure is a key, never a " +
          "fifth member of a four-member enum",
      );
    }
    return code as SubsystemCode;
  });
  if (new Set(covered).size !== SUBSYSTEMS.size) {
    throw new PublicationPayloadError(
      `${where}: the figure names ${covered.join(", ") || "no subsystem"}; a ` +
        "national total over anything but the four is a different quantity " +
        "wearing the same name",
    );
  }
  const rowDate = civilDate(raw.target_date, `${where}.target_date`);
  if (rowDate !== targetDate) {
    throw new PublicationPayloadError(
      `a national row for ${rowDate} arrived in a publication of ${targetDate}`,
    );
  }
  return {
    targetDate: rowDate,
    thresholdMw: num(raw, "threshold_mw", where),
    dayTotal: band(raw, "day_total", where),
    peakPower: band(raw, "peak_power", where),
    dayOccurrenceProbability: num(raw, "day_occurrence_probability", where),
    expectedMwh: num(raw, "expected_mwh", where),
    subsystems: covered,
    derivation,
    ensembleDraws: num(raw, "ensemble_draws", where),
    ensembleSeed: num(raw, "ensemble_seed", where),
    ensembleCalibrationDays: num(raw, "ensemble_calibration_days", where),
  };
}

function parseHour(raw: unknown, where: string): PublishedHour {
  if (!isRecord(raw)) {
    throw new PublicationPayloadError(`${where} is not a row`);
  }
  return {
    subsystem: subsystemOf(raw, where),
    validTime: instant(raw.valid_time, `${where}.valid_time`),
    targetDate: civilDate(raw.target_date, `${where}.target_date`),
    localHour: num(raw, "local_hour", where),
    thresholdMw: num(raw, "threshold_mw", where),
    occurrenceProbability: num(raw, "occurrence_probability", where),
    p10Mwh: num(raw, "p10_mwh", where),
    p50Mwh: num(raw, "p50_mwh", where),
    p90Mwh: num(raw, "p90_mwh", where),
    expectedMwh: num(raw, "expected_mwh", where),
    p50WindMwh: num(raw, "p50_wind_mwh", where),
    p50SolarMwh: num(raw, "p50_solar_mwh", where),
    expectedWindMwh: num(raw, "expected_wind_mwh", where),
    expectedSolarMwh: num(raw, "expected_solar_mwh", where),
    crossed: raw.crossed === true,
    derivation: str(raw, "derivation", where),
  };
}

function parseDay(raw: unknown, where: string): PublishedDay {
  if (!isRecord(raw)) {
    throw new PublicationPayloadError(`${where} is not a row`);
  }
  const derivation = str(raw, "derivation", where);
  if (derivation !== PATH_ENSEMBLE) {
    // The one value check in this file, and it is here rather than left to the
    // table's constraint because this is where the sentence can be said: a day
    // figure that did not come off the path ensemble came off a sum of
    // quantiles, which `docs/specs/replay.md` forbids by name.
    throw new PublicationPayloadError(
      `${where}: a day figure derived by ${derivation} is not publishable; the ` +
        `day total is a quantile of the path ensemble (${PATH_ENSEMBLE}) and ` +
        "never a sum of the hourly band",
    );
  }
  return {
    subsystem: subsystemOf(raw, where),
    targetDate: civilDate(raw.target_date, `${where}.target_date`),
    thresholdMw: num(raw, "threshold_mw", where),
    dayTotal: band(raw, "day_total", where),
    peakPower: band(raw, "peak_power", where),
    dayOccurrenceProbability: num(raw, "day_occurrence_probability", where),
    expectedMwh: num(raw, "expected_mwh", where),
    expectedWindMwh: num(raw, "expected_wind_mwh", where),
    expectedSolarMwh: num(raw, "expected_solar_mwh", where),
    hoursP50Nonzero: num(raw, "hours_p50_nonzero", where),
    derivation,
    ensembleDraws: num(raw, "ensemble_draws", where),
    ensembleSeed: num(raw, "ensemble_seed", where),
    ensembleCalibrationDays: num(raw, "ensemble_calibration_days", where),
  };
}

/** Digest of an hour row's *values* — never its vintage. */
export function hourDigest(
  publication: ForecastPublication,
  hour: PublishedHour,
): string {
  return digestValues([
    publication.artifactId,
    publication.correctionRegime,
    publication.featureSet,
    hour.thresholdMw,
    hour.occurrenceProbability,
    hour.p10Mwh,
    hour.p50Mwh,
    hour.p90Mwh,
    hour.expectedMwh,
    hour.p50WindMwh,
    hour.p50SolarMwh,
    hour.expectedWindMwh,
    hour.expectedSolarMwh,
    hour.crossed ? "crossed" : "clean",
  ]);
}

/** Digest of a day row's values. The ensemble's parameters are values. */
export function dayDigest(publication: ForecastPublication, day: PublishedDay): string {
  return digestValues([
    publication.artifactId,
    publication.correctionRegime,
    publication.featureSet,
    publication.trainedThrough,
    day.thresholdMw,
    day.dayTotal.p10,
    day.dayTotal.p50,
    day.dayTotal.p90,
    day.peakPower.p10,
    day.peakPower.p50,
    day.peakPower.p90,
    day.dayOccurrenceProbability,
    day.expectedMwh,
    day.expectedWindMwh,
    day.expectedSolarMwh,
    day.hoursP50Nonzero,
    day.derivation,
    day.ensembleDraws,
    day.ensembleSeed,
    day.ensembleCalibrationDays,
    publication.riskBinElevatedFrom,
    publication.riskBinHighFrom,
  ]);
}

/**
 * Digest of the national row's values.
 *
 * The `subsystems` array is a value: a figure over three subsystems and one
 * over four are different numbers under the same key, and a digest that ignored
 * the coverage would call the second an unchanged republication of the first.
 */
export function nationalDigest(
  publication: ForecastPublication,
  national: PublishedNationalDay,
): string {
  return digestValues([
    publication.artifactId,
    publication.correctionRegime,
    publication.featureSet,
    publication.trainedThrough,
    national.thresholdMw,
    national.dayTotal.p10,
    national.dayTotal.p50,
    national.dayTotal.p90,
    national.peakPower.p10,
    national.peakPower.p50,
    national.peakPower.p90,
    national.dayOccurrenceProbability,
    national.expectedMwh,
    national.subsystems.join(","),
    national.derivation,
    national.ensembleDraws,
    national.ensembleSeed,
    national.ensembleCalibrationDays,
    publication.riskBinElevatedFrom,
    publication.riskBinHighFrom,
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
 * partial failure safe *and* what stops a re-run inflating `data_version` past
 * the vintages a replay may want to pin.
 */
export async function writePublication(
  db: Database,
  publication: ForecastPublication,
  options: { ingestedAt?: Date } = {},
): Promise<PublicationWriteResult> {
  assertShapedLikeAForecast(publication);
  const ingestedAt = options.ingestedAt ?? new Date();

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const hourLatest = await latestHourVersions(scoped, publication);
    const dayLatest = await latestDayVersions(scoped, publication);
    const nationalLatest = await latestNationalVersion(scoped, publication);

    const result: PublicationWriteResult = {
      hoursInserted: 0,
      hoursRevised: 0,
      hoursUnchanged: 0,
      daysInserted: 0,
      daysRevised: 0,
      daysUnchanged: 0,
      nationalInserted: 0,
      nationalRevised: 0,
      nationalUnchanged: 0,
    };

    const hourInserts: (typeof curtailmentForecastHour.$inferInsert)[] = [];
    for (const hour of publication.hours) {
      const valueDigest = hourDigest(publication, hour);
      const current = hourLatest.get(`${hour.subsystem}|${hour.validTime.toISOString()}`);
      if (current?.valueDigest === valueDigest) {
        result.hoursUnchanged += 1;
        continue;
      }
      if (current) {
        result.hoursRevised += 1;
      } else {
        result.hoursInserted += 1;
      }
      hourInserts.push({
        subsystem: hour.subsystem,
        validTime: hour.validTime,
        originKind: publication.originKind,
        gateProfile: publication.gateProfile,
        targetDate: hour.targetDate,
        localHour: hour.localHour,
        forecastProducer: PRODUCER,
        runLabel: publication.artifactId,
        featureSet: publication.featureSet,
        correctionRegime: publication.correctionRegime,
        thresholdMw: hour.thresholdMw,
        occurrenceProbability: hour.occurrenceProbability,
        p10Mwh: hour.p10Mwh,
        p50Mwh: hour.p50Mwh,
        p90Mwh: hour.p90Mwh,
        expectedMwh: hour.expectedMwh,
        p50WindMwh: hour.p50WindMwh,
        p50SolarMwh: hour.p50SolarMwh,
        expectedWindMwh: hour.expectedWindMwh,
        expectedSolarMwh: hour.expectedSolarMwh,
        crossed: hour.crossed,
        dataVersion: (current?.dataVersion ?? 0) + 1,
        publishedAt: publication.publishedAt,
        ingestedAt,
        valueDigest,
      });
    }

    const dayInserts: (typeof curtailmentForecastDay.$inferInsert)[] = [];
    for (const day of publication.days) {
      const valueDigest = dayDigest(publication, day);
      const current = dayLatest.get(`${day.subsystem}|${day.targetDate}`);
      if (current?.valueDigest === valueDigest) {
        result.daysUnchanged += 1;
        continue;
      }
      if (current) {
        result.daysRevised += 1;
      } else {
        result.daysInserted += 1;
      }
      dayInserts.push({
        subsystem: day.subsystem,
        targetDate: day.targetDate,
        originKind: publication.originKind,
        gateProfile: publication.gateProfile,
        forecastProducer: PRODUCER,
        runLabel: publication.artifactId,
        featureSet: publication.featureSet,
        correctionRegime: publication.correctionRegime,
        thresholdMw: day.thresholdMw,
        dayTotalP10Mwh: day.dayTotal.p10,
        dayTotalP50Mwh: day.dayTotal.p50,
        dayTotalP90Mwh: day.dayTotal.p90,
        peakPowerP10Mw: day.peakPower.p10,
        peakPowerP50Mw: day.peakPower.p50,
        peakPowerP90Mw: day.peakPower.p90,
        dayOccurrenceProbability: day.dayOccurrenceProbability,
        expectedMwh: day.expectedMwh,
        expectedWindMwh: day.expectedWindMwh,
        expectedSolarMwh: day.expectedSolarMwh,
        hoursP50Nonzero: day.hoursP50Nonzero,
        derivation: day.derivation,
        ensembleDraws: day.ensembleDraws,
        ensembleSeed: day.ensembleSeed,
        ensembleCalibrationDays: day.ensembleCalibrationDays,
        trainedThrough: publication.trainedThrough,
        riskBinElevatedFrom: publication.riskBinElevatedFrom,
        riskBinHighFrom: publication.riskBinHighFrom,
        dataVersion: (current?.dataVersion ?? 0) + 1,
        publishedAt: publication.publishedAt,
        ingestedAt,
        valueDigest,
      });
    }

    const nationalInserts: (typeof curtailmentForecastNationalDay.$inferInsert)[] = [];
    if (publication.national !== undefined) {
      const national = publication.national;
      const valueDigest = nationalDigest(publication, national);
      if (nationalLatest?.valueDigest === valueDigest) {
        result.nationalUnchanged += 1;
      } else {
        if (nationalLatest) {
          result.nationalRevised += 1;
        } else {
          result.nationalInserted += 1;
        }
        nationalInserts.push({
          targetDate: national.targetDate,
          originKind: publication.originKind,
          gateProfile: publication.gateProfile,
          thresholdMw: national.thresholdMw,
          forecastProducer: PRODUCER,
          runLabel: publication.artifactId,
          featureSet: publication.featureSet,
          correctionRegime: publication.correctionRegime,
          subsystems: national.subsystems,
          dayTotalP10Mwh: national.dayTotal.p10,
          dayTotalP50Mwh: national.dayTotal.p50,
          dayTotalP90Mwh: national.dayTotal.p90,
          peakPowerP10Mw: national.peakPower.p10,
          peakPowerP50Mw: national.peakPower.p50,
          peakPowerP90Mw: national.peakPower.p90,
          dayOccurrenceProbability: national.dayOccurrenceProbability,
          expectedMwh: national.expectedMwh,
          derivation: national.derivation,
          ensembleDraws: national.ensembleDraws,
          ensembleSeed: national.ensembleSeed,
          ensembleCalibrationDays: national.ensembleCalibrationDays,
          trainedThrough: publication.trainedThrough,
          riskBinElevatedFrom: publication.riskBinElevatedFrom,
          riskBinHighFrom: publication.riskBinHighFrom,
          dataVersion: (nationalLatest?.dataVersion ?? 0) + 1,
          publishedAt: publication.publishedAt,
          ingestedAt,
          valueDigest,
        });
      }
    }

    // All three, inside one transaction, or none. A day band without its hours —
    // or hours without the day band the route is required to read rather than
    // compute — is exactly the half-written publication the boundary decision
    // promises is not representable.
    if (hourInserts.length > 0) {
      await scoped
        .insert(curtailmentForecastHour)
        .values(hourInserts)
        .onConflictDoNothing();
    }
    if (dayInserts.length > 0) {
      await scoped
        .insert(curtailmentForecastDay)
        .values(dayInserts)
        .onConflictDoNothing();
    }
    // The national row is in the *same* transaction as the four subsystem rows,
    // which is the whole of forecaster ticket 22's third clause: a national band
    // that landed without its subsystems — or four subsystems whose national
    // band did not land — would be a partial publication, and the route would
    // serve it without being able to tell.
    if (nationalInserts.length > 0) {
      await scoped
        .insert(curtailmentForecastNationalDay)
        .values(nationalInserts)
        .onConflictDoNothing();
    }
    return result;
  });
}

/**
 * The forecast shape, checked before the first insert.
 *
 * `published_at < valid_time` is what makes these rows a `Forecast` rather than
 * an `Observation` (`docs/domain-model.md` §4), and the table's constraint
 * guarantees it. This is the diagnosis: the constraint would report a name and
 * a row, and the question is which lane published after the hour it describes.
 */
function assertShapedLikeAForecast(publication: ForecastPublication): void {
  for (const hour of publication.hours) {
    if (hour.validTime.getTime() <= publication.publishedAt.getTime()) {
      throw new PublicationPayloadError(
        `${publication.lane} published at ${publication.publishedAt.toISOString()}, ` +
          `at or after the ${hour.validTime.toISOString()} hour it forecasts. A ` +
          "row with published_at ≥ valid_time is an observation, and these tables " +
          "hold forecasts.",
      );
    }
    if (hour.targetDate !== publication.targetDate) {
      throw new PublicationPayloadError(
        `${publication.lane}: an hour of ${hour.targetDate} arrived in a ` +
          `publication of ${publication.targetDate}`,
      );
    }
  }
  for (const day of publication.days) {
    if (day.targetDate !== publication.targetDate) {
      throw new PublicationPayloadError(
        `${publication.lane}: a day row for ${day.targetDate} arrived in a ` +
          `publication of ${publication.targetDate}`,
      );
    }
  }
  const covered = new Set(publication.days.map((day) => day.subsystem));
  if (publication.national !== undefined) {
    // The national row goes in with the four subsystem rows or it does not go
    // in: a national band beside three day rows is a figure whose components
    // are not in the table it claims to have been summed from.
    const missing = publication.national.subsystems.filter((code) => !covered.has(code));
    if (missing.length > 0) {
      throw new PublicationPayloadError(
        `${publication.lane}: the national figure is summed over ` +
          `${missing.join(", ")}, which this publication carries no day row for. ` +
          "The national row and the four subsystem rows are one transaction, so " +
          "a national band whose components are absent is not a state",
      );
    }
    if (publication.national.thresholdMw !== publication.thresholdMw) {
      throw new PublicationPayloadError(
        `${publication.lane}: the national figure is against ` +
          `${publication.national.thresholdMw} MW and the publication against ` +
          `${publication.thresholdMw} MW; a magnitude and the threshold that ` +
          "produced it travel together",
      );
    }
  }
  for (const hour of publication.hours) {
    if (!covered.has(hour.subsystem)) {
      // The day row is what the route reads its day figures from; hours without
      // one would make the day band unanswerable except by adding them up.
      throw new PublicationPayloadError(
        `${publication.lane}: ${hour.subsystem} has hour rows and no day-grain ` +
          "row. The day total is read from the day row and is never reduced " +
          "from the hours, so a subsystem is published whole or not at all",
      );
    }
  }
}

async function latestHourVersions(
  db: Database,
  publication: ForecastPublication,
): Promise<Map<string, LatestVersion>> {
  const rows = await db.execute<{
    subsystem: string;
    valid_time: string;
    data_version: number;
    value_digest: string;
  }>(sql`
    select distinct on (subsystem, valid_time)
      subsystem, valid_time, data_version, value_digest
    from curtailment_forecast_hour
    where target_date = ${publication.targetDate}::date
      and origin_kind = ${publication.originKind}::forecast_origin_kind
      and gate_profile = ${publication.gateProfile}::forecast_gate_profile
    order by subsystem, valid_time, data_version desc
  `);
  const latest = new Map<string, LatestVersion>();
  for (const row of rows) {
    latest.set(`${row.subsystem}|${new Date(row.valid_time).toISOString()}`, {
      dataVersion: Number(row.data_version),
      valueDigest: String(row.value_digest),
    });
  }
  return latest;
}

/**
 * The newest vintage of this publication's national key, or none.
 *
 * `threshold_mw` is in the key here and is not in the subsystem grain's: two
 * thresholds are two national quantities rather than two beliefs about one, so
 * a sweep appends a second row instead of revising the first.
 */
async function latestNationalVersion(
  db: Database,
  publication: ForecastPublication,
): Promise<LatestVersion | undefined> {
  if (publication.national === undefined) {
    return undefined;
  }
  const rows = await db.execute<{
    data_version: number;
    value_digest: string;
  }>(sql`
    select data_version, value_digest
    from curtailment_forecast_national_day
    where target_date = ${publication.targetDate}::date
      and origin_kind = ${publication.originKind}::forecast_origin_kind
      and gate_profile = ${publication.gateProfile}::forecast_gate_profile
      and threshold_mw = ${publication.national.thresholdMw}::double precision
    order by data_version desc
    limit 1
  `);
  const [row] = [...rows];
  return row === undefined
    ? undefined
    : { dataVersion: Number(row.data_version), valueDigest: String(row.value_digest) };
}

async function latestDayVersions(
  db: Database,
  publication: ForecastPublication,
): Promise<Map<string, LatestVersion>> {
  const rows = await db.execute<{
    subsystem: string;
    target_date: string;
    data_version: number;
    value_digest: string;
  }>(sql`
    select distinct on (subsystem, target_date)
      subsystem, target_date, data_version, value_digest
    from curtailment_forecast_day
    where target_date = ${publication.targetDate}::date
      and origin_kind = ${publication.originKind}::forecast_origin_kind
      and gate_profile = ${publication.gateProfile}::forecast_gate_profile
    order by subsystem, target_date, data_version desc
  `);
  const latest = new Map<string, LatestVersion>();
  for (const row of rows) {
    latest.set(`${row.subsystem}|${String(row.target_date).slice(0, 10)}`, {
      dataVersion: Number(row.data_version),
      valueDigest: String(row.value_digest),
    });
  }
  return latest;
}

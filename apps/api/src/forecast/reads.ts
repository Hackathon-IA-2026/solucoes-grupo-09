import { sql } from "drizzle-orm";
import { readOnly } from "../contract/read-only.js";
import { applyAxes } from "../contract/scope.js";
import type { VintageFidelity } from "../contract/vintage.js";
import {
  canonicalForecastDay,
  canonicalForecastHour,
} from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import type { ForecastGateProfile } from "./publication.js";

/**
 * Reading back what was said — the query `/v1/forecast/day-ahead` is.
 *
 * **Two reads, and the day figures come from the day row.**
 * `docs/specs/replay.md` requires `forecast.day_total` to be read from the
 * contract and forbids reconstructing it by summing the hourly band, and
 * `docs/specs/api-surface.md` repeats it as the first of the day-ahead
 * response's five decisions. So there are two selects here — one per view — and
 * there is deliberately **no** aggregate over `canonical_forecast_hour` that
 * could produce a day figure. `hours_p50_nonzero` is stored rather than counted
 * here for the same reason the day band is: it is a property of the publication,
 * and a second place that computes it is a second answer.
 *
 * **`origin_kind` is filtered in the query, unconditionally.** Not in a branch,
 * not by a caller-supplied parameter with a default: `replay.md` seam 6
 * requires that a `backfilled_holdout` row is never returned by this route
 * "under any query", and a filter that a parameter can widen is not that. The
 * value is a constant in the SQL below and there is no argument that reaches it.
 *
 * **The round trip is the point.** These reads are what make the persisted rows
 * a *record*: `readForecastDayAhead` at the publication's own `as_of` returns
 * the numbers that were served, to the bit, because nothing between the write
 * and the read recomputes anything. That is the property forecaster ticket 14's
 * acceptance list calls "the rows round-trip through `AsOf` returning exactly
 * the numbers served", and it is a property of there being no arithmetic in
 * this file rather than of a test that happens to pass.
 */

/** The one origin kind this route may return. A constant, not a parameter. */
export const SERVED: "served" = "served";

/** The band shape, exactly as the wire publishes it. */
export interface ForecastBand {
  p10: number;
  p50: number;
  p90: number;
}

/** Two scalars. There is no per-technology band, and nowhere to put one. */
export interface ForecastSplit {
  windMwh: number;
  solarMwh: number;
}

/** One published hour, read back. */
export interface ForecastHourRow {
  validTime: Date;
  localHour: number;
  band: ForecastBand;
  /** A sibling of the band. Never its centre. */
  expectedMwh: number;
  occurrenceProbability: number;
  /** The split of the **expectation** — the two add to `expectedMwh`. */
  split: ForecastSplit;
  /** The split of the P50, carried for callers that plan against the median. */
  p50Split: ForecastSplit;
}

/** One published day: the figures that exist only at day grain, plus identity. */
export interface ForecastDayRow {
  subsystem: SubsystemCode;
  targetDate: string;
  gateProfile: ForecastGateProfile;
  thresholdMw: number;
  artifactId: string;
  featureSet: string;
  trainedThrough: string;
  /** Which correction regime composed every number in this answer. */
  correctionRegime: string;
  /** `gate_at(target_date, gate_profile)` — the publication instant. */
  publishedAt: Date;
  ingestedAt: Date;
  dataVersion: number;
  dayTotalMwh: ForecastBand;
  peakPowerMw: ForecastBand;
  dayOccurrenceProbability: number;
  dayExpectedMwh: number;
  split: ForecastSplit;
  hoursP50Nonzero: number;
  /** `path_ensemble`, read back rather than assumed. */
  derivation: string;
  riskBinElevatedFrom: number;
  riskBinHighFrom: number;
}

/** A day and its hours, as one answer. */
export interface PublishedForecast {
  day: ForecastDayRow;
  hours: ForecastHourRow[];
  /**
   * A `served` row is a record of a real publication, so its fidelity is
   * `point_in_time` by construction — `docs/specs/replay.md` makes
   * `served + revision_optimistic` impossible by definition, which is why this
   * is derived from the origin kind rather than stored as a fourth column
   * nobody could write a second value into.
   */
  vintageFidelity: VintageFidelity;
}

export interface ForecastQuery {
  subsystem: SubsystemCode;
  /** The civil day in `America/Sao_Paulo`, `YYYY-MM-DD`. */
  targetDate: string;
  gateProfile: ForecastGateProfile;
  /** The vintage cut. The route defaults it to the request instant. */
  asOf: Date;
}

interface DayRecord {
  [column: string]: unknown;
  gate_profile: string;
  threshold_mw: number;
  run_label: string;
  feature_set: string;
  trained_through: string;
  correction_regime: string;
  published_at: string;
  ingested_at: string;
  data_version: number;
  day_total_p10_mwh: number;
  day_total_p50_mwh: number;
  day_total_p90_mwh: number;
  peak_power_p10_mw: number;
  peak_power_p50_mw: number;
  peak_power_p90_mw: number;
  day_occurrence_probability: number;
  expected_mwh: number;
  expected_wind_mwh: number;
  expected_solar_mwh: number;
  hours_p50_nonzero: number;
  derivation: string;
  risk_bin_elevated_from: number;
  risk_bin_high_from: number;
}

interface HourRecord {
  [column: string]: unknown;
  valid_time: string;
  local_hour: number;
  p10_mwh: number;
  p50_mwh: number;
  p90_mwh: number;
  expected_mwh: number;
  occurrence_probability: number;
  expected_wind_mwh: number;
  expected_solar_mwh: number;
  p50_wind_mwh: number;
  p50_solar_mwh: number;
}

const asNumber = (value: unknown): number => Number(value);

/**
 * One day-grain row, mapped.
 *
 * One mapping for both reads, because `/v1/grid/outlook` publishes the same
 * day-grain numbers `/v1/forecast/day-ahead` does, for four subsystems instead
 * of one. A second mapping is how the hero would come to show a different band
 * from the detail view for the same subsystem-day, and nothing would say which
 * of the two was the published row.
 */
function toDayRow(
  record: DayRecord,
  subsystem: SubsystemCode,
  targetDate: string,
): ForecastDayRow {
  return {
    subsystem,
    targetDate,
    gateProfile: record.gate_profile as ForecastGateProfile,
    thresholdMw: asNumber(record.threshold_mw),
    artifactId: record.run_label,
    featureSet: record.feature_set,
    trainedThrough: String(record.trained_through).slice(0, 10),
    correctionRegime: record.correction_regime,
    publishedAt: new Date(record.published_at),
    ingestedAt: new Date(record.ingested_at),
    dataVersion: asNumber(record.data_version),
    dayTotalMwh: {
      p10: asNumber(record.day_total_p10_mwh),
      p50: asNumber(record.day_total_p50_mwh),
      p90: asNumber(record.day_total_p90_mwh),
    },
    peakPowerMw: {
      p10: asNumber(record.peak_power_p10_mw),
      p50: asNumber(record.peak_power_p50_mw),
      p90: asNumber(record.peak_power_p90_mw),
    },
    dayOccurrenceProbability: asNumber(record.day_occurrence_probability),
    dayExpectedMwh: asNumber(record.expected_mwh),
    split: {
      windMwh: asNumber(record.expected_wind_mwh),
      solarMwh: asNumber(record.expected_solar_mwh),
    },
    hoursP50Nonzero: asNumber(record.hours_p50_nonzero),
    derivation: record.derivation,
    riskBinElevatedFrom: asNumber(record.risk_bin_elevated_from),
    riskBinHighFrom: asNumber(record.risk_bin_high_from),
  };
}

/**
 * The forecast for one subsystem-day at one gate, or `null` if none was published.
 *
 * `null` is an absence and the route answers it as one. It is never an empty
 * band, never a zero-filled day and never twenty-four hours of nothing drawn as
 * a flat line: `docs/specs/api-surface.md`'s standing rule across all four "no
 * forecast" states.
 */
export async function readForecastDayAhead(
  db: Database,
  query: ForecastQuery,
): Promise<PublishedForecast | null> {
  return readOnly(db, async (tx) => {
    // The vintage axis on the transaction, never in the predicate: the views
    // read `canonical_as_of()` and raise when it is unset, so there is no path
    // to them from here that forgets it.
    await applyAxes(tx, { asOf: query.asOf });

    const days = await tx.execute<DayRecord>(sql`
      select *
      from ${canonicalForecastDay}
      where subsystem = ${query.subsystem}::subsystem_code
        and target_date = ${query.targetDate}::date
        and gate_profile = ${query.gateProfile}::forecast_gate_profile
        and origin_kind = 'served'::forecast_origin_kind
    `);
    const [day] = [...days];
    if (day === undefined) {
      // No day-grain row means no publication. Answering from the hours alone
      // is the one repair that is not available: the day band would have to be
      // summed, and that is the arithmetic both specs forbid.
      return null;
    }

    const hourRows = await tx.execute<HourRecord>(sql`
      select *
      from ${canonicalForecastHour}
      where subsystem = ${query.subsystem}::subsystem_code
        and target_date = ${query.targetDate}::date
        and gate_profile = ${query.gateProfile}::forecast_gate_profile
        and origin_kind = 'served'::forecast_origin_kind
      order by valid_time
    `);

    const hours: ForecastHourRow[] = [...hourRows].map((row) => ({
      validTime: new Date(row.valid_time),
      localHour: asNumber(row.local_hour),
      band: {
        p10: asNumber(row.p10_mwh),
        p50: asNumber(row.p50_mwh),
        p90: asNumber(row.p90_mwh),
      },
      expectedMwh: asNumber(row.expected_mwh),
      occurrenceProbability: asNumber(row.occurrence_probability),
      split: {
        windMwh: asNumber(row.expected_wind_mwh),
        solarMwh: asNumber(row.expected_solar_mwh),
      },
      p50Split: {
        windMwh: asNumber(row.p50_wind_mwh),
        solarMwh: asNumber(row.p50_solar_mwh),
      },
    }));

    return {
      day: toDayRow(day, query.subsystem, query.targetDate),
      hours,
      vintageFidelity: "point_in_time",
    };
  });
}

/** The two axes `/v1/grid/outlook` reads on: one day, one gate, one vintage. */
export interface OutlookQuery {
  /** The civil day in `America/Sao_Paulo`, `YYYY-MM-DD`. */
  targetDate: string;
  gateProfile: ForecastGateProfile;
  /** The vintage cut. The route defaults it to the request instant. */
  asOf: Date;
}

/**
 * The four subsystems' day-grain rows for one target date and one gate.
 *
 * **Day grain only, and no aggregate.** This is `/v1/grid/outlook`'s whole
 * read: the hero has no hourly detail to draw, so there is no second select
 * over `canonical_forecast_hour` here and nothing that could reduce one into a
 * day figure. Every band on the response is the persisted path-ensemble row.
 *
 * **Nothing is summed in SQL, and nothing is summed here.** The one additive
 * national quantity — the expectation — is added by the route, in one visible
 * place, beside the `band: null` that says why the other quantities are not.
 * An aggregate in this query would be the first step of exactly the arithmetic
 * `docs/specs/api-surface.md` exists to remove.
 *
 * **What comes back may be fewer than four rows, and that is an absence.** The
 * route refuses a partial publication rather than filling the gap: three
 * subsystems and a zero reads as "no curtailment in the north", which is a
 * different and much worse statement than "the publication is incomplete".
 * `origin_kind = 'served'` is filtered in the SQL, as a constant, exactly as on
 * the day-ahead read — there is no argument that reaches it, so no query can
 * widen this route onto a `backfilled_holdout` row.
 */
export async function readGridOutlook(
  db: Database,
  query: OutlookQuery,
): Promise<ForecastDayRow[]> {
  return readOnly(db, async (tx) => {
    // The vintage axis on the transaction, never in the predicate — the same
    // rule the day-ahead read follows, and for the same reason.
    await applyAxes(tx, { asOf: query.asOf });

    const rows = await tx.execute<DayRecord & { subsystem: string }>(sql`
      select *
      from ${canonicalForecastDay}
      where target_date = ${query.targetDate}::date
        and gate_profile = ${query.gateProfile}::forecast_gate_profile
        and origin_kind = 'served'::forecast_origin_kind
      order by subsystem
    `);

    return [...rows].map((row) =>
      toDayRow(row, row.subsystem as SubsystemCode, query.targetDate),
    );
  });
}

/** One published origin, as `/v1/meta`'s `forecast.latest_published` lists it. */
export interface PublishedOrigin {
  targetDate: string;
  gateProfile: ForecastGateProfile;
  publishedAt: Date;
  subsystems: SubsystemCode[];
}

/**
 * The most recent publications, newest target date first.
 *
 * `/v1/meta`'s `forecast.latest_published`, and the reason a publication that
 * silently stopped is visible: the gate instant is derived from the schedule and
 * is on the same payload, so an instant that has passed with no origin behind
 * it is a failure an operator can *see* rather than one a page view discovers.
 *
 * Read off the day rows, because a publication is one day of one lane and the
 * day row is the one row per (subsystem, day) it produces.
 */
export async function readLatestPublished(
  db: Database,
  options: { asOf: Date; limit?: number },
): Promise<PublishedOrigin[]> {
  const limit = options.limit ?? 4;
  return readOnly(db, async (tx) => {
    await applyAxes(tx, { asOf: options.asOf });
    const rows = await tx.execute<{
      target_date: string;
      gate_profile: string;
      published_at: string;
      subsystems: string[];
    }>(sql`
      select
        target_date,
        gate_profile,
        max(published_at) as published_at,
        array_agg(distinct subsystem::text order by subsystem::text) as subsystems
      from ${canonicalForecastDay}
      where origin_kind = 'served'::forecast_origin_kind
      group by target_date, gate_profile
      order by target_date desc, max(published_at) desc
      limit ${limit}::int
    `);
    return [...rows].map((row) => ({
      targetDate: String(row.target_date).slice(0, 10),
      gateProfile: row.gate_profile as ForecastGateProfile,
      publishedAt: new Date(row.published_at),
      subsystems: [...row.subsystems] as SubsystemCode[],
    }));
  });
}

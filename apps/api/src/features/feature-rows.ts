import { sql } from "drizzle-orm";
import type { VintageFidelity } from "../contract/vintage.js";
import type { Database } from "../database/connection.js";
import type { SubsystemCode } from "../ingest/normalise.js";

/**
 * `feature_rows(...)` — the caller, and deliberately nothing more.
 *
 * The function lives in the API's migration tree
 * (`drizzle/0016_the_feature_gate.sql`) because the API owns the schema and
 * because there must be exactly one definition of a feature. This module is the
 * TypeScript side of that: it binds five arguments and returns what came back.
 * It computes nothing — **no window, no join, no time offset** — for the same
 * reason `wattsteer_ml/features.py` computes nothing. If a computation needs
 * another row, it belongs in the function.
 *
 * **The rows are not renamed.** Every other read in this codebase maps snake
 * case to camel case at the boundary; this one does not, and that is the point.
 * A feature's name is its identity — `docs/specs/forecaster.md` hashes the
 * ordered names into the lane's `feature_hash`, and a model artifact is bound
 * to them — so a second spelling of `y_constrained_off_total_mwh` on the way out
 * of the database would be a second dictionary, kept in step by hand. The
 * column names below are the ones the composite type declares, spelled once.
 *
 * ## Why there is no `asOf` here
 *
 * Because there is nowhere to put one. `feature_rows` takes a date range, a
 * gate profile, a feature set and a threshold, and no instant of any kind: the
 * gate is derived per row from the target date inside the function. Training
 * passes a range and serving passes tomorrow twice, so the two calls run the
 * same expression over the same views — which is why `readServingRows` below is
 * a delegation and not an implementation.
 */

/** The two decision gates. `docs/specs/feature-engineering.md` §"The gate". */
export type GateProfile = "gate_early" | "gate_late";

/** The two feature sets of the DESSEM A/B. */
export type FeatureSet = "dessem_free_v1" | "dessem_augmented_v1";

export const GATE_PROFILES: readonly GateProfile[] = ["gate_early", "gate_late"];
export const FEATURE_SETS: readonly FeatureSet[] = [
  "dessem_free_v1",
  "dessem_augmented_v1",
];

/**
 * One feature row, at (`Subsystem`, `valid_time`) grain — hourly, UTC,
 * start-labelled.
 *
 * The `y_` columns are the labels and are read at the settled vintage; every
 * other value column is a feature and is read at the gate. That asymmetry is
 * deliberate and is argued at the function itself.
 */
export interface FeatureRow {
  subsystem: SubsystemCode;
  /** Start of the hour, UTC. */
  valid_time: Date;
  /** The civil date whose gate produced this row, `YYYY-MM-DD`. */
  target_date: string;
  gate_profile: GateProfile;
  /** The resolved gate instant — `gate_at(target_date, gate_profile)`. */
  gate_at: Date;
  feature_set: FeatureSet;
  threshold_mw: number;
  vintage_fidelity: VintageFidelity;
  /** Class `W`, cut on `published_at <= gate`. */
  weather_temperature_2m: number | null;
  y_constrained_off_wind_mwh: number | null;
  y_constrained_off_solar_mwh: number | null;
  y_constrained_off_total_mwh: number | null;
  /** Derived from `threshold_mw` inside the function, and never stored. */
  y_has_curtailment: boolean | null;
  y_magnitude_mwh: number | null;
  /**
   * `InstalledCapacityAsOf(subsystem, WIND, target_date)`, read at the gate.
   *
   * Class `T`, **day grain**: one value for the day, broadcast identically
   * across its 24 hours. Null when the registry had nothing to say at the gate.
   */
  capacity_wind_mw: number | null;
  /** As above, `SOLAR`. Day grain. */
  capacity_solar_mw: number | null;
  /** `capacity_wind_mw(D) − capacity_wind_mw(D−28)`, one vintage. Day grain. */
  capacity_wind_added_28d_mw: number | null;
  /** As above, `SOLAR`. Day grain. */
  capacity_solar_added_28d_mw: number | null;
}

/**
 * Every column of a feature row, in the order the composite type declares them.
 *
 * Enumerated so the seam tests can compare rows **column by column without
 * knowing which columns exist** — the property they assert has to survive the
 * twelve tickets that add columns behind this one, and a test naming the
 * columns it checks would quietly stop covering the ones it does not.
 */
export const FEATURE_ROW_COLUMNS: readonly (keyof FeatureRow)[] = [
  "subsystem",
  "valid_time",
  "target_date",
  "gate_profile",
  "gate_at",
  "feature_set",
  "threshold_mw",
  "vintage_fidelity",
  "weather_temperature_2m",
  "y_constrained_off_wind_mwh",
  "y_constrained_off_solar_mwh",
  "y_constrained_off_total_mwh",
  "y_has_curtailment",
  "y_magnitude_mwh",
  // Appended, because `ALTER TYPE ... ADD ATTRIBUTE` appends. The ordinal
  // position is the composite type's and this list is a copy of it, never an
  // opinion about it.
  "capacity_wind_mw",
  "capacity_solar_mw",
  "capacity_wind_added_28d_mw",
  "capacity_solar_added_28d_mw",
];

/**
 * The grain a feature column varies at — the feature dictionary's marking,
 * spelled where the row type is.
 *
 * Every column is hourly unless it is named here, because the row grain is
 * hourly and the exception is the thing worth writing down. A **day**-grain
 * column carries one value for the target date, broadcast identically across
 * its 24 hours, and the marking exists because that is invisible in the data:
 * twenty-four equal numbers look exactly like a signal that happens to be flat,
 * and a model given `capacity_wind_mw` as an hourly series will find intraday
 * structure in a constant. `docs/specs/feature-engineering.md` §"Installed
 * capacity" marks them the same way, and so does the column comment in
 * `drizzle/0017_capacity_at_the_gate.sql`.
 */
export type FeatureGrain = "hour" | "day";

const DAY_GRAIN_COLUMNS: readonly string[] = [
  "capacity_wind_mw",
  "capacity_solar_mw",
  "capacity_wind_added_28d_mw",
  "capacity_solar_added_28d_mw",
];

/** The grain of one column. Hourly is the default because the row is. */
export const featureGrain = (column: string): FeatureGrain =>
  DAY_GRAIN_COLUMNS.includes(column) ? "day" : "hour";

/**
 * The label columns — the ones read `AsOf(now())` rather than at the gate.
 *
 * Named by their prefix rather than one at a time, because the prefix is the
 * rule: `y_` is the label namespace in the spec's feature table, and a column
 * added under it by a later ticket is a label without anyone re-deciding.
 */
export const isLabelColumn = (column: string): boolean => column.startsWith("y_");

/**
 * The stamp: what the row is, rather than what it measured.
 *
 * A closed list, and it can stay closed because these are the columns that say
 * which question was asked. Everything a later ticket adds is a feature or a
 * label, so the two open categories are the two that grow.
 */
export const FEATURE_ROW_STAMP_COLUMNS: readonly (keyof FeatureRow)[] = [
  "subsystem",
  "valid_time",
  "target_date",
  "gate_profile",
  "gate_at",
  "feature_set",
  "threshold_mw",
  "vintage_fidelity",
];

/**
 * A feature is anything that is neither a label nor a stamp — defined by
 * exclusion so the gate-ablation seam covers columns it was never told about.
 *
 * That is the whole value of that test. The feature table will be edited and a
 * table is a snapshot of one session's care; the ablation is a *property*, and
 * a property that only holds for the columns someone remembered to list is not
 * one.
 */
export const isFeatureColumn = (column: string): boolean =>
  !(
    isLabelColumn(column) ||
    FEATURE_ROW_STAMP_COLUMNS.includes(column as keyof FeatureRow)
  );

export interface FeatureRowsQuery {
  /** First target date, `YYYY-MM-DD` — a civil date, never an instant. */
  targetFrom: string;
  /** Last target date, inclusive. */
  targetTo: string;
  gateProfile: GateProfile;
  featureSet: FeatureSet;
  /** The positive class boundary. An argument so the sweep costs a parameter. */
  thresholdMw: number;
}

/**
 * The training call: a range of target dates, one gate per date.
 *
 * A range query does not have "a gate" — it has one per day, resolved inside
 * the function — which is exactly why the caller cannot hold one.
 */
export async function readFeatureRows(
  db: Database,
  query: FeatureRowsQuery,
): Promise<FeatureRow[]> {
  // `execute` wants an index signature; a feature row has a closed shape, and
  // the cast is where the two meet. The column names are the ones the composite
  // type declares — `features-gate.test.ts` checks that list against the
  // migration's own text, so this cast cannot drift silently.
  const rows = await db.execute<FeatureRow & Record<string, unknown>>(sql`
    select * from feature_rows(
      ${query.targetFrom}::date,
      ${query.targetTo}::date,
      ${query.gateProfile},
      ${query.featureSet},
      ${query.thresholdMw}
    )
  `);
  return [...rows];
}

export interface ServingQuery extends Omit<FeatureRowsQuery, "targetFrom" | "targetTo"> {
  /** Tomorrow, in Brasília civil time. See `servingTargetDate`. */
  targetDate: string;
}

/**
 * The serving call: `target_from = target_to = tomorrow`.
 *
 * A delegation on purpose. There is no second query here to drift from the
 * first, so "the serving row equals the training row" is a property of this
 * function's shape before it is a fact any test discovers — and the test that
 * discovers it anyway is checking that the shape is still what it looks like.
 */
export async function readServingRows(
  db: Database,
  query: ServingQuery,
): Promise<FeatureRow[]> {
  return readFeatureRows(db, {
    targetFrom: query.targetDate,
    targetTo: query.targetDate,
    gateProfile: query.gateProfile,
    featureSet: query.featureSet,
    thresholdMw: query.thresholdMw,
  });
}

const BRASILIA = "America/Sao_Paulo";

/** `en-CA` renders `YYYY-MM-DD`, which is the shape a `date` argument wants. */
const civilDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: BRASILIA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const DAY_MS = 86_400_000;

/**
 * Tomorrow's target date, in the grid's own civil time.
 *
 * The day-ahead product forecasts a Brazilian calendar day, so "tomorrow" is
 * tomorrow in Brasília and not in UTC. Between 21:00 and 24:00 BRT the two
 * disagree, which is inside `gate_late`'s working evening — so a UTC reading
 * would serve the wrong day for three hours every night.
 */
export function servingTargetDate(now: Date): string {
  return civilDay.format(new Date(now.getTime() + DAY_MS));
}

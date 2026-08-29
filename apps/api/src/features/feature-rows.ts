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

  // Class `T` — deterministic. Appended after the labels because
  // `ALTER TYPE ... ADD ATTRIBUTE` appends, and the composite type is the
  // authority on the order. See `drizzle/0019_calendar_and_astronomy.sql`.
  //
  // `month` and `week_of_year` are deliberately absent: a coarser quantisation
  // of the same axis as `calendar_doy_sin/cos`, adding split points without
  // information. Their absence is a decision recorded in the spec's rejected
  // list, not an oversight to be helpfully repaired.

  /** Local hour 0–23 in `America/Sao_Paulo`. Categorical. */
  calendar_local_hour: number | null;
  calendar_hour_sin: number | null;
  calendar_hour_cos: number | null;
  /** Period 365.25, so the encoding closes on itself across a leap year. */
  calendar_doy_sin: number | null;
  calendar_doy_cos: number | null;
  /** 0 = Sunday, matching Postgres' `dow`. Categorical. */
  calendar_day_of_week: number | null;
  calendar_is_weekend: boolean | null;
  /** Includes the moveable feasts. Null outside the loaded calendar's horizon. */
  calendar_is_holiday_national: boolean | null;
  /**
   * Share of the subsystem's ONS-assigned states observing a *state* holiday.
   *
   * **A proxy, unweighted by load**, and shipped labelled as one: no per-state
   * load exists in WattSteer's sources, so no honest weight does either.
   */
  calendar_holiday_state_share: number | null;
  calendar_is_day_before_holiday: boolean | null;
  calendar_is_bridge_day: boolean | null;
  /** cos of the solar zenith at the frozen solar-capacity-weighted centroid. */
  solar_zenith_cos: number | null;
  /** Top-of-atmosphere horizontal irradiance, W/m². The clearness denominator. */
  solar_extraterrestrial_ghi: number | null;

  // Class `K` — lagged actuals, every one cut on
  // `valid_time <= actuals_cutoff(gate, dataset)` rather than on a vintage.
  // See `drizzle/0021_lagged_actuals_behind_the_cutoff.sql`.
  //
  // Every column here is a **level**. There is no difference, no ramp and no
  // window centred on the target hour, because those are the three shapes
  // last-known-value substitution cannot carry honestly — the spec's §"Dropped"
  // table names the forecast-side replacement for each of them.

  /**
   * `valid_time − actuals_cutoff(gate, dataset)`, in hours, at the widest of
   * the three observation lags the row reads.
   *
   * How stale the backward view is, so the model can condition on its own
   * blindness rather than assume the lag is constant. It is not: it moves by a
   * day between the two gate profiles.
   */
  observed_actual_lag_hours: number | null;
  /** Subsystem constrained-off total at t−168 h, same local hour. */
  observed_constrained_off_lag_168h: number | null;
  observed_constrained_off_wind_lag_168h: number | null;
  observed_constrained_off_solar_lag_168h: number | null;
  /**
   * t−48 h, and **NULL rather than slid** where the cutoff excludes it.
   *
   * At `gate_late` the cutoff falls at D−2 03:00 BRT, so this clears only for
   * the first four local hours of the day; at `gate_early` it never clears. A
   * lag that slid to the nearest available hour would mean "48 hours" in one row
   * and something else in the next, with nothing in the row to say which.
   */
  observed_constrained_off_lag_48h: number | null;
  /**
   * Mean at the same local hour over the seven days ending at the cutoff.
   *
   * **The mandatory baseline's definition** (`docs/specs/forecaster.md` rung 1),
   * computed here rather than reimplemented so the baseline and the model
   * cannot disagree about what "the last seven days" means.
   */
  observed_constrained_off_same_hour_mean_7d: number | null;
  /** Hours above `threshold_mw` over the trailing seven days. Day grain. */
  observed_constrained_off_hours_above_threshold_7d: number | null;
  /** Sum over the trailing seven days. Day grain. */
  observed_constrained_off_total_7d_mwh: number | null;
  observed_load_lag_168h: number | null;
  observed_wind_generation_lag_168h: number | null;
  observed_solar_generation_lag_168h: number | null;
  /**
   * Realised fleet capacity factor over the trailing seven days. **Day grain.**
   *
   * The denominator is the fleet of the **last available day** at the gate's
   * vintage, never the target date's: a ratio of last week's generation to
   * tomorrow's fleet would drift down with every commissioning, and a modeller
   * would read the drift as weather.
   */
  observed_wind_capacity_factor_mean_7d: number | null;
  /** As above, `SOLAR`. Day grain. */
  observed_solar_capacity_factor_mean_7d: number | null;
  observed_net_exchange_lag_168h: number | null;
  /** Mean over the last 24 available hours, ending at the cutoff. Day grain. */
  observed_net_exchange_mean_24h_to_cutoff: number | null;
  /** Directed NE→SE flow at t−168 h. A system fact, broadcast to all four. */
  observed_corridor_flow_ne_se_lag_168h: number | null;
  /** Directed N→NE flow at t−168 h. */
  observed_corridor_flow_n_ne_lag_168h: number | null;
  /**
   * Share of reason-carrying entity-hours in the subsystem, trailing seven
   * days. **Day grain**, and aggregated **upward** from reporting entities
   * only — nothing attributes a conjunto's reason downward to a member plant.
   *
   * `PAR` has no share column: it is a live enum member with zero observations,
   * and a share of a class that has never occurred is a column of zeroes. It
   * stays in the denominator, so the day it first appears these three stop
   * summing to one — which is the monitoring signal rather than a silent
   * redistribution.
   */
  observed_reason_share_ene_7d: number | null;
  observed_reason_share_cnf_7d: number | null;
  /** `REL` is external grid unavailability, not *relaxamento*. */
  observed_reason_share_rel_7d: number | null;
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
  "calendar_local_hour",
  "calendar_hour_sin",
  "calendar_hour_cos",
  "calendar_doy_sin",
  "calendar_doy_cos",
  "calendar_day_of_week",
  "calendar_is_weekend",
  "calendar_is_holiday_national",
  "calendar_holiday_state_share",
  "calendar_is_day_before_holiday",
  "calendar_is_bridge_day",
  "solar_zenith_cos",
  "solar_extraterrestrial_ghi",
  "observed_actual_lag_hours",
  "observed_constrained_off_lag_168h",
  "observed_constrained_off_wind_lag_168h",
  "observed_constrained_off_solar_lag_168h",
  "observed_constrained_off_lag_48h",
  "observed_constrained_off_same_hour_mean_7d",
  "observed_constrained_off_hours_above_threshold_7d",
  "observed_constrained_off_total_7d_mwh",
  "observed_load_lag_168h",
  "observed_wind_generation_lag_168h",
  "observed_solar_generation_lag_168h",
  "observed_wind_capacity_factor_mean_7d",
  "observed_solar_capacity_factor_mean_7d",
  "observed_net_exchange_lag_168h",
  "observed_net_exchange_mean_24h_to_cutoff",
  "observed_corridor_flow_ne_se_lag_168h",
  "observed_corridor_flow_n_ne_lag_168h",
  "observed_reason_share_ene_7d",
  "observed_reason_share_cnf_7d",
  "observed_reason_share_rel_7d",
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
  // Class `K`'s trailing windows. These are anchored to `actuals_cutoff` rather
  // than to the target hour, so they carry one value for the whole target date
  // — and the marking matters more here than for capacity, because a lagged
  // *level* beside a trailing *window* looks like two hourly series until
  // somebody says otherwise. The same-hour mean is **not** in this list: its
  // window is anchored to the cutoff but selected by the target's local hour, so
  // it genuinely varies across the day.
  "observed_constrained_off_hours_above_threshold_7d",
  "observed_constrained_off_total_7d_mwh",
  "observed_wind_capacity_factor_mean_7d",
  "observed_solar_capacity_factor_mean_7d",
  "observed_net_exchange_mean_24h_to_cutoff",
  "observed_reason_share_ene_7d",
  "observed_reason_share_cnf_7d",
  "observed_reason_share_rel_7d",
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

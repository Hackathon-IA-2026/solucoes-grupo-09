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

  // Class `P` — ONS day-ahead programming, and `dessem_free_v1`'s spine. A
  // `Forecast`, so it is cut on `published_at <= gate` like the weather and
  // unlike the class-`K` block above it. See
  // `drizzle/0024_day_ahead_programming.sql`.
  //
  // **The publication instant is a decision, not a measurement.** The endpoint
  // returns no update stamp of any kind, so the programme for day D is stamped
  // D−1 15:00 BRT at the adapter — the DESSEM-anchored upper bound, argued at
  // `programmePublishedAt` in `ingest/ons/load.ts`. It clears `gate_late` by
  // four hours and does **not** clear `gate_early`, where every column here is
  // NULL: a visible hole rather than a leak, and one only measurement closes.

  /** ONS's programmed load for the subsystem-hour. */
  programmed_load_mwh: number | null;
  /**
   * Difference within the day-D programmed profile.
   *
   * Legal where the actuals-side ramp is not, and for one reason: a D−1
   * programme publishes the whole of day D at once, so the difference is
   * computed from data that exists at the gate. NULL at the local day's first
   * hour, whose predecessor belongs to a different publication.
   */
  programmed_load_ramp_1h: number | null;
  /** Centred on t, within the same profile. NULL at both edges of the day. */
  programmed_load_mean_3h: number | null;
  /** Minimum over D's 24 programmed hours. **Day grain**, and NULL if any is missing. */
  programmed_load_daily_min_mwh: number | null;
  /** Rank of t among D's 24 programmed loads, ascending: 1 is the trough. */
  programmed_load_rank_in_day: number | null;

  // Class `D` — ONS's DESSEM day-ahead balance, and the augmented set's whole
  // contribution. See `drizzle/0025_dessem_and_the_feature_set.sql`.
  //
  // **Every column here exists only in `dessem_augmented_v1`, and only at
  // `gate_late`.** That is not a rule imposed on the data; it is the shape of
  // the data. The DESSEM file for reference day D is created mid-afternoon on
  // D−1, so at 09:00 on D−1 the newest one describes D−1 itself — which is why
  // `feature_rows` *refuses* the augmented set at `gate_early` rather than
  // returning a row of NULLs, and why asking for `dessem_free_v1` returns rows
  // whose `dessem_*` columns are NULL because the block produced nothing to
  // join, not because a filter emptied them.
  //
  // **The eleven hours are the augmented set's second cost.** `gate_late` is
  // D−1 19:00 BRT against `gate_early`'s 09:00, so a model that needs these
  // columns hands an operator far less notice. The A/B reports it beside the
  // shorter window, because a comparison that reports only the metric is
  // reporting half the trade.
  //
  // DESSEM publishes instantaneous MW at 30-minute grain; the two half hours of
  // an hour are **averaged** into the hour's MWh. That is the opposite of the
  // class-`P` sum above it, and right for the opposite reason.

  /** `val_demanda`. */
  dessem_demand_mwh: number | null;
  /** `val_ger_eolica` — the day-ahead wind expectation. */
  dessem_wind_mwh: number | null;
  /** `val_ger_fotovoltaica` — utility-scale PV, a different fleet from MMGD. */
  dessem_solar_mwh: number | null;
  /** `val_ger_mmgd` — ONS's *modelled* distributed generation, not metered. */
  dessem_mmgd_mwh: number | null;
  /** `val_ger_hidraulica` + `val_ger_pch`. */
  dessem_hydro_mwh: number | null;
  /** `val_ger_termica` + `val_ger_pct`. */
  dessem_thermal_mwh: number | null;
  /** `val_cons_elevatoria` — a consumption, subtracted in the identity below. */
  dessem_pumping_mwh: number | null;
  /**
   * `demand − wind − solar − mmgd`, from DESSEM's own quantities.
   *
   * Set B's answer to `proxy_residual_load_mwh`, and one of the four features
   * that would justify the augmented set's trade.
   */
  dessem_residual_load_mwh: number | null;
  /** `(wind + solar + mmgd) / demand`. NULL where demand is zero. */
  dessem_renewable_load_ratio: number | null;
  /** `(wind + solar + mmgd) − demand`. */
  dessem_vre_surplus_mwh: number | null;
  /** `(hydro + thermal) / demand`. NULL where demand is zero. */
  dessem_inflexible_share: number | null;
  /**
   * `(hydro + thermal + wind + solar + mmgd) − demand − pumping`.
   *
   * DESSEM publishes no exchange column, so net export is derived from the
   * energy identity. **Named *implied* because transmission losses are not
   * modelled** — ONS publishes no day-ahead loss figure to model them from — so
   * it is a signal for the northern export limits, not a measured flow. The
   * utilisation ratio that would divide it needs an export capability estimate
   * that does not exist yet; that denominator is ticket 10's.
   */
  dessem_implied_net_export_mwh: number | null;
  /**
   * Difference within the day-D DESSEM profile.
   *
   * Legal where the actuals-side ramp is not, for the reason the class-`P`
   * ramps are: a D−1 publication carries the whole of day D at once. NULL at
   * the local day's first hour, whose predecessor belongs to D−1's own file.
   */
  dessem_demand_ramp_1h: number | null;
  /** As above, on `dessem_residual_load_mwh`. */
  dessem_residual_load_ramp_1h: number | null;
  /** As above, on `wind + solar + mmgd`. */
  dessem_vre_ramp_1h: number | null;
  /** Minimum over D's 24 residual loads. **Day grain**, NULL if any hour is missing. */
  dessem_residual_load_min_of_day: number | null;
  /** Rank of t among D's 24 residual loads, ascending: 1 is the trough. */
  dessem_residual_load_rank_in_day: number | null;
  /**
   * `dessem_wind_mwh / (capacity_wind_mw × 1 h)`, the fleet read at the gate's
   * vintage — the same double as-of, and the same reading, as
   * `capacity_wind_mw` in this row. NULL where the fleet is unknown or zero.
   */
  dessem_wind_capacity_factor: number | null;
  /** As above, `SOLAR`. The numerator is utility-scale PV only, so MMGD is
   * deliberately outside a ratio whose denominator is the registered fleet. */
  dessem_solar_capacity_factor: number | null;
  /**
   * Sum of `dessem_residual_load_mwh` over the four subsystems for this hour.
   *
   * A **derived sum**, which is the only form a national total may take:
   * `SIN` is not a `Subsystem` (`docs/domain-model.md` §2). A system fact,
   * broadcast identically to all four rows of the hour, and NULL unless all
   * four reported it.
   */
  dessem_sin_residual_load_mwh: number | null;
  /**
   * SE's `dessem_residual_load_mwh`, carried onto the N and NE rows.
   *
   * A physical asymmetry rather than a statistic: N and NE curtail when SE has
   * no headroom to absorb what they export. NULL on SE's own rows — a subsystem
   * is not its own absorber — and NULL on S, which the mechanism does not
   * describe.
   */
  dessem_absorber_residual_load_mwh: number | null;

  // Class `W`, the rest of it — appended by `drizzle/0029_the_weather_block.sql`
  // because `ALTER TYPE ... ADD ATTRIBUTE` appends, which is why the weather
  // columns are split across the row rather than gathered.
  // `weather_temperature_2m` above keeps its name and its position and changes
  // its **meaning**: through ticket 01 it was the unweighted mean over every
  // centroid that reported the hour and was the same number for all four
  // subsystems; it is now the VRE-capacity-weighted mean over this subsystem's
  // own fleet.
  //
  // `weather_lead_hours` is deliberately absent. Within a fixed run cycle it is
  // perfectly collinear with `calendar_local_hour` — from a D−1 12Z run the lead
  // is exactly `15 + local_hour` — so it carries nothing the vector does not
  // already hold. `weather_run_age_hours` captures the only informative part.

  /** Wind speed at 100 m, km/h, weighted on the **wind** vector. */
  weather_wind_speed_100m: number | null;
  /** Wind speed at 120 m, km/h — the hub height the power curve is stated at. */
  weather_wind_speed_120m: number | null;
  /**
   * sin of the capacity-weighted **vector** mean wind direction at 120 m.
   *
   * Never a numeric mean: 350° and 10° do not average to 180°. Null where
   * opposed bearings cancel exactly and the resultant has no direction.
   */
  weather_wind_direction_120m_sin: number | null;
  /** cos of the same weighted vector mean. */
  weather_wind_direction_120m_cos: number | null;
  /** Gusts at 10 m, km/h — the only height the pinned model publishes them at. */
  weather_wind_gusts_10m: number | null;
  /** Surface pressure, hPa, weighted on the combined **VRE** vector. */
  weather_surface_pressure: number | null;
  /** Relative humidity at 2 m, %, VRE-weighted. */
  weather_relative_humidity_2m: number | null;
  /** Precipitation over the hour, mm, VRE-weighted. */
  weather_precipitation: number | null;
  /** GHI, W/m², an hour mean, weighted on the **solar** vector. */
  weather_shortwave_radiation: number | null;
  /** DNI, W/m², solar-weighted. */
  weather_direct_normal_irradiance: number | null;
  /** DHI, W/m², solar-weighted. */
  weather_diffuse_radiation: number | null;
  /** Total cloud cover, %, solar-weighted. */
  weather_cloud_cover: number | null;
  /**
   * `weather_shortwave_radiation / max(solar_extraterrestrial_ghi, 1 W/m²)`.
   *
   * The denominator is the astronomy block's own top-of-atmosphere irradiance,
   * sampled at the hour midpoint so an hour-mean numerator is not divided by an
   * edge-sampled denominator. Clamped rather than divided by zero: below the
   * horizon the denominator is exactly zero.
   */
  weather_clearness_index: number | null;
  /**
   * Generic IEC-class power curve at 120 m — cut-in 3 m/s, rated 12 m/s,
   * cut-out 25 m/s, no air-density correction — applied **per centroid** and
   * then capacity-weighted.
   *
   * A **proxy**, named as one: it is not the Brazilian fleet's curve.
   */
  weather_wind_power_curve_cf: number | null;
  /** `weather_wind_power_curve_cf × capacity_wind_mw × 1 h`. */
  weather_expected_wind_mwh: number | null;
  /**
   * `capacity_solar_mw × weather_shortwave_radiation / 1000 × 1 h`.
   *
   * STC-referenced, with **no temperature derate**: adding one would bake a
   * coefficient into a feature, and `weather_temperature_2m` is in the vector.
   */
  weather_expected_solar_mwh: number | null;
  /**
   * Δ within the forecast profile — legal because a D−1 run publishes the whole
   * profile at once, and defined at the first hour of the local day because the
   * hour before it belongs to the same run rather than to a different file.
   */
  weather_wind_speed_120m_ramp_1h: number | null;
  /** Δ of `weather_shortwave_radiation`, on the same terms. */
  weather_shortwave_radiation_ramp_1h: number | null;
  /** Δ of `weather_expected_wind_mwh + weather_expected_solar_mwh`. */
  weather_expected_vre_ramp_1h: number | null;
  /** Mean over the three hours centred on t, within the forecast profile. */
  weather_wind_speed_120m_mean_3h: number | null;
  /** Sample sd over the six hours t−3 … t+2. Null unless all six carry a value. */
  weather_wind_speed_120m_std_6h: number | null;
  /** Mean of `weather_shortwave_radiation` over the three hours centred on t. */
  weather_shortwave_radiation_mean_3h: number | null;
  /**
   * `run_init(scheduled) − run_init(used)`, hours, as the **max** over the
   * centroids carrying weight here.
   *
   * 0 on the normal path; 12 or 24 when a scheduled run was missing from the
   * archive and an older cycle stood in — which is how a 4.5% missing-run rate
   * degrades the forecast rather than corrupting it.
   */
  weather_run_age_hours: number | null;
  /**
   * Share of the subsystem's combined-VRE capacity weight **mass** that a
   * centroid reported for this hour — not the fraction of centroids.
   *
   * Losing a 426 MW point and losing a 4,172 MW point are the same fraction of
   * points and are not the same event. 1 means everything arrived. The weighted
   * means beside it are renormalised over the reporters, so a hole moves this
   * column and not them — which is what makes it the thing the serve path
   * refuses on.
   */
  weather_centroid_coverage: number | null;

  // Class `P`+`W`+`T` — residual load, rebuilt for the DESSEM-free set. See
  // `drizzle/0030_the_proxy_residual_load.sql`.
  //
  // The original feature list asked for `load − solar − wind` at the target
  // hour: three day-D **actuals**, and a description of the oversupply
  // condition after the fact. This family is that quantity rebuilt from terms
  // that exist at D−1 — ONS's day-ahead programme minus the two deterministic
  // conversions of the pinned weather run against the fleet at the gate — so it
  // is a **forecast** of the same condition, which is what a day-ahead product
  // should condition on. No term is an actual and no term is a model output.
  //
  // **Every column here is NULL at `gate_early`**, because `programmed_load_mwh`
  // is: D−1 09:00 BRT is six hours before the programme's decided publication
  // instant, and a subtraction from NULL is NULL. That hole is reported rather
  // than filled — an earlier hour, or a load forecast of our own, would be a
  // value the served model will not have at 09:00.

  /**
   * `programmed_load_mwh − weather_expected_wind_mwh − weather_expected_solar_mwh`.
   *
   * The most important feature in the DESSEM-free set, and the reason that set
   * is worth training at all. NULL unless all three terms are present: a
   * subsystem the registry places no VRE in at the gate carries no residual
   * load, rather than a programmed load with two zeroes taken off it.
   */
  proxy_residual_load_mwh: number | null;
  /** `proxy_residual_load_mwh / programmed_load_mwh`. NULL on a zero programme. */
  proxy_residual_load_ratio: number | null;
  /** `(expected_wind + expected_solar) / programmed_load_mwh` — one minus the ratio above. */
  proxy_renewable_load_ratio: number | null;
  /** `(expected_wind + expected_solar) − programmed_load_mwh`; the unguarded form. */
  proxy_vre_surplus_mwh: number | null;
  /**
   * Difference within the day-D proxy profile.
   *
   * NULL at the local day's first hour: its predecessor needs a programmed load
   * from D−1's own publication. The weather run spans that boundary and the
   * programme does not, and the narrower parent decides the profile.
   */
  proxy_residual_load_ramp_1h: number | null;
  /** Minimum over D's 24 reconstructed hours. **Day grain**, and NULL if any is missing. */
  proxy_residual_load_min_of_day: number | null;
  /** Rank of t among D's 24 reconstructed residual loads, ascending: 1 is the trough. */
  proxy_residual_load_rank_in_day: number | null;
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
  // Class `P`, appended by `drizzle/0024_day_ahead_programming.sql`.
  "programmed_load_mwh",
  "programmed_load_ramp_1h",
  "programmed_load_mean_3h",
  "programmed_load_daily_min_mwh",
  "programmed_load_rank_in_day",
  // Class `D`, appended by `drizzle/0025_dessem_and_the_feature_set.sql`.
  // Twenty-one, not the spec's twenty-two names: `dessem_export_utilisation`
  // needs an export capability estimate that does not exist yet, and is
  // ticket 10's.
  "dessem_demand_mwh",
  "dessem_wind_mwh",
  "dessem_solar_mwh",
  "dessem_mmgd_mwh",
  "dessem_hydro_mwh",
  "dessem_thermal_mwh",
  "dessem_pumping_mwh",
  "dessem_residual_load_mwh",
  "dessem_renewable_load_ratio",
  "dessem_vre_surplus_mwh",
  "dessem_inflexible_share",
  "dessem_implied_net_export_mwh",
  "dessem_demand_ramp_1h",
  "dessem_residual_load_ramp_1h",
  "dessem_vre_ramp_1h",
  "dessem_residual_load_min_of_day",
  "dessem_residual_load_rank_in_day",
  "dessem_wind_capacity_factor",
  "dessem_solar_capacity_factor",
  "dessem_sin_residual_load_mwh",
  "dessem_absorber_residual_load_mwh",
  // The rest of class `W`, appended by `drizzle/0029_the_weather_block.sql`.
  // Twenty-four, not the spec's twenty-five names: `weather_lead_hours` is
  // deliberately absent, and the collinearity argument is recorded at the block.
  "weather_wind_speed_100m",
  "weather_wind_speed_120m",
  "weather_wind_direction_120m_sin",
  "weather_wind_direction_120m_cos",
  "weather_wind_gusts_10m",
  "weather_surface_pressure",
  "weather_relative_humidity_2m",
  "weather_precipitation",
  "weather_shortwave_radiation",
  "weather_direct_normal_irradiance",
  "weather_diffuse_radiation",
  "weather_cloud_cover",
  "weather_clearness_index",
  "weather_wind_power_curve_cf",
  "weather_expected_wind_mwh",
  "weather_expected_solar_mwh",
  "weather_wind_speed_120m_ramp_1h",
  "weather_shortwave_radiation_ramp_1h",
  "weather_expected_vre_ramp_1h",
  "weather_wind_speed_120m_mean_3h",
  "weather_wind_speed_120m_std_6h",
  "weather_shortwave_radiation_mean_3h",
  "weather_run_age_hours",
  "weather_centroid_coverage",
  // Class `P`+`W`+`T`, appended by `drizzle/0030_the_proxy_residual_load.sql`.
  // Seven, and the spec's seven: the reconstruction, the three quantities
  // derived from the same three terms, and the three shapes of the day-D proxy
  // profile.
  "proxy_residual_load_mwh",
  "proxy_residual_load_ratio",
  "proxy_renewable_load_ratio",
  "proxy_vre_surplus_mwh",
  "proxy_residual_load_ramp_1h",
  "proxy_residual_load_min_of_day",
  "proxy_residual_load_rank_in_day",
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
  // Class `P`'s one summary of the whole profile. `programmed_load_rank_in_day`
  // is deliberately *not* here: it is computed over the day but selected by the
  // target hour, so it genuinely varies across the 24 — the same distinction
  // that keeps `observed_constrained_off_same_hour_mean_7d` out of this list.
  "programmed_load_daily_min_mwh",
  // Class `D`'s one summary of the whole profile, on the same terms as class
  // `P`'s. `dessem_residual_load_rank_in_day` is deliberately *not* here — it
  // is computed over the day but selected by the target hour — and neither is
  // `dessem_sin_residual_load_mwh`, which is constant across the four
  // subsystems of an hour but varies across the 24 hours of the day. Constant
  // across subsystems is not day grain; nothing in this marking is about the
  // other axis.
  "dessem_residual_load_min_of_day",
  // The proxy family's one summary of the whole profile, on the same terms as
  // class `P`'s and class `D`'s. `proxy_residual_load_rank_in_day` is
  // deliberately *not* here: it is computed over the day and selected by the
  // target hour, so it genuinely varies across the 24.
  "proxy_residual_load_min_of_day",
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
  const rows = await readFeatureRows(db, {
    targetFrom: query.targetDate,
    targetTo: query.targetDate,
    gateProfile: query.gateProfile,
    featureSet: query.featureSet,
    thresholdMw: query.thresholdMw,
  });
  assertWeatherCompleteness(rows, query.targetDate);
  return rows;
}

/**
 * The class-`W` columns the serve path insists on, and nothing derived.
 *
 * The twelve pinned variables as they arrive at the row — twelve stored
 * variables becoming thirteen columns, because wind direction enters as a
 * sin/cos pair. Deliberately **not** the derived block beside them: a ramp is
 * NULL at a profile edge and a centred window is NULL wherever a neighbour is,
 * and refusing to serve on those would refuse on the machinery working as
 * designed. The question this contract asks is whether the *forecast arrived*,
 * and these thirteen are the columns that answer it.
 */
const SERVED_WEATHER_COLUMNS: readonly (keyof FeatureRow)[] = [
  "weather_wind_speed_100m",
  "weather_wind_speed_120m",
  "weather_wind_direction_120m_sin",
  "weather_wind_direction_120m_cos",
  "weather_wind_gusts_10m",
  "weather_temperature_2m",
  "weather_surface_pressure",
  "weather_relative_humidity_2m",
  "weather_precipitation",
  "weather_shortwave_radiation",
  "weather_direct_normal_irradiance",
  "weather_diffuse_radiation",
  "weather_cloud_cover",
];

/**
 * The coverage a served row must carry: **all of it**.
 *
 * `weather_centroid_coverage` is the share of capacity weight mass that
 * reported, so anything below 1 means some of tomorrow's fleet has no weather.
 * The aggregate renormalises over the reporters rather than dividing by the
 * full mass, which is right for a training row — a hole is a hole, and the
 * column beside it says how big — and is exactly why the serve path has to look
 * at the column: the mean of the points that did arrive is a plausible-looking
 * number, and nothing in it says it describes three-quarters of a subsystem.
 */
const SERVED_MIN_CENTROID_COVERAGE = 1;

/** Floating-point slack. A weighted sum of nineteen shares need not land on 1. */
const COVERAGE_EPSILON = 1e-9;

/** Four subsystems by twenty-four local hours — the row spine, restated. */
const SERVED_ROW_COUNT = 96;

/**
 * The serve path refused, and why — never a partially built row.
 *
 * `docs/specs/feature-engineering.md`: at serve time the completeness contract
 * is asserted and a failure **refuses to serve** rather than imputing. Imputing
 * is the one response that cannot be detected downstream: a mean over the
 * centroids that happened to arrive is a number of exactly the right shape, and
 * a forecast built on it is wrong in a way the interval does not widen for.
 */
export class ServingCompletenessError extends Error {
  constructor(
    readonly targetDate: string,
    readonly failures: readonly string[],
  ) {
    super(
      `refusing to serve ${targetDate}: the weather completeness contract failed — ${failures.join("; ")}`,
    );
    this.name = "ServingCompletenessError";
  }
}

/**
 * The completeness contract, across variables, hours and centroids.
 *
 * Four questions, and a served day has to answer all four: are all 96
 * subsystem-hours here, does at least one subsystem carry a weight vector at
 * all, does every *weighted* row carry all thirteen pinned weather columns, and
 * did every megawatt behind those rows have a centroid reporting for it. Any
 * "no" refuses.
 *
 * **A subsystem with no VRE fleet is not a failure, and the distinction is the
 * subtle half of this contract.** `weather_centroid_coverage` is NULL exactly
 * when the registry places no capacity in that subsystem at the gate: there is
 * no weight vector, so there is no mass to cover and no weather to aggregate.
 * Refusing the whole day because a subsystem has no registered VRE would be
 * refusing on the machinery working — those rows already carry a NULL
 * `capacity_wind_mw`, and the model cannot forecast the curtailment of a fleet
 * that does not exist. Coverage **below** 1 is the failure: part of a real
 * fleet had no weather, and the mean of the points that did arrive is a number
 * of exactly the right shape with nothing in it to say so.
 *
 * The vacuous case is closed by the second question: if *every* subsystem is
 * unweighted the registry read itself has failed, and a day with no weather
 * anywhere passes no contract.
 *
 * Exported so the assertion can be exercised without a database, and because a
 * serving job needs to distinguish this refusal from a transport failure.
 */
export function assertWeatherCompleteness(
  rows: readonly FeatureRow[],
  targetDate: string,
): void {
  const failures: string[] = [];

  if (rows.length !== SERVED_ROW_COUNT) {
    failures.push(`expected ${SERVED_ROW_COUNT} subsystem-hours, got ${rows.length}`);
  }

  const missing = new Map<string, number>();
  let weighted = 0;
  let uncovered = 0;
  for (const row of rows) {
    const coverage = row.weather_centroid_coverage;
    if (coverage === null || coverage === undefined) {
      continue;
    }
    weighted += 1;
    for (const column of SERVED_WEATHER_COLUMNS) {
      if (row[column] === null || row[column] === undefined) {
        missing.set(column, (missing.get(column) ?? 0) + 1);
      }
    }
    if (coverage < SERVED_MIN_CENTROID_COVERAGE - COVERAGE_EPSILON) {
      uncovered += 1;
    }
  }

  if (weighted === 0) {
    failures.push(
      "no subsystem carries a capacity weight vector: the fleet read behind the weights returned nothing at this gate",
    );
  }
  for (const [column, count] of missing) {
    failures.push(`${column} is null in ${count} of ${weighted} weighted rows`);
  }
  if (uncovered > 0) {
    failures.push(
      `weather_centroid_coverage is below ${SERVED_MIN_CENTROID_COVERAGE} in ${uncovered} of ${weighted} weighted rows`,
    );
  }

  if (failures.length > 0) {
    throw new ServingCompletenessError(targetDate, failures);
  }
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

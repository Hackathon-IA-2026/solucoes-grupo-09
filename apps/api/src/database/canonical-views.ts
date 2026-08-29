import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  integer,
  pgView,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  forecastProducer,
  reasonCode,
  reportingEntityKind,
  restrictionOrigin,
  subsystemCode,
  technology,
  weatherRunCycle,
} from "./schema.js";

/**
 * The canonical read contract, as SQL.
 *
 * **This file is the contract.** `apps/api/src/contract/reads.ts` calls these
 * views and `apps/ml` calls the same ones on its read-only role; neither writes
 * an `AsOf` of its own, and neither knows a base table name. That is the whole
 * of ticket 016: a TypeScript module composing TypeScript functions is not
 * something Python can consume, so "the modelling service reads Postgres
 * directly" and "there is exactly one definition of a canonical read" could not
 * both be true while the contract lived in one language. In SQL they can.
 *
 * ## What a view owns
 *
 * The **row vocabulary**, and only that:
 *
 * - the domain model's names (`docs/domain-model.md` is the authority),
 * - the grain, one row per business key,
 * - unit and timestamp resolution, already done at ingest and never undone,
 * - the vintage columns `data_version`, `published_at`, `ingested_at`,
 * - and the `AsOf` pick itself — the `DISTINCT ON` that turns an append-only
 *   fact table into "what WattSteer believed at an instant".
 *
 * What a view does **not** own is `VintageFidelity`. That is two timestamps and
 * an inequality, it is bound in both languages by the golden vectors in
 * `packages/core/fixtures/canonical-contract/`, and it stays a pure function on
 * each side (`contract/vintage.ts`, `wattsteer_ml/canonical.py`). Duplicating
 * that is safe in a way duplicating row-shaping SQL is not. What the database
 * supplies for it is the input — see `canonicalReadGoLive`.
 *
 * ## Why the axes are session settings
 *
 * A view cannot take an argument, and every canonical read is a function of an
 * `as_of`. The axes therefore arrive through `set_config` and are read back by
 * the functions created in `drizzle/0012_canonical_read_axes.sql`.
 * `canonical_as_of()` **raises** when the setting is absent rather than
 * defaulting to `now()`: a default would turn a forgotten axis into a
 * latest-version read that is indistinguishable from a correct answer, which is
 * the one regression this layer exists to prevent. `contract/scope.ts` and
 * `wattsteer_ml/canonical_reads.py` are the only two places that set them.
 *
 * The two optional axes — the day-ahead gate and the weather run cycle — are
 * inside the views rather than left to the caller for a reason that is easy to
 * get backwards. Both restrict a column that is **not** part of the business
 * key, so applying them after the `DISTINCT ON` is a different query: "the
 * latest version of the 00Z run" is not "the latest version, discarded if it
 * turned out to be 12Z". Every other filter a caller applies — `valid_time`,
 * subsystem, technology, entity code, centroid — is on a key column, where
 * outside and inside are the same question and Postgres pushes the predicate
 * down for free.
 */

/** The vintage columns every fact view carries, spelled once. */
const rowVintage = {
  /** Monotonic per business key; bumped only when the value tuple changes. */
  dataVersion: integer().notNull(),
  /** When the upstream source asserted this value. Never null. */
  publishedAt: timestamp({ withTimezone: true }).notNull(),
  /** When WattSteer learned it — the axis `AsOf(t)` filters on. */
  ingestedAt: timestamp({ withTimezone: true }).notNull(),
};

/**
 * Constrained-off as settled, at `ReportingEntity` grain.
 *
 * The only canonical read whose rows carry a restriction cause, because it is
 * the only grain at which one is observed (`docs/domain-model.md` §3).
 *
 * **`reporting_entity_kind` is joined in here**, and that is ticket 016's third
 * drift correction. A consumer holding a curtailment row could not previously
 * tell a conjunto from a self-reporting plant without a second call, which is
 * exactly the kind of question a screen showing a cause has to answer. The
 * join is safe: `reporting_entity_code` is a foreign key, so it neither drops
 * nor duplicates a row.
 */
export const canonicalCurtailmentByReportingEntity = pgView(
  "canonical_curtailment_by_reporting_entity",
  {
    /** A `CJU_*` conjunto code, or a self-reporting plant's ONS code. */
    reportingEntityCode: text().notNull(),
    /** `CONJUNTO` or `PLANT` — the grain of the row, on the row. */
    reportingEntityKind: reportingEntityKind().notNull(),
    technology: technology().notNull(),
    /** Start of the hour, UTC. */
    validTime: timestamp({ withTimezone: true }).notNull(),
    /** The primary label: energy the entity was instructed not to generate. */
    constrainedOffMwh: doublePrecision().notNull(),
    verifiedGenerationMwh: doublePrecision().notNull(),
    referenceGenerationMwh: doublePrecision(),
    finalReferenceGenerationMwh: doublePrecision(),
    /** Real-time availability. A power, so it is a mean and not a sum. */
    availableCapacityMw: doublePrecision(),
    /** 1 or 2. Below 2 the source hour was incomplete. */
    halfHoursObserved: integer().notNull(),
    /** The cause is one value object over three columns, or none of them. */
    restrictionReason: reasonCode(),
    restrictionOrigin: restrictionOrigin(),
    restrictionDescription: text(),
    /** The two half-hours disagreed; the dominant reason is the one carried. */
    restrictionCauseMixed: boolean().notNull(),
    ...rowVintage,
  },
).as(sql`
  select distinct on (c.reporting_entity_code, c.technology, c.valid_time)
    c.reporting_entity_code,
    e.kind as reporting_entity_kind,
    c.technology,
    c.valid_time,
    c.constrained_off_mwh,
    c.verified_generation_mwh,
    c.reference_generation_mwh,
    c.final_reference_generation_mwh,
    c.available_capacity_mw,
    c.half_hours_observed,
    c.reason as restriction_reason,
    c.origin as restriction_origin,
    c.restriction_description,
    (c.cause_mixed = 1) as restriction_cause_mixed,
    c.data_version,
    c.published_at,
    c.ingested_at
  from curtailment_report_hour c
  join reporting_entity e on e.ons_code = c.reporting_entity_code
  where c.ingested_at <= canonical_as_of()
  order by c.reporting_entity_code, c.technology, c.valid_time,
           c.ingested_at desc, c.data_version desc
`);

/**
 * Per-plant generation and measured resource, at `Plant` grain.
 *
 * No restriction cause and no reference generation exist here, so neither is
 * projected and no filter could produce one. The measurement is resolved into
 * the one shape the domain model has for it: a named quantity, a value and its
 * validity flag, all three present or all three absent.
 */
export const canonicalCurtailmentByPlant = pgView("canonical_curtailment_by_plant", {
  plantOnsCode: text().notNull(),
  technology: technology().notNull(),
  /** Start of the hour, UTC. */
  validTime: timestamp({ withTimezone: true }).notNull(),
  estimatedGenerationMwh: doublePrecision(),
  verifiedGenerationMwh: doublePrecision(),
  /**
   * `wind_speed_ms` or `irradiance_wm2`, stated rather than left to be
   * inferred from the technology — an unlabelled number is how a wind speed
   * reaches a PV curve.
   */
  measuredQuantity: text().notNull(),
  /** m/s or W/m², per `measured_quantity`. Negative values are real. */
  measurementValue: doublePrecision(),
  measurementInvalid: boolean(),
  halfHoursObserved: integer().notNull(),
  ...rowVintage,
}).as(sql`
  select distinct on (plant_ons_code, technology, valid_time)
    plant_ons_code,
    technology,
    valid_time,
    estimated_generation_mwh,
    verified_generation_mwh,
    case technology when 'WIND' then 'wind_speed_ms' else 'irradiance_wm2' end
      as measured_quantity,
    case technology
      when 'WIND' then measured_wind_speed_ms
      else measured_irradiance_wm2
    end as measurement_value,
    (measurement_invalid = 1) as measurement_invalid,
    half_hours_observed,
    data_version,
    published_at,
    ingested_at
  from plant_detail_hour
  where ingested_at <= canonical_as_of()
  order by plant_ons_code, technology, valid_time,
           ingested_at desc, data_version desc
`);

/** Load and generation by technology per subsystem-hour, with net exchange. */
export const canonicalSystemContext = pgView("canonical_system_context", {
  subsystem: subsystemCode().notNull(),
  /** Start of the hour, UTC. */
  validTime: timestamp({ withTimezone: true }).notNull(),
  loadMwh: doublePrecision().notNull(),
  windGenerationMwh: doublePrecision().notNull(),
  solarGenerationMwh: doublePrecision().notNull(),
  hydroGenerationMwh: doublePrecision().notNull(),
  thermalGenerationMwh: doublePrecision().notNull(),
  netExchangeMwh: doublePrecision().notNull(),
  ...rowVintage,
}).as(sql`
  select distinct on (subsystem, valid_time)
    subsystem,
    valid_time,
    load_mwh,
    wind_generation_mwh,
    solar_generation_mwh,
    hydro_generation_mwh,
    thermal_generation_mwh,
    net_exchange_mwh,
    data_version,
    published_at,
    ingested_at
  from subsystem_energy_balance_hour
  where ingested_at <= canonical_as_of()
  order by subsystem, valid_time, ingested_at desc, data_version desc
`);

/**
 * Interchange per directed subsystem link — the corridor grain.
 *
 * Orientation is canonical (`from < to`, enforced by a check on the table), so
 * a caller restricting to one subsystem asks about either end of the link
 * rather than about a pair.
 */
export const canonicalSystemExchange = pgView("canonical_system_exchange", {
  fromSubsystem: subsystemCode().notNull(),
  toSubsystem: subsystemCode().notNull(),
  /** Start of the hour, UTC. */
  validTime: timestamp({ withTimezone: true }).notNull(),
  verifiedExchangeMwh: doublePrecision().notNull(),
  programmedExchangeMwh: doublePrecision(),
  ...rowVintage,
}).as(sql`
  select distinct on (from_subsystem, to_subsystem, valid_time)
    from_subsystem,
    to_subsystem,
    valid_time,
    verified_exchange_mwh,
    programmed_exchange_mwh,
    data_version,
    published_at,
    ingested_at
  from subsystem_exchange_hour
  where ingested_at <= canonical_as_of()
  order by from_subsystem, to_subsystem, valid_time,
           ingested_at desc, data_version desc
`);

/**
 * The operational day-ahead balance published D−1. A forecast, in its own read.
 *
 * The gate (`wattsteer.published_at_or_before`) is applied **inside** the
 * `DISTINCT ON`, which is the only correct place for it: over backfilled
 * history every row was ingested at go-live, so `as_of` alone filters nothing,
 * and what reproduces what was knowable is the latest-ingested row *among those
 * published by the gate* (`docs/specs/feature-engineering.md`).
 *
 * No `lead_time` is projected. It is `valid_time − published_at`, the consumer
 * holds both, and a stored copy can disagree with the pair it came from.
 */
export const canonicalDayAheadBalance = pgView("canonical_day_ahead_balance", {
  subsystem: subsystemCode().notNull(),
  /** Start of the half hour, UTC. */
  validTime: timestamp({ withTimezone: true }).notNull(),
  /** `ForecastOrigin.producer`. */
  forecastProducer: forecastProducer().notNull(),
  /** `ForecastOrigin.run_label` — the DESSEM reference day, this run's identity. */
  runLabel: text().notNull(),
  /** Power, not energy: DESSEM publishes instantaneous MW. */
  demandMw: doublePrecision().notNull(),
  hydroGenerationMw: doublePrecision().notNull(),
  smallHydroGenerationMw: doublePrecision().notNull(),
  thermalGenerationMw: doublePrecision().notNull(),
  smallThermalGenerationMw: doublePrecision().notNull(),
  windGenerationMw: doublePrecision().notNull(),
  solarGenerationMw: doublePrecision().notNull(),
  mmgdGenerationMw: doublePrecision().notNull(),
  pumpingConsumptionMw: doublePrecision().notNull(),
  ...rowVintage,
}).as(sql`
  select distinct on (subsystem, valid_time)
    subsystem,
    valid_time,
    forecast_producer,
    run_label,
    demand_mw,
    hydro_generation_mw,
    small_hydro_generation_mw,
    thermal_generation_mw,
    small_thermal_generation_mw,
    wind_generation_mw,
    solar_generation_mw,
    mmgd_generation_mw,
    pumping_consumption_mw,
    data_version,
    published_at,
    ingested_at
  from dessem_balance_half_hour
  where ingested_at <= canonical_as_of()
    and (canonical_published_at_or_before() is null
         or published_at <= canonical_published_at_or_before())
  order by subsystem, valid_time, ingested_at desc, data_version desc
`);

/**
 * Weather at capacity-weighted cluster centroids, from a named run.
 *
 * With no run cycle set — the normal read — the later run simply wins as a
 * newer version of the same hours, so D−1 12Z supersedes 00Z without any clause
 * here saying so. Setting `wattsteer.weather_run_cycle` answers the diagnostic
 * question "what did the 00Z run say?", and it too is applied inside the
 * `DISTINCT ON` for the reason in this file's header.
 *
 * `published_at` **is** the run initialisation, which is why supersession needs
 * no rule of its own.
 */
export const canonicalWeatherForecast = pgView("canonical_weather_forecast", {
  centroidId: text().notNull(),
  /** Start of the forecast hour, UTC. */
  validTime: timestamp({ withTimezone: true }).notNull(),
  /** `ForecastOrigin.run_label`. */
  runCycle: weatherRunCycle().notNull(),
  /** The model grid cell the query snapped to, as echoed by the source. */
  gridLatitude: doublePrecision().notNull(),
  gridLongitude: doublePrecision().notNull(),
  gridElevationM: doublePrecision().notNull(),
  /** `run_init(scheduled) − run_init(used)`, in hours. Zero on the normal path. */
  runAgeHours: doublePrecision().notNull(),
  windSpeed100mKmh: doublePrecision(),
  windSpeed120mKmh: doublePrecision(),
  windDirection120mDeg: doublePrecision(),
  windGusts10mKmh: doublePrecision(),
  temperature2mC: doublePrecision(),
  surfacePressureHpa: doublePrecision(),
  relativeHumidity2mPct: doublePrecision(),
  precipitationMm: doublePrecision(),
  shortwaveRadiationWm2: doublePrecision(),
  directNormalIrradianceWm2: doublePrecision(),
  diffuseRadiationWm2: doublePrecision(),
  cloudCoverPct: doublePrecision(),
  ...rowVintage,
}).as(sql`
  select distinct on (centroid_id, valid_time)
    centroid_id,
    valid_time,
    run_cycle,
    grid_latitude,
    grid_longitude,
    grid_elevation_m,
    run_age_hours,
    wind_speed100m_kmh,
    wind_speed120m_kmh,
    wind_direction120m_deg,
    wind_gusts10m_kmh,
    temperature2m_c,
    surface_pressure_hpa,
    relative_humidity2m_pct,
    precipitation_mm,
    shortwave_radiation_wm2,
    direct_normal_irradiance_wm2,
    diffuse_radiation_wm2,
    cloud_cover_pct,
    data_version,
    published_at,
    ingested_at
  from weather_forecast_hour
  where ingested_at <= canonical_as_of()
    and (canonical_weather_run_cycle() is null
         or run_cycle::text = canonical_weather_run_cycle())
  order by centroid_id, valid_time, ingested_at desc, data_version desc
`);

/**
 * `InstalledCapacityAsOf(scope, technology, t)` — the domain model's function,
 * as a view.
 *
 * Never a stored scalar: a plant's capacity is the sum over its units *at a
 * date*, and the units of one plant routinely commission months apart. Fixed
 * present-day weights misallocate a quarter of fleet MW at window start.
 *
 * The `DISTINCT ON` runs **before** the interval filter, deliberately: a
 * revision can move a commissioning date, and filtering first would compare the
 * question's date against a superseded answer and then pick a winner among the
 * survivors, which is a different query and quietly a wrong one.
 */
export const canonicalInstalledCapacity = pgView("canonical_installed_capacity", {
  subsystem: subsystemCode().notNull(),
  technology: technology().notNull(),
  plants: integer().notNull(),
  units: integer().notNull(),
  capacityMw: doublePrecision().notNull(),
}).as(sql`
  with live_units as (
    select distinct on (plant_ceg_core, equipment_code)
      plant_ceg_core, equipment_code, rated_power_mw,
      commissioned_on, decommissioned_on
    from generating_unit
    where ingested_at <= canonical_as_of()
    order by plant_ceg_core, equipment_code, ingested_at desc, data_version desc
  )
  select
    p.subsystem,
    p.technology,
    count(distinct live_units.plant_ceg_core)::int as plants,
    count(*)::int as units,
    sum(live_units.rated_power_mw) as capacity_mw
  from live_units
  join plant p on p.ceg_core = live_units.plant_ceg_core
  where live_units.commissioned_on <= canonical_fleet_date()
    and (live_units.decommissioned_on is null
         or live_units.decommissioned_on > canonical_fleet_date())
  group by p.subsystem, p.technology
`);

/**
 * Which conjunto a plant belonged to on a date.
 *
 * The only path between the plant and reporting-entity grains, and every
 * traversal takes a date (`docs/domain-model.md` §7). At most one row per plant
 * by construction — the one-conjunto-per-plant invariant is asserted at ingest.
 *
 * `member_to` is compared with `>=` because it is the **inclusive** last day of
 * membership: an exclusive reading would leave every plant that ever changed
 * conjunto unattributed for exactly one day.
 */
export const canonicalConjuntoMembership = pgView("canonical_conjunto_membership", {
  plantOnsCode: text().notNull(),
  conjuntoCode: text().notNull(),
  /** The member's `ceg_core`, where ONS's bridge supplies one. */
  plantCegCore: text(),
  /** Inclusive first day of membership. */
  memberFrom: timestamp({ withTimezone: true }).notNull(),
  /** Inclusive last day, or null while the membership is current. */
  memberTo: timestamp({ withTimezone: true }),
  ...rowVintage,
}).as(sql`
  with latest as (
    select distinct on (plant_ons_code, conjunto_code, member_from)
      plant_ons_code, plant_ceg_core, conjunto_code, member_from, member_to,
      data_version, published_at, ingested_at
    from conjunto_membership
    where ingested_at <= canonical_as_of()
    order by plant_ons_code, conjunto_code, member_from,
             ingested_at desc, data_version desc
  )
  select
    plant_ons_code,
    conjunto_code,
    plant_ceg_core,
    member_from,
    member_to,
    data_version,
    published_at,
    ingested_at
  from latest
  where member_from <= canonical_fleet_date()
    and (member_to is null or member_to >= canonical_fleet_date())
`);

/**
 * WattSteer's own go-live, per canonical read — the input to `vintageFidelity`.
 *
 * The earliest instant anything was ingested for a read's source. Deliberately
 * **not** filtered by `as_of`: it is a fact about WattSteer's history rather
 * than about the cut being asked for, and filtering it would make a
 * sufficiently early `as_of` report a source as having ingested nothing.
 *
 * This is the one view without an axis, and therefore the one a caller may
 * query without setting anything. It exists so that the fidelity rule has the
 * same input in both languages while remaining a pure function in each.
 */
export const canonicalReadGoLive = pgView("canonical_read_go_live", {
  /** A `CanonicalReadName` — the manifest's name, not a table's. */
  read: text().notNull(),
  goLiveAt: timestamp({ withTimezone: true }),
}).as(sql`
  select 'curtailment-by-reporting-entity' as read,
         min(ingested_at) as go_live_at from curtailment_report_hour
  union all
  select 'curtailment-by-plant', min(ingested_at) from plant_detail_hour
  union all
  select 'system-context', min(ingested_at) from subsystem_energy_balance_hour
  union all
  select 'system-exchange', min(ingested_at) from subsystem_exchange_hour
  union all
  select 'day-ahead-balance', min(ingested_at) from dessem_balance_half_hour
  union all
  select 'weather-forecast', min(ingested_at) from weather_forecast_hour
  union all
  select 'installed-capacity', min(ingested_at) from generating_unit
  union all
  select 'conjunto-membership', min(ingested_at) from conjunto_membership
`);

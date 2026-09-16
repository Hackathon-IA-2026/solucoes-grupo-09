import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  pgView,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
// The module importing itself, so `canonicalViewNames` walks the exports
// rather than a list that can fall behind them. Resolved once, at load.
import * as canonicalViewModule from "./canonical-views.js";
import {
  diagnosisAttributionGrain,
  diagnosisDriverDirection,
  diagnosisRuleAction,
  forecastGateProfile,
  forecastOriginKind,
  forecastProducer,
  operationModality,
  plantLocationSource,
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
 *
 * **`reporting_entity_name` comes from the same join**, and is what a reason
 * row is labelled with: `GET /v1/curtailment/reasons` returns an `entity_label`
 * on every row, and a code is not a name.
 *
 * **`subsystem` comes from the same join**, and for the same class of reason.
 * The label the day-ahead model is trained on is defined at (`Subsystem`,
 * `valid_time`) grain (`docs/specs/feature-engineering.md` §"The feature
 * table"), and constrained-off is settled at `ReportingEntity` grain, so
 * something has to carry the entity's subsystem across. If the view did not,
 * the feature function would have to reach into `reporting_entity` itself —
 * which is the one thing it must never do, because an ingest table is where
 * ONS's conventions still exist. One more projected column here is strictly
 * cheaper than a second path to the base tables.
 */
export const canonicalCurtailmentByReportingEntity = pgView(
  "canonical_curtailment_by_reporting_entity",
  {
    /** A `CJU_*` conjunto code, or a self-reporting plant's ONS code. */
    reportingEntityCode: text().notNull(),
    /** `CONJUNTO` or `PLANT` — the grain of the row, on the row. */
    reportingEntityKind: reportingEntityKind().notNull(),
    /**
     * ONS's `nom_usina` for the entity — display only, never a join key.
     *
     * Projected for the same reason `reporting_entity_kind` is: a screen that
     * shows a restriction cause has to name the entity it was reported for, and
     * a code is not a name. Reaching into `reporting_entity` from a product
     * read to fetch it would be a second path to a base table for one column.
     */
    reportingEntityName: text().notNull(),
    /** The entity's electrical subsystem — the grain the label is defined at. */
    subsystem: subsystemCode().notNull(),
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
    e.name as reporting_entity_name,
    e.subsystem,
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
 *
 * ## Whole days, unless a caller asks otherwise
 *
 * ONS publishes reference days short: 34 of 470, each a contiguous prefix or
 * suffix of the civil day (data-platform 25). 29 of them are now stored rather
 * than refused, and the pair `reference_day_patamares` /
 * `reference_day_half_hours` is how this read *says* how complete a day is.
 *
 * **The default excludes them, and that is the whole point of the change.**
 * `feature_rows` reads this view and computes `dessem_residual_load_min_of_day`
 * and `dessem_residual_load_rank_in_day` over the day it finds here; on a
 * 21-patamar day those would be a minimum and a rank over ten hours wearing a
 * day's name, and nothing in the answer would say so. A default that quietly
 * admitted partial days would therefore be worse than the refusal it replaced.
 * So a reader that does not ask gets exactly what it got before this change,
 * and `wattsteer.partial_reference_days` is the ask.
 *
 * The predicate sits **inside** the `DISTINCT ON`, beside the gate and for the
 * same reason: dropping partial rows before the version pick means a day ONS
 * first published whole and later re-published short still answers with the
 * whole vintage, rather than answering with nothing because the newest version
 * was filtered out after being chosen.
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
  /** How many half hours of this row's reference day ONS published. */
  referenceDayPatamares: integer().notNull(),
  /** How many half hours the local civil day contains. Equal on a whole day. */
  referenceDayHalfHours: integer().notNull(),
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
    ingested_at,
    reference_day_patamares,
    reference_day_half_hours
  from dessem_balance_half_hour
  where ingested_at <= canonical_as_of()
    and (canonical_published_at_or_before() is null
         or published_at <= canonical_published_at_or_before())
    and (canonical_partial_reference_days()
         or reference_day_patamares = reference_day_half_hours)
  order by subsystem, valid_time, ingested_at desc, data_version desc
`);

/**
 * ONS's day-ahead load programme per subsystem-hour — `carga-energia-programada`,
 * dataset 7, and `dessem_free_v1`'s spine.
 *
 * A `Forecast`, and cut on `published_at <= gate` for the reason
 * `canonical_day_ahead_balance` and `canonical_weather_forecast` are: the
 * publication instant is what makes a D−1 availability *genuine* in the
 * backfill window, where `as_of` filters nothing. Which instant a programme row
 * carries is decided at the adapter and argued there
 * (`ingest/ons/load.ts`, `programmePublishedAt`).
 *
 * Three conventions are removed here so that no feature can meet them:
 *
 * - **`SECO` never leaves the adapter.** The subsystem column is already
 *   WattSteer's `SE`; this view exposes only the four subsystem areas, because
 *   the forecast grain is the subsystem and ONS publishes no assignment from a
 *   geoelectric or loss area to one (`schema.ts`, `programmed_load_half_hour`).
 * - **Half hours become hours.** The source grain is 30 minutes and the feature
 *   row is hourly, so the two half hours of an hour are summed into it — they
 *   are MWh after the adapter's MWmed conversion, so a sum is the hour's energy
 *   and a mean would be its average power.
 * - **A half-empty hour is a hole, not a half-sized one.** The sum is taken
 *   only where both half hours survive the gate; with one of them the hour
 *   would be published as a number roughly half its true size, which is the
 *   kind of wrong that looks exactly like a quiet evening.
 *
 * The vintage columns are the *latest* of the pair, because the hour is as new
 * as its newer half and as late-published as its later half — the weakest-link
 * rule the fidelity stamp already uses, applied to an aggregate.
 */
export const canonicalProgrammedLoad = pgView("canonical_programmed_load", {
  subsystem: subsystemCode().notNull(),
  /** Start of the hour, UTC. */
  validTime: timestamp({ withTimezone: true }).notNull(),
  /** `val_cargaglobalprogramada`, both half hours of the hour, as MWh. */
  programmedLoadMwh: doublePrecision().notNull(),
  ...rowVintage,
}).as(sql`
  with half_hours as (
    select distinct on (area_code, valid_time)
      subsystem,
      valid_time,
      programmed_load_mwh,
      data_version,
      published_at,
      ingested_at
    from programmed_load_half_hour
    where subsystem is not null
      and ingested_at <= canonical_as_of()
      and (canonical_published_at_or_before() is null
           or published_at <= canonical_published_at_or_before())
    order by area_code, valid_time, ingested_at desc, data_version desc
  )
  select
    subsystem,
    date_trunc('hour', valid_time) as valid_time,
    sum(programmed_load_mwh) as programmed_load_mwh,
    max(data_version) as data_version,
    max(published_at) as published_at,
    max(ingested_at) as ingested_at
  from half_hours
  group by subsystem, date_trunc('hour', valid_time)
  having count(*) = 2
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
 *
 * **The day-ahead gate applies here too**, and its absence was a hole. Ticket
 * 016 put the gate in the day-ahead balance and left it out of this view,
 * because within a target day the newer run winning is exactly right. It is
 * exactly wrong across the gate: the D 00Z run is a newer version of D's hours
 * than the D−1 12Z run, so with no publication cut a feature built for day D at
 * `gate_late` silently reads a run that will not exist for another three hours.
 * Over backfilled history every row shares one `ingested_at`, so `as_of` filters
 * nothing and there is no second line of defence — the read simply returns the
 * future, and it looks exactly like a correct answer.
 *
 * Inside the `DISTINCT ON` for this file's header reason: what reproduces what
 * was knowable is the latest-ingested row *among those published by the gate*,
 * not the latest-ingested row discarded if it turned out to be late.
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
    and (canonical_published_at_or_before() is null
         or published_at <= canonical_published_at_or_before())
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
 *
 * **The row set is derived, not listed** — data-platform ticket 20, migration
 * `0040`. It was a nine-arm `union all` written out by hand, and the ninth arm
 * arrived a migration after the eighth: the reads and the rows had to be kept
 * in step by whoever remembered. They were not.
 * `canonical_plant_registry` reads `plant_geo` under `canonical_as_of()` and
 * stands behind every weather feature through `canonical_capacity_weight`, and
 * `plant_geo` appeared in no arm at all — which is what kept
 * feature-engineering 16 from narrowing the feature horizon to the sources a
 * feature row actually reads.
 *
 * So a rule replaced the list. `canonical_read_source()` walks the catalogue —
 * every `canonical_*` view, transitively through the views it reads, down to
 * the base tables carrying an `ingested_at` column — and this view is one
 * aggregate over it. Three consequences are the point:
 *
 * - A tenth read added tomorrow **arrives with a go-live row**. Nothing to
 *   remember, and `database-read-go-live.test.ts` creates a read that did not
 *   exist when it was written and asserts the row appears.
 * - A read with **two** vintaged sources gets one go-live, and it is the
 *   _later_ of them — `docs/contracts/canonical-reads.md`'s weakest-link rule,
 *   which no arm of the union was shaped to express. `plant-registry` is the
 *   first such read: `generating_unit` and `plant_geo`. NULL if either has
 *   ingested nothing, because then no honest instant exists.
 * - A read whose sources carry **no** ingestion axis has no row rather than a
 *   NULL one. `canonical_solar_centroid` reads the frozen geometry and
 *   `canonical_subsystem_state` reads `plant`; neither has an `ingested_at`,
 *   and a NULL here would say "this source has ingested nothing", which is a
 *   different and false statement.
 *
 * Its own row set no longer contains itself, and that falls out of the rule
 * rather than being excluded by name: the body below reads two functions and no
 * relation, so the catalogue records no table this view depends on.
 *
 * The names are still the manifest's, by the transform the rest of the contract
 * applies in reverse — `canonical_curtailment_by_plant` →
 * `curtailment-by-plant`. Reads with no `/v1/canonical` entry appear too, which
 * was already true of `programmed-load` before the rule: the ONS day-ahead
 * programme feeds `dessem_free_v1`'s spine and the feature function needs its
 * go-live, and a row here is strictly better than a feature reaching into
 * `programmed_load_half_hour` for a `min(ingested_at)` — the one thing a
 * feature may never do. Publishing those reads is an api-surface ticket; these
 * rows are what it will find waiting.
 */
export const canonicalReadGoLive = pgView("canonical_read_go_live", {
  /** A `CanonicalReadName` — the manifest's name, not a table's. */
  read: text().notNull(),
  goLiveAt: timestamp({ withTimezone: true }),
}).as(sql`
  select
    s.read,
    case
      when count(*) filter (where g.go_live_at is null) > 0 then null
      else max(g.go_live_at)
    end as go_live_at
  from (select distinct read, source_table from canonical_read_source()) s
  cross join lateral (
    select canonical_source_go_live(s.source_table) as go_live_at
  ) g
  group by s.read
`);

/**
 * Which states a subsystem is made of — **ONS's electrical assignment**, not a
 * map of Brazil.
 *
 * The denominator of `calendar_holiday_state_share`. It is derived from
 * `plant.subsystem` × `plant.state_code`, which is ONS's own pairing of a plant
 * to a subsystem and to a federal unit, because the alternative — a geographic
 * state→subsystem table — is wrong on the cases that matter: twelve VRE units
 * in Bahia are assigned to `SE` in the live file, and any geography would place
 * them in `NE` (`schema.ts`, `plant.subsystem`). A subsystem is an electrical
 * region and its state list has to come from the same source that says so.
 *
 * **Read without a vintage axis, exactly as `canonical_installed_capacity`
 * reads `plant`.** The registry is a slowly changing dimension WattSteer
 * overwrites rather than versions, so this read is revision-optimistic in the same
 * sense the capacity features are, and for the same reason. What it costs is
 * bounded: a new state entering a subsystem changes a denominator of 5–10 by
 * one, and that is a knowably small restatement rather than a silent one.
 */
export const canonicalSubsystemState = pgView("canonical_subsystem_state", {
  subsystem: subsystemCode().notNull(),
  /** ONS `id_estado` — the two-letter UF, the key the calendar is stored under. */
  uf: text().notNull(),
  /** How many registry plants carry the pair. Provenance, never a weight. */
  plants: integer().notNull(),
}).as(sql`
  select subsystem, state_code as uf, count(*)::int as plants
  from plant
  group by subsystem, state_code
`);

/**
 * The solar-capacity-weighted centroid of a frozen centroid set — one point per
 * set, and the point the solar geometry is computed at.
 *
 * **Frozen, and that is the requirement rather than a convenience.** Solar
 * zenith at hour *t* is a fact about a place; if the place moved with the fleet
 * the cosine for a past hour would change every time a plant was commissioned,
 * silently restating a class-`T` feature that is supposed to be recomputable
 * from the calendar alone. `centroid_point.represented_mw` is the freeze-time
 * solar capacity behind each point, so the weighted mean of the points under one
 * set version is itself frozen with the set — and a set that moves is already a
 * new feature-set version and a retrain.
 *
 * No axis: a centroid set is immutable once written (`centroid_set.version` is
 * the key and `geometry_digest` refuses a restatement), so there is no vintage
 * to choose between. This is the second view without one, and for a stronger
 * reason than `canonical_read_go_live`'s.
 */
export const canonicalSolarCentroid = pgView("canonical_solar_centroid", {
  setVersion: text().notNull(),
  /** Degrees north, capacity-weighted. */
  latitude: doublePrecision(),
  /** Degrees east, capacity-weighted. */
  longitude: doublePrecision(),
  representedMw: doublePrecision(),
  centroids: integer().notNull(),
}).as(sql`
  select
    set_version,
    sum(latitude * represented_mw) / nullif(sum(represented_mw), 0) as latitude,
    sum(longitude * represented_mw) / nullif(sum(represented_mw), 0) as longitude,
    sum(represented_mw) as represented_mw,
    count(*)::int as centroids
  from centroid_point
  where technology = 'SOLAR'
  group by set_version
`);

/**
 * The plant registry at one grain per plant — identity, attributes, the
 * location and its provenance, and installed capacity **as of a fleet date**.
 *
 * The read behind `GET /v1/plants`, which exists for ODbL §4.6 and not for a
 * screen. It is a view rather than a query in the route for the reason every
 * other canonical read is one: `apps/api` and `apps/ml` must not each own a
 * copy of the two `AsOf` picks and the ONS↔SIGA join, and a product route that
 * reached into `plant`, `plant_geo` and `generating_unit` itself would be that
 * second copy in the one place where being wrong is a licence breach as well
 * as a bug.
 *
 * Four decisions are in the SQL rather than downstream, because downstream is
 * where each of them gets forgotten:
 *
 * - **Capacity is summed here, over the units live on `canonical_fleet_date()`.**
 *   The `DISTINCT ON` runs before the interval filter, exactly as
 *   `canonical_installed_capacity` does and for the same reason: a revision can
 *   move a commissioning date, and filtering first compares the question's date
 *   against a superseded answer. A plant with no live unit on that date did not
 *   exist yet and is not a row — an `inner join`, not a zero.
 * - **The name is ONS's `nom_usina`.** `plant_geo.siga_name` carries
 *   `(Antiga …)` aliases and is never projected here, so no consumer can render
 *   it by reaching for the nearest string.
 * - **The location is left-joined and its source rides beside it.** A plant SIGA
 *   does not name keeps its capacity and loses only its point;
 *   `location_source` distinguishes a surveyed coordinate from the municipality
 *   centroid four plants fall back to, so a fallback can never be presented as
 *   a survey. Withdrawn SIGA rows are excluded — the source represents a
 *   retirement by deleting the row, and `withdrawn_on` is the diff that records it.
 * - **Ownership is ONS's agent, not SIGA's `DscPropriRegimePariticipacao`.**
 *   That field is free text carrying CNPJs of named legal persons, which ODbL
 *   §2.4 explicitly does not license. It is ingested because ownership is a
 *   modelled attribute; it is not projected into the endpoint that publishes
 *   the database in bulk.
 *
 * `ingested_at` is the freshest of the two snapshots behind the row — the ONS
 * capacity cut and the SIGA location cut — which is what the endpoint's ETag is
 * built from.
 */
export const canonicalPlantRegistry = pgView("canonical_plant_registry", {
  /** ANEEL CEG, version segment stripped. The identity and the SIGA bridge. */
  cegCore: text().notNull(),
  /** ONS's own rendering, zero-padded version segment and all. */
  cegRaw: text().notNull(),
  /** ONS `id_ons`. Null where no dataset in scope names one. */
  onsPlantCode: text(),
  /** ONS `nom_usina`. Never SIGA's alias-carrying `NomEmpreendimento`. */
  name: text().notNull(),
  /** The **electrical** assignment, never derived from `state_code`. */
  subsystem: subsystemCode().notNull(),
  stateCode: text().notNull(),
  technology: technology().notNull(),
  operationModality: operationModality().notNull(),
  ownerName: text().notNull(),
  operatorName: text().notNull(),
  /** Summed over the units live on `canonical_fleet_date()`. Never stored. */
  installedCapacityMw: doublePrecision().notNull(),
  generatingUnits: integer().notNull(),
  /** Null unless `location_source` is a located one — the two cannot disagree. */
  latitude: doublePrecision(),
  longitude: doublePrecision(),
  /** `siga_coordinate`, `siga_municipality_centroid` or `unlocated`. */
  locationSource: plantLocationSource().notNull(),
  municipalityName: text(),
  municipalityUf: text(),
  /** The freshest of the ONS capacity and SIGA location cuts behind the row. */
  ingestedAt: timestamp({ withTimezone: true }).notNull(),
}).as(sql`
  with live_units as (
    select distinct on (plant_ceg_core, equipment_code)
      plant_ceg_core, equipment_code, rated_power_mw,
      commissioned_on, decommissioned_on, ingested_at
    from generating_unit
    where ingested_at <= canonical_as_of()
    order by plant_ceg_core, equipment_code, ingested_at desc, data_version desc
  ),
  capacity as (
    select plant_ceg_core,
           sum(rated_power_mw) as installed_capacity_mw,
           count(*)::int as generating_units,
           max(ingested_at) as ingested_at
    from live_units
    where commissioned_on <= canonical_fleet_date()
      and (decommissioned_on is null
           or decommissioned_on > canonical_fleet_date())
    group by plant_ceg_core
  ),
  location as (
    select distinct on (plant_ceg_core)
      plant_ceg_core, latitude, longitude, location_source,
      municipality_name, municipality_uf, withdrawn_on, ingested_at
    from plant_geo
    where ingested_at <= canonical_as_of()
    order by plant_ceg_core, ingested_at desc, data_version desc
  )
  select
    p.ceg_core,
    p.ceg_raw,
    p.ons_plant_code,
    p.name,
    p.subsystem,
    p.state_code,
    p.technology,
    p.operation_modality,
    p.owner_name,
    p.operator_name,
    capacity.installed_capacity_mw,
    capacity.generating_units,
    l.latitude,
    l.longitude,
    coalesce(l.location_source, 'unlocated') as location_source,
    l.municipality_name,
    l.municipality_uf,
    greatest(capacity.ingested_at,
             coalesce(l.ingested_at, capacity.ingested_at)) as ingested_at
  from capacity
  join plant p on p.ceg_core = capacity.plant_ceg_core
  left join location l
    on l.plant_ceg_core = p.ceg_core and l.withdrawn_on is null
`);

/**
 * `CapacityWeight(centroid, technology, t)` — the weight vector the class-`W`
 * weather features are aggregated on, as a view.
 *
 * The other half of `canonical_solar_centroid`. That view answers "where is the
 * solar fleet, once and forever" because a frozen point is what makes the solar
 * geometry recomputable from the calendar alone. This one answers the question
 * the geometry deliberately does not: **how much of each subsystem's fleet each
 * frozen point speaks for, on a given day** — which moves, and has to.
 *
 * **Time-varying is settled by measurement, not by caution.**
 * `docs/research/plant-registry.md` §5 measured 25.8% of today's curtailed-fleet
 * MW as commissioned *after* the training window opens, fixed 2026-08 weights as
 * misallocating 50.4% of the SE-solar weight mass at window start, and the SE
 * solar capacity centroid as moving 94 km — more than seven Open-Meteo grid
 * cells — between 2024-04 and 2026-08. A static vector would leak today's fleet
 * composition into 2024's features and contaminate every backtest built on them.
 *
 * **Wind and solar carry separate vectors**, because the two fleets sit in
 * different places: NE wind is the Bahia/Piauí interior and the RN/CE coast,
 * while more than half of SE solar is three municipality clusters in northern
 * Minas Gerais. One shared vector would put solar weight on wind's coast. The
 * combined VRE basis the shared variables need is not a third row here — it is
 * `capacity_mw` summed across the two technologies of a subsystem, which is the
 * blend by installed capacity and nothing else.
 *
 * **Both axes, and they are not interchangeable.** The read is
 * `canonical_plant_registry`, which is already the double as-of the weights
 * need: `canonical_fleet_date()` decides which units existed, and
 * `canonical_as_of()` decides what WattSteer had learned. A feature block writes
 * both through `feature_apply_gate` and never picks either itself.
 *
 * **An unlocated plant is spread pro rata rather than dropped.**
 * `location_source = 'unlocated'` is a real state — 1.72% of operating SIGA
 * rows are at Null Island and lose their point — and a plant with no coordinate
 * still generates. `weight` is its share of the scope's **located** mass, so the
 * shape of the vector is untouched; `capacity_mw` is that share of the
 * **placed** mass, so the megawatts still add up to `InstalledCapacityAsOf`.
 * A scope with no located plant at all has no row: an even spread over the
 * frozen points would be a fabricated location.
 *
 * **The grid-cell merge `capacity-weights.ts` performs has no work to do here.**
 * That module folds two frozen points that snapped to one Open-Meteo cell into
 * a single weight, because one cell entering a weighted mean twice is a silently
 * doubled region. `centroid_point`'s `centroid_point_cell` unique index makes
 * that state unrepresentable within a set, so on `centroid_set_v1` — nineteen
 * points, all resolving to distinct cells as measured against `ecmwf_ifs` on
 * 2026-08-28 — the two agree row for row. `database-features.test.ts` asserts
 * that agreement against `computeCapacityWeights` rather than assuming it.
 *
 * The set version is a **literal**, exactly as `br_calendar_v1` is a literal in
 * the calendar block: "whichever set happens to be loaded" is the silent
 * restatement this design exists to prevent. Moving to `centroid_set_v2` is an
 * edit to this file, a migration and a retrain — visible in a diff, which is
 * the point. `ingest/weather/centroids.ts` holds the same string and
 * `features-gate.test.ts` asserts the two agree.
 */
export const canonicalCapacityWeight = pgView("canonical_capacity_weight", {
  /** The frozen geometry these weights are attached to. Weights outlive no set. */
  setVersion: text().notNull(),
  subsystem: subsystemCode().notNull(),
  technology: technology().notNull(),
  /** A point of the set — `W1`, `S5`. The business key of every weather row. */
  centroidId: text().notNull(),
  /** Share of the scope's **located** capacity. A scope's weights sum to 1. */
  weight: doublePrecision().notNull(),
  /** Placed MW behind that share — the located mass plus its pro-rata share. */
  capacityMw: doublePrecision().notNull(),
  /** Capacity-weighted mean plant-to-centroid distance, km. The drift metric. */
  distanceKm: doublePrecision().notNull(),
  /** `InstalledCapacityAsOf(subsystem, technology, fleet_date)` — placed or not. */
  scopeCapacityMw: doublePrecision().notNull(),
  /** The denominator `capacity_mw` is a share of. Never more than the scope's. */
  scopePlacedMw: doublePrecision().notNull(),
}).as(sql`
  with fleet as (
    select subsystem, technology, installed_capacity_mw, latitude, longitude
    from canonical_plant_registry
    where installed_capacity_mw > 0
  ),
  scope_totals as (
    select
      subsystem,
      technology,
      sum(installed_capacity_mw) as scope_capacity_mw,
      coalesce(sum(installed_capacity_mw)
                 filter (where latitude is not null), 0) as located_mw,
      coalesce(sum(installed_capacity_mw)
                 filter (where latitude is null), 0) as unlocated_mw
    from fleet
    group by subsystem, technology
  ),
  assigned as (
    select
      fleet.subsystem,
      fleet.technology,
      fleet.installed_capacity_mw,
      nearest.centroid_id,
      nearest.distance_km
    from fleet
    cross join lateral (
      select
        c.centroid_id,
        great_circle_km(fleet.latitude, fleet.longitude,
                        c.latitude, c.longitude) as distance_km
      from centroid_point c
      where c.set_version = 'centroid_set_v1'
        and c.technology = fleet.technology
      order by distance_km
      limit 1
    ) nearest
    where fleet.latitude is not null and fleet.longitude is not null
  ),
  by_centroid as (
    select
      subsystem,
      technology,
      centroid_id,
      sum(installed_capacity_mw) as centroid_mw,
      sum(distance_km * installed_capacity_mw) as distance_mw_km
    from assigned
    group by subsystem, technology, centroid_id
  )
  select
    'centroid_set_v1' as set_version,
    by_centroid.subsystem,
    by_centroid.technology,
    by_centroid.centroid_id,
    by_centroid.centroid_mw / scope_totals.located_mw as weight,
    (by_centroid.centroid_mw / scope_totals.located_mw)
      * (scope_totals.located_mw + scope_totals.unlocated_mw) as capacity_mw,
    by_centroid.distance_mw_km / by_centroid.centroid_mw as distance_km,
    scope_totals.scope_capacity_mw,
    scope_totals.located_mw + scope_totals.unlocated_mw as scope_placed_mw
  from by_centroid
  join scope_totals
    on scope_totals.subsystem = by_centroid.subsystem
   and scope_totals.technology = by_centroid.technology
  where scope_totals.located_mw > 0
`);

// ---------------------------------------------------------------------------
// The published forecast, as canonical reads — forecaster ticket 14.
//
// Two views rather than one, because a day-grain figure is not an aggregate of
// the hourly one and a single view would have to invent the join that makes it
// look like one. `docs/specs/replay.md` forbids exactly that arithmetic, and
// the shape of this layer is where the prohibition is cheapest to hold.
// ---------------------------------------------------------------------------

/**
 * `AsOf(t)` over the published hourly forecast.
 *
 * The `DISTINCT ON` key is the whole business key —
 * (`subsystem`, `valid_time`, `origin_kind`, `gate_profile`) — which is what
 * makes the two things it separates separable:
 *
 * - a **record** and a **reconstruction** of the same hour coexist, and
 *   `/v1/forecast/day-ahead` filters `origin_kind = 'served'` in its query. A
 *   view that collapsed them would make a `backfilled_holdout` row reachable
 *   from the day-ahead route whenever it happened to be the newer vintage,
 *   which is precisely the leak `replay.md` seam 6 tests for.
 * - the **early and the late gate** are two forecasts of one day, not two
 *   versions of one forecast, so a re-publication supersedes only within its
 *   own gate.
 *
 * There is no `published_at_or_before` axis here, and its absence is deliberate.
 * That axis exists for *upstream* forecasts — DESSEM, the weather run — where
 * the question is "what had been published by the gate the features were cut
 * against". These rows **are** the publication: their `published_at` is the
 * gate, and cutting them on a gate would be asking whether our own forecast had
 * been published before it was published.
 */
export const canonicalForecastHour = pgView("canonical_forecast_hour", {
  subsystem: subsystemCode().notNull(),
  /** Start of the hour the forecast is about, UTC. */
  validTime: timestamp({ withTimezone: true }).notNull(),
  /** `served` or `backfilled_holdout` — a record, or a reconstruction. */
  originKind: forecastOriginKind().notNull(),
  gateProfile: forecastGateProfile().notNull(),
  /** The civil day in `America/Sao_Paulo` the hour belongs to. */
  targetDate: date({ mode: "string" }).notNull(),
  localHour: integer().notNull(),
  forecastProducer: forecastProducer().notNull(),
  /** `ForecastOrigin.run_label` — the artifact id. */
  runLabel: text().notNull(),
  featureSet: text().notNull(),
  /** Which correction regime composed this band. See the table's own note. */
  correctionRegime: text().notNull(),
  thresholdMw: doublePrecision().notNull(),
  occurrenceProbability: doublePrecision().notNull(),
  p10Mwh: doublePrecision().notNull(),
  p50Mwh: doublePrecision().notNull(),
  p90Mwh: doublePrecision().notNull(),
  /** A sibling of the band, never inside it. */
  expectedMwh: doublePrecision().notNull(),
  p50WindMwh: doublePrecision().notNull(),
  p50SolarMwh: doublePrecision().notNull(),
  expectedWindMwh: doublePrecision().notNull(),
  expectedSolarMwh: doublePrecision().notNull(),
  crossed: boolean().notNull(),
  ...rowVintage,
}).as(sql`
  select distinct on (subsystem, valid_time, origin_kind, gate_profile)
    subsystem,
    valid_time,
    origin_kind,
    gate_profile,
    target_date,
    local_hour,
    forecast_producer,
    run_label,
    feature_set,
    correction_regime,
    threshold_mw,
    occurrence_probability,
    p10_mwh,
    p50_mwh,
    p90_mwh,
    expected_mwh,
    p50_wind_mwh,
    p50_solar_mwh,
    expected_wind_mwh,
    expected_solar_mwh,
    crossed,
    data_version,
    published_at,
    ingested_at
  from curtailment_forecast_hour
  where ingested_at <= canonical_as_of()
  order by subsystem, valid_time, origin_kind, gate_profile,
           ingested_at desc, data_version desc
`);

/**
 * `AsOf(t)` over the day-grain companion row.
 *
 * The read `replay.md` needs so that a day total is a **query** rather than
 * either a re-run of the ensemble or a sum of twenty-four quantiles. Nothing in
 * this view aggregates the hourly one: it selects a stored row, and the only
 * relation between the two is that they were written by one publication.
 *
 * `derivation` is projected rather than filtered on, so a reader can see what
 * produced the figure instead of trusting that this view only ever returns one
 * kind. The table's check constraint is what makes it always `path_ensemble`.
 */
export const canonicalForecastDay = pgView("canonical_forecast_day", {
  subsystem: subsystemCode().notNull(),
  /** The civil day in `America/Sao_Paulo` being forecast. */
  targetDate: date({ mode: "string" }).notNull(),
  originKind: forecastOriginKind().notNull(),
  gateProfile: forecastGateProfile().notNull(),
  forecastProducer: forecastProducer().notNull(),
  runLabel: text().notNull(),
  featureSet: text().notNull(),
  correctionRegime: text().notNull(),
  thresholdMw: doublePrecision().notNull(),
  /** Quantiles of the drawn day totals. Never a sum of the hourly band. */
  dayTotalP10Mwh: doublePrecision().notNull(),
  dayTotalP50Mwh: doublePrecision().notNull(),
  dayTotalP90Mwh: doublePrecision().notNull(),
  peakPowerP10Mw: doublePrecision().notNull(),
  peakPowerP50Mw: doublePrecision().notNull(),
  peakPowerP90Mw: doublePrecision().notNull(),
  dayOccurrenceProbability: doublePrecision().notNull(),
  expectedMwh: doublePrecision().notNull(),
  expectedWindMwh: doublePrecision().notNull(),
  expectedSolarMwh: doublePrecision().notNull(),
  hoursP50Nonzero: integer().notNull(),
  /** `path_ensemble`, stored so a reader can check it rather than assume it. */
  derivation: text().notNull(),
  ensembleDraws: integer().notNull(),
  ensembleSeed: integer().notNull(),
  ensembleCalibrationDays: integer().notNull(),
  trainedThrough: date({ mode: "string" }).notNull(),
  riskBinElevatedFrom: doublePrecision().notNull(),
  riskBinHighFrom: doublePrecision().notNull(),
  ...rowVintage,
}).as(sql`
  select distinct on (subsystem, target_date, origin_kind, gate_profile)
    subsystem,
    target_date,
    origin_kind,
    gate_profile,
    forecast_producer,
    run_label,
    feature_set,
    correction_regime,
    threshold_mw,
    day_total_p10_mwh,
    day_total_p50_mwh,
    day_total_p90_mwh,
    peak_power_p10_mw,
    peak_power_p50_mw,
    peak_power_p90_mw,
    day_occurrence_probability,
    expected_mwh,
    expected_wind_mwh,
    expected_solar_mwh,
    hours_p50_nonzero,
    derivation,
    ensemble_draws,
    ensemble_seed,
    ensemble_calibration_days,
    trained_through,
    risk_bin_elevated_from,
    risk_bin_high_from,
    data_version,
    published_at,
    ingested_at
  from curtailment_forecast_day
  where ingested_at <= canonical_as_of()
  order by subsystem, target_date, origin_kind, gate_profile,
           ingested_at desc, data_version desc
`);

/**
 * `AsOf(t)` over the national day grain — forecaster ticket 22.
 *
 * The `DISTINCT ON` key is the whole business key, and it carries
 * `threshold_mw` where `canonical_forecast_day`'s does not: a national total
 * above 5 MW and one above 20 MW are two quantities, not two beliefs about one.
 * Supersession still happens *within* a key, where a re-publication is a new
 * `data_version`.
 *
 * There is no `subsystem` column and no aggregate here. This view returns the
 * row the modelling service wrote and nothing reduced from four others; the
 * `subsystems` array is projected so a reader can check the figure covered the
 * whole grid rather than trust that it did.
 */
export const canonicalForecastNationalDay = pgView("canonical_forecast_national_day", {
  /** The civil day in `America/Sao_Paulo` being forecast. */
  targetDate: date({ mode: "string" }).notNull(),
  originKind: forecastOriginKind().notNull(),
  gateProfile: forecastGateProfile().notNull(),
  thresholdMw: doublePrecision().notNull(),
  forecastProducer: forecastProducer().notNull(),
  runLabel: text().notNull(),
  featureSet: text().notNull(),
  correctionRegime: text().notNull(),
  /** The four this was summed over. `SIN` is not spellable in this array. */
  subsystems: subsystemCode("subsystems").array().notNull(),
  /** Quantiles of the four subsystems' day totals added draw by draw. */
  dayTotalP10Mwh: doublePrecision().notNull(),
  dayTotalP50Mwh: doublePrecision().notNull(),
  dayTotalP90Mwh: doublePrecision().notNull(),
  /** Peak of the sum, never a sum of peaks. */
  peakPowerP10Mw: doublePrecision().notNull(),
  peakPowerP50Mw: doublePrecision().notNull(),
  peakPowerP90Mw: doublePrecision().notNull(),
  dayOccurrenceProbability: doublePrecision().notNull(),
  /** `Σ_s E[Y_s]` — the one national quantity that adds exactly. */
  expectedMwh: doublePrecision().notNull(),
  /** `joint_path_ensemble`, projected so a reader checks it rather than assumes. */
  derivation: text().notNull(),
  ensembleDraws: integer().notNull(),
  ensembleSeed: integer().notNull(),
  ensembleCalibrationDays: integer().notNull(),
  trainedThrough: date({ mode: "string" }).notNull(),
  riskBinElevatedFrom: doublePrecision().notNull(),
  riskBinHighFrom: doublePrecision().notNull(),
  ...rowVintage,
}).as(sql`
  select distinct on (target_date, origin_kind, gate_profile, threshold_mw)
    target_date,
    origin_kind,
    gate_profile,
    threshold_mw,
    forecast_producer,
    run_label,
    feature_set,
    correction_regime,
    subsystems,
    day_total_p10_mwh,
    day_total_p50_mwh,
    day_total_p90_mwh,
    peak_power_p10_mw,
    peak_power_p50_mw,
    peak_power_p90_mw,
    day_occurrence_probability,
    expected_mwh,
    derivation,
    ensemble_draws,
    ensemble_seed,
    ensemble_calibration_days,
    trained_through,
    risk_bin_elevated_from,
    risk_bin_high_from,
    data_version,
    published_at,
    ingested_at
  from curtailment_forecast_national_day
  where ingested_at <= canonical_as_of()
  order by target_date, origin_kind, gate_profile, threshold_mw,
           ingested_at desc, data_version desc
`);

// ---------------------------------------------------------------------------
// The published attribution, as canonical reads — diagnosis ticket 06.
//
// Two views, parent and children, and the second is defined *through* the
// first. A driver row is only meaningful as part of the vintage it was written
// with, so selecting drivers independently — by their own newest `ingested_at`
// — could return the day's eight from one publication and the peak hour's from
// another. Joining onto the parent view makes "the drivers you read are the
// drivers of the attribution you read" a property of the SQL.
// ---------------------------------------------------------------------------

/**
 * `AsOf(t)` over the published attribution.
 *
 * The `DISTINCT ON` key is the whole business key —
 * (`subsystem`, `target_date`, `origin_kind`, `gate_profile`) — for the reason
 * `canonical_forecast_day`'s is: a record and a reconstruction of the same day
 * coexist, and the early and the late gate are two explanations of one day
 * rather than two versions of one explanation. Supersession happens *within* a
 * gate, where a re-publication is a new `data_version`.
 *
 * `driver_group_hash` and `background_source` are projected rather than
 * filtered on. A reader is meant to *see* which grouping ranked these bars and
 * which background defined their "typical", and a view that quietly returned
 * only rows agreeing with today's map would answer "what did we say at D−1"
 * with silence on exactly the days the question is interesting.
 */
export const canonicalDiagnosisAttribution = pgView("canonical_diagnosis_attribution", {
  subsystem: subsystemCode().notNull(),
  /** The civil day in `America/Sao_Paulo` that was explained. */
  targetDate: date({ mode: "string" }).notNull(),
  /** `served` or `backfilled_holdout` — a record, or a reconstruction. */
  originKind: forecastOriginKind().notNull(),
  gateProfile: forecastGateProfile().notNull(),
  forecastProducer: forecastProducer().notNull(),
  /** `ForecastOrigin.run_label` — the artifact that produced the numbers. */
  runLabel: text().notNull(),
  featureSet: text().notNull(),
  correctionRegime: text().notNull(),
  thresholdMw: doublePrecision().notNull(),
  /** `expected_mwh_day` — what the eight bars decompose. */
  target: text().notNull(),
  explains: text().notNull(),
  hoursAttributed: integer().notNull(),
  baselineExpectedMwh: doublePrecision().notNull(),
  dayExpectedMwh: doublePrecision().notNull(),
  totalAttributedMwh: doublePrecision().notNull(),
  sumAbsAttributedMwh: doublePrecision().notNull(),
  localAccuracyResidualMwh: doublePrecision().notNull(),
  topTwoShare: doublePrecision().notNull(),
  attributionStderrMwh: doublePrecision().notNull(),
  baselineStderrMwh: doublePrecision().notNull(),
  stderrResamples: integer().notNull(),
  stderrSeed: integer().notNull(),
  peakHourLocal: integer().notNull(),
  peakHourExpectedMwh: doublePrecision().notNull(),
  peakHourBaselineExpectedMwh: doublePrecision().notNull(),
  /** The vocabulary the bars were ranked under, so a change is visible. */
  driverGroupVersion: text().notNull(),
  driverGroupHash: text().notNull(),
  /** Which matched background defined "typical", and how it was drawn. */
  backgroundSource: text().notNull(),
  backgroundSeed: integer().notNull(),
  backgroundRows: integer().notNull(),
  coalitions: integer().notNull(),
  /** Every rule that fired, with the inputs that fired it. */
  ruleFlags: jsonb().notNull(),
  /**
   * Every rule the engine evaluated, fired or not — so `rule_flags: []` reads
   * as "four rules looked and none fired" rather than as "nobody asked".
   */
  rulesEvaluated: text().array().notNull(),
  /** The strictest action any of them took, or null when none fired. */
  governingRuleAction: diagnosisRuleAction(),
  ...rowVintage,
}).as(sql`
  select distinct on (subsystem, target_date, origin_kind, gate_profile)
    subsystem,
    target_date,
    origin_kind,
    gate_profile,
    forecast_producer,
    run_label,
    feature_set,
    correction_regime,
    threshold_mw,
    target,
    explains,
    hours_attributed,
    baseline_expected_mwh,
    day_expected_mwh,
    total_attributed_mwh,
    sum_abs_attributed_mwh,
    local_accuracy_residual_mwh,
    top_two_share,
    attribution_stderr_mwh,
    baseline_stderr_mwh,
    stderr_resamples,
    stderr_seed,
    peak_hour_local,
    peak_hour_expected_mwh,
    peak_hour_baseline_expected_mwh,
    driver_group_version,
    driver_group_hash,
    background_source,
    background_seed,
    background_rows,
    coalitions,
    rule_flags,
    rules_evaluated,
    governing_rule_action,
    data_version,
    published_at,
    ingested_at
  from diagnosis_attribution
  where ingested_at <= canonical_as_of()
  order by subsystem, target_date, origin_kind, gate_profile,
           ingested_at desc, data_version desc
`);

/**
 * `AsOf(t)` over the eight contributions — both rankings, ranked.
 *
 * **All eight groups, always.** The `share ≥ 0.03` cut and the merge into one
 * `other` row are the client's, applied to identical wire numbers on both
 * sides; a view that applied the cut would be publishing shares whose
 * denominator no longer exists. `demoted` travels as a flag beside a full
 * contribution for the same reason: a `demote` rule moves a bar below the fold
 * and never removes it, and a row that is missing cannot be shown to be intact.
 */
export const canonicalDiagnosisDriver = pgView("canonical_diagnosis_driver", {
  subsystem: subsystemCode().notNull(),
  targetDate: date({ mode: "string" }).notNull(),
  originKind: forecastOriginKind().notNull(),
  gateProfile: forecastGateProfile().notNull(),
  dataVersion: integer().notNull(),
  /** The day's ranking, or the peak hour's. */
  grain: diagnosisAttributionGrain().notNull(),
  driverGroup: text().notNull(),
  labelCode: text().notNull(),
  rank: integer().notNull(),
  phiMwh: doublePrecision().notNull(),
  /** A share of all eight groups, never of the displayed rows. */
  share: doublePrecision().notNull(),
  direction: diagnosisDriverDirection().notNull(),
  /** Day rows only — one hour has nothing to disagree with. */
  hourDisagreement: doublePrecision(),
  headlineFeature: text().notNull(),
  /** The reading, or NULL with its reason beside it. Never NULL alone. */
  observed: doublePrecision(),
  typical: doublePrecision(),
  observedAbsentReason: text(),
  typicalAbsentReason: text(),
  unit: text().notNull(),
  demoted: boolean().notNull(),
}).as(sql`
  select
    d.subsystem,
    d.target_date,
    d.origin_kind,
    d.gate_profile,
    d.data_version,
    d.grain,
    d.driver_group,
    d.label_code,
    d.rank,
    d.phi_mwh,
    d.share,
    d.direction,
    d.hour_disagreement,
    d.headline_feature,
    d.observed,
    d.typical,
    d.observed_absent_reason,
    d.typical_absent_reason,
    d.unit,
    d.demoted
  from diagnosis_attribution_driver d
  join canonical_diagnosis_attribution a
    on a.subsystem = d.subsystem
   and a.target_date = d.target_date
   and a.origin_kind = d.origin_kind
   and a.gate_profile = d.gate_profile
   and a.data_version = d.data_version
`);

/**
 * The most recent hour ONS has settled in **every** subsystem.
 *
 * A canonical read of its own, because it is a question the product asks and
 * the fact view could not answer cheaply. `GET /v1/grid/now` used to assemble
 * it by grouping the whole of {@link canonicalCurtailmentByReportingEntity} by
 * `valid_time` and taking the newest group carrying four subsystems — the right
 * question, asked in the one way that forces a sort of the entire table: that
 * view's `DISTINCT ON` ordering has no index behind it, so the deduplication
 * had to complete before the grouping could start.
 *
 * Measured on a reproduction at 864,000 rows: **1,026 ms**, a sequential scan
 * and an `external merge` sort spilling 42 MB. Deployed, Railway's proxy log put
 * the endpoint at **8.4–9.7 s** whenever the 60-second CDN cache missed — and it
 * is the first call the Overview makes, so that was the wait before any panel
 * could render. This view answers the same question in **1.3 ms** on the same
 * data, by reading `curtailment_report_hour_time` backwards and stopping at the
 * first qualifying hour: 751 rows read instead of 864,000. It needed no new
 * index and changes no stored value.
 *
 * **Skipping the deduplication is sound, and the argument is short.**
 * `DISTINCT ON` picks one row per business key and never drops a key, so the
 * set of (`valid_time`, `subsystem`) pairs is identical either side of it and a
 * `count(distinct subsystem)` per hour cannot differ. `0051`'s migration note
 * records the cases that argument was checked against — superseding versions,
 * out-of-order ingests, a newest hour with only two subsystems, and three
 * `as_of` cuts including one before any ingest.
 *
 * **It is the canonical layer, not a way around it.** The rule that a product
 * read never touches an ingest table is intact: `canonical_as_of()` applies
 * here exactly as it does in every sibling above, and `contract/grid-now.ts`
 * selects from this view by name. The change is that the canonical layer now
 * publishes the read the product needed, rather than the product building it
 * out of a view shaped for a different question.
 */
export const canonicalLatestCompleteSettledHour = pgView(
  "canonical_latest_complete_settled_hour",
  {
    /** Start of the hour, UTC. `null` when nothing has settled at all. */
    validTime: timestamp({ withTimezone: true }).notNull(),
  },
).as(sql`
  select c.valid_time
  from curtailment_report_hour c
  join reporting_entity e on e.ons_code = c.reporting_entity_code
  where c.ingested_at <= canonical_as_of()
  group by c.valid_time
  having count(distinct e.subsystem)
       = (select count(*) from unnest(enum_range(null::subsystem_code)))
  order by c.valid_time desc
  limit 1
`);

/**
 * Every canonical view this build selects from, by its SQL name.
 *
 * **Derived from the module, not listed beside it.** A hand-written list is a
 * second statement of which views exist, and the failure it would produce is
 * the one this function is for: a view added to the schema, forgotten here, and
 * therefore never checked. Reading the exports means a new `pgView` is covered
 * on the line it is declared.
 *
 * Drizzle keeps the SQL name on `Symbol(drizzle:ViewBaseConfig)`; the symbol is
 * looked up by description rather than imported, because the exported symbol
 * lives in a `drizzle-orm` subpath this package does not otherwise depend on
 * and a name is all that is wanted from it.
 */
export function canonicalViewNames(): readonly string[] {
  const names: string[] = [];
  for (const exported of Object.values(canonicalViewModule as Record<string, unknown>)) {
    if (typeof exported !== "object" || exported === null) {
      continue;
    }
    for (const symbol of Object.getOwnPropertySymbols(exported)) {
      if (symbol.description !== "drizzle:ViewBaseConfig") {
        continue;
      }
      const config = (exported as Record<symbol, unknown>)[symbol];
      if (
        typeof config === "object" &&
        config !== null &&
        typeof (config as { name?: unknown }).name === "string"
      ) {
        names.push((config as { name: string }).name);
      }
    }
  }
  return names.sort();
}

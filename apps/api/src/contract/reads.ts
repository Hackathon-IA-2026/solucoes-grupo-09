import { sql } from "drizzle-orm";
import {
  canonicalConjuntoMembership,
  canonicalCurtailmentByPlant,
  canonicalCurtailmentByReportingEntity,
  canonicalDayAheadBalance,
  canonicalInstalledCapacity,
  canonicalSystemContext,
  canonicalSystemExchange,
  canonicalWeatherForecast,
} from "../database/canonical-views.js";
import type { Database } from "../database/connection.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import type { ReasonCode, RestrictionOrigin, Technology } from "../ingest/types.js";
import type { CanonicalReadName } from "./manifest.js";
import { readOnly } from "./read-only.js";
import { applyAxes, type ReadAxes, readGoLive } from "./scope.js";
import type {
  CanonicalReadResult,
  ConjuntoMembershipAtDate,
  CurtailmentObservation,
  DayAheadBalanceForecast,
  InstalledCapacityScope,
  PlantMeasurement,
  ReportingEntityKind,
  SystemContextObservation,
  SystemExchangeObservation,
  VintageReceipt,
  WeatherForecastAtCentroid,
} from "./types.js";
import {
  combineFidelity,
  combineGoLive,
  type VintageSource,
  vintageFidelity,
} from "./vintage.js";

/**
 * The canonical reads themselves — a thin caller over the canonical views.
 *
 * **These select; they do not shape.** Every read here is one `select` from one
 * view in `src/database/canonical-views.ts`, plus the window predicate the
 * caller asked for. There is no `distinct on` in this file and no base table
 * name, deliberately: the `AsOf` pick, the renames, the grain, the unit and
 * timestamp resolution and the vintage columns all live in the view, which is
 * the only definition of them and the one `apps/ml` reads too.
 *
 * That is ticket 016's whole change of shape. Ticket 013's version of this file
 * composed the ingest repositories and renamed their fields on the way past,
 * which was right as far as TypeScript goes and unusable from Python: a
 * TypeScript module composing TypeScript functions is not a contract a second
 * language can hold, so the contract had to be re-served over HTTP to reach the
 * modelling side. Moving the definition into SQL is what lets "the ML service
 * reads Postgres directly" and "there is exactly one definition of a canonical
 * read" both be true. The compensating renames are gone with it — the two
 * drifted field names are corrected in the schema now, not at this edge.
 *
 * What this layer still adds is three things:
 *
 * 1. **The typed row.** Snake-cased view columns become the domain shapes in
 *    `types.ts`, and the two value objects the database stores as loose columns
 *    — `RestrictionCause` and `ResourceMeasurementValue` — are put back together
 *    as wholes, because a reason without its origin is an illegal state rather
 *    than a partial one.
 * 2. **The vintage receipt.** Every answer carries its `VintageFidelity`, its
 *    go-live and the sources that decided them. The fidelity rule stays a pure
 *    function here and in Python — `vintage.ts` says why it is the one thing
 *    deliberately not pushed into SQL.
 * 3. **The read-only boundary**, one snapshot per answer, and the read axes
 *    (`read-only.ts`, `scope.ts`).
 *
 * Each read is written twice over: a `*Within` function that takes an open
 * read-only transaction with its axes already applied, and the exported wrapper
 * that opens one. The split exists so `readTrainingWindow` can compose several
 * reads inside a **single** snapshot; `SET TRANSACTION` cannot be reissued in a
 * nested one, so a bundle built by calling the public reads would either fail or
 * silently span an ingest commit.
 */

/** The two axes every fact read takes. */
export interface FactReadQuery {
  /** Vintage axis: what WattSteer had learned by this instant. */
  asOf: Date;
  /** Valid-time window, `[from, to)`. */
  from: Date;
  to: Date;
}

/** The two axes every registry read takes. */
export interface RegistryReadQuery {
  /** Vintage axis: what WattSteer had learned by this instant. */
  asOf: Date;
  /** Fleet date: which units existed, which conjunto applied, on this day. */
  on: Date;
}

// ---------------------------------------------------------------------------
// The vintage receipt
// ---------------------------------------------------------------------------

/** One source's contribution, with the fidelity rule applied on the axis it uses. */
const sourceOf = (
  read: CanonicalReadName,
  fidelityAxisInstant: Date,
  goLiveAt: Date | null,
): VintageSource => ({
  read,
  vintageFidelity: vintageFidelity(fidelityAxisInstant, goLiveAt),
  goLiveAt,
});

/** Build the receipt for a fact read composed of one or more sources. */
function factReceipt(query: FactReadQuery, sources: VintageSource[]): VintageReceipt {
  return {
    asOf: query.asOf,
    window: { from: query.from, to: query.to },
    fleetDate: null,
    vintageFidelity: combineFidelity(sources),
    goLiveAt: combineGoLive(sources),
    sources,
  };
}

/** Build the receipt for a registry read. */
function registryReceipt(
  query: RegistryReadQuery,
  sources: VintageSource[],
): VintageReceipt {
  return {
    asOf: query.asOf,
    window: null,
    fleetDate: query.on,
    vintageFidelity: combineFidelity(sources),
    goLiveAt: combineGoLive(sources),
    sources,
  };
}

/** The half-open valid-time window every fact view is filtered by. */
const windowFilter = (query: FactReadQuery) =>
  sql`valid_time >= ${query.from.toISOString()}::timestamptz
      and valid_time < ${query.to.toISOString()}::timestamptz`;

const number = (value: number | string | null): number | null =>
  value === null ? null : Number(value);

// ---------------------------------------------------------------------------
// Curtailment
// ---------------------------------------------------------------------------

export interface CurtailmentReadQuery extends FactReadQuery {
  technology?: Technology;
  /** A `CJU_*` conjunto code or a self-reporting plant's ONS code. */
  reportingEntityCode?: string;
  /**
   * The entity's electrical subsystem.
   *
   * A filter on a column the view projects from its `reporting_entity` join,
   * applied outside the version pick like every other caller filter — the
   * subsystem of an entity is constant across its versions, so inside and
   * outside are the same question (`docs/contracts/canonical-reads.md`).
   */
  subsystem?: SubsystemCode;
}

async function curtailmentWithin(
  tx: Database,
  query: CurtailmentReadQuery,
): Promise<CanonicalReadResult<CurtailmentObservation>> {
  const technologyFilter = query.technology
    ? sql`and technology = ${query.technology}`
    : sql``;
  const entityFilter = query.reportingEntityCode
    ? sql`and reporting_entity_code = ${query.reportingEntityCode}`
    : sql``;
  const subsystemFilter = query.subsystem
    ? sql`and subsystem = ${query.subsystem}`
    : sql``;

  const rows = await tx.execute<{
    reporting_entity_code: string;
    reporting_entity_kind: ReportingEntityKind;
    subsystem: SubsystemCode;
    technology: Technology;
    valid_time: string;
    constrained_off_mwh: number;
    verified_generation_mwh: number;
    reference_generation_mwh: number | null;
    final_reference_generation_mwh: number | null;
    available_capacity_mw: number | null;
    half_hours_observed: number;
    restriction_reason: ReasonCode | null;
    restriction_origin: RestrictionOrigin | null;
    restriction_description: string | null;
    restriction_cause_mixed: boolean;
    data_version: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select * from ${canonicalCurtailmentByReportingEntity}
    where ${windowFilter(query)}
      ${technologyFilter}
      ${entityFilter}
      ${subsystemFilter}
    order by reporting_entity_code, technology, valid_time
  `);

  return {
    read: "curtailment-by-reporting-entity",
    kind: "observation",
    rows: [...rows].map((row) => ({
      reportingEntityCode: row.reporting_entity_code,
      // Ticket 016's third drift correction: the grain of the row, on the row.
      // Without it a consumer could not tell a conjunto from a self-reporting
      // plant without a second call, which is the first thing a screen showing
      // a restriction cause has to say.
      reportingEntityKind: row.reporting_entity_kind,
      // Ticket 18's residual: the view has carried this since
      // feature-engineering 01 and neither language could see it. The label is
      // defined at subsystem grain, so a consumer that cannot read it here has
      // to go back to the registry for the grain of the row it is holding.
      subsystem: row.subsystem,
      technology: row.technology,
      validTime: new Date(row.valid_time),
      constrainedOffMwh: Number(row.constrained_off_mwh),
      verifiedGenerationMwh: Number(row.verified_generation_mwh),
      referenceGenerationMwh: number(row.reference_generation_mwh),
      finalReferenceGenerationMwh: number(row.final_reference_generation_mwh),
      availableCapacityMw: number(row.available_capacity_mw),
      halfHoursObserved: row.half_hours_observed,
      // Reconstructed as the value object it is: all three or none.
      restrictionCause:
        row.restriction_reason === null || row.restriction_origin === null
          ? null
          : {
              reason: row.restriction_reason,
              origin: row.restriction_origin,
              description: row.restriction_description,
            },
      restrictionCauseMixed: row.restriction_cause_mixed,
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintage: factReceipt(query, [
      sourceOf(
        "curtailment-by-reporting-entity",
        query.from,
        await readGoLive(tx, "curtailment-by-reporting-entity"),
      ),
    ]),
  };
}

/**
 * Constrained-off as settled, at `ReportingEntity` grain.
 *
 * The only read in the contract whose rows carry a `restrictionCause`.
 */
export async function readCurtailment(
  db: Database,
  query: CurtailmentReadQuery,
): Promise<CanonicalReadResult<CurtailmentObservation>> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, axesOf(query));
    return curtailmentWithin(tx, query);
  });
}

export interface PlantMeasurementReadQuery extends FactReadQuery {
  technology?: Technology;
  plantOnsCode?: string;
}

async function plantMeasurementsWithin(
  tx: Database,
  query: PlantMeasurementReadQuery,
): Promise<CanonicalReadResult<PlantMeasurement>> {
  const technologyFilter = query.technology
    ? sql`and technology = ${query.technology}`
    : sql``;
  const plantFilter = query.plantOnsCode
    ? sql`and plant_ons_code = ${query.plantOnsCode}`
    : sql``;

  const rows = await tx.execute<{
    plant_ons_code: string;
    technology: Technology;
    valid_time: string;
    estimated_generation_mwh: number | null;
    verified_generation_mwh: number | null;
    measured_quantity: "wind_speed_ms" | "irradiance_wm2";
    measurement_value: number | null;
    measurement_invalid: boolean | null;
    half_hours_observed: number;
    data_version: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select * from ${canonicalCurtailmentByPlant}
    where ${windowFilter(query)}
      ${technologyFilter}
      ${plantFilter}
    order by plant_ons_code, technology, valid_time
  `);

  return {
    read: "curtailment-by-plant",
    kind: "observation",
    rows: [...rows].map((row) => ({
      plantOnsCode: row.plant_ons_code,
      technology: row.technology,
      validTime: new Date(row.valid_time),
      estimatedGenerationMwh: number(row.estimated_generation_mwh),
      verifiedGenerationMwh: number(row.verified_generation_mwh),
      // Reading and flag, or neither: a reading whose validity is unknown is
      // not a reading. Which quantity it is comes from the view rather than
      // being re-derived from the technology here.
      measurement:
        row.measurement_value === null || row.measurement_invalid === null
          ? null
          : {
              quantity: row.measured_quantity,
              value: Number(row.measurement_value),
              invalid: row.measurement_invalid,
            },
      halfHoursObserved: row.half_hours_observed,
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintage: factReceipt(query, [
      sourceOf(
        "curtailment-by-plant",
        query.from,
        await readGoLive(tx, "curtailment-by-plant"),
      ),
    ]),
  };
}

/**
 * Per-plant generation and measured resource, at `Plant` grain.
 *
 * There is no cause parameter and no cause field. See `PlantMeasurement`.
 */
export async function readPlantMeasurements(
  db: Database,
  query: PlantMeasurementReadQuery,
): Promise<CanonicalReadResult<PlantMeasurement>> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, axesOf(query));
    return plantMeasurementsWithin(tx, query);
  });
}

// ---------------------------------------------------------------------------
// System context
// ---------------------------------------------------------------------------

export interface SystemContextReadQuery extends FactReadQuery {
  subsystem?: SubsystemCode;
}

async function systemContextWithin(
  tx: Database,
  query: SystemContextReadQuery,
): Promise<CanonicalReadResult<SystemContextObservation>> {
  const subsystemFilter = query.subsystem
    ? sql`and subsystem = ${query.subsystem}`
    : sql``;

  const rows = await tx.execute<{
    subsystem: SubsystemCode;
    valid_time: string;
    load_mwh: number;
    wind_generation_mwh: number;
    solar_generation_mwh: number;
    hydro_generation_mwh: number;
    thermal_generation_mwh: number;
    net_exchange_mwh: number;
    data_version: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select * from ${canonicalSystemContext}
    where ${windowFilter(query)}
      ${subsystemFilter}
    order by subsystem, valid_time
  `);

  return {
    read: "system-context",
    kind: "observation",
    rows: [...rows].map((row) => ({
      subsystem: row.subsystem,
      validTime: new Date(row.valid_time),
      loadMwh: Number(row.load_mwh),
      windGenerationMwh: Number(row.wind_generation_mwh),
      solarGenerationMwh: Number(row.solar_generation_mwh),
      hydroGenerationMwh: Number(row.hydro_generation_mwh),
      thermalGenerationMwh: Number(row.thermal_generation_mwh),
      netExchangeMwh: Number(row.net_exchange_mwh),
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintage: factReceipt(query, [
      sourceOf("system-context", query.from, await readGoLive(tx, "system-context")),
    ]),
  };
}

/** Load and generation by technology per subsystem-hour, with net exchange. */
export async function readSystemContext(
  db: Database,
  query: SystemContextReadQuery,
): Promise<CanonicalReadResult<SystemContextObservation>> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, axesOf(query));
    return systemContextWithin(tx, query);
  });
}

async function systemExchangeWithin(
  tx: Database,
  query: SystemContextReadQuery,
): Promise<CanonicalReadResult<SystemExchangeObservation>> {
  // Either end of the link — orientation is canonical, so this is not a pair.
  const linkFilter = query.subsystem
    ? sql`and (from_subsystem = ${query.subsystem} or to_subsystem = ${query.subsystem})`
    : sql``;

  const rows = await tx.execute<{
    from_subsystem: SubsystemCode;
    to_subsystem: SubsystemCode;
    valid_time: string;
    verified_exchange_mwh: number;
    programmed_exchange_mwh: number | null;
    data_version: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select * from ${canonicalSystemExchange}
    where ${windowFilter(query)}
      ${linkFilter}
    order by from_subsystem, to_subsystem, valid_time
  `);

  return {
    read: "system-exchange",
    kind: "observation",
    rows: [...rows].map((row) => ({
      fromSubsystem: row.from_subsystem,
      toSubsystem: row.to_subsystem,
      validTime: new Date(row.valid_time),
      verifiedExchangeMwh: Number(row.verified_exchange_mwh),
      programmedExchangeMwh: number(row.programmed_exchange_mwh),
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintage: factReceipt(query, [
      sourceOf("system-exchange", query.from, await readGoLive(tx, "system-exchange")),
    ]),
  };
}

/** Interchange per directed subsystem link — the corridor grain. */
export async function readSystemExchange(
  db: Database,
  query: SystemContextReadQuery,
): Promise<CanonicalReadResult<SystemExchangeObservation>> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, axesOf(query));
    return systemExchangeWithin(tx, query);
  });
}

// ---------------------------------------------------------------------------
// Forecasts
// ---------------------------------------------------------------------------

export interface DayAheadBalanceReadQuery extends FactReadQuery {
  subsystem?: SubsystemCode;
  /**
   * The gate.
   *
   * Forecast features are cut on `published_at`, not on `ingested_at`: over
   * backfilled history every row was ingested at go-live, so `AsOf` alone
   * filters nothing while this genuinely reproduces what was knowable
   * (`docs/specs/feature-engineering.md`). It is an axis rather than a filter —
   * the view applies it before choosing a version, which is not the same query
   * as applying it after.
   */
  publishedAtOrBefore?: Date;
}

async function dayAheadBalanceWithin(
  tx: Database,
  query: DayAheadBalanceReadQuery,
): Promise<CanonicalReadResult<DayAheadBalanceForecast>> {
  const subsystemFilter = query.subsystem
    ? sql`and subsystem = ${query.subsystem}`
    : sql``;

  const rows = await tx.execute<{
    subsystem: SubsystemCode;
    valid_time: string;
    forecast_producer: "ons_dessem";
    run_label: string;
    demand_mw: number;
    hydro_generation_mw: number;
    small_hydro_generation_mw: number;
    thermal_generation_mw: number;
    small_thermal_generation_mw: number;
    wind_generation_mw: number;
    solar_generation_mw: number;
    mmgd_generation_mw: number;
    pumping_consumption_mw: number;
    data_version: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select * from ${canonicalDayAheadBalance}
    where ${windowFilter(query)}
      ${subsystemFilter}
    order by subsystem, valid_time
  `);

  return {
    read: "day-ahead-balance",
    kind: "forecast",
    rows: [...rows].map((row) => ({
      subsystem: row.subsystem,
      validTime: new Date(row.valid_time),
      origin: {
        producer: row.forecast_producer,
        // The reference day is this run's identity, per `ForecastOrigin`.
        runLabel: row.run_label,
        publishedAt: new Date(row.published_at),
      },
      demandMw: Number(row.demand_mw),
      hydroGenerationMw: Number(row.hydro_generation_mw),
      smallHydroGenerationMw: Number(row.small_hydro_generation_mw),
      thermalGenerationMw: Number(row.thermal_generation_mw),
      smallThermalGenerationMw: Number(row.small_thermal_generation_mw),
      windGenerationMw: Number(row.wind_generation_mw),
      solarGenerationMw: Number(row.solar_generation_mw),
      mmgdGenerationMw: Number(row.mmgd_generation_mw),
      pumpingConsumptionMw: Number(row.pumping_consumption_mw),
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintage: factReceipt(query, [
      sourceOf(
        "day-ahead-balance",
        query.from,
        await readGoLive(tx, "day-ahead-balance"),
      ),
    ]),
  };
}

/** The operational day-ahead balance published D−1. A forecast, in its own read. */
export async function readDayAheadBalance(
  db: Database,
  query: DayAheadBalanceReadQuery,
): Promise<CanonicalReadResult<DayAheadBalanceForecast>> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, axesOf(query));
    return dayAheadBalanceWithin(tx, query);
  });
}

export interface WeatherReadQuery extends FactReadQuery {
  centroidIds?: readonly string[];
  /**
   * Restrict to one cycle.
   *
   * Absent — the normal read — the latest version wins whichever run produced
   * it, which is the D−1 12Z-supersedes-00Z rule falling out of the vintage
   * rather than being special-cased. Present, it answers "what did the 00Z run
   * say?" for a diagnosis, and like the day-ahead gate it is an axis rather
   * than a filter.
   */
  runCycle?: "00Z" | "12Z";
}

async function weatherForecastWithin(
  tx: Database,
  query: WeatherReadQuery,
): Promise<CanonicalReadResult<WeatherForecastAtCentroid>> {
  const centroidFilter =
    query.centroidIds && query.centroidIds.length > 0
      ? sql`and centroid_id in (${sql.join(
          query.centroidIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;

  const rows = await tx.execute<{
    centroid_id: string;
    valid_time: string;
    run_cycle: "00Z" | "12Z";
    grid_latitude: number;
    grid_longitude: number;
    grid_elevation_m: number;
    run_age_hours: number;
    wind_speed100m_kmh: number | null;
    wind_speed120m_kmh: number | null;
    wind_direction120m_deg: number | null;
    wind_gusts10m_kmh: number | null;
    temperature2m_c: number | null;
    surface_pressure_hpa: number | null;
    relative_humidity2m_pct: number | null;
    precipitation_mm: number | null;
    shortwave_radiation_wm2: number | null;
    direct_normal_irradiance_wm2: number | null;
    diffuse_radiation_wm2: number | null;
    cloud_cover_pct: number | null;
    data_version: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select * from ${canonicalWeatherForecast}
    where ${windowFilter(query)}
      ${centroidFilter}
    order by centroid_id, valid_time
  `);

  return {
    read: "weather-forecast",
    kind: "forecast",
    rows: [...rows].map((row) => ({
      centroidId: row.centroid_id,
      validTime: new Date(row.valid_time),
      origin: {
        producer: "open_meteo" as const,
        runLabel: row.run_cycle,
        // The run initialisation *is* the publication instant, which is why
        // supersession needs no rule of its own.
        publishedAt: new Date(row.published_at),
      },
      gridLatitude: Number(row.grid_latitude),
      gridLongitude: Number(row.grid_longitude),
      gridElevationM: Number(row.grid_elevation_m),
      runAgeHours: Number(row.run_age_hours),
      windSpeed100mKmh: number(row.wind_speed100m_kmh),
      windSpeed120mKmh: number(row.wind_speed120m_kmh),
      windDirection120mDeg: number(row.wind_direction120m_deg),
      windGusts10mKmh: number(row.wind_gusts10m_kmh),
      temperature2mC: number(row.temperature2m_c),
      surfacePressureHpa: number(row.surface_pressure_hpa),
      relativeHumidity2mPct: number(row.relative_humidity2m_pct),
      precipitationMm: number(row.precipitation_mm),
      shortwaveRadiationWm2: number(row.shortwave_radiation_wm2),
      directNormalIrradianceWm2: number(row.direct_normal_irradiance_wm2),
      diffuseRadiationWm2: number(row.diffuse_radiation_wm2),
      cloudCoverPct: number(row.cloud_cover_pct),
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintage: factReceipt(query, [
      sourceOf("weather-forecast", query.from, await readGoLive(tx, "weather-forecast")),
    ]),
  };
}

/** Weather at capacity-weighted cluster centroids, from a named run. */
export async function readWeatherForecast(
  db: Database,
  query: WeatherReadQuery,
): Promise<CanonicalReadResult<WeatherForecastAtCentroid>> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, axesOf(query));
    return weatherForecastWithin(tx, query);
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface InstalledCapacityReadQuery extends RegistryReadQuery {
  subsystem?: SubsystemCode;
  technology?: Technology;
}

/** The capacity read carries the scope total, which a consumer would re-sum. */
export interface InstalledCapacityResult
  extends CanonicalReadResult<InstalledCapacityScope> {
  totalMw: number;
}

async function installedCapacityWithin(
  tx: Database,
  query: InstalledCapacityReadQuery,
): Promise<InstalledCapacityResult> {
  const subsystemFilter = query.subsystem
    ? sql`and subsystem = ${query.subsystem}`
    : sql``;
  const technologyFilter = query.technology
    ? sql`and technology = ${query.technology}`
    : sql``;

  const rows = await tx.execute<{
    subsystem: SubsystemCode;
    technology: Technology;
    plants: number;
    units: number;
    capacity_mw: number;
  }>(sql`
    select * from ${canonicalInstalledCapacity}
    where true
      ${subsystemFilter}
      ${technologyFilter}
    order by subsystem, technology
  `);

  const scopes = [...rows].map((row) => ({
    subsystem: row.subsystem,
    technology: row.technology,
    plants: row.plants,
    units: row.units,
    capacityMw: Number(row.capacity_mw),
  }));

  return {
    read: "installed-capacity",
    kind: "observation",
    rows: scopes,
    totalMw: scopes.reduce((total, scope) => total + scope.capacityMw, 0),
    // The registry snapshot is today's record of the past: a fleet date before
    // WattSteer's first ingest can only be answered from ONS's current cut, so
    // the fidelity axis here is the fleet date and not the window.
    vintage: registryReceipt(query, [
      sourceOf(
        "installed-capacity",
        query.on,
        await readGoLive(tx, "installed-capacity"),
      ),
    ]),
  };
}

/** `InstalledCapacityAsOf(scope, technology, t)`, as a read. */
export async function readInstalledCapacity(
  db: Database,
  query: InstalledCapacityReadQuery,
): Promise<InstalledCapacityResult> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, { asOf: query.asOf, fleetDate: query.on });
    return installedCapacityWithin(tx, query);
  });
}

export interface ConjuntoMembershipReadQuery extends RegistryReadQuery {
  conjuntoCode?: string;
  plantOnsCode?: string;
}

async function conjuntoMembershipWithin(
  tx: Database,
  query: ConjuntoMembershipReadQuery,
): Promise<CanonicalReadResult<ConjuntoMembershipAtDate>> {
  const conjuntoFilter = query.conjuntoCode
    ? sql`and conjunto_code = ${query.conjuntoCode}`
    : sql``;
  const plantFilter = query.plantOnsCode
    ? sql`and plant_ons_code = ${query.plantOnsCode}`
    : sql``;

  const rows = await tx.execute<{
    plant_ons_code: string;
    conjunto_code: string;
    plant_ceg_core: string | null;
    member_from: string;
    member_to: string | null;
    data_version: number;
    published_at: string;
    ingested_at: string;
  }>(sql`
    select * from ${canonicalConjuntoMembership}
    where true
      ${conjuntoFilter}
      ${plantFilter}
    order by conjunto_code, plant_ons_code
  `);

  return {
    read: "conjunto-membership",
    kind: "observation",
    rows: [...rows].map((row) => ({
      plantOnsCode: row.plant_ons_code,
      conjuntoCode: row.conjunto_code,
      memberFrom: new Date(row.member_from),
      memberTo: row.member_to === null ? null : new Date(row.member_to),
      dataVersion: row.data_version,
      publishedAt: new Date(row.published_at),
      ingestedAt: new Date(row.ingested_at),
    })),
    vintage: registryReceipt(query, [
      sourceOf(
        "conjunto-membership",
        query.on,
        await readGoLive(tx, "conjunto-membership"),
      ),
    ]),
  };
}

/**
 * Which conjunto a plant belonged to on a date.
 *
 * The only path between the plant and reporting-entity grains, and every
 * traversal takes a date (`docs/domain-model.md` §7). At most one row per plant
 * by construction — the one-conjunto-per-plant invariant is asserted at ingest.
 */
export async function readConjuntoMembership(
  db: Database,
  query: ConjuntoMembershipReadQuery,
): Promise<CanonicalReadResult<ConjuntoMembershipAtDate>> {
  return readOnly(db, async (tx) => {
    await applyAxes(tx, { asOf: query.asOf, fleetDate: query.on });
    return conjuntoMembershipWithin(tx, query);
  });
}

// ---------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------

/** The axes a fact read needs, from the query it was given. */
const axesOf = (
  query: FactReadQuery & { publishedAtOrBefore?: Date; runCycle?: "00Z" | "12Z" },
): ReadAxes => ({
  asOf: query.asOf,
  publishedAtOrBefore: query.publishedAtOrBefore,
  weatherRunCycle: query.runCycle,
});

export interface TrainingWindowQuery extends FactReadQuery {
  subsystem?: SubsystemCode;
  technology?: Technology;
  centroidIds?: readonly string[];
  /** The forecast gate, applied to both forecast reads — day-ahead and weather. */
  publishedAtOrBefore?: Date;
  /**
   * Fleet date for the capacity weights. Defaults to the window start, which is
   * the conservative choice: weighting a window by the fleet that existed at its
   * end credits capacity that had not been built.
   */
  fleetDate?: Date;
}

/**
 * One training window: every family the modelling side needs, one `asOf`, one
 * receipt.
 *
 * This is the read the ticket is really about. Assembling the same five
 * families by hand is possible and is exactly the thing that goes wrong: five
 * separate calls give five separate `asOf` instants, five snapshots and five
 * fidelities, and the one that quietly decides whether a backtest is honest is
 * whichever the caller forgot to look at. Here the window has **one**
 * `VintageFidelity`, and it is `point_in_time` only when every contributing
 * source is — the composition rule in `vintage.ts`.
 */
export interface TrainingWindow {
  curtailment: CanonicalReadResult<CurtailmentObservation>;
  plantMeasurements: CanonicalReadResult<PlantMeasurement>;
  systemContext: CanonicalReadResult<SystemContextObservation>;
  systemExchange: CanonicalReadResult<SystemExchangeObservation>;
  dayAheadBalance: CanonicalReadResult<DayAheadBalanceForecast>;
  weather: CanonicalReadResult<WeatherForecastAtCentroid>;
  installedCapacity: InstalledCapacityResult;
  /** The receipt for the window as a whole — the weakest link across all of it. */
  vintage: VintageReceipt;
}

export async function readTrainingWindow(
  db: Database,
  query: TrainingWindowQuery,
): Promise<TrainingWindow> {
  const fleetDate = query.fleetDate ?? query.from;
  return readOnly(db, async (tx) => {
    // Every axis for the whole bundle, written once. The registry reads need a
    // fleet date and the day-ahead read a gate, and both are set here so the
    // seven reads below share one axis set as well as one snapshot.
    await applyAxes(tx, {
      asOf: query.asOf,
      fleetDate,
      publishedAtOrBefore: query.publishedAtOrBefore,
    });

    // Serial rather than concurrent: they share one transaction, and a single
    // Postgres connection serialises them anyway. Written as `await` in
    // sequence so that is visible rather than implied by a `Promise.all` that
    // does not do what it looks like it does.
    const curtailment = await curtailmentWithin(tx, query);
    const plantMeasurements = await plantMeasurementsWithin(tx, query);
    const systemContext = await systemContextWithin(tx, query);
    const systemExchange = await systemExchangeWithin(tx, query);
    const dayAheadBalance = await dayAheadBalanceWithin(tx, query);
    const weather = await weatherForecastWithin(tx, query);
    const installedCapacity = await installedCapacityWithin(tx, {
      asOf: query.asOf,
      on: fleetDate,
      subsystem: query.subsystem,
      technology: query.technology,
    });

    const sources = [
      curtailment,
      plantMeasurements,
      systemContext,
      systemExchange,
      dayAheadBalance,
      weather,
      installedCapacity,
    ].flatMap((part) => part.vintage.sources);

    return {
      curtailment,
      plantMeasurements,
      systemContext,
      systemExchange,
      dayAheadBalance,
      weather,
      installedCapacity,
      vintage: {
        asOf: query.asOf,
        window: { from: query.from, to: query.to },
        fleetDate,
        vintageFidelity: combineFidelity(sources),
        goLiveAt: combineGoLive(sources),
        sources,
      },
    };
  });
}

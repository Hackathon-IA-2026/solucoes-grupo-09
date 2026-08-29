import type { Database } from "../database/connection.js";
import { readCurtailmentAsOf } from "../ingest/curtailment-repository.js";
import { readDessemBalanceAsOf } from "../ingest/dessem-repository.js";
import { readSubsystemExchangeAsOf } from "../ingest/interchange-repository.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import { readPlantDetailAsOf } from "../ingest/plant-detail-repository.js";
import {
  readConjuntoMembershipAsOf,
  readInstalledCapacityAsOf,
} from "../ingest/registry-repository.js";
import { readEnergyBalanceAsOf } from "../ingest/repository.js";
import type { Technology } from "../ingest/types.js";
import { readWeatherForecastAsOf } from "../ingest/weather-repository.js";
import type { CanonicalReadName } from "./manifest.js";
import { readOnly } from "./read-only.js";
import type {
  CanonicalReadResult,
  ConjuntoMembershipAtDate,
  CurtailmentObservation,
  DayAheadBalanceForecast,
  InstalledCapacityScope,
  PlantMeasurement,
  SystemContextObservation,
  SystemExchangeObservation,
  VintageReceipt,
  WeatherForecastAtCentroid,
} from "./types.js";
import { combineFidelity, combineGoLive, type VintageSource } from "./vintage.js";

/**
 * The canonical reads themselves.
 *
 * **These compose; they do not query.** Every function here calls the as-of
 * read that already exists on the matching `src/ingest/*-repository.ts` and
 * then renames into `docs/domain-model.md`'s vocabulary. There is no `sql` tag
 * in this file and no table name, deliberately: a second `DISTINCT ON` written
 * here would be a second implementation of the one query whose correctness the
 * data-platform spec paid for, and the two would drift the first time an
 * ordering tiebreak changed.
 *
 * What the layer therefore adds is exactly three things, all of them the
 * ticket's:
 *
 * 1. **Vocabulary.** Source-shaped field names become domain names, and the
 *    ingest layer's two drifts from the domain model are corrected (see
 *    `types.ts`).
 * 2. **The vintage receipt.** Every answer carries its `VintageFidelity`, its
 *    go-live and the sources that decided them, so a consumer can always tell a
 *    point-in-time view from a revision-optimistic one — and a composition is
 *    only as honest as its weakest source.
 * 3. **The read-only boundary**, and one snapshot per answer (`read-only.ts`).
 *
 * Each read is written twice over: a `*Within` function that takes an open
 * read-only transaction, and the exported wrapper that opens one. The split
 * exists so `readTrainingWindow` can compose several reads inside a **single**
 * snapshot; `SET TRANSACTION` cannot be reissued in a nested one, so a bundle
 * built by calling the public reads would either fail or silently span an
 * ingest commit.
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

const source = (
  read: CanonicalReadName,
  result: { vintageFidelity: VintageSource["vintageFidelity"]; goLiveAt: Date | null },
): VintageSource => ({
  read,
  vintageFidelity: result.vintageFidelity,
  goLiveAt: result.goLiveAt,
});

// ---------------------------------------------------------------------------
// Curtailment
// ---------------------------------------------------------------------------

export interface CurtailmentReadQuery extends FactReadQuery {
  technology?: Technology;
  /** A `CJU_*` conjunto code or a self-reporting plant's ONS code. */
  reportingEntityCode?: string;
}

async function curtailmentWithin(
  tx: Database,
  query: CurtailmentReadQuery,
): Promise<CanonicalReadResult<CurtailmentObservation>> {
  const result = await readCurtailmentAsOf(tx, query);
  return {
    read: "curtailment-by-reporting-entity",
    kind: "observation",
    rows: result.rows.map((row) => ({
      reportingEntityCode: row.reportingEntityCode,
      technology: row.technology,
      validTime: row.validTime,
      constrainedOffMwh: row.constrainedOffMwh,
      // `generationMwh` upstream. `docs/domain-model.md` §4 names the quantity
      // `verified_generation_mwh`; the contract speaks that name.
      verifiedGenerationMwh: row.generationMwh,
      referenceGenerationMwh: row.referenceGenerationMwh,
      finalReferenceGenerationMwh: row.finalReferenceGenerationMwh,
      // `availabilityMw` upstream; §4 names it `available_capacity_mw`.
      availableCapacityMw: row.availabilityMw,
      halfHoursObserved: row.halfHoursObserved,
      restrictionCause: row.cause,
      restrictionCauseMixed: row.causeMixed,
      dataVersion: row.dataVersion,
      publishedAt: row.publishedAt,
      ingestedAt: row.ingestedAt,
    })),
    vintage: factReceipt(query, [source("curtailment-by-reporting-entity", result)]),
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
  return readOnly(db, (tx) => curtailmentWithin(tx, query));
}

export interface PlantMeasurementReadQuery extends FactReadQuery {
  technology?: Technology;
  plantOnsCode?: string;
}

async function plantMeasurementsWithin(
  tx: Database,
  query: PlantMeasurementReadQuery,
): Promise<CanonicalReadResult<PlantMeasurement>> {
  const result = await readPlantDetailAsOf(tx, query);
  return {
    read: "curtailment-by-plant",
    kind: "observation",
    rows: result.rows.map((row) => ({
      plantOnsCode: row.plantOnsCode,
      technology: row.technology,
      validTime: row.validTime,
      estimatedGenerationMwh: row.estimatedGenerationMwh,
      verifiedGenerationMwh: row.verifiedGenerationMwh,
      measurement:
        row.measurement === null
          ? null
          : {
              // Which quantity was measured follows from the technology and is
              // stated rather than left to be inferred — an unlabelled number
              // is how a wind speed reaches a PV curve.
              quantity:
                row.technology === "WIND"
                  ? ("wind_speed_ms" as const)
                  : ("irradiance_wm2" as const),
              value: row.measurement.value,
              invalid: row.measurement.invalid,
            },
      halfHoursObserved: row.halfHoursObserved,
      dataVersion: row.dataVersion,
      publishedAt: row.publishedAt,
      ingestedAt: row.ingestedAt,
    })),
    vintage: factReceipt(query, [source("curtailment-by-plant", result)]),
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
  return readOnly(db, (tx) => plantMeasurementsWithin(tx, query));
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
  const result = await readEnergyBalanceAsOf(tx, query);
  return {
    read: "system-context",
    kind: "observation",
    rows: result.rows.map((row) => ({
      subsystem: row.subsystem,
      validTime: row.validTime,
      loadMwh: row.loadMwh,
      windGenerationMwh: row.windGenerationMwh,
      solarGenerationMwh: row.solarGenerationMwh,
      hydroGenerationMwh: row.hydroGenerationMwh,
      thermalGenerationMwh: row.thermalGenerationMwh,
      netExchangeMwh: row.netExchangeMwh,
      dataVersion: row.dataVersion,
      publishedAt: row.publishedAt,
      ingestedAt: row.ingestedAt,
    })),
    vintage: factReceipt(query, [source("system-context", result)]),
  };
}

/** Load and generation by technology per subsystem-hour, with net exchange. */
export async function readSystemContext(
  db: Database,
  query: SystemContextReadQuery,
): Promise<CanonicalReadResult<SystemContextObservation>> {
  return readOnly(db, (tx) => systemContextWithin(tx, query));
}

async function systemExchangeWithin(
  tx: Database,
  query: SystemContextReadQuery,
): Promise<CanonicalReadResult<SystemExchangeObservation>> {
  const result = await readSubsystemExchangeAsOf(tx, query);
  return {
    read: "system-exchange",
    kind: "observation",
    rows: result.rows.map((row) => ({
      fromSubsystem: row.fromSubsystem,
      toSubsystem: row.toSubsystem,
      validTime: row.validTime,
      verifiedExchangeMwh: row.verifiedExchangeMwh,
      programmedExchangeMwh: row.programmedExchangeMwh,
      dataVersion: row.dataVersion,
      publishedAt: row.publishedAt,
      ingestedAt: row.ingestedAt,
    })),
    vintage: factReceipt(query, [source("system-exchange", result)]),
  };
}

/** Interchange per directed subsystem link — the corridor grain. */
export async function readSystemExchange(
  db: Database,
  query: SystemContextReadQuery,
): Promise<CanonicalReadResult<SystemExchangeObservation>> {
  return readOnly(db, (tx) => systemExchangeWithin(tx, query));
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
   * (`docs/specs/feature-engineering.md`).
   */
  publishedAtOrBefore?: Date;
}

async function dayAheadBalanceWithin(
  tx: Database,
  query: DayAheadBalanceReadQuery,
): Promise<CanonicalReadResult<DayAheadBalanceForecast>> {
  const result = await readDessemBalanceAsOf(tx, query);
  return {
    read: "day-ahead-balance",
    kind: "forecast",
    rows: result.rows.map((row) => ({
      subsystem: row.subsystem,
      validTime: row.validTime,
      origin: {
        producer: row.forecastProducer,
        // The reference day is this run's identity, per `ForecastOrigin`.
        runLabel: row.referenceDay,
        publishedAt: row.publishedAt,
      },
      demandMw: row.demandMw,
      hydroGenerationMw: row.hydroGenerationMw,
      smallHydroGenerationMw: row.smallHydroGenerationMw,
      thermalGenerationMw: row.thermalGenerationMw,
      smallThermalGenerationMw: row.smallThermalGenerationMw,
      windGenerationMw: row.windGenerationMw,
      solarGenerationMw: row.solarGenerationMw,
      mmgdGenerationMw: row.mmgdGenerationMw,
      pumpingConsumptionMw: row.pumpingConsumptionMw,
      dataVersion: row.dataVersion,
      publishedAt: row.publishedAt,
      ingestedAt: row.ingestedAt,
    })),
    vintage: factReceipt(query, [source("day-ahead-balance", result)]),
  };
}

/** The operational day-ahead balance published D−1. A forecast, in its own read. */
export async function readDayAheadBalance(
  db: Database,
  query: DayAheadBalanceReadQuery,
): Promise<CanonicalReadResult<DayAheadBalanceForecast>> {
  return readOnly(db, (tx) => dayAheadBalanceWithin(tx, query));
}

export interface WeatherReadQuery extends FactReadQuery {
  centroidIds?: readonly string[];
  /**
   * Restrict to one cycle.
   *
   * Absent — the normal read — the latest version wins whichever run produced
   * it, which is the D−1 12Z-supersedes-00Z rule falling out of the vintage
   * rather than being special-cased. Present, it answers "what did the 00Z run
   * say?" for a diagnosis.
   */
  runCycle?: "00Z" | "12Z";
}

async function weatherForecastWithin(
  tx: Database,
  query: WeatherReadQuery,
): Promise<CanonicalReadResult<WeatherForecastAtCentroid>> {
  const result = await readWeatherForecastAsOf(tx, query);
  return {
    read: "weather-forecast",
    kind: "forecast",
    rows: result.rows.map((row) => ({
      centroidId: row.centroidId,
      validTime: row.validTime,
      origin: {
        producer: "open_meteo" as const,
        runLabel: row.runCycle,
        // The run initialisation *is* the publication instant, which is why
        // supersession needs no rule of its own.
        publishedAt: row.runInitTime,
      },
      gridLatitude: row.gridLatitude,
      gridLongitude: row.gridLongitude,
      gridElevationM: row.gridElevationM,
      runAgeHours: row.runAgeHours,
      windSpeed100mKmh: row.windSpeed100mKmh,
      windSpeed120mKmh: row.windSpeed120mKmh,
      windDirection120mDeg: row.windDirection120mDeg,
      windGusts10mKmh: row.windGusts10mKmh,
      temperature2mC: row.temperature2mC,
      surfacePressureHpa: row.surfacePressureHpa,
      relativeHumidity2mPct: row.relativeHumidity2mPct,
      precipitationMm: row.precipitationMm,
      shortwaveRadiationWm2: row.shortwaveRadiationWm2,
      directNormalIrradianceWm2: row.directNormalIrradianceWm2,
      diffuseRadiationWm2: row.diffuseRadiationWm2,
      cloudCoverPct: row.cloudCoverPct,
      dataVersion: row.dataVersion,
      publishedAt: row.runInitTime,
      ingestedAt: row.ingestedAt,
    })),
    vintage: factReceipt(query, [source("weather-forecast", result)]),
  };
}

/** Weather at capacity-weighted cluster centroids, from a named run. */
export async function readWeatherForecast(
  db: Database,
  query: WeatherReadQuery,
): Promise<CanonicalReadResult<WeatherForecastAtCentroid>> {
  return readOnly(db, (tx) => weatherForecastWithin(tx, query));
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
  const result = await readInstalledCapacityAsOf(tx, query);
  return {
    read: "installed-capacity",
    kind: "observation",
    rows: result.groups,
    totalMw: result.totalMw,
    vintage: registryReceipt(query, [source("installed-capacity", result)]),
  };
}

/** `InstalledCapacityAsOf(scope, technology, t)`, as a read. */
export async function readInstalledCapacity(
  db: Database,
  query: InstalledCapacityReadQuery,
): Promise<InstalledCapacityResult> {
  return readOnly(db, (tx) => installedCapacityWithin(tx, query));
}

export interface ConjuntoMembershipReadQuery extends RegistryReadQuery {
  conjuntoCode?: string;
  plantOnsCode?: string;
}

async function conjuntoMembershipWithin(
  tx: Database,
  query: ConjuntoMembershipReadQuery,
): Promise<CanonicalReadResult<ConjuntoMembershipAtDate>> {
  const result = await readConjuntoMembershipAsOf(tx, query);
  return {
    read: "conjunto-membership",
    kind: "observation",
    rows: result.rows.map((row) => ({
      plantOnsCode: row.plantOnsCode,
      conjuntoCode: row.conjuntoCode,
      memberFrom: row.memberFrom,
      memberTo: row.memberTo,
      dataVersion: row.dataVersion,
      publishedAt: row.publishedAt,
      ingestedAt: row.ingestedAt,
    })),
    vintage: registryReceipt(query, [source("conjunto-membership", result)]),
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
  return readOnly(db, (tx) => conjuntoMembershipWithin(tx, query));
}

// ---------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------

export interface TrainingWindowQuery extends FactReadQuery {
  subsystem?: SubsystemCode;
  technology?: Technology;
  centroidIds?: readonly string[];
  /** The forecast gate, applied to the day-ahead balance. See above. */
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

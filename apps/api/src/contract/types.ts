import type { SubsystemCode } from "../ingest/normalise.js";
import type {
  ReasonCode,
  ReportingEntityKind,
  RestrictionCause,
  RestrictionOrigin,
  Technology,
} from "../ingest/types.js";
import type { CanonicalReadName, FactKind, ForecastOrigin } from "./manifest.js";
import type { VintageFidelity, VintageSource } from "./vintage.js";

/**
 * The row and envelope vocabulary of the canonical read contract.
 *
 * Every name in this file is `docs/domain-model.md`'s, and — since ticket 016 —
 * so is every name underneath it. Ticket 013 corrected two drifted field names
 * at this layer's edge: `generationMwh` became `verifiedGenerationMwh` and
 * `availabilityMw` became `availableCapacityMw` on the way past. That made
 * the domain model true for a consumer while leaving it false in the schema,
 * which is the wrong half to fix. The columns are `verified_generation_mwh`
 * (§4, `val_geracao`) and `available_capacity_mw` (§4, `val_disponibilidade`)
 * in `curtailment_report_hour` itself now, the canonical view selects them under
 * those names, and there is no compensating rename left anywhere to perform.
 */

export type {
  ReasonCode,
  ReportingEntityKind,
  RestrictionCause,
  RestrictionOrigin,
  SubsystemCode,
  Technology,
};

/**
 * The vintage of an answer, returned **beside** the rows on every read.
 *
 * This is the ticket's central requirement made structural: there is no shape
 * of this contract in which a consumer holds rows without also holding the
 * receipt that says which version of the truth they are. A field that must be
 * read is better than a field that may be — so the receipt is not optional, not
 * nullable, and not behind a flag.
 */
export interface VintageReceipt {
  /** The vintage cut the caller asked for: what WattSteer knew at this instant. */
  asOf: Date;
  /** Valid-time window `[from, to)` for a fact read; `null` for a registry read. */
  window: { from: Date; to: Date } | null;
  /** The fleet date for a registry read; `null` for a fact read. */
  fleetDate: Date | null;
  /** See `VintageFidelity`. The whole reason this object exists. */
  vintageFidelity: VintageFidelity;
  /**
   * The instant from which this answer would have been point-in-time.
   *
   * For a composed read it is the **latest** contributing go-live, or `null`
   * when any contributor has ingested nothing at all.
   */
  goLiveAt: Date | null;
  /** Per-source contributions, so a degraded composition names its weak link. */
  sources: VintageSource[];
}

/** The envelope every canonical read returns. */
export interface CanonicalReadResult<TRow> {
  read: CanonicalReadName;
  /**
   * Observation or forecast, restated on the answer.
   *
   * Present on the envelope as well as in the manifest so that a consumer that
   * received a serialised payload — and therefore has no type — can still tell
   * the two apart without a lookup table of its own.
   */
  kind: FactKind;
  rows: TRow[];
  vintage: VintageReceipt;
}

/** The vintage of one row: which version of the truth it is. */
export interface RowVintage {
  dataVersion: number;
  /** When the upstream source asserted this value. Never null. */
  publishedAt: Date;
  /** When WattSteer learned it. */
  ingestedAt: Date;
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * Constrained-off as settled, at `ReportingEntity` grain.
 *
 * The **only** row type in this contract with a `restrictionCause`, because it
 * is the only grain at which one is observed (`docs/domain-model.md` §3). The
 * entity behind `reportingEntityCode` is a `Conjunto` or a self-reporting
 * `Plant`; a screen showing the cause must name which.
 */
export interface CurtailmentObservation extends RowVintage {
  reportingEntityCode: string;
  /**
   * Whether that code names a `Conjunto` or a self-reporting `Plant`.
   *
   * On the row because the grain is not derivable from the code, and a screen
   * showing a restriction cause has to say which grain it is showing. Before
   * ticket 016 this took a second call to the registry; it is reachable now
   * because the canonical view joins `reporting_entity`, which the composing
   * version of this contract had no place to do.
   */
  reportingEntityKind: ReportingEntityKind;
  /**
   * The entity's electrical subsystem.
   *
   * The label is defined at subsystem grain — a constrained-off instruction is
   * issued against a subsystem's network — so a consumer that has the row but
   * not the subsystem cannot aggregate it to the grain the product forecasts
   * at without a second call to the registry. It comes from the same
   * `reporting_entity` join that supplies `reportingEntityKind`, so it costs
   * nothing here and it is not a second path to a base table.
   */
  subsystem: SubsystemCode;
  technology: Technology;
  /** Start of the hour, UTC. */
  validTime: Date;
  /** The primary label: energy the entity was instructed not to generate. */
  constrainedOffMwh: number;
  verifiedGenerationMwh: number;
  /** What generation would have been. */
  referenceGenerationMwh: number | null;
  /** The settled restatement of the above. */
  finalReferenceGenerationMwh: number | null;
  /** Real-time availability. A power, so it is a mean and not a sum. */
  availableCapacityMw: number | null;
  /** 1 or 2. Below 2 the source hour was incomplete. */
  halfHoursObserved: number;
  /** Nullable as a whole: all three fields, or none. */
  restrictionCause: RestrictionCause | null;
  /** The two half-hours disagreed on cause; the dominant one is carried. */
  restrictionCauseMixed: boolean;
}

/** Which physical quantity a plant's resource measurement is. */
export type MeasuredQuantity = "wind_speed_ms" | "irradiance_wm2";

/**
 * The measured resource at a plant, with its validity flag inseparable from it.
 *
 * One value object rather than a reading plus a loose boolean, because a
 * reading whose validity is unknown is not a reading.
 */
export interface ResourceMeasurementValue {
  quantity: MeasuredQuantity;
  /** m/s or W/m². Negative values are real and are kept. */
  value: number;
  invalid: boolean;
}

/**
 * Per-plant generation and resource, at `Plant` grain.
 *
 * **There is no `restrictionCause` on this type and no parameter that could
 * add one.** For the 93% of rows that are Tipo II-C the cause exists only at
 * the conjunto's grain, and pushing it down is an allocation that v1 does not
 * compute. Neither is there a reference generation, so curtailment volume
 * cannot be derived here — a consumer that wants it asks the entity-grain read.
 */
export interface PlantMeasurement extends RowVintage {
  plantOnsCode: string;
  technology: Technology;
  /** Start of the hour, UTC. */
  validTime: Date;
  estimatedGenerationMwh: number | null;
  verifiedGenerationMwh: number | null;
  /** Mean over the hour — a speed and an irradiance are intensive. */
  measurement: ResourceMeasurementValue | null;
  halfHoursObserved: number;
}

/** Load and generation by technology per subsystem-hour. */
export interface SystemContextObservation extends RowVintage {
  subsystem: SubsystemCode;
  /** Start of the hour, UTC. */
  validTime: Date;
  loadMwh: number;
  windGenerationMwh: number;
  solarGenerationMwh: number;
  hydroGenerationMwh: number;
  thermalGenerationMwh: number;
  netExchangeMwh: number;
}

/** Interchange on one directed subsystem link. */
export interface SystemExchangeObservation extends RowVintage {
  fromSubsystem: SubsystemCode;
  toSubsystem: SubsystemCode;
  /** Start of the hour, UTC. */
  validTime: Date;
  verifiedExchangeMwh: number;
  programmedExchangeMwh: number | null;
}

// ---------------------------------------------------------------------------
// Forecasts
// ---------------------------------------------------------------------------

/**
 * Every forecast row carries the run that produced it.
 *
 * The observation types above have no such field and no place to put one. That
 * asymmetry *is* the discriminator (`docs/domain-model.md` §4): a forecast
 * cannot be mistaken for an actual because the two shapes differ, not because
 * a flag says so.
 */
export interface ForecastRow extends RowVintage {
  origin: ForecastOrigin;
}

/** The operational day-ahead balance, half-hour × subsystem, published D−1. */
export interface DayAheadBalanceForecast extends ForecastRow {
  subsystem: SubsystemCode;
  /** Start of the half hour, UTC. */
  validTime: Date;
  /**
   * Power, not energy — DESSEM publishes instantaneous MW rather than MWmed,
   * so the MWh conversion every other adapter applies would be a factual error
   * here. `docs/domain-model.md` §1: `*_mw` holds power.
   */
  demandMw: number;
  hydroGenerationMw: number;
  smallHydroGenerationMw: number;
  thermalGenerationMw: number;
  smallThermalGenerationMw: number;
  windGenerationMw: number;
  solarGenerationMw: number;
  mmgdGenerationMw: number;
  pumpingConsumptionMw: number;
}

/** Weather at one cluster centroid for one forecast hour, from a named run. */
export interface WeatherForecastAtCentroid extends ForecastRow {
  centroidId: string;
  /** Start of the forecast hour, UTC. */
  validTime: Date;
  /** The model grid cell the query snapped to, as echoed by the source. */
  gridLatitude: number;
  gridLongitude: number;
  gridElevationM: number;
  /**
   * `run_init(scheduled) − run_init(used)`, in hours.
   *
   * Zero on the normal path. Non-zero means the scheduled run was missing and
   * an older one stood in — a fact a model conditioning on lead time must be
   * able to see, so it is on the row rather than in a log line.
   */
  runAgeHours: number;
  windSpeed100mKmh: number | null;
  windSpeed120mKmh: number | null;
  windDirection120mDeg: number | null;
  windGusts10mKmh: number | null;
  temperature2mC: number | null;
  surfacePressureHpa: number | null;
  relativeHumidity2mPct: number | null;
  precipitationMm: number | null;
  shortwaveRadiationWm2: number | null;
  directNormalIrradianceWm2: number | null;
  diffuseRadiationWm2: number | null;
  cloudCoverPct: number | null;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * `InstalledCapacityAsOf(scope, technology, t)` for one scope.
 *
 * A function of the fleet date, never a stored scalar: fixed present-day
 * weights misallocate half the SE-solar weight mass at window start
 * (`docs/domain-model.md` §3).
 */
export interface InstalledCapacityScope {
  subsystem: SubsystemCode;
  technology: Technology;
  plants: number;
  units: number;
  capacityMw: number;
}

/** Which conjunto a plant belonged to on a date. */
export interface ConjuntoMembershipAtDate extends RowVintage {
  plantOnsCode: string;
  conjuntoCode: string;
  /** Inclusive first day of membership. */
  memberFrom: Date;
  /** Inclusive last day, or `null` while the membership is current. */
  memberTo: Date | null;
}

export type {
  CanonicalReadName,
  FactKind,
  ForecastOrigin,
  VintageFidelity,
  VintageSource,
};

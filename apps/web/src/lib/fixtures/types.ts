/**
 * Fixture shapes for the `/app` prototype.
 *
 * Every name here comes from `docs/domain-model.md`, which is the naming
 * authority. Where a shape here is narrower than the domain model, it is
 * narrower on purpose (a prototype does not need the whole model) — it is
 * never *differently* named.
 *
 * Nothing in this directory talks to the API. The point of ticket 014 is the
 * shape of the screens, not the pipeline.
 *
 * The shared vocabulary — `SubsystemCode`, `Technology`, `Band`, `Figure`,
 * `Driver`, `ForecastOrigin` and the reason/origin/vintage enums — is defined
 * once in `@/lib/domain` and re-exported here. It used to be declared in both
 * places, and the two copies disagreed.
 */

export {
  type Band,
  band,
  centre,
  type Driver,
  type Figure,
  type ForecastOrigin,
  observed,
  type ReasonCode,
  type RestrictionOrigin,
  type SubsystemCode,
  spread,
  type Technology,
  upper,
  type VintageFidelity,
} from "@/lib/domain";

import type {
  Band,
  Driver,
  ForecastOrigin,
  ReasonCode,
  RestrictionOrigin,
  SubsystemCode,
  Technology,
  VintageFidelity,
} from "@/lib/domain";

export interface SubsystemMeta {
  code: SubsystemCode;
  /** ONS's own display name, untranslated (naming rule 2). */
  onsDisplayName: string;
  /** Short label for tight chrome. */
  short: string;
}

/** `CurtailmentHour`, forecast side: the atom the model predicts. */
export interface CurtailmentHourForecast {
  /** `valid_time`, UTC, start-labelled. */
  validTime: string;
  /** Hour of day in `America/Sao_Paulo`, which is what the axis shows. */
  hourLocal: number;
  /** `constrained_off_mwh`, as a band. */
  constrainedOff: Band;
  /** Hurdle model, part one: P(this hour exceeds the threshold). */
  occurrenceProbability: number;
}

/** `CurtailmentHour`, observed side. */
export interface CurtailmentHourObservation {
  validTime: string;
  hourLocal: number;
  constrainedOffMwh: number;
}

/**
 * The day-ahead forecast for one (`Subsystem`, `Technology`) — the only
 * horizon WattSteer serves.
 */
export interface SubsystemDayForecast {
  subsystem: SubsystemCode;
  technology: Technology;
  /** The day being forecast, `America/Sao_Paulo` civil date. */
  targetDate: string;
  forecastOrigin: ForecastOrigin;
  /** `curtailment_threshold_mw` in force, stamped on every output. */
  thresholdMw: number;
  /** Hurdle model, part one, at day grain. */
  occurrenceProbability: number;
  /** Hurdle model, part two: day total conditional on occurrence. */
  dailyEnergy: Band;
  /** Peak hourly power across the day. */
  peakPower: Band;
  hours: CurtailmentHourForecast[];
}

/**
 * `RiskClass` — the ordinal the overview shows instead of a raw probability.
 * Three wide, named bins; see `components/charts/risk-class.tsx` for why.
 */
export type RiskClass = "low" | "elevated" | "high";

/**
 * A reliability (calibration) point: of the hours we called `binCentre`, how
 * many actually exceeded the threshold.
 */
export interface ReliabilityPoint {
  binCentre: number;
  observedFrequency: number;
  hourCount: number;
}

/**
 * Observed restriction reasons, at the grain ONS reports them and no finer.
 *
 * `grain` is displayed, never assumed: for a `conjunto` the reason belongs to
 * the settlement unit and cannot be allocated to its member plants; for a
 * `self_reporting_plant` (Tipo I / II-B) the reason genuinely is observed at
 * plant grain.
 */
export interface ObservedReason {
  grain: "conjunto" | "self_reporting_plant";
  entityLabel: string;
  reason: ReasonCode;
  origin: RestrictionOrigin;
  constrainedOffMwh: number;
  /** `dsc_restricao` — displayable evidence, never a vocabulary. */
  description: string | null;
}

export interface ExplainFixture {
  subsystem: SubsystemCode;
  technology: Technology;
  targetDate: string;
  drivers: Driver[];
  /** Generated directly in the requested locale; not a translated string. */
  narration: string;
  reliability: ReliabilityPoint[];
  /** How many hours the reliability curve was computed over. */
  reliabilitySampleHours: number;
  reliabilityWindow: string;
  reliabilityFidelity: VintageFidelity;
  observedReasons: ObservedReason[];
  observedReasonsDate: string;
}

/** `FlexibilityAsset` — a sum type; v1 implements two variants. */
export interface BatteryAsset {
  assetType: "battery";
  label: string;
  maxPowerMw: number;
  energyCapacityMwh: number;
  roundTripEfficiency: number;
  initialStateOfCharge: number;
}

export interface ShiftableLoadAsset {
  assetType: "shiftable_load";
  label: string;
  maxShiftMw: number;
  shiftWindowHours: number;
  dailyEnergyMwh: number;
}

export type FlexibilityAsset = BatteryAsset | ShiftableLoadAsset;

/**
 * Which point of the forecast band the optimizer is pointed at.
 *
 * `docs/research/optimizer-formulation.md` §7 lays out P50 / P10 / robust-Γ /
 * scenario-based and *deliberately does not choose* — that is ticket 011. The
 * prototype therefore exposes the choice rather than hiding it, and reports
 * the outcome across the whole band either way.
 */
export type CurtailmentBasis = "p10" | "p50";

/** `OptimizationResult`, narrowed to what the screen renders. */
export interface OptimizationResult {
  /** Baseline curtailment under the evaluated realisation, MWh. */
  baselineCurtailmentMwh: number;
  optimizedCurtailmentMwh: number;
  avoidedEnergyMwh: number;
  /** `avoided / baseline`; **null**, never 0, when baseline is 0. */
  avoidability: number | null;
  /** Per-hour dispatch, MW. Positive = added demand, negative = discharge. */
  dispatch: HourlyDispatch[];
  thresholdMw: number;
}

export interface HourlyDispatch {
  hourLocal: number;
  /** Curtailment offered to the assets in this hour, MWh. */
  offeredMwh: number;
  batteryChargeMw: number;
  batteryDischargeMw: number;
  /** Battery state of charge at the end of the hour, MWh. */
  stateOfChargeMwh: number;
  loadShiftUpMw: number;
  loadShiftDownMw: number;
  absorbedMwh: number;
}

/** One step of the Mitigate reveal. */
export interface MitigationStep {
  key: "no_action" | "battery" | "battery_and_load";
  label: string;
  /** Remaining curtailment across the band, MWh. */
  remaining: Band;
  /** Recovered energy across the band, MWh. */
  recovered: Band;
  /** % avoided across the band; null where the baseline is zero. */
  avoidability: Band | null;
  /** The dispatch, evaluated on the P50 realisation. */
  dispatch: HourlyDispatch[];
}

/** A `CurtailmentEpisode` — a read-time view, carrying its own threshold. */
export interface CurtailmentEpisode {
  id: string;
  subsystem: SubsystemCode;
  technology: Technology;
  startedAt: string;
  endedAt: string;
  durationHours: number;
  totalMwh: number;
  peakMw: number;
  thresholdMw: number;
  maxGapHours: number;
}

/** One replayed day for the Time Machine. */
export interface ReplayDay {
  episode: CurtailmentEpisode;
  label: string;
  /** What ONS settled, hour by hour. */
  observed: CurtailmentHourObservation[];
  /** What the D−1 run said, pinned to the vintage available at D−1. */
  forecast: CurtailmentHourForecast[];
  forecastOrigin: ForecastOrigin;
  /** What the reference scenario's dispatch would have absorbed. */
  recoveredMwh: number;
  scenarioLabel: string;
  vintageFidelity: VintageFidelity;
  /**
   * Whether the model that produced `forecast` had this period inside its
   * training window. If it did, the replay is in-sample and is not a
   * counterfactual — which the screen has to say out loud.
   */
  inTrainingWindow: boolean;
  modelTrainedThrough: string;
}

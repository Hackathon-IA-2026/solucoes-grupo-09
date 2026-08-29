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
 * `Driver`, `ForecastOrigin`, `SubsystemMeta` and the reason/origin/vintage
 * enums — is defined once in `@wattsteer/core` and re-exported here. It used to
 * be declared in both places, and the two copies disagreed; it now lives in the
 * shared package rather than in this app, so the gateway and the modelling
 * service read the same definitions instead of forming a second opinion.
 */

export {
  type AttributedDriver,
  type Band,
  band,
  centre,
  type Driver,
  type DriverCode,
  type DriverDirection,
  type DriverReading,
  type DriverTerm,
  type Figure,
  type ForecastOrigin,
  observed,
  type ReasonCode,
  type RestrictionOrigin,
  type SubsystemCode,
  type SubsystemMeta,
  spread,
  type Technology,
  upper,
  type VintageFidelity,
} from "@wattsteer/core";

import type {
  AttributedDriver,
  Band,
  ForecastOrigin,
  ReasonCode,
  RestrictionOrigin,
  SubsystemCode,
  Technology,
  VintageFidelity,
} from "@wattsteer/core";

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
  drivers: AttributedDriver[];
  /**
   * The share of attributed magnitude the narration's two named drivers carry
   * between them.
   *
   * The narration is the one deliberate exception `docs/specs/i18n.md` carves
   * out of "the API returns codes, the client renders the words": there is no
   * translation key for a sentence a language model writes fresh per request,
   * so the shipped API will take a `locale` and generate the prose directly in
   * it. There is no language model behind a fixture, so the prototype
   * composes the same sentence from a per-locale template and the values here
   * — which keeps the screen honest in both languages until the real
   * narration arrives to replace it wholesale.
   */
  narrationTopShare: number;
  reliability: ReliabilityPoint[];
  /** How many hours the reliability curve was computed over. */
  reliabilitySampleHours: number;
  /** The scored window, as civil dates — formatted by the reader's locale. */
  reliabilityWindowFrom: string;
  reliabilityWindowTo: string;
  reliabilityFidelity: VintageFidelity;
  observedReasons: ObservedReason[];
  observedReasonsDate: string;
}

/**
 * `FlexibilityAsset` — a sum type; v1 implements two variants.
 *
 * Neither carries a `label`. The two kinds of asset are named in the
 * dictionaries by their `assetType`, because "Battery" is copy and an asset
 * type is not.
 */
export interface BatteryAsset {
  assetType: "battery";
  maxPowerMw: number;
  energyCapacityMwh: number;
  roundTripEfficiency: number;
  initialStateOfCharge: number;
}

export interface ShiftableLoadAsset {
  assetType: "shiftable_load";
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
  /**
   * Because "recovered" is not "delivered": absorbed energy is metered at the
   * grid boundary, and some of it is still inside the battery when the horizon
   * ends. There is no terminal state-of-charge constraint, so the consequence
   * is reported rather than constrained away.
   */
  storedAtHorizonEndMwh: number;
  /** The other half of the same honesty: what did not survive the round trip. */
  roundTripLossMwh: number;
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
  /** The step's identity; its words live in the dictionaries. */
  key: "no_action" | "battery" | "battery_and_load";
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

/** The fixed asset scenario a replayed day is scored against. */
export interface ReplayScenario {
  batteryPowerMw: number;
  batteryEnergyMwh: number;
  loadShiftMw: number;
}

/** One replayed day for the Time Machine. */
export interface ReplayDay {
  episode: CurtailmentEpisode;
  /** The replayed civil date, `America/Sao_Paulo`. The label is built from it. */
  date: string;
  /** What ONS settled, hour by hour. */
  observed: CurtailmentHourObservation[];
  /** What the D−1 run said, pinned to the vintage available at D−1. */
  forecast: CurtailmentHourForecast[];
  /**
   * The day total as a JOINT band — never the componentwise sum of `forecast`.
   *
   * Adding 24 hourly P90s assumes every hour lands at its 90th percentile at
   * once, which describes a day far worse than a 90th-percentile day. The
   * forecaster produces this from a path ensemble; the fixture reproduces the
   * sub-additivity so the screens cannot learn the wrong habit.
   */
  forecastDayEnergy: Band;
  forecastOrigin: ForecastOrigin;
  /** What the reference scenario's dispatch would have absorbed. */
  recoveredMwh: number;
  /** The reference scenario, as parameters rather than as an English sentence. */
  scenario: ReplayScenario;
  vintageFidelity: VintageFidelity;
  /**
   * Whether the model that produced `forecast` had this period inside its
   * training window. If it did, the replay is in-sample and is not a
   * counterfactual — which the screen has to say out loud.
   */
  inTrainingWindow: boolean;
  modelTrainedThrough: string;
}

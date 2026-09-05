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
  type DisplayDriverCode,
  type Driver,
  type DriverCode,
  type DriverDirection,
  type DriverReading,
  type DriverTerm,
  directionOf,
  type Figure,
  type ForecastOrigin,
  observed,
  type ReasonCode,
  type RestrictionOrigin,
  type SignedDriverDirection,
  type SubsystemCode,
  type SubsystemMeta,
  splitFor,
  splitOther,
  spread,
  type Technology,
  type TechnologySplit,
  upper,
  type VintageFidelity,
} from "@wattsteer/core";

/**
 * The replay contract's own vocabulary. `docs/specs/replay.md` fixes these
 * names and `packages/core`'s generated types carry them; the fixture adopts
 * them rather than inventing a parallel spelling.
 */
export type { ReplayIntegrity, ReplayIntegrityHeldOutBy } from "@wattsteer/core/api";

import type {
  AttributedDriver,
  Band,
  ForecastOrigin,
  ReasonCode,
  RestrictionOrigin,
  SubsystemCode,
  Technology,
  TechnologySplit,
  VintageFidelity,
} from "@wattsteer/core";
import type { ReplayIntegrity, ReplayIntegrityHeldOutBy } from "@wattsteer/core/api";

/** `CurtailmentHour`, forecast side: the atom the model predicts. */
export interface CurtailmentHourForecast {
  /** `valid_time`, UTC, start-labelled. */
  validTime: string;
  /** Hour of day in `America/Sao_Paulo`, which is what the axis shows. */
  hourLocal: number;
  /** `constrained_off_mwh`, as a band. */
  constrainedOff: Band;
  /**
   * `E[constrained_off_mwh]` for this hour — a **sibling** of the band, never
   * inside it and never its centre.
   *
   * The hourly model is a hurdle: mass at zero with weight `1 −
   * occurrenceProbability`, and a magnitude distribution above it. Its
   * expectation therefore exceeds its median whenever the hour is less than an
   * even chance to clear the threshold, and the median is flatly zero below
   * that. Storing the expectation as a fourth number inside `constrainedOff`
   * would have invited exactly the reading the shape exists to prevent.
   */
  expectedMwh: number;
  /** Hurdle model, part one: P(this hour exceeds the threshold). */
  occurrenceProbability: number;
  /** Two scalars summing to `expectedMwh`. There is no per-technology band. */
  split: TechnologySplit;
}

/** `CurtailmentHour`, observed side. */
export interface CurtailmentHourObservation {
  validTime: string;
  hourLocal: number;
  constrainedOffMwh: number;
}

/**
 * The day-ahead forecast for one `Subsystem` — the only horizon WattSteer
 * serves, and **one object per subsystem-day**.
 *
 * There is deliberately no `technology` field. This shape used to carry one,
 * and `buildForecast(subsystem, technology, run)` built a whole band per
 * technology; no such model exists. The forecaster has a single head per
 * subsystem, so the only division it can publish is a scalar split of the
 * expectation (`split`, and `CurtailmentHourForecast.split` at the finer
 * grain). A technology selector on a screen picks which of those two scalars
 * to emphasise; it cannot filter this object, because there is nothing here to
 * filter — see `docs/specs/api-surface.md`, contract change 5.
 */
export interface SubsystemDayForecast {
  subsystem: SubsystemCode;
  /** The day being forecast, `America/Sao_Paulo` civil date. */
  targetDate: string;
  forecastOrigin: ForecastOrigin;
  /** `curtailment_threshold_mw` in force, stamped on every output. */
  thresholdMw: number;
  /**
   * P(the day contains at least one hour above the threshold), read from the
   * day-grain path ensemble — not `1 − Π(1 − p_t)` over the hours, which would
   * assume the hours are independent when the whole point of drawing paths is
   * that they are not.
   */
  occurrenceProbability: number;
  /**
   * The day total, as a band. **Read from the path ensemble, never reduced
   * from the hours**: quantiles do not add, and neither do medians.
   */
  dailyEnergy: Band;
  /** Peak hourly power across the day — also a path-ensemble quantity. */
  peakPower: Band;
  /**
   * `E[day total]` — a sibling of `dailyEnergy`, **not its centre**. It is the
   * sum of the hourly expectations, which is exact because expectations add,
   * and it sits above `dailyEnergy.p50` whenever the day is a mixture with
   * meaningful mass at zero.
   */
  dayExpectedMwh: number;
  /** Two scalars summing to `dayExpectedMwh`. No quantile lives in here. */
  split: TechnologySplit;
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

/**
 * The day's diagnosis for one `Subsystem` — **one object per subsystem-day**.
 *
 * There is deliberately no `technology` field, and `buildExplain` takes no
 * technology argument. This shape used to carry one and the screen used to
 * pass the URL's selection through to it; no such model exists. The forecaster
 * has a single head per subsystem, so there is no per-technology prediction
 * for a Shapley game to be played over and no per-technology head to explain
 * — see `docs/specs/api-surface.md`, contract change 4, where the change is
 * named a deletion rather than an edit.
 *
 * The `technology` URL parameter survives, because the *observed* panels have
 * a technology dimension that genuinely exists. It simply stops reaching the
 * attribution.
 */
export interface ExplainFixture {
  subsystem: SubsystemCode;
  targetDate: string;
  /**
   * All eight groups, ranked by share. **Not a shortlist**: the `share >= 0.03`
   * cut, the six-row cap and the merge into `other` are the client's, and
   * `lib/driver-rows.ts` applies them at render time.
   */
  drivers: AttributedDriver[];
  /**
   * The share of the attributed *movement* the narration's two named drivers
   * carry between them.
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
  /**
   * No reliability curve here, and that is the point.
   *
   * It used to live on this object, which gave a property of the *model* the
   * cache key and the request shape of a property of the *day*.
   * `docs/specs/api-surface.md` §9 splits it onto `GET /v1/model/card`, keyed
   * by lane; `fixtures/model-card.ts` is its fixture, and the Explain screen
   * reads the two separately.
   */
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
  /**
   * The connection limit, and the ceiling `SHIFT_EXCEEDS_CONNECTION` is read
   * against. It used to be absent here, which made the fixture load the one
   * asset in the prototype that could not be written as a `Scenario` at all:
   * `max_power_mw` is a required common field on every variant, and a shape
   * that omits it cannot be encoded into the URL the screen now carries.
   */
  maxPowerMw: number;
  maxShiftMw: number;
  shiftWindowHours: number;
  dailyEnergyMwh: number;
}

export type FlexibilityAsset = BatteryAsset | ShiftableLoadAsset;

/**
 * There is no `OptimizationResult` shape here any more.
 *
 * It used to be a narrowed local copy of the contract, for a browser-side
 * evaluator that no longer exists. `@wattsteer/core`'s generated
 * `OptimizationResult` is now the only one: the screen renders what
 * `POST /v1/optimize` returned, and `lib/optimization.ts` is the single place
 * that reads it.
 */

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
  /**
   * The share avoided **on each realisation** — `p10` is the share on the P10
   * realisation and not the low end of an interval. The three are not ordered
   * (see `mitigate.ts`), so nothing may read this as an ascending band.
   */
  avoidability: Band | null;
  /**
   * `recovered_floor_mwh` — the P10-simulated recovery, and **the number the
   * product quotes in prose**. Equal to `recovered.p10` by construction; it is
   * named separately because the prose and the band are two different claims
   * and only one of them is the promise.
   */
  recoveredFloorMwh: number;
  /**
   * Still in the battery when the horizon ends, on the planning envelope.
   * Reported rather than constrained away: there is no terminal state-of-charge
   * constraint, because requiring one would penalise absorption on the day
   * being planned in order to serve a day the horizon does not cover.
   */
  storedAtHorizonEndMwh: number;
  /** What did not survive the round trip, on the planning envelope. */
  roundTripLossMwh: number;
  /**
   * The **scheduled** dispatch, on the planning envelope, as the solver
   * returned it. Empty for `no_action`, which is the day and not a plan.
   */
  dispatch: HourlyDispatch[];
  /**
   * The economic scenario the solver stamped on this step, R$ — recovered
   * energy on the planning envelope at the assumed rate. `null` for
   * `no_action`, because nothing was recovered and a zero would read as a
   * priced outcome.
   */
  brl: number | null;
  /**
   * `curtailment_threshold_mw` in force for the solve this step came from. On
   * every step rather than on the screen: an unstamped figure cannot be
   * compared with another one, and the threshold is the definition of the
   * quantity being avoided.
   */
  thresholdMw: number;
  /**
   * The resolved `ForecastOrigin` this step was optimised against, as the
   * instant the run published. A plan is a statement about a forecast; without
   * the origin it is a statement about whenever the page happened to load.
   */
  forecastOrigin: string;
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
   * `forecast.day_total` on the wire — the day's energy as a JOINT band, read
   * off the payload and never rebuilt from `forecast`.
   *
   * Adding 24 hourly P90s assumes every hour lands at its 90th percentile at
   * once, which describes a day far worse than a 90th-percentile day. The
   * forecaster produces this from a path ensemble and `docs/specs/replay.md`
   * puts it on the contract for exactly this reason; the fixture draws it the
   * same way, so the screens cannot learn the wrong habit.
   * `test/no-summed-bands.test.ts` is the standing guard.
   */
  forecastDayTotal: Band;
  forecastOrigin: ForecastOrigin;
  /** What the reference scenario's dispatch would have absorbed. */
  recoveredMwh: number;
  /** The reference scenario, as parameters rather than as an English sentence. */
  scenario: ReplayScenario;
  vintageFidelity: VintageFidelity;
  /**
   * What the vintage caveat touches, and what it explicitly does not.
   *
   * `docs/specs/replay.md`: the label and the lagged-actual features are read
   * as ONS states them today; the weather run, DESSEM and the ONS programming
   * are cut on `published_at` and are genuinely point-in-time on both sides of
   * go-live. The lists travel as data so the screen names them by reading
   * rather than by repeating — a blanket "this day is unreliable" would be both
   * vaguer and less true.
   */
  vintageAffects: readonly string[];
  vintageExempt: readonly string[];
  /**
   * The measured size of the vintage caveat, in Replay's own currency, or
   * `null`.
   *
   * `null` means **unmeasured**, and the screen says that word. It is
   * computable only after ingestion go-live and only once ONS has restated days
   * WattSteer holds both vintages of, so it will be `null` for months. A zero
   * here would read as "measured, and small", which is the one thing an
   * unmeasured caveat must never look like.
   */
  revisionPremiumRecoveredMwh: number | null;
  /**
   * `integrity.provenance` — how the forecast for this day was kept out of
   * the model that produced it.
   *
   * This replaces the prototype's `inTrainingWindow` /`modelTrainedThrough`
   * pair, which compared the replayed date against the *serving* artifact's
   * training cut: the right question asked of the wrong artifact.
   * `docs/specs/replay.md` refuses to label an in-sample day at all — it
   * refuses to replay it — so no replayable day is in-sample and the badge
   * stops being a warning and becomes a provenance statement.
   *
   * `served` and `fold_holdout` are `replay.md`'s own spellings, adopted
   * verbatim rather than restated; `packages/core`'s `ReplayIntegrity` is the
   * generated type they come from.
   */
  provenance: ReplayIntegrity["provenance"];
  /**
   * `integrity.held_out_by` — the identity of what held this day out, so the
   * claim is checkable rather than asserted.
   *
   * `null` on a `served` day, and that is not an omission: a served forecast
   * was published before the day it describes, so no fold had to hold it out
   * and there is no fold id to name. A `fold_holdout` day names its fold, the
   * artifact and both windows — the training block *and* the calibration
   * window, because a day inside the calibration window shaped the interval
   * the replay promises a floor from.
   */
  heldOutBy: ReplayIntegrityHeldOutBy | null;
}

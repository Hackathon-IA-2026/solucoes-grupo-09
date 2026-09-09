/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source: `packages/core/schema/*.json`, the cross-language authority.
 * Generator: `packages/core/scripts/generate-types.ts`.
 * Regenerate: `bun run --cwd packages/core generate:types`.
 *
 * Checked in on purpose: a reader of the repository sees the wire contract
 * without running a build, and a schema edited without regenerating fails
 * `packages/core/test/schema-generated-types.test.ts` rather than drifting.
 *
 * The interfaces are `camelCase` — the vocabulary the screens already use.
 * The wire is `snake_case`, and `WIRE_SHAPES` at the bottom is the table
 * `src/wire.ts` renames through, in exactly one place.
 */

/**
 * An enum with exactly four members. `SIN` is ONS's national aggregate row,
 * filtered at the ingest boundary, and is deliberately NOT a member: a
 * national figure lives under a `national` key with its derivation named
 * (vocabulary rule 6).
 */
export type Subsystem = "N" | "NE" | "S" | "SE";

/**
 * The two variable renewable fleets. Uppercase, case-sensitively, everywhere a
 * value is serialized including the `technology=` query parameter. `wind_mwh`
 * is a snake_case *field name* under the wire's casing rule and is not a
 * spelling of the value.
 */
export type Technology = "WIND" | "SOLAR";

/**
 * A P10/P50/P90 triple - the shape of every quantity the forecaster emits.
 * Quantiles do not add: two bands are never summed componentwise. Referenced
 * rather than inlined everywhere it appears (vocabulary rule 1), and closed to
 * additional properties so an expectation cannot be smuggled inside one
 * (vocabulary rule 2).
 */
export interface Band {
  /**
   * 10th percentile.
   */
  p10: number;
  /**
   * Median. Not the expectation.
   */
  p50: number;
  /**
   * 90th percentile.
   */
  p90: number;
}

/**
 * Two scalars, and nothing else (vocabulary rule 3). The forecaster publishes
 * no per-technology band, so an object carrying a `p10` under the split must
 * fail validation rather than reach a chart that would draw it.
 */
export interface TechnologySplit {
  windMwh: number;
  solarMwh: number;
}

/**
 * Stamped on every object carrying a metric or a historical number (vocabulary
 * rule 9), and never averaged across values by anything.
 */
export type VintageFidelity = "point_in_time" | "revision_optimistic";

/**
 * The parameter that produced the numbers beside it, carried on every object
 * it applies to (vocabulary rule 8). Defaults: 5 MW at subsystem grain, 1 MW
 * at reporting-entity grain.
 */
export type ThresholdMw = number;

/**
 * How many sub-threshold hours an episode may contain. Default 0: one hour
 * below the threshold ends the episode.
 */
export type MaxGapHours = number;

/**
 * ISO-8601 with an explicit `Z`. There is no offset-carrying local timestamp
 * anywhere on this surface; the two representations are UTC instants and
 * Brasilia civil dates, and mixing them is what the domain model's interval
 * convention exists to prevent.
 */
export type UtcInstant = string;

/**
 * `YYYY-MM-DD`, a civil date in `America/Sao_Paulo`. Never an instant.
 */
export type CivilDate = string;

/**
 * Integer 0-23, in `America/Sao_Paulo`.
 */
export type HourLocal = number;

/**
 * `HH:MM` in `America/Sao_Paulo`; minutes are always `00`. `24:00` is the
 * exclusive end of the day.
 */
export type ClockTime = string;

/**
 * Which of the two daily gates published this. `gate_early` is D-1 09:00 BRT
 * on the 00Z weather run; `gate_late` is D-1 19:00 BRT on the 12Z run.
 */
export type GateProfile = "gate_early" | "gate_late";

/**
 * `served` is a record of a publication. `backfilled_holdout` is a
 * counterfactual publication instant and is never returned by a live forecast
 * route under any query.
 */
export type OriginKind = "served" | "backfilled_holdout";

/**
 * Identity, never copy. The producer of a *curtailment* forecast is
 * `wattsteer`; `open_meteo` is the producer of the weather run it consumed,
 * which is a different fact about a different artifact.
 */
export type ForecastProducer = "open_meteo" | "ons_dessem" | "wattsteer";

/**
 * The identity of the run that produced a forecast. Every surface that shows a
 * forecast must name it. `weather_run_label` rides beside the WattSteer origin
 * rather than making a screen choose which of the two facts to call "the run".
 */
export interface ForecastOrigin {
  producer: ForecastProducer;
  /**
   * For a `wattsteer` forecast, the artifact version.
   */
  runLabel: string;
  /**
   * `gate_at(target_date, gate_profile)` - a property of the target date, not of
   * the request.
   */
  publishedAt: UtcInstant;
  /**
   * Derived and returned, so no screen computes a date difference against a
   * clock it may not have.
   */
  ageHours?: number;
  originKind?: OriginKind;
  gateProfile?: GateProfile;
  /**
   * The weather run the forecast was built on, e.g. "D-1 12Z".
   */
  weatherRunLabel?: string;
}

/**
 * A code; the client translates it.
 */
export type RiskClass = "low" | "elevated" | "high";

/**
 * A half-open probability interval `[lo, hi)`.
 */
export type RiskBin = [number, number];

/**
 * The cut points the risk class was read off, published beside every risk
 * class so the class is checkable rather than asserted.
 */
export interface RiskBins {
  low: RiskBin;
  elevated: RiskBin;
  high: RiskBin;
}

export type Probability = number;

/**
 * `avoided / baseline`. **`null`, never 0, when baseline curtailment is zero**
 * (vocabulary rule 4): the ratio is undefined, and a zero would read as
 * "nothing could be avoided" rather than "there was nothing to avoid". The
 * null is meaningful and the schema admits it explicitly.
 */
export type Avoidability = number | null;

/**
 * ONS's restriction reason, verbatim from the dictionary. The identifier
 * travels and the English gloss does not (vocabulary rule 7); the gloss is a
 * `t()` key. `REL` is grid unavailability, not "relaxamento".
 */
export type ReasonCode = "REL" | "CNF" | "ENE" | "PAR";

/**
 * Whether a restriction was local to the entity or systemic.
 */
export type RestrictionOrigin = "LOC" | "SIS";

/**
 * A unit as a code, so a reading is formatted in the reader's locale rather
 * than the server's.
 */
export type UnitCode = "mwh" | "mw" | "ratio" | "pct" | "hours" | "brl" | "count" | "m_s";

/**
 * Why a published figure has no band - an identity, never a sentence. One
 * member today: a quantile of a sum needs a joint draw, and the path ensemble
 * is drawn per subsystem.
 */
export type BandUnavailableReason = "no_joint_ensemble";

/**
 * `sha256:` followed by the digest of the canonical scenario bytes.
 */
export type ScenarioHash = string;

/**
 * What actually solved it. Carried so a plan is attributable to a backend and
 * a build.
 */
export interface SolverReceipt {
  backend: string;
  status: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNBOUNDED";
  wallTimeMs: number;
  objective?: number;
  ortoolsVersion?: string;
  scipVersion?: string;
}

/**
 * Money appears only as a labelled scenario with its assumed rate visible.
 * Never a market price.
 */
export interface EconomicScenario {
  brlPerMwh: number;
  brl: number;
}

/**
 * The four scalars evaluated on one realisation of the forecast.
 */
export interface ScoredRealisation {
  baselineMwh: number;
  remainingMwh: number;
  recoveredMwh: number;
  avoidability: Avoidability;
}

/**
 * One hour of the plan, in `America/Sao_Paulo` local hours.
 */
export interface DispatchHour {
  hourLocal: HourLocal;
  offeredMwh?: number;
  batteryChargeMw?: number;
  batteryDischargeMw?: number;
  stateOfChargeMwh?: number;
  loadShiftUpMw?: number;
  loadShiftDownMw?: number;
  absorbedMwh?: number;
}

/**
 * A read-time view, never a stored table. Every episode carries the
 * `threshold_mw` and `max_gap_hours` that produced it (vocabulary rule 8),
 * because an unstamped duration cannot be compared with another one.
 */
export interface CurtailmentEpisode {
  subsystem?: Subsystem;
  technology?: Technology;
  startedAt: UtcInstant;
  /**
   * Exclusive: the valid_time of the first hour below threshold.
   */
  endedAt: UtcInstant;
  durationHours: number;
  totalMwh: number;
  peakMw: number;
  thresholdMw: ThresholdMw;
  maxGapHours: MaxGapHours;
}

export interface CurtailmentHours {
  subsystem: Subsystem;
  /**
   * `null` when the range was not filtered by technology. A technology dimension
   * genuinely exists on the observed panels, which is why the `technology=`
   * parameter survives here and not on the forecast.
   */
  technology: Technology | null;
  from: UtcInstant;
  to: UtcInstant;
  asOf: UtcInstant;
  dataVersion: string;
  vintageFidelity: VintageFidelity;
  rows: CurtailmentHour[];
  /**
   * There is no response envelope on this surface. Pagination is needed on
   * exactly two routes and carries its own cursor field rather than buying a
   * `{data, meta}` wrapper for all fourteen.
   */
  nextCursor: string | null;
}

export interface CurtailmentHour {
  subsystem: Subsystem;
  technology: Technology;
  validTime: UtcInstant;
  hourLocal: HourLocal;
  /**
   * A measured actual. No band, because there is nothing to be uncertain about.
   */
  constrainedOffMwh: number;
}

export interface CurtailmentEpisodes {
  subsystem: Subsystem;
  from: UtcInstant;
  to: UtcInstant;
  asOf: UtcInstant;
  dataVersion: string;
  vintageFidelity: VintageFidelity;
  /**
   * Echoed at the top level as well as on every episode, so the parameter in
   * force is visible without reading a row.
   */
  thresholdMw: ThresholdMw;
  maxGapHours: MaxGapHours;
  episodes: CurtailmentEpisode[];
}

export interface ObservedReasons {
  subsystem: Subsystem;
  date: CivilDate;
  asOf: UtcInstant;
  dataVersion: string;
  vintageFidelity: VintageFidelity;
  rows: ObservedReason[];
}

/**
 * Reported at `ReportingEntity` grain. Nothing is aggregated to plant grain
 * and there is no `plant` parameter.
 */
export interface ObservedReason {
  /**
   * Required on every row, per the domain model's rule that screens label the
   * grain rather than assume it.
   */
  grain: "conjunto" | "self_reporting_plant";
  entityCode: string;
  /**
   * ONS's own name for the entity - a proper noun, not translated copy.
   */
  entityLabel: string;
  /**
   * The identifier. The English gloss is not returned (vocabulary rule 7); it is
   * a `t()` key.
   */
  reason: ReasonCode;
  origin: RestrictionOrigin;
  constrainedOffMwh: number;
  /**
   * ONS's free-text note, passed through verbatim when present. Not a gloss of
   * `reason`.
   */
  description: string | null;
  /**
   * The hour changed cause mid-way. Surfaced rather than hidden, because the
   * single stored reason is a simplification and hiding that would make it look
   * like an observation.
   */
  causeMixed: boolean;
}

/**
 * The renderer's entire world - the JSON handed to the language model that
 * writes the Explain paragraph. It is not an API response and never reaches a
 * client; it is here because it crosses the same boundary the wire does and
 * because `docs/specs/diagnosis.md`'s rule "the renderer may not compute" is
 * only enforceable if every number the copy could want is present *as a
 * number*. `top_two_share` looks redundant and is not: the prototype's own
 * fixture narration added two shares together.
 */
export interface DiagnosisNarrationInput {
  schemaVersion: "diagnosis.narration.v1";
  promptVersion: string;
  locale: "pt-BR" | "en-US";
  subsystem: Subsystem;
  /**
   * ONS's proper noun, untranslated.
   */
  subsystemDisplayName: string;
  targetDate: CivilDate;
  thresholdMw: ThresholdMw;
  /**
   * A reduced origin: the renderer needs the run's label, its gate and its
   * instant, and has nothing to say about the producer.
   */
  forecastOrigin: DiagnosisNarrationInputForecastOrigin;
  vintageFidelity: VintageFidelity;
  risk: DiagnosisNarrationInputRisk;
  /**
   * The day band arrives as three named scalars rather than as a `Band`, because
   * the renderer's numeric whitelist is flat and a nested object would let a
   * quantile be quoted as if it were the expectation. `day_expected_mwh` stays a
   * separate name from every `p*` for the same reason.
   */
  magnitude: DiagnosisNarrationInputMagnitude;
  attribution: DiagnosisNarrationInputAttribution;
  ruleFlags: RuleFlag[];
  observedReasonsLatest?: ObservedReasonsLatest;
}

/**
 * `GET /v1/diagnosis/day-ahead?subsystem=&date=&gate_profile=&locale=`. One
 * attribution per subsystem-day and **no `technology` parameter** - there is
 * no per-technology head to explain. All eight driver groups are returned,
 * ranked by |share|; the `share >= 0.03` / six-row / merge-into-`other`
 * display rule is the client's, so the merged row's `direction: "mixed"` is
 * computed in exactly one place. A withheld diagnosis is a **200** carrying
 * the drivers untouched and a template narration, never an error.
 */
export interface DiagnosisDayAhead {
  subsystem: Subsystem;
  targetDate: CivilDate;
  thresholdMw: ThresholdMw;
  forecastOrigin: ForecastOrigin;
  vintageFidelity: VintageFidelity;
  attribution: DiagnosisAttribution;
  ruleFlags: RuleFlag[];
  /**
   * Empty when nothing was withheld. A non-empty list is still a 200: "there is
   * nothing to explain" is an answer rather than an error.
   */
  withheldBy: string[];
  narration: Narration;
  observedReasonsLatest?: ObservedReasonsLatest;
}

/**
 * The eight groups of the driver-group map
 * (`apps/ml/src/wattsteer_ml/diagnosis/driver_groups.yaml`), which are a total
 * partition of the feature space. `other` is **not** a member: it is the
 * client's merged remainder and never travels on the wire.
 */
export type DriverCode =
  | "renewable_resource"
  | "demand_level"
  | "net_surplus"
  | "export_stress"
  | "ramp_shape"
  | "calendar_season"
  | "recent_history"
  | "data_conditions";

/**
 * `mixed` is deliberately absent. A grouped Shapley value is one number, so
 * each of the eight always has a sign; only the client's merged `other` row
 * can be mixed, and it is computed client-side so that the mixed rule lives in
 * one place.
 */
export type DriverDirection = "raises" | "lowers";

export interface Driver {
  code: DriverCode;
  /**
   * A `t()` key, not copy. An English label travelling through the data layer is
   * how a bilingual product goes monolingual again.
   */
  labelCode: string;
  /**
   * The signed grouped Shapley contribution itself, in MWh.
   */
  phiMwh: number;
  /**
   * Share of the attributed *movement*: |phi_j| / sum_k |phi_k|, computed over
   * **all eight** groups, not over the displayed ones. A denominator that does
   * not exist until after the display cut cannot be put on a wire.
   */
  share: Probability;
  direction: DriverDirection;
  /**
   * The feature name whose reading is quoted beside the group.
   */
  headlineFeature: string;
  /**
   * The headline feature's reading, as a number. Never a preformatted string
   * like "310 MW left": a preformatted value is a translated string by another
   * name, and the client formats this one through `Intl` against `unit`.
   */
  observed: number;
  /**
   * The same feature over the matched background, as a number, on the same terms
   * as `observed`.
   */
  typical: number;
  unit: UnitCode;
  hourDisagreement: number;
  demoted: boolean;
}

export interface DiagnosisAttribution {
  target: "expected_mwh_day";
  /**
   * day_expected_mwh - baseline_expected_mwh.
   */
  totalAttributedMwh: number;
  sumAbsAttributedMwh: number;
  stderrMwh: number;
  baselineExpectedMwh: number;
  dayExpectedMwh: number;
  driverGroupVersion: string;
  driverGroupHash: string;
  /**
   * All eight groups, ranked by |share|. Not a shortlist: the cut is the
   * client's.
   */
  drivers: Driver[];
  peakHourLocal: HourLocal;
  peakHourDrivers: Driver[];
}

/**
 * A domain rule that fired, as a code plus the facts it fired on. The sentence
 * is the client's.
 */
export interface RuleFlag {
  code: string;
  severity: "annotate" | "demote" | "withhold";
  /**
   * The values the rule fired on, keyed by name. A list of strings is permitted
   * because one shipping rule reports one - `stale_inputs` names every headline
   * feature that was NULL at serve time - and flattening it into one string here
   * would be assembling prose on the server.
   */
  facts: Record<string, string | number | boolean | null | unknown[]>;
}

/**
 * The narration panel's paragraph, in one of the only two shapes it can arrive
 * in. The model's arrives as prose - the single settled exception to "codes on
 * the wire, never translated strings". The template's does **not**: it arrives
 * as an ordered list of `t()` keys with their interpolation values, because a
 * template is a fixed string catalogue and a server that filled one in would
 * be deciding whether a number is written `412,0` or `412.0`. `source` says
 * which, so the panel's footnote stays true when a rule withheld the model's
 * or the daily cap was reached.
 */
export type Narration = NarrationFromModel | NarrationFromTemplate;

/**
 * Prose, generated in `locale` rather than translated into it, already past
 * the output validator's three gates.
 */
export interface NarrationFromModel {
  source: "model";
  text: string;
  locale: "pt-BR" | "en-US";
  promptVersion: string;
}

/**
 * The deterministic narration, as a plan rather than a paragraph. There is no
 * `text`: the clauses are `t()` keys the client looks up in its own catalogue
 * and fills with numbers it formats in its own locale, so decimal comma and
 * decimal point stay a property of the reader rather than of the server.
 */
export interface NarrationFromTemplate {
  source: "template";
  /**
   * In the order they are read. Every fired rule has one; a rule with no clause
   * is a failure upstream rather than a silent omission here.
   */
  clauses: NarrationClause[];
  locale: "pt-BR" | "en-US";
  promptVersion: string;
}

/**
 * One sentence of the deterministic paragraph: the key of the string, and the
 * values its `{placeholder}`s are filled with. A placeholder is always a value
 * - a number, a civil date, or a code the client has a label for - and never
 * another sentence.
 */
export interface NarrationClause {
  key: NarrationClauseKey;
  /**
   * Keyed by the **document field name** the value was read from, so a catalogue
   * string names the field it quotes. A list of strings is permitted for the
   * same reason `rule_flag.facts` permits one: `stale_inputs` reports a list of
   * headline features, and joining it here would be assembling prose on the
   * server.
   */
  values: Record<string, string | number | unknown[]>;
}

/**
 * The closed set of sentences the template can say. Closed so that both
 * message catalogues can be typed against it and a missing Portuguese clause
 * is a compile error rather than an English sentence in a Portuguese
 * paragraph.
 */
export type NarrationClauseKey =
  | "risk_low"
  | "risk_elevated"
  | "risk_high"
  | "magnitude"
  | "peak"
  | "driver_raises"
  | "driver_lowers"
  | "top_two_share"
  | "hour_disagreement"
  | "flag_nothing_to_explain"
  | "flag_attribution_is_noise"
  | "flag_stale_inputs_run_age"
  | "flag_stale_inputs_coverage"
  | "flag_stale_inputs_headline"
  | "flag_unmodelled_outage_regime";

/**
 * The most recent settled day's dominant restriction reason, as a code. The
 * gloss is a `t()` key and is not returned (vocabulary rule 7).
 */
export interface ObservedReasonsLatest {
  date: CivilDate;
  topReason: ReasonCode;
  topReasonShare: Probability;
}

/**
 * The body of every error this API returns. There is no second shape - not for
 * validation, not for a 404, not for an upstream refusal. The closed code enum
 * is `ERROR_STATUS` in `packages/core/src/errors.ts`, which this schema does
 * not restate: `packages/core/test/schema-generated-types.test.ts` asserts the
 * two agree member for member, so the TypeScript table stays the single
 * authority (ticket 02 built it; this schema is generated against it).
 */
export interface ErrorEnvelope {
  error: ErrorEnvelopeError;
}

/**
 * A sum type discriminated by `asset_type`, per `docs/domain-model.md` - not
 * one wide struct with mutually-exclusive nullable fields, which is what stops
 * a battery arriving with a `max_shift_mw`. `additionalProperties: false` on
 * each variant is what makes `FIELD_NOT_ON_VARIANT` a schema fact rather than
 * a hand-written rule. A value object with no persisted identity: ONS
 * publishes no flexibility-asset registry, so these are user-supplied scenario
 * inputs.
 */
export type FlexibilityAsset = Battery | ShiftableLoad;

export interface Battery {
  assetType: "battery";
  /**
   * Echoed back, never interpolated into SQL, a log format string or a tooltip
   * without escaping. The 64-character cap is `docs/specs/flex-optimizer.md`'s
   * untrusted-input hygiene rule: the scenario is attacker-controlled and the
   * label is the one free-text field on it.
   */
  label: string;
  subsystem: Subsystem;
  /**
   * Inverter limit on charge and discharge. The cap is `MAGNITUDE_OUT_OF_RANGE`:
   * the endpoint is public and unauthenticated, and the cap's job is to bound
   * the solver, not to model the market.
   */
  maxPowerMw: number;
  energyCapacityMwh: number;
  /**
   * `RTE_OUT_OF_RANGE` is [0.50, 1.00).
   */
  roundTripEfficiency?: number;
  chargeEfficiency?: number;
  dischargeEfficiency?: number;
  initialStateOfCharge: number;
  minStateOfCharge?: number;
  maxStateOfCharge?: number;
  maxChargeMw?: number;
  maxDischargeMw?: number;
  availableFrom?: ClockTime;
  availableTo?: ClockTime;
}

export interface ShiftableLoad {
  assetType: "shiftable_load";
  /**
   * Echoed back, never interpolated into SQL, a log format string or a tooltip
   * without escaping. The 64-character cap is `docs/specs/flex-optimizer.md`'s
   * untrusted-input hygiene rule: the scenario is attacker-controlled and the
   * label is the one free-text field on it.
   */
  label: string;
  subsystem: Subsystem;
  /**
   * Connection limit.
   */
  maxPowerMw: number;
  /**
   * The shiftable portion. `SHIFT_EXCEEDS_CONNECTION` and
   * `SHIFT_EXCEEDS_BASELINE` are cross-field rules the gateway validates; a
   * schema cannot express either.
   */
  maxShiftMw: number;
  /**
   * `L` - the window within which a shift must be compensated.
   */
  shiftWindowHours: number;
  /**
   * A validation input, not a constraint: with no baseline profile supplied it
   * fixes the flat baseline at `daily_energy_mwh / 24`.
   */
  dailyEnergyMwh: number;
  recoveryTimeHours?: number | null;
  availableFrom?: ClockTime;
  availableTo?: ClockTime;
}

/**
 * `GET /v1/forecast/day-ahead?subsystem=&target_date=&gate_profile=`. **There
 * is no `technology` parameter and no per-technology band**: the forecast
 * grain is the subsystem and the split is two scalars. `day_energy_mwh` and
 * `peak_power_mw` are read from the persisted day-grain row - they are
 * path-ensemble quantiles and are never a componentwise sum of
 * `hours[].constrained_off_mwh`.
 */
export interface ForecastDayAhead {
  subsystem: Subsystem;
  onsDisplayName: string;
  targetDate: CivilDate;
  thresholdMw: ThresholdMw;
  forecastOrigin: ForecastOrigin;
  vintageFidelity: VintageFidelity;
  artifact: ForecastArtifact;
  riskBins: RiskBins;
  /**
   * From the path ensemble, not from 1 - prod(1 - p) over the hours.
   */
  dayOccurrenceProbability: Probability;
  riskClass: RiskClass;
  dayEnergyMwh: Band;
  peakPowerMw: Band;
  /**
   * A sibling of the day band, never its centre (vocabulary rule 2).
   */
  dayExpectedMwh: number;
  split: TechnologySplit;
  hoursP50Nonzero: number;
  hours: CurtailmentHourForecast[];
}

/**
 * Which model produced this, and how far its training window reached.
 */
export interface ForecastArtifact {
  artifactId: string;
  featureSet: string;
  trainedThrough: CivilDate;
}

/**
 * One hour, carrying its own expectation and its own scalar split.
 * `valid_time` is a UTC instant at the start of the interval; `hour_local` is
 * the same hour written as a Brasilia clock hour, and the two are given rather
 * than one being derivable only with a timezone database the client may not
 * have.
 */
export interface CurtailmentHourForecast {
  validTime: UtcInstant;
  hourLocal: HourLocal;
  constrainedOffMwh: Band;
  /**
   * A sibling of the hourly band, never inside it.
   */
  expectedMwh: number;
  occurrenceProbability: Probability;
  split: TechnologySplit;
}

/**
 * `GET /v1/grid/now` - observed, not forecast. It needs no model, which is
 * what makes it the honest thing to show on a landing page when no artifact is
 * promoted. Its national total *is* legitimate where the forecast's is not:
 * observations add exactly, and `national.derived` is a field rather than a
 * comment so the addition is stated on the wire.
 */
export interface GridNow {
  /**
   * The vintage cut: what WattSteer had learned by this instant.
   */
  asOf: UtcInstant;
  latestSettledHour: UtcInstant;
  lagHours: number;
  vintageFidelity: VintageFidelity;
  subsystems: SubsystemNow[];
  national: NationalNow;
}

export interface SubsystemNow {
  subsystem: Subsystem;
  onsDisplayName: string;
  last24hConstrainedOffMwh: number;
  latestHourConstrainedOffMwh: number;
  split: TechnologySplit;
}

/**
 * The national observed total, with its derivation named on the object. `SIN`
 * is not a subsystem; this key is where a national number is allowed to exist.
 */
export interface NationalNow {
  last24hConstrainedOffMwh: number;
  /**
   * A field and not a comment: it says which four rows were added, so a reader
   * cannot mistake it for an ONS `SIN` row.
   */
  derived: "sum_of_four";
}

/**
 * `GET /v1/grid/outlook` - the one call the landing hero and the Overview's
 * first paint both make. Four subsystems, one target date, no hourly detail
 * and no drivers. The national figure is an expectation and a count of
 * subsystems per risk class, because expectations add exactly and quantiles do
 * not - plus a joint band read from the persisted national day row, whose
 * quantiles are taken over the four subsystems' paths added draw by draw under
 * one shared index. Where no national row was published, `national.band` is
 * `null` and carries `band_unavailable_reason`.
 */
export interface GridOutlook {
  targetDate: CivilDate;
  thresholdMw: ThresholdMw;
  forecastOrigin: ForecastOrigin;
  vintageFidelity: VintageFidelity;
  riskBins: RiskBins;
  subsystems: SubsystemOutlook[];
  national: NationalOutlook;
}

/**
 * One subsystem's day-grain readout. `day_expected_mwh` is a **sibling** of
 * `day_energy_mwh`, never its `p50` (vocabulary rule 2): for a mixture the
 * expectation exceeds the median whenever the occurrence probability is below
 * a half.
 */
export interface SubsystemOutlook {
  subsystem: Subsystem;
  /**
   * ONS's own string, untranslated, so a subsystem stays searchable against the
   * files it came from.
   */
  onsDisplayName: string;
  /**
   * From the path ensemble, not from 1 - prod(1 - p) over the hours.
   */
  dayOccurrenceProbability: Probability;
  riskClass: RiskClass;
  /**
   * Path-ensemble quantiles read from the persisted day-grain row. Never a
   * componentwise sum of the hourly band.
   */
  dayEnergyMwh: Band;
  peakPowerMw: Band;
  /**
   * E[Y] for the day. The diagnosis engine's attribution target, and the one
   * national-additive quantity.
   */
  dayExpectedMwh: number;
  split: TechnologySplit;
}

/**
 * The one place a national number exists, with its derivation named. `SIN` is
 * not a subsystem (vocabulary rule 6), so the national figure lives under this
 * key rather than as a fifth row. The band is a quantile of the four
 * subsystems' day totals added on the same draw, and never a sum of four
 * bands: the median of a sum is not the sum of the medians, and the four
 * subsystems' curtailment is not comonotone. Where no such row exists the band
 * is `null` and says why.
 */
export interface NationalOutlook {
  /**
   * The sum of the four `day_expected_mwh`. Expectations add exactly; this is
   * the only additive forecast quantity.
   */
  expectedMwh: number;
  riskClassCounts: NationalOutlookRiskClassCounts;
  /**
   * The persisted joint band - quantiles over the draws of the four subsystems'
   * day totals added under one shared draw index. `null`, with a stated reason,
   * when no national row was published for this day: an artifact trained before
   * the shared draw index landed has none. Never assembled by adding the four
   * subsystem bands.
   */
  band: Band | null;
  bandUnavailableReason: BandUnavailableReason | null;
}

/**
 * `GET /v1/meta` - the precondition every screen reads first, and the endpoint
 * that makes a misconfigured deployment diagnosable in one request. It is the
 * gateway's own answer and not a proxy of the modelling service's: it merges
 * what only the gateway knows with what only the modelling service knows, and
 * it **degrades** - if the modelling service is unreachable, `model.reachable`
 * is false and the rest of the body is still correct. `no-store`, because it
 * is what you read to discover something is broken.
 */
export interface Meta {
  service: string;
  version: string;
  environment: string;
  serverTime: UtcInstant;
  window: MetaWindow;
  /**
   * The four published constants, echoed. `packages/core/src/constants.ts` is
   * the definition; this is diagnosability, never a source a client should fetch
   * in order to use.
   */
  defaults: MetaDefaults;
  gates: MetaGate[];
  model: MetaModel;
  forecast: MetaForecastState;
  data: MetaData;
  /**
   * `REFERENCE_FLEET`, echoed for diagnosability. Echoed, never fetched in order
   * to be used: a caller that reads it over HTTP can be served a different
   * battery than the one the number it is looking at was computed against. Its
   * fields are named here rather than left as a free-form object so that the one
   * translator renames them: `max_power_mw` is a field name, and a block whose
   * shape the table does not know travels in whatever casing the gateway
   * happened to build it in.
   */
  referenceFleet: MetaReferenceFleet;
  declines: MetaDeclines;
  caveats: MetaCaveats;
  /**
   * Data rather than copy, because the ODbL/CC-BY notice is bilingual and a
   * bilingual notice assembled from translated strings around untranslated
   * licence identifiers is exactly the shape `docs/specs/i18n.md` asks for. The
   * keys are source identifiers and are *data*, so they travel untouched; the
   * values are a named shape and their fields are renamed like any other
   * object's, which is what puts `derivative_database` on the wire under that
   * name.
   */
  attribution: Record<string, SourceAttribution>;
}

/**
 * Every figure this deployment declines to state, and why - one place
 * answering the question that was previously only answerable by reading cards,
 * blocks and wire fields. **Assembled, never hand-written**: the modelling
 * service's half is taken by walking its own package for declared reason
 * constants (`apps/ml/src/wattsteer_ml/declined.py`), the gateway's half is
 * keyed by the schema enum that owns it (`packages/core/src/declines.ts`), and
 * adding a named reason to either requires editing no list. It is a property
 * of the *code that answered* rather than of what is on the volume, which is
 * why an unmounted volume empties `model.lanes` and changes nothing here.
 */
export interface MetaDeclines {
  /**
   * In `name` order, so two deployments are diffable.
   */
  figures: DeclinedFigure[];
  /**
   * Why this list may be **short**, or `null` when it is whole. A census of what
   * a system refuses to claim is the last place that could afford to imply a
   * completeness it does not have, so an unreachable modelling service is stated
   * here rather than silently costing the caller its half: the code the
   * gateway's edge produced (`OPTIMIZER_UNAVAILABLE`, `OPTIMIZER_TIMEOUT`,
   * `OPTIMIZER_NOT_CONFIGURED`), or `MODEL_DECLINES_NOT_REPORTED` for a
   * modelling service that answered without this block at all - which is an
   * older build, and not a build with nothing to declare.
   */
  incompleteReason: string | null;
}

/**
 * One figure that is not published, and the four things a reader needs to act
 * on it: which figure, why, whether it *cannot* be produced or merely has not
 * been, and where they would have met it. Every field is prose - there is no
 * number anywhere on this surface, because a census of withheld measurements
 * is the last place that could carry a figure a reader might take for one.
 */
export interface DeclinedFigure {
  /**
   * The reason constant's identifier, or the wire identity where the absence is
   * one - a grep target, so this census is a way into the code rather than a
   * restatement of it.
   */
  name: string;
  /**
   * Where the reason is declared, as a repository path.
   */
  declaredIn: string;
  /**
   * Which number is not stated, as a noun phrase. A reason sentence explains an
   * absence; it does not name the thing absent, and a census whose rows do not
   * name the quantity is a census of prose.
   */
  figure: string;
  /**
   * `unrunnable` - the figure cannot be produced here. `unrun` - it can be, and
   * nobody has. The two are two on purpose and must not be collapsed: forecaster
   * 16's `ARCHIVE_FEATURES_HAVE_NO_SHAPE` says a thing cannot be built, and
   * forecaster 18 chose `NOT_RUN_YET` precisely so that it would not read like
   * that. `unresolvable` is not a third kind - it is this gateway refusing to
   * guess between the two for a value a newer modelling service reported and
   * this build does not recognise, exactly as it refuses to round an unknown
   * lane state down to `no_artifact`.
   */
  kind: "unrunnable" | "unrun" | "unresolvable";
  /**
   * The sentence the card already carries, verbatim. Not re-worded on the way
   * out: the forecaster owns the vocabulary of its own absences, and a rename
   * here is where two vocabularies start.
   */
  reason: string;
  /**
   * The response, card block or field a caller actually meets this absence on.
   */
  surface: string;
  /**
   * Why `kind` is `unresolvable`, naming the value that was reported. Absent for
   * every kind this build recognises.
   */
  fault?: string;
}

/**
 * Every figure this deployment publishes *with* a caveat that changes what it
 * means - the mirror of `declines`, and the sharper of the two. An absent
 * figure cannot mislead anybody: a reader who wanted it is told why it is not
 * there. A present figure carrying a caveat nobody reads is a number that will
 * be quoted, and `coverage_p10 = 1.0` is the case that proves it - real
 * arithmetic, computed over zero rows on which the served floor was a positive
 * number, read for months as evidence that the floor was perfect. Nobody was
 * lying; the caveat was simply not attached to the number. **Assembled, never
 * hand-written**, on `declines`' mechanism and for a stronger reason: a caveat
 * list rots faster than an absence list, because a caveat attaches to a number
 * people actively use. A caveat sentence *is* its census entry - a `str`
 * subclass declared beside the code that publishes it, which
 * `apps/ml/src/wattsteer_ml/caveated.py` walks the package for - so nothing
 * about where a consumer meets one has moved and adding one edits no list.
 * **Collected here and attached there, and the two are not alternatives.**
 * Every one of these sentences is also published in the block that carries the
 * figure, because a caveat on this endpoint does nothing for the code path
 * that reads `share_p50_zero`; this half is for a reviewer, who cannot read
 * every card block to discover which of a build's numbers do not mean what
 * they say. It is **not** a third `kind` on `declines`: `unrunnable` and
 * `unrun` are two answers to one question - does this figure exist? - and
 * every row here answers yes to it, so filing one under a heading whose whole
 * contract is absence would tell a reviewer `coverage_p10` was withheld when
 * the defect is precisely that it is not.
 */
export interface MetaCaveats {
  /**
   * In `(declared_in, name)` order, so two deployments are diffable. Sorted on
   * the pair and not on the name alone because the name is deliberately not
   * unique: six blocks declare a `_NOT_A_READING`, each naming its own figures,
   * and renaming them apart so that a bare string could be an identity would
   * invent six distinctions where there is one recurring defect.
   */
  figures: CaveatedFigure[];
  /**
   * Why this list may be **short**, or `null` when it is whole. Every row is the
   * modelling service's: the gateway publishes no figure of its own to caveat,
   * which is why this block has no gateway half where `declines` has one, and
   * `no_joint_ensemble` is a figure the gateway *withholds* rather than states.
   * So an unreachable modelling service costs the whole census and says so - the
   * code the gateway's edge produced (`OPTIMIZER_UNAVAILABLE`,
   * `OPTIMIZER_TIMEOUT`, `OPTIMIZER_NOT_CONFIGURED`), or
   * `MODEL_CAVEATS_NOT_REPORTED` for a modelling service that answered without
   * this block at all - which is an older build, and not a build every one of
   * whose published numbers means what it says.
   */
  incompleteReason: string | null;
}

/**
 * One published figure that does not mean what its name says, and the five
 * things a reader needs in order to stop quoting it wrongly: which figure, the
 * sentence that corrects it, what it reads as without that sentence, where the
 * two are met together, and where the caveat is declared. Every field is prose
 * - a list of numbers that mean something other than what they say is the last
 * surface that could afford to carry one.
 */
export interface CaveatedFigure {
  /**
   * The caveat constant's identifier, or the subscript it is published under
   * (`COMPARABILITY["pr_auc"]`) - a grep target, so this census is a way into
   * the code rather than a restatement of it. **Not unique**, and not meant to
   * be: with `declared_in` it is the identity of a row.
   */
  name: string;
  /**
   * Where the caveat is declared, as a repository path.
   */
  declaredIn: string;
  /**
   * Which published number this changes the meaning of, as a noun phrase,
   * including the condition it holds under where the caveat is conditional -
   * `coverage_p10, on a fold where coverage_stated_rows_p10 is zero`.
   */
  figure: string;
  /**
   * The sentence the block already carries, verbatim. Not re-worded on the way
   * out and not relocated: several of these are load-bearing where they stand -
   * `NOT_A_NINETY_PERCENT_BAND` says a band must not be described as a 90% band,
   * `COMPARABILITY` is what stops five of six sweep figures being read across
   * the arms, and the `_NOT_A_READING` prose is what a reader of a fabricated
   * block meets first.
   */
  caveat: string;
  /**
   * **The sentence this caveat exists to make false**: what the number reads as
   * if a reader takes the name and the value and nothing else. Required at
   * declaration, and it is the forced choice of this census the way `kind` is
   * forced for a declined figure - an author who cannot write down what the
   * figure would be quoted as has not decided whether it is misleading, and the
   * caveat they wrote is decoration.
   */
  misreading: string;
  /**
   * The block, field or response where a consumer meets the figure and this
   * sentence *together*. Never `GET /v1/meta` itself: this census collects, and
   * every entry is attached where its figure is published as well.
   */
  surface: string;
  /**
   * Why a field on this row could not be resolved, naming what was reported.
   * Absent for a row that arrived whole. The row is reported as it arrived
   * rather than dropped: a census that shed what it could not read would be
   * shorter than the truth, which is the one direction it may never be wrong in.
   */
  fault?: string;
}

export interface MetaGate {
  profile: GateProfile;
  publishesAtLocal: ClockTime;
  timezone: "America/Sao_Paulo";
  weatherRun: "00Z" | "12Z";
}

/**
 * `state` reproduces the forecaster's three artifact states verbatim, because
 * a stale forecast and an unmounted volume must not look alike.
 */
export interface MetaLane {
  lane: string;
  /**
   * The forecaster's three states, verbatim, plus `unresolvable` - which is not
   * a fourth state so much as the refusal to guess between the first three.
   * `apps/ml/src/wattsteer_ml/artifacts.py` produces it for a corrupt promotion
   * log or a `promote` line naming an artifact that is not on the volume, and
   * the one thing that module must never do when it cannot tell is fall back to
   * the newest file. Neither may this endpoint: mapping it onto `no_artifact`
   * would report a damaged volume as an untrained lane.
   */
  state: "no_artifact" | "present_unpromoted" | "promoted" | "unresolvable";
  /**
   * Why the lane is `unresolvable`, in the modelling service's own prose. Absent
   * for every other state.
   */
  fault?: string;
  /**
   * Whether this lane can answer a forecast right now - promoted *and* loadable.
   * `state: "promoted"` alone is not enough: an artifact the hot-swap gate
   * marked invalid against the live feature contract is refused by the loader,
   * so a lane can be promoted and still serve nothing. Absent when the modelling
   * service is too old to report it, which is not the same as `false`.
   */
  usable?: boolean;
  /**
   * True when the artifact this lane is promoted to serve is bound to a
   * `feature_hash` the live `feature_rows` no longer produces.
   * `0039_the_gate_over_a_backfill.sql` put both serving lanes here at once by
   * repairing the feature gate's `as_of` inside `feature_rows`, which moved the
   * hash on purpose. It is the one unserviceable state that needs a retrain
   * rather than time, a first training run or a repaired volume - and the one an
   * operator has to be told about without triggering a promotion attempt to find
   * out.
   */
  retrainOwed?: boolean;
  /**
   * The gate's own prose for why the promoted artifact will not load. Present
   * exactly when `retrain_owed` is true.
   */
  contractFault?: string;
  /**
   * Why the promoted artifact's card could not be read, when it could not. Kept
   * apart from `contract_fault` because the repair is the volume's rather than
   * the model's, and while it is set nothing can say whether a retrain is also
   * owed - so `retrain_owed` is false, not unknown-as-true.
   */
  cardError?: string;
  /**
   * One sentence saying why this lane has no usable artifact, or absent when it
   * has one. It distinguishes a retrain debt from the weeks of
   * `freshness_and_coverage` refusals that are the gate working: check 4's
   * sixty-test-day floor and the quarterly live edge mean a candidate can only
   * be promoted in roughly the last third of each quarter, and this sentence
   * says so during those weeks rather than reading as an alarm.
   */
  unusableReason?: string;
  artifactId?: string | null;
  trainedThrough?: CivilDate | null;
  vintageFidelity?: VintageFidelity;
}

export interface MetaModel {
  reachable: boolean;
  /**
   * The error code the gateway's edge onto the modelling service produced -
   * `OPTIMIZER_UNAVAILABLE`, `OPTIMIZER_TIMEOUT`, `OPTIMIZER_NOT_CONFIGURED`.
   * Present only when `reachable` is false, and it is the difference between
   * "not deployed" and "deployed and broken", which is the whole reason an
   * operator reads this endpoint.
   */
  unreachableReason?: string;
  lanes: MetaLane[];
  /**
   * Reported separately from the lane state, so an unmounted volume is
   * diagnosable rather than inferred from an absent artifact. `null` when the
   * modelling service is unreachable: the volume is mounted into *that* process,
   * so with the service unreachable its state is unknown, and `{mounted: false}`
   * would be a claim this endpoint cannot support.
   */
  volume: MetaModelVolume | null;
}

export interface MetaForecastState {
  latestPublished: MetaForecastStateLatestPublishedItem[];
  /**
   * What makes this surface pull-shaped rather than push-shaped: the data
   * changes twice a day at known instants.
   */
  nextPublicationAt: UtcInstant;
}

/**
 * One ingestion source, and how far behind it is. The three instants are
 * nullable because a source that has **never** ingested is the most diagnostic
 * line this endpoint can carry, and the alternative - omitting the source - is
 * precisely how a feed that silently stopped becomes invisible. A null lag is
 * not a zero lag.
 */
export interface MetaFreshness {
  source: string;
  latestValidTime: UtcInstant | null;
  latestIngestedAt: UtcInstant | null;
  /**
   * Hours behind now, on the basis this source is judged by - the newest fact
   * time for an observation series, the newest ingestion for a forecast whose
   * valid time is in the future by construction.
   */
  lagHours: number | null;
}

/**
 * The published battery. Deliberately not `flexibility-asset.schema.json`'s
 * `battery`: that one requires a `subsystem`, and the reference fleet is
 * subsystem-agnostic by construction - it is the fleet every subsystem's floor
 * coverage is measured against.
 */
export interface ReferenceBattery {
  assetType: "battery";
  label: string;
  maxPowerMw: number;
  energyCapacityMwh: number;
  roundTripEfficiency: number;
  initialStateOfCharge: number;
}

/**
 * The published flexible load. Subsystem-agnostic for the same reason the
 * battery is.
 */
export interface ReferenceShiftableLoad {
  assetType: "shiftable_load";
  label: string;
  maxPowerMw: number;
  maxShiftMw: number;
  shiftWindowHours: number;
  dailyEnergyMwh: number;
}

export interface SourceAttribution {
  name: string;
  /**
   * An SPDX-style identifier, untranslated, with the bilingual notice built
   * around it by the client.
   */
  licence: string;
  url: string;
  derivativeDatabase?: boolean;
  /**
   * ODbL 4.6 obliges machine-readable access to a Derivative Database. This is
   * where the obligation is discharged.
   */
  machineReadableAt?: string;
}

/**
 * `GET /v1/model/card` - the Explain screen's second call. Model metadata and
 * never a day's answer: the reliability curve is a property of the *model*, so
 * folding it into the per-day payload would give a weekly-changing object a
 * daily cache key. This is the **product-facing subset** of the artifact card;
 * `card_url` points at the whole document. Every field forwarded from the card
 * keeps the card's own spelling, because the forecaster owns that vocabulary
 * and a rename here is where two vocabularies start.
 */
export interface ModelCard {
  lane: LaneName;
  /**
   * Always `promoted` on a 200. The other three states are not a card with empty
   * groups - they are a `MODEL_UNAVAILABLE` carrying `details.lane_state`.
   */
  laneState: "promoted";
  artifact: CardArtifact;
  fold: CardFold;
  windows: CardWindows;
  reliability: Reliability;
  riskBins: RiskBins;
  band: BandCalibration;
  ensemble: EnsembleSummary;
  /**
   * The headline metrics table, one row per fold and per rung of the baseline
   * ladder. `null` when the card carries no Metrics group - which is "not
   * measured yet", and is why `metrics_absent_reason` is required beside it
   * rather than an empty array standing in for a table nobody ran.
   */
  metrics: MetricsRow[] | null;
  /**
   * Why the metrics table is `null`. English prose for a developer and an
   * auditor, in the same status as an error `message`: never rendered to a user.
   */
  metricsAbsentReason: string | null;
  /**
   * The hot-swap gate's Decision group - what it decided about this artifact and
   * why. `null` on a card written before a gate ran over it.
   */
  decision: GateDecision | null;
  /**
   * Where the raw `*.card.json` is served, for anyone auditing. A path relative
   * to this API's own origin, because the API has no reliable knowledge of the
   * origin a client reached it through.
   */
  cardUrl: string;
}

/**
 * The artifact lane's directory name - `dessem_free_v1__gate_late__thr5`. The
 * addressable unit a forecast is served from: a feature set, a gate profile
 * and a threshold, in one identifier rather than three loose fields that could
 * disagree.
 */
export type LaneName = string;

/**
 * A closed interval of Brasilia civil dates, both ends inclusive, exactly as
 * the card records it.
 */
export interface CardWindow {
  start: CivilDate;
  end: CivilDate;
}

/**
 * The lane's identity and the artifact's. `feature_hash` is the whole feature
 * contract in one value: the names, the dtypes and the categorical levels are
 * on the raw card and are not on this wire, because a client that needs them
 * is auditing rather than rendering.
 */
export interface CardArtifact {
  /**
   * The bundle's stem, which is an ISO-8601 UTC instant. This is also the
   * `run_label` a `wattsteer` `ForecastOrigin` carries, and the response's own
   * ETag.
   */
  artifactId: UtcInstant;
  createdAt: UtcInstant;
  estimatorFamily: string;
  modelConfigVersion: string;
  featureSet: string;
  /**
   * `null` until the feature dictionary publishes one. An explicit null rather
   * than a string nobody minted: a card claiming a version that was never issued
   * is worse than one saying the version is unknown.
   */
  featureSetVersion: string | null;
  gateProfile: GateProfile;
  thresholdMw: ThresholdMw;
  featureHash: string;
  gitShaMl: string | null;
  gitShaApi: string | null;
}

/**
 * Which fold of the walk-forward calendar this artifact was trained and scored
 * on, and the two hashes that make the fold reproducible.
 */
export interface CardFold {
  foldId: string;
  foldHash: string;
  rulesDigest: string;
}

/**
 * What the artifact saw, and when. The calibration window is carved out of the
 * training block, so the two overlap by construction and are published
 * separately anyway - Replay asserts a held-out day against **both**, and a
 * check against one is a weaker check.
 */
export interface CardWindows {
  training: CardWindow;
  baseFit: CardWindow;
  calibration: CardWindow;
  test: CardWindow;
  /**
   * Training rows counted per `VintageFidelity`, never averaged across it
   * (vocabulary rule 9). A fold spanning ingestion go-live is two numbers,
   * because their mean describes no fold.
   */
  rowsByVintageFidelity: Record<string, number>;
}

/**
 * One bin of the curve. `mean_predicted` and not the bin centre: after a merge
 * a bin can be 0.2 wide, and the gap that matters is between what was *said*
 * and what happened. `merged` is on the point so a wide bin is visibly a
 * merged one rather than an oddly shaped chart.
 */
export interface ReliabilityPoint {
  binLower: Probability;
  binUpper: Probability;
  binCentre: Probability;
  meanPredicted: Probability;
  observedFrequency: Probability;
  hourCount: number;
  merged: boolean;
}

/**
 * The calibration curve and the three scalars read off it, with the window and
 * the vintage fidelity they are true over. The fidelity is one value and never
 * a mix: a pooled curve that spanned ingestion go-live would be
 * `revision_optimistic` with no way to say how much of it was, so the pool is
 * refused rather than labelled.
 */
export interface Reliability {
  points: ReliabilityPoint[];
  /**
   * Hours behind the whole curve. Equal to the sum of the points' `hour_count`
   * by construction.
   */
  sampleHours: number;
  window: CardWindow;
  vintageFidelity: VintageFidelity;
  /**
   * The folds whose out-of-fold predictions were pooled. A curve that cannot say
   * which folds it pooled is a curve nobody can reproduce.
   */
  folds: string[];
  /**
   * Pooled hours dropped because they fell inside the calibration window the
   * isotonic map was fitted on. Published rather than silently netted off, so a
   * reader can tell "the pool had some and they were removed" from "the pool had
   * none".
   */
  excludedCalibrationHours: number;
  /**
   * Expected calibration error: the hour-weighted mean absolute gap.
   */
  ece: number;
  /**
   * Maximum calibration error: the worst bin gap, unweighted.
   */
  mce: number;
  /**
   * The **signed** gap of the bin reaching 1.0, reported on its own because that
   * is where a curtailment classifier fails and where the product's confident
   * sentences come from. Positive means the model said more than happened.
   * Signed, so an absolute value cannot hide the direction.
   */
  topBinGap: number;
}

/**
 * How much of one tail's conformal correction reaches the **served** band. An
 * identifier and never copy. It is a property of the `correction_regime`,
 * resolved from a published table rather than inferred: a regime this API has
 * no entry for is refused, because guessing a tail's status is exactly the
 * number that is wrong in a direction nobody can see.
 */
export type CorrectionReach = "full" | "partial";

/**
 * The half of the band the product quotes. `delta_lo` reaches the composed P10
 * in full at every occurrence probability whose P10 is a positive number, and
 * did so under both correction regimes: `recovered_floor_mwh` is simulated
 * against this tail and forecaster ticket 21 moved the other one without
 * moving this.
 */
export interface LowerTailCoverage {
  coverageP10: Probability;
  /**
   * The scored hours whose composed P10 is a **positive number** - the rows on
   * which this edge states a bound at all. `coverage_p10` is counted over every
   * curtailed hour of the fold, and on an hour where `p <= 0.90` the served
   * floor is exactly 0 MWh, so `y >= P10` holds for free and the row enters the
   * numerator without ever having tested the floor. A `stated_rows` of 0 beside
   * a `coverage_p10` of 1.0 is therefore arithmetic over an edge that is zero
   * everywhere and not a floor that held, which is the reading forecaster ticket
   * 24 found in the wild.
   */
  statedRows: number;
  /**
   * `coverage_p10` counted over `stated_rows` alone, or **null** where there are
   * none. Null and never 1.0: a fold on which the floor was never a bound has no
   * lower coverage, and a perfect score printed in that slot is exactly how the
   * vacuous figure came to be read as evidence.
   */
  coverageP10WhereStated: Probability | null;
  correctionApplied: CorrectionReach;
  /**
   * The product figure simulated against this half of the band.
   * `recovered_floor_mwh` is the number the prose quotes, and it is a floor
   * because it is simulated against P10 - so the exactness of *this* tail is the
   * thing that sentence rests on.
   */
  quotedAs: "recovered_floor_mwh";
}

/**
 * The band's upper half, with the fact that makes it readable attached rather
 * than beside it. `coverage_p90` is **not readable without**
 * `upper_correction_realised`, and what that number means is set by
 * `correction_regime`. Under `conformal_v1_partial_upper` the correction was
 * applied to the 0.90 knot of `Q_pos`, which composition reads below for every
 * `p < 1` and not at all at `p <= 0.20`, so a short `coverage_p90` was
 * under-application. Under `conformal_v2_full_upper` the correction is a shift
 * in `q` on the composed quantile and arrives whole, so the realised share
 * reports instead how many scored hours have a positive P90 at all - at `p <=
 * 0.10` the served P90 is exactly zero because the mixture is stating at least
 * a 90% chance of no curtailment. Either way a P90 published without it
 * invites a conclusion about the fit that belongs elsewhere, so the schema
 * makes the three fields required together.
 */
export interface UpperTailCoverage {
  coverageP90: Probability;
  /**
   * The scored hours whose composed P90 is a **positive number**. Its lower
   * twin's mirror image, with the sign flipped: where the P90 is on the point
   * mass, `y <= P90` is false with certainty for exactly the reason `y >= P10`
   * is true for free, so the row enters `coverage_p90`'s denominator as a
   * guaranteed failure. `upper_correction_realised` is this count over `rows`;
   * the count is published beside the share because a denominator a reader can
   * see is what makes the marginal readable.
   */
  statedRows: number;
  /**
   * `coverage_p90` counted over `stated_rows` alone, or **null** where there are
   * none. This is the figure the **conformal correction's width** is answerable
   * for. The marginal is this times `upper_correction_realised`, exactly, and
   * only the second factor is a fact about the classifier: a short marginal
   * beside a nominal figure here is the point mass, not a band too narrow at the
   * top.
   */
  coverageP90WhereStated: Probability | null;
  correctionApplied: CorrectionReach;
  /**
   * The mean share of `delta_hi` that actually reached the composed P90 over the
   * scored hours. `1.0` is the correction applied in full everywhere. Below it,
   * read against `correction_regime`: under `conformal_v1_partial_upper` it is
   * `delta_hi` lost in the interpolant, and under `conformal_v2_full_upper` it
   * is the share of scored hours the classifier placed on the mixture's point
   * mass at zero, where the P90 is structurally zero and bounds `coverage_p90`
   * from above.
   */
  upperCorrectionRealised: Probability;
  /**
   * The card's own sentence about the pair above, verbatim. English prose for a
   * developer and an auditor, in the same status as an error `message`: it is
   * never rendered to a user, and a client that renders it has a bug.
   */
  upperCorrectionNote: string;
}

/**
 * Empirical coverage of the fold's test period, **split by tail**. The two
 * halves are separate objects and not two numbers side by side, because
 * whether they are the same kind of statement depends on `correction_regime`:
 * under `conformal_v1_partial_upper` the lower correction reached the served
 * band in full and the upper one arrived in part, and a reader comparing the
 * two without that fact drew the wrong conclusion about the fit. Under
 * `conformal_v2_full_upper` both reach it in full and the comparison is
 * direct. The split stays because the regime is data and the reader still has
 * to be told which one they are looking at. The population is the fold's
 * curtailed hours - over *every* hour the lower statement is trivially true,
 * because the composed P10 is zero wherever `p <= 0.90`.
 */
export interface Coverage {
  foldId: string;
  population: "curtailed_hours";
  rows: number;
  target: Probability;
  /**
   * The window the hot-swap gate vetoes outside. Published so the verdict beside
   * it is checkable rather than asserted.
   */
  guardrail: Probability[];
  guardrailSatisfied: boolean;
  /**
   * Whether this fold's served band **may be described as a 90% band** over its
   * curtailed hours. False unless both marginals sit inside `guardrail` and both
   * tails state a bound on at least one row. It is `false` on a band whose upper
   * marginal falls short *and* on one whose `coverage_p10` is a vacuous 1.0, and
   * a client that renders a coverage claim without reading it has a bug.
   */
  nominalClaim: boolean;
  /**
   * The card's own sentence about `nominal_claim`, verbatim, assembled from this
   * fold's numbers. Where the claim is withheld it opens with the refusal,
   * carries the decomposition that says which factor is short, and ends with the
   * named unmeasured reason - because a fixture's marginal is not a measurement
   * of anything and must never be read as one. Auditor prose in the same status
   * as an error `message`: never rendered to a user.
   */
  claimNote: string;
  lower: LowerTailCoverage;
  upper: UpperTailCoverage;
  /**
   * Share of scored hours below P50, target 0.50 - the guardrail standing in for
   * the correction the median deliberately does not get.
   */
  p50Unbiasedness: Probability;
  /**
   * Share of scored hours whose composed quantiles arrived out of order. Beside
   * the deltas because a band that had to be sorted is a band whose coverage
   * statement is about three fits that disagreed.
   */
  crossingRate: Probability;
}

/**
 * What was added to the band and what it bought. `delta_lo` is subtracted from
 * the 0.10 knot and `delta_hi` added to the 0.90 knot; either may be negative,
 * which says the uncorrected knot was already conservative on that side.
 */
export interface BandCalibration {
  /**
   * The **name of the rule** that produced the served band, stamped identically
   * on every published forecast row. It is on this response because a number is
   * only interpretable against the rule that made it:
   * `conformal_v1_partial_upper` applied the correction to the knots of `Q_pos`
   * and reached the served P90 only in part, `conformal_v2_full_upper` applies
   * it to the composed quantile and reaches it whole, and
   * `band.coverage.upper.correction_applied` resolves which from a published
   * table rather than from the name.
   */
  correctionRegime: string;
  deltaLo: number;
  deltaHi: number;
  method: string;
  miscoverage: Probability;
  targetCoverage: Probability;
  calibrationRows: number;
  /**
   * Which order statistic of the calibration residuals `delta` is. Published
   * because the finite-sample correction is the whole of split conformal's
   * guarantee.
   */
  rank: number;
  window: CardWindow;
  /**
   * The card's own statement of what the guarantee is worth here, verbatim -
   * approximate, because exchangeability fails on a time series with a growing
   * fleet. Auditor prose, never rendered to a user.
   */
  guarantee: string;
  /**
   * `null` when the fold's test period held no curtailed hour - absent for a
   * stated reason rather than a row of zeros that would read as total failure.
   */
  coverage: Coverage | null;
  coverageAbsentReason: string | null;
}

/**
 * Coverage of the day-grain band and the peak, over the complete settled days
 * of the fold's test period. A day total is a sum over twenty-four hours whose
 * upper knot is under-corrected, so a shortfall here concentrated above the
 * band is that same under-correction at day grain - reported, never repaired.
 */
export interface DayGrainCoverage {
  foldId: string;
  days: number;
  dayTotalCoverage: Probability;
  peakCoverage: Probability;
  target: Probability;
  population: "complete_settled_days";
}

/**
 * What every figure above hour grain rests on. Day-grain quantiles are
 * quantiles of whole-row draws of the PIT matrix `U`, so **the days in `U` are
 * the days the published day band is a statement about** - and
 * `pit_dropped_days` is therefore a limitation of the published band rather
 * than a training log line. One row is one complete calibration day; a day
 * missing any of its 96 subsystem-hours is dropped whole, because a row with a
 * hole in it is not a coherent day.
 */
export interface EnsembleSummary {
  ensembleDraws: number;
  /**
   * Rows of `U` - the distinct calibration days every day-grain and national
   * quantile is drawn from.
   */
  pitRows: number;
  /**
   * Calibration days dropped whole for holding an unsettled cell. Read against
   * `pit_rows`: the two together say how much of the calibration window the day
   * band actually rests on.
   */
  pitDroppedDays: number;
  pitColumns: number;
  pitWindow: CardWindow;
  /**
   * The card's own statement of the drop rule, verbatim. Auditor prose, never
   * rendered to a user.
   */
  pitDroppedDaysRule: string;
  /**
   * The largest per-column two-sided KS distance from U(0, 1). Above the
   * tolerance the marginals are miscalibrated and every day-grain number drawn
   * from `U` is meaningless.
   */
  pitMaxKs: number;
  pitKsTolerance: number;
  pitUniformWithinTolerance: boolean;
  dayGrain: DayGrainCoverage | null;
  dayGrainAbsentReason: string | null;
}

/**
 * One rung of the baseline ladder, on one fold segment. `vintage_fidelity` is
 * a group key and never a filter that could be omitted: nothing on this
 * surface averages a metric across it.
 */
export interface MetricsRow {
  run: string;
  rung: string;
  rungNumber: number;
  foldId: string;
  vintageFidelity: VintageFidelity;
  rows: number;
  prevalence: Probability;
  prAuc: Probability;
  brier: number;
  ece: number;
  mce: number;
  topBinGap: number;
  maePositivesMwh: number | null;
  pinball10: number | null;
  pinball50: number | null;
  pinball90: number | null;
}

/**
 * What the hot-swap gate decided about this artifact. `reason` is auditor
 * prose and never rendered to a user; `decision` is the identifier a client
 * may act on.
 */
export interface GateDecision {
  decision: "promote" | "refuse";
  reason: string;
  at: UtcInstant;
  /**
   * The bootstrap probability the promotion rested on. `null` when there was no
   * incumbent to compare against, which is a cold start and not a failed
   * comparison.
   */
  bootstrapP: Probability | null;
  comparedAgainst: string | null;
}

/**
 * The response of `POST /v1/optimize` - `docs/specs/flex-optimizer.md`'s
 * contract, re-pathed and never re-shaped. `avoided_energy_mwh`, `absorbed`
 * and `recovered` are **one quantity with three names**; `avoidability` is
 * `null` and never `0` when the baseline is zero. Every number here is
 * evaluated on the *planning envelope*, which is why a Replay - which
 * evaluates the same field names on the observed realisation - names its
 * realisation on the object.
 */
export interface OptimizationResult {
  scenarioHash: ScenarioHash;
  /**
   * The resolved origin this was optimised against; part of the cache key, so a
   * superseding 12Z run cannot be served an 00Z plan.
   */
  forecastOrigin: UtcInstant;
  vintageFidelity: VintageFidelity;
  thresholdMw: ThresholdMw;
  /**
   * Which realisation of the forecast the plan was built against.
   */
  planningBasis: "p10" | "p50" | "p90";
  executionRule: "follow_curtailment";
  baselineCurtailmentMwh: number;
  optimizedCurtailmentMwh: number;
  /**
   * baseline - optimized. Past tense: what *this* dispatch achieves under *this*
   * scenario, not a property of the day.
   */
  avoidedEnergyMwh: number;
  avoidability: Avoidability;
  /**
   * = scored.p10.recovered_mwh. The promise a Replay later scores against.
   */
  recoveredFloorMwh: number;
  scored: OptimizationResultScored;
  dispatch: DispatchHour[];
  storedAtHorizonEndMwh: number;
  roundTripLossMwh: number;
  economicScenario: EconomicScenario;
  solver: SolverReceipt;
}

/**
 * `GET /v1/plants` - the plant registry, machine-readable. The one endpoint in
 * `docs/specs/api-surface.md` that no screen asked for: WattSteer's plant
 * table is a Derivative Database of ANEEL SIGA, ODbL 4.4(c) pulls it under
 * share-alike because the public charts built from it are Publicly Used
 * Produced Works, and 4.6 then obliges machine-readable access. `licence` and
 * `attribution` are `required` here rather than documented as a courtesy, so a
 * build that drops the notice fails to compile against this schema instead of
 * quietly shipping a licence breach.
 */
export interface PlantRegistry {
  /**
   * The vintage cut: what WattSteer had learned by this instant.
   */
  asOf: UtcInstant;
  /**
   * The date `installed_capacity_mw` is summed at. Stamped on the response
   * because capacity is a function of time and not an attribute: the units of
   * one plant routinely commission months apart, and fixed present-day weights
   * were measured misallocating half the SE-solar weight mass at window start.
   */
  fleetDate: CivilDate;
  /**
   * SIGA has no archive before WattSteer's first snapshot, so an early `as_of`
   * is honestly a restatement rather than a point-in-time reconstruction.
   */
  vintageFidelity: VintageFidelity;
  filters: RegistryFilters;
  /**
   * Rows in `plants`, after the filters. On the payload so a truncated download
   * is detectable.
   */
  plantCount: number;
  licence: RegistryLicence;
  /**
   * Source attribution, keyed by source - `meta.schema.json`'s
   * `source_attribution`, `$ref`-ed rather than restated, so the two endpoints
   * that carry the notice cannot come to disagree about what is in it. Data
   * rather than copy: the bilingual 4.3 notice is assembled by the client from
   * translated strings around these untranslated identifiers. The keys are
   * source identifiers and are *data*, so they travel untouched; the values are
   * a named shape and are renamed field by field, which is what puts
   * `derivative_database` on the wire under that name. This block was once a
   * narrower local definition holding only the three casing-stable fields,
   * because the one translator carried a map's values through unrenamed; it does
   * not any more.
   */
  attribution: Record<string, SourceAttribution>;
  plants: RegistryPlantRow[];
}

/**
 * The filters the caller asked for, echoed. `null` means unfiltered - stated
 * rather than left to be inferred from the row count.
 */
export interface RegistryFilters {
  subsystem: Subsystem | null;
  technology: Technology | null;
}

/**
 * ODbL 4.4(a) and 4.6, discharged on the payload rather than only on
 * `/v1/meta`. A consumer of this file is a recipient of the Derivative
 * Database and has to be told, in the file, what it may do with it.
 */
export interface RegistryLicence {
  /**
   * The licence this Derivative Database is offered under, SPDX-style and
   * untranslated.
   */
  database: string;
  url: string;
  /**
   * ODbL 4.4: extracting a substantial part of SIGA into Postgres creates one.
   * Stated as a fact on the payload rather than argued about in a wiki.
   */
  derivativeDatabase: boolean;
  /**
   * ODbL 4.6(b): where the alterations - the `ceg_core` derivation, the
   * coordinate validation, the ONS join, the as-of capacity reconstruction - are
   * published. The cheap and honest half of the obligation; 4.6(a), the database
   * itself, is this endpoint.
   */
  alterationsAt: string;
  /**
   * ODbL 4.3: a Produced Work built from this file must carry a notice naming
   * the source database and its licence.
   */
  attributionRequired: boolean;
}

/**
 * A surveyed or fallback point, in WGS-84 decimal degrees, inside the Brazil
 * bounding box. Never `(0, 0)`: nearly two percent of registry rows sit at
 * exactly Null Island, which is an absence wearing a location's clothes, and
 * an absent coordinate is `null` here.
 */
export interface RegistryCoordinate {
  latitude: number;
  longitude: number;
}

export interface RegistryPlantRow {
  /**
   * ONS `id_ons`, recovered from the conjunto bridge where one names it. Null is
   * genuinely unknown - a Tipo I or II-B plant belongs to no conjunto - and not
   * optional.
   */
  onsPlantCode: string | null;
  /**
   * ANEEL CEG with the version segment stripped. The identity, and the only join
   * to SIGA that works: verbatim `CodCEG` against ONS `ceg` matches 0 of 1,619
   * plants because ANEEL writes `.1` where ONS writes `.01`.
   */
  cegCore: string;
  /**
   * ONS `nom_usina`. Never SIGA's `NomEmpreendimento`, which carries `(Antiga
   * ...)` aliases and is kept for provenance and diffing only.
   */
  name: string;
  subsystem: Subsystem;
  /**
   * ONS `id_estado`. An attribute of the plant, and never a subsystem input:
   * twelve VRE units in Bahia are electrically `SE`.
   */
  stateCode: string;
  technology: Technology;
  operationModality: "TIPO_I" | "TIPO_II_A" | "TIPO_II_B" | "TIPO_II_C";
  /**
   * The SIGA municipality, `Name - UF`. Null where SIGA names no municipality
   * for the plant.
   */
  municipality: string | null;
  /**
   * ONS `nom_agenteproprietario`. Deliberately ONS's agent name and not SIGA's
   * `DscPropriRegimePariticipacao`, which carries CNPJs of named legal persons
   * that ODbL 2.4 does not license.
   */
  ownerName: string;
  /**
   * ONS `nom_agenteoperador`.
   */
  operatorName: string;
  /**
   * Summed over the generating units live on `fleet_date`. Never a stored
   * scalar.
   */
  installedCapacityMw: number;
  /**
   * How many units that sum is over. A plant with none live on `fleet_date` did
   * not exist yet and is not a row.
   */
  generatingUnits: number;
  /**
   * `null` when absent, and absent includes out-of-bounds and Null Island. Never
   * a zero pair.
   */
  coordinate: RegistryCoordinate | null;
  /**
   * Where the point came from, per row. A municipality centroid is a fallback
   * and is labelled as one: presenting it as a surveyed coordinate would be a
   * plausible-looking lie about four plants.
   */
  locationSource: "siga_coordinate" | "siga_municipality_centroid" | "unlocated";
}

/**
 * What a day in the pre-F1 training block gets instead of a replay -
 * `docs/specs/replay.md`, "the observed-only view". Every artifact was fitted
 * on those days, so no honest counterfactual exists and the day is refused
 * rather than labelled. The settled profile, the episodes at the threshold in
 * force, and the perfect-foresight bound, which needs no forecast and
 * therefore no model. There is no `scored`, no `avoided_energy_mwh` and no
 * `recovered_floor_mwh`: absent, not zero, because a zero would be a claim
 * about a plan WattSteer was never asked to build. `additionalProperties:
 * false` is what makes that absence a refusal rather than a convention.
 */
export interface ReplayObservedOnly {
  targetDate: CivilDate;
  subsystem: Subsystem;
  thresholdMw: ThresholdMw;
  maxGapHours: MaxGapHours;
  scenarioHash: ScenarioHash;
  /**
   * Always `false`. The field exists so that a client reading this object and a
   * client reading a `Replay` do not have to tell them apart by which keys are
   * missing.
   */
  replayable: false;
  refusal: ReplayRefusal;
  /**
   * Carried on a refused day too: "this day cannot be replayed" and "its actuals
   * would have been a restatement" are two facts, and the spec keeps them apart
   * because today they coincide.
   */
  vintageFidelity: VintageFidelity;
  actual: ReplayActual;
  upperBound: PerfectForesightBound;
  episodes: CurtailmentEpisode[];
}

/**
 * The best any plan could have done knowing the answer - a property of the day
 * and the fleet. Two numbers and not three: `forecast_value_gap_mwh` is
 * perfect foresight minus what WattSteer achieved, and on this day WattSteer
 * achieved nothing because it was never asked, so the gap is absent rather
 * than zero.
 */
export interface PerfectForesightBound {
  label: "perfect_foresight";
  recoveredMwh: number;
  avoidability: Avoidability;
}

/**
 * The clause of the replayable predicate that failed, as the typed code a
 * client renders one sentence from. `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW` is the
 * only code this view is offered for: the other refusals are a missing read
 * rather than a decision, and they are answered as a `404` with no screen
 * behind them.
 */
export interface ReplayRefusal {
  code: "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW";
  status: 422;
  /**
   * Developer prose for a log. The screen renders `t("error." + code)` and never
   * this.
   */
  message: string;
  details: Record<string, unknown>;
}

/**
 * `GET /v1/replay?d=&s=&subsystem=` and `POST /v1/replay` -
 * `docs/specs/replay.md`'s contract, re-pathed and never re-shaped. The
 * top-level scalars share their names with `OptimizationResult` and mean
 * something different: they are evaluated on the **observed** realisation,
 * which is why `scored_on` exists on the object. Without that field the two
 * results are a trap. `forecast.day_total` comes from the path ensemble and is
 * never a componentwise sum of the hourly band.
 */
export interface Replay {
  targetDate: CivilDate;
  subsystem: Subsystem;
  thresholdMw: ThresholdMw;
  maxGapHours: MaxGapHours;
  scenarioHash: ScenarioHash;
  integrity: ReplayIntegrity;
  /**
   * Top level, exactly as in `OptimizationResult`: a field whose whole purpose
   * is that shared names do not shift meaning must not shift position either.
   * The vintage *detail* under `integrity` is replay-only; the verdict is not.
   */
  vintageFidelity: VintageFidelity;
  forecastOrigin: ForecastOrigin;
  actual: ReplayActual;
  forecast: ReplayForecast;
  planningBasis: "p10" | "p50" | "p90";
  executionRule: "follow_curtailment";
  /**
   * Which realisation the top-level scalars were evaluated on. A Replay scores
   * against what happened, which is the entire point.
   */
  scoredOn: "observed" | "p10" | "p50" | "p90";
  baselineCurtailmentMwh: number;
  optimizedCurtailmentMwh: number;
  avoidedEnergyMwh: number;
  avoidability: Avoidability;
  recoveredFloorMwh: number;
  floorMet: boolean;
  floorMarginMwh: number;
  scored: ReplayScored;
  /**
   * What perfect foresight would have recovered, and the gap the forecast cost.
   */
  upperBound: ReplayUpperBound;
  /**
   * Scheduled, on the planning envelope - the plan.
   */
  dispatch: DispatchHour[];
  /**
   * What the execution rule did against the observed - the reality.
   */
  executed: DispatchHour[];
  storedAtHorizonEndMwh: number;
  roundTripLossMwh: number;
  economicScenario: EconomicScenario;
  episodes: CurtailmentEpisode[];
  solver: SolverReceipt;
}

/**
 * Asserted at read time, never computed hopefully. `provenance` and
 * `vintage_fidelity` are two axes and neither is derived from the other: the
 * first is the model's information set, the second is the data's.
 * `revision_premium_recovered_mwh` is `null` when unmeasured, and says so,
 * rather than standing in as a zero.
 */
export interface ReplayIntegrity {
  provenance: "served" | "fold_holdout";
  modelSawThisDay: boolean;
  heldOutBy: ReplayIntegrityHeldOutBy | null;
  /**
   * The same verdict the top-level field carries, beside `provenance` so the two
   * honesty axes are read against each other. One value, one source: the day's
   * position relative to the go-live of the reads its actuals depend on. Today
   * every `fold_holdout` day is also `revision_optimistic`, which is exactly why
   * a merged badge is refused.
   */
  vintageFidelity: VintageFidelity;
  vintageAffects: string[];
  vintageExempt: string[];
  revisionPremiumRecoveredMwh: number | null;
}

export type ReplayDateWindow = [CivilDate, CivilDate];

export interface ReplayActual {
  totalMwh: number;
  peakMw: number;
  hours: number[];
  /**
   * The vintage of the observed half - the greatest `data_version` among the
   * settled rows this day was read from, as a string, or `"none"` when there
   * were none. The forecast half of a replay is pinned and cannot move; this
   * half is read `AsOf(now)` against a record ONS restates in place, so without
   * this field two replays of one day computed either side of a restatement are
   * indistinguishable on the wire. It is the quantity `/v1/curtailment/*`
   * already validates on, and it is what puts the observed vintage into
   * `/v1/replay`'s ETag. A provenance and never a duration: it moves when the
   * record moves and at no other time.
   */
  dataVersion: string;
}

export interface ReplayForecast {
  hours: ReplayForecastHour[];
  /**
   * Path ensemble. **Not** a sum of the 24 hourly quantiles.
   */
  dayTotal: Band;
  peakPower: Band;
  dayOccurrenceProbability: Probability;
}

/**
 * `docs/specs/replay.md` writes this hour as `{ p10, p50, p90, expected_mwh,
 * occurrence_probability }` inside an elision comment rather than as a literal
 * example. Spelled out here as a `Band` plus siblings, because flattening the
 * three quantiles alongside `expected_mwh` would put an expectation inside a
 * band-shaped object (vocabulary rule 2) and would hide a band from a grep for
 * the shared reference (rule 1). Same five numbers, and the same hour shape
 * the forecast route already returns.
 */
export interface ReplayForecastHour {
  constrainedOffMwh: Band;
  /**
   * A sibling of the band, never its centre.
   */
  expectedMwh: number;
  occurrenceProbability: Probability;
}

/**
 * The body of `POST /v1/optimize`, and the base64url of the same canonical
 * bytes on `GET /v1/optimize?s=`. **Not persisted**: the product is public,
 * read-only and has no accounts, so the URL is the storage and there is no
 * identity to invent. `v` is mandatory and rejected if unknown - a schema
 * change bumps it and an old link then fails loudly rather than parsing into a
 * subtly different scenario, which is the difference between a shareable URL
 * and a time bomb.
 */
export interface Scenario {
  v: 1;
  subsystem: Subsystem;
  targetDate: CivilDate;
  /**
   * Optional; the latest published origin if omitted. A bare instant, not the
   * full `ForecastOrigin` object: what pins a scenario is which run it was
   * optimised against.
   */
  forecastOrigin?: UtcInstant;
  assets: FlexibilityAsset[];
  economicAssumptions?: ScenarioEconomicAssumptions;
}

/**
 * A reduced origin: the renderer needs the run's label, its gate and its
 * instant, and has nothing to say about the producer.
 */
export interface DiagnosisNarrationInputForecastOrigin {
  runLabel: string;
  gateProfile: GateProfile;
  publishedAt: UtcInstant;
}

export interface DiagnosisNarrationInputRisk {
  dayOccurrenceProbability: Probability;
  riskClass: RiskClass;
  hoursP50Nonzero: number;
}

/**
 * The day band arrives as three named scalars rather than as a `Band`, because
 * the renderer's numeric whitelist is flat and a nested object would let a
 * quantile be quoted as if it were the expectation. `day_expected_mwh` stays a
 * separate name from every `p*` for the same reason.
 */
export interface DiagnosisNarrationInputMagnitude {
  dayExpectedMwh: number;
  baselineExpectedMwh: number;
  dayEnergyP10Mwh: number;
  dayEnergyP50Mwh: number;
  dayEnergyP90Mwh: number;
  peakPowerP50Mw: number;
  peakHourLocal: HourLocal;
}

export interface DiagnosisNarrationInputAttribution {
  target: "expected_mwh_day";
  totalAttributedMwh: number;
  sumAbsAttributedMwh: number;
  stderrMwh: number;
  /**
   * Pre-computed: the renderer may not add.
   */
  topTwoShare: Probability;
  groups: Driver[];
}

export interface ErrorEnvelopeError {
  /**
   * A member of the closed enum. The only field a client branches on; it renders
   * `t("error." + code)` and never the message.
   */
  code:
    | "BAD_INPUT"
    | "REQUEST_INVALID"
    | "ROUTE_NOT_FOUND"
    | "INTERNAL"
    | "UPSTREAM_UNAVAILABLE"
    | "SERVICE_BUSY"
    | "PAYLOAD_TOO_LARGE"
    | "FORECAST_NOT_YET_PUBLISHED"
    | "FORECAST_UNAVAILABLE"
    | "MODEL_UNAVAILABLE"
    | "DATA_UNAVAILABLE"
    | "DIAGNOSIS_UNAVAILABLE"
    | "SUBSYSTEM_UNKNOWN"
    | "TARGET_DATE_OUT_OF_RANGE"
    | "DATE_RANGE_TOO_LARGE"
    | "GATE_PROFILE_UNKNOWN"
    | "LOCALE_UNSUPPORTED"
    | "RATE_LIMITED"
    | "OPTIMIZER_NOT_CONFIGURED"
    | "OPTIMIZER_UNAVAILABLE"
    | "OPTIMIZER_TIMEOUT"
    | "OPTIMIZER_NOT_READY"
    | "UPSTREAM_REJECTED"
    | "UPSTREAM_FAILED"
    | "SOLVER_GAP_UNCLOSED"
    | "SOLVER_TIMEOUT"
    | "SOLVER_BUG"
    | "SCENARIO_VERSION_UNSUPPORTED"
    | "SCENARIO_TOO_LARGE"
    | "ASSET_TYPE_UNKNOWN"
    | "SUBSYSTEM_MISMATCH"
    | "FIELD_NOT_ON_VARIANT"
    | "MAGNITUDE_OUT_OF_RANGE"
    | "RTE_OUT_OF_RANGE"
    | "EFFICIENCY_PAIR_INCOMPLETE"
    | "SOC_BOUNDS_INVALID"
    | "SOC_INITIAL_OUT_OF_BOUNDS"
    | "POWER_LIMIT_INCONSISTENT"
    | "SHIFT_EXCEEDS_CONNECTION"
    | "SHIFT_EXCEEDS_BASELINE"
    | "SHIFT_WINDOW_OUT_OF_RANGE"
    | "RECOVERY_TIME_OUT_OF_RANGE"
    | "AVAILABILITY_INVALID"
    | "ECONOMIC_ASSUMPTION_OUT_OF_RANGE"
    | "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW"
    | "REPLAY_DATE_OUT_OF_RANGE"
    | "REPLAY_FORECAST_UNAVAILABLE"
    | "REPLAY_OBSERVATION_INCOMPLETE"
    | "REPLAY_INTEGRITY_VIOLATION";
  /**
   * English developer prose, for logs and `/docs`. **Never shown to a user.** A
   * client that renders it has a bug.
   */
  message: string;
  /**
   * Optional machine-readable context, typed per code: the field path of a
   * validation failure, the limit it broke, `lane_state` on a MODEL_UNAVAILABLE,
   * `upstream_code` on an admitted upstream refusal. Never free-form prose.
   */
  details?: Record<string, string | number | boolean | null>;
  /**
   * The `x-request-id` this failure was answered under, so a user-reported
   * failure is one grep.
   */
  requestId?: string;
}

export interface NationalOutlookRiskClassCounts {
  low: number;
  elevated: number;
  high: number;
}

export interface MetaWindow {
  opensOn: CivilDate;
  ingestionGoLive: CivilDate;
  firstHoldoutFoldStart: CivilDate;
}

/**
 * The four published constants, echoed. `packages/core/src/constants.ts` is
 * the definition; this is diagnosability, never a source a client should fetch
 * in order to use.
 */
export interface MetaDefaults {
  subsystemThresholdMw: ThresholdMw;
  reportingEntityThresholdMw: ThresholdMw;
  maxGapHours: MaxGapHours;
  brlPerMwh: number;
}

export interface MetaData {
  freshness: MetaFreshness[];
}

/**
 * `REFERENCE_FLEET`, echoed for diagnosability. Echoed, never fetched in order
 * to be used: a caller that reads it over HTTP can be served a different
 * battery than the one the number it is looking at was computed against. Its
 * fields are named here rather than left as a free-form object so that the one
 * translator renames them: `max_power_mw` is a field name, and a block whose
 * shape the table does not know travels in whatever casing the gateway
 * happened to build it in.
 */
export interface MetaReferenceFleet {
  battery: ReferenceBattery;
  shiftableLoad: ReferenceShiftableLoad;
}

export interface MetaModelVolume {
  mounted: boolean;
  writable: boolean;
}

export interface MetaForecastStateLatestPublishedItem {
  targetDate: CivilDate;
  gateProfile: GateProfile;
  publishedAt: UtcInstant;
  ageHours: number;
  subsystems: Subsystem[];
}

export interface OptimizationResultScored {
  p10: ScoredRealisation;
  p50: ScoredRealisation;
  p90: ScoredRealisation;
}

export interface ReplayScored {
  p10: ScoredRealisation;
  p50: ScoredRealisation;
  p90: ScoredRealisation;
  observed: ScoredRealisation;
}

/**
 * What perfect foresight would have recovered, and the gap the forecast cost.
 */
export interface ReplayUpperBound {
  label: "perfect_foresight";
  recoveredMwh: number;
  avoidability: Avoidability;
  forecastValueGapMwh: number;
}

export interface ReplayIntegrityHeldOutBy {
  fold: string;
  artifactId: string;
  trainWindow: ReplayDateWindow;
  calibrationWindow: ReplayDateWindow;
}

export interface ScenarioEconomicAssumptions {
  /**
   * `ECONOMIC_ASSUMPTION_OUT_OF_RANGE`. Carried because R$ appears only as a
   * labelled scenario with its assumption visible.
   */
  brlPerMwh: number;
}

/**
 * One field of a wire object: the `snake_case` name it travels under, the
 * shape to recurse into if it is an object or a list of them, and whether the
 * schema makes it optional.
 */
export interface WireField {
  readonly wire: string;
  /**
   * The nested shape to recurse into, as a `WireShapeName`. Typed `string`
   * rather than `WireShapeName` because the name union is derived from
   * `WIRE_SHAPES` itself and the two would reference each other; `src/wire.ts`
   * narrows it at the one place it is used.
   */
  readonly shape?: string;
  readonly list?: boolean;
  /**
   * True where the field is a **map whose keys are data** and whose values are
   * `shape` — `/v1/meta`'s and `/v1/plants`' `attribution`. The keys are
   * carried through untouched and every value is renamed, which is the whole
   * distinction: a source identifier is not a field name, and
   * `derivative_database` is.
   */
  readonly map?: boolean;
  readonly optional?: boolean;
  /**
   * The single value a `const` property is fixed to — the discriminant of a
   * `oneOf`. Present only where the schema pins one, which for the wire means
   * `asset_type` on each `FlexibilityAsset` variant.
   */
  readonly const?: string;
}

/** A wire object, keyed by the camelCase name the interface above declares. */
export type WireShape = Readonly<Record<string, WireField>>;

/**
 * The whole translation table, generated from `schema/`.
 *
 * `src/wire.ts` is the only module that reads it. A field renamed in the
 * schema changes both the interface and this table in one regeneration, which
 * is what makes the rename a compile error in the web app.
 */
export const WIRE_SHAPES = {
  Band: {
    p10: { wire: "p10" },
    p50: { wire: "p50" },
    p90: { wire: "p90" },
  },
  TechnologySplit: {
    windMwh: { wire: "wind_mwh" },
    solarMwh: { wire: "solar_mwh" },
  },
  ForecastOrigin: {
    producer: { wire: "producer" },
    runLabel: { wire: "run_label" },
    publishedAt: { wire: "published_at" },
    ageHours: { wire: "age_hours", optional: true },
    originKind: { wire: "origin_kind", optional: true },
    gateProfile: { wire: "gate_profile", optional: true },
    weatherRunLabel: { wire: "weather_run_label", optional: true },
  },
  RiskBins: {
    low: { wire: "low" },
    elevated: { wire: "elevated" },
    high: { wire: "high" },
  },
  SolverReceipt: {
    backend: { wire: "backend" },
    status: { wire: "status" },
    wallTimeMs: { wire: "wall_time_ms" },
    objective: { wire: "objective", optional: true },
    ortoolsVersion: { wire: "ortools_version", optional: true },
    scipVersion: { wire: "scip_version", optional: true },
  },
  EconomicScenario: {
    brlPerMwh: { wire: "brl_per_mwh" },
    brl: { wire: "brl" },
  },
  ScoredRealisation: {
    baselineMwh: { wire: "baseline_mwh" },
    remainingMwh: { wire: "remaining_mwh" },
    recoveredMwh: { wire: "recovered_mwh" },
    avoidability: { wire: "avoidability" },
  },
  DispatchHour: {
    hourLocal: { wire: "hour_local" },
    offeredMwh: { wire: "offered_mwh", optional: true },
    batteryChargeMw: { wire: "battery_charge_mw", optional: true },
    batteryDischargeMw: { wire: "battery_discharge_mw", optional: true },
    stateOfChargeMwh: { wire: "state_of_charge_mwh", optional: true },
    loadShiftUpMw: { wire: "load_shift_up_mw", optional: true },
    loadShiftDownMw: { wire: "load_shift_down_mw", optional: true },
    absorbedMwh: { wire: "absorbed_mwh", optional: true },
  },
  CurtailmentEpisode: {
    subsystem: { wire: "subsystem", optional: true },
    technology: { wire: "technology", optional: true },
    startedAt: { wire: "started_at" },
    endedAt: { wire: "ended_at" },
    durationHours: { wire: "duration_hours" },
    totalMwh: { wire: "total_mwh" },
    peakMw: { wire: "peak_mw" },
    thresholdMw: { wire: "threshold_mw" },
    maxGapHours: { wire: "max_gap_hours" },
  },
  CurtailmentHours: {
    subsystem: { wire: "subsystem" },
    technology: { wire: "technology" },
    from: { wire: "from" },
    to: { wire: "to" },
    asOf: { wire: "as_of" },
    dataVersion: { wire: "data_version" },
    vintageFidelity: { wire: "vintage_fidelity" },
    rows: { wire: "rows", shape: "CurtailmentHour", list: true },
    nextCursor: { wire: "next_cursor" },
  },
  CurtailmentHour: {
    subsystem: { wire: "subsystem" },
    technology: { wire: "technology" },
    validTime: { wire: "valid_time" },
    hourLocal: { wire: "hour_local" },
    constrainedOffMwh: { wire: "constrained_off_mwh" },
  },
  CurtailmentEpisodes: {
    subsystem: { wire: "subsystem" },
    from: { wire: "from" },
    to: { wire: "to" },
    asOf: { wire: "as_of" },
    dataVersion: { wire: "data_version" },
    vintageFidelity: { wire: "vintage_fidelity" },
    thresholdMw: { wire: "threshold_mw" },
    maxGapHours: { wire: "max_gap_hours" },
    episodes: { wire: "episodes", shape: "CurtailmentEpisode", list: true },
  },
  ObservedReasons: {
    subsystem: { wire: "subsystem" },
    date: { wire: "date" },
    asOf: { wire: "as_of" },
    dataVersion: { wire: "data_version" },
    vintageFidelity: { wire: "vintage_fidelity" },
    rows: { wire: "rows", shape: "ObservedReason", list: true },
  },
  ObservedReason: {
    grain: { wire: "grain" },
    entityCode: { wire: "entity_code" },
    entityLabel: { wire: "entity_label" },
    reason: { wire: "reason" },
    origin: { wire: "origin" },
    constrainedOffMwh: { wire: "constrained_off_mwh" },
    description: { wire: "description" },
    causeMixed: { wire: "cause_mixed" },
  },
  DiagnosisNarrationInput: {
    schemaVersion: { wire: "schema_version", const: "diagnosis.narration.v1" },
    promptVersion: { wire: "prompt_version" },
    locale: { wire: "locale" },
    subsystem: { wire: "subsystem" },
    subsystemDisplayName: { wire: "subsystem_display_name" },
    targetDate: { wire: "target_date" },
    thresholdMw: { wire: "threshold_mw" },
    forecastOrigin: {
      wire: "forecast_origin",
      shape: "DiagnosisNarrationInputForecastOrigin",
    },
    vintageFidelity: { wire: "vintage_fidelity" },
    risk: { wire: "risk", shape: "DiagnosisNarrationInputRisk" },
    magnitude: { wire: "magnitude", shape: "DiagnosisNarrationInputMagnitude" },
    attribution: { wire: "attribution", shape: "DiagnosisNarrationInputAttribution" },
    ruleFlags: { wire: "rule_flags", shape: "RuleFlag", list: true },
    observedReasonsLatest: {
      wire: "observed_reasons_latest",
      shape: "ObservedReasonsLatest",
      optional: true,
    },
  },
  DiagnosisDayAhead: {
    subsystem: { wire: "subsystem" },
    targetDate: { wire: "target_date" },
    thresholdMw: { wire: "threshold_mw" },
    forecastOrigin: { wire: "forecast_origin", shape: "ForecastOrigin" },
    vintageFidelity: { wire: "vintage_fidelity" },
    attribution: { wire: "attribution", shape: "DiagnosisAttribution" },
    ruleFlags: { wire: "rule_flags", shape: "RuleFlag", list: true },
    withheldBy: { wire: "withheld_by" },
    narration: { wire: "narration", shape: "Narration" },
    observedReasonsLatest: {
      wire: "observed_reasons_latest",
      shape: "ObservedReasonsLatest",
      optional: true,
    },
  },
  Driver: {
    code: { wire: "code" },
    labelCode: { wire: "label_code" },
    phiMwh: { wire: "phi_mwh" },
    share: { wire: "share" },
    direction: { wire: "direction" },
    headlineFeature: { wire: "headline_feature" },
    observed: { wire: "observed" },
    typical: { wire: "typical" },
    unit: { wire: "unit" },
    hourDisagreement: { wire: "hour_disagreement" },
    demoted: { wire: "demoted" },
  },
  DiagnosisAttribution: {
    target: { wire: "target" },
    totalAttributedMwh: { wire: "total_attributed_mwh" },
    sumAbsAttributedMwh: { wire: "sum_abs_attributed_mwh" },
    stderrMwh: { wire: "stderr_mwh" },
    baselineExpectedMwh: { wire: "baseline_expected_mwh" },
    dayExpectedMwh: { wire: "day_expected_mwh" },
    driverGroupVersion: { wire: "driver_group_version" },
    driverGroupHash: { wire: "driver_group_hash" },
    drivers: { wire: "drivers", shape: "Driver", list: true },
    peakHourLocal: { wire: "peak_hour_local" },
    peakHourDrivers: { wire: "peak_hour_drivers", shape: "Driver", list: true },
  },
  RuleFlag: {
    code: { wire: "code" },
    severity: { wire: "severity" },
    facts: { wire: "facts" },
  },
  Narration: {
    source: { wire: "source", optional: true },
    text: { wire: "text", optional: true },
    locale: { wire: "locale", optional: true },
    promptVersion: { wire: "prompt_version", optional: true },
    clauses: { wire: "clauses", shape: "NarrationClause", list: true, optional: true },
  },
  NarrationFromModel: {
    source: { wire: "source", const: "model" },
    text: { wire: "text" },
    locale: { wire: "locale" },
    promptVersion: { wire: "prompt_version" },
  },
  NarrationFromTemplate: {
    source: { wire: "source", const: "template" },
    clauses: { wire: "clauses", shape: "NarrationClause", list: true },
    locale: { wire: "locale" },
    promptVersion: { wire: "prompt_version" },
  },
  NarrationClause: {
    key: { wire: "key" },
    values: { wire: "values" },
  },
  ObservedReasonsLatest: {
    date: { wire: "date" },
    topReason: { wire: "top_reason" },
    topReasonShare: { wire: "top_reason_share" },
  },
  ErrorEnvelope: {
    error: { wire: "error", shape: "ErrorEnvelopeError" },
  },
  FlexibilityAsset: {
    assetType: { wire: "asset_type", optional: true },
    label: { wire: "label", optional: true },
    subsystem: { wire: "subsystem", optional: true },
    maxPowerMw: { wire: "max_power_mw", optional: true },
    energyCapacityMwh: { wire: "energy_capacity_mwh", optional: true },
    roundTripEfficiency: { wire: "round_trip_efficiency", optional: true },
    chargeEfficiency: { wire: "charge_efficiency", optional: true },
    dischargeEfficiency: { wire: "discharge_efficiency", optional: true },
    initialStateOfCharge: { wire: "initial_state_of_charge", optional: true },
    minStateOfCharge: { wire: "min_state_of_charge", optional: true },
    maxStateOfCharge: { wire: "max_state_of_charge", optional: true },
    maxChargeMw: { wire: "max_charge_mw", optional: true },
    maxDischargeMw: { wire: "max_discharge_mw", optional: true },
    availableFrom: { wire: "available_from", optional: true },
    availableTo: { wire: "available_to", optional: true },
    maxShiftMw: { wire: "max_shift_mw", optional: true },
    shiftWindowHours: { wire: "shift_window_hours", optional: true },
    dailyEnergyMwh: { wire: "daily_energy_mwh", optional: true },
    recoveryTimeHours: { wire: "recovery_time_hours", optional: true },
  },
  Battery: {
    assetType: { wire: "asset_type", const: "battery" },
    label: { wire: "label" },
    subsystem: { wire: "subsystem" },
    maxPowerMw: { wire: "max_power_mw" },
    energyCapacityMwh: { wire: "energy_capacity_mwh" },
    roundTripEfficiency: { wire: "round_trip_efficiency", optional: true },
    chargeEfficiency: { wire: "charge_efficiency", optional: true },
    dischargeEfficiency: { wire: "discharge_efficiency", optional: true },
    initialStateOfCharge: { wire: "initial_state_of_charge" },
    minStateOfCharge: { wire: "min_state_of_charge", optional: true },
    maxStateOfCharge: { wire: "max_state_of_charge", optional: true },
    maxChargeMw: { wire: "max_charge_mw", optional: true },
    maxDischargeMw: { wire: "max_discharge_mw", optional: true },
    availableFrom: { wire: "available_from", optional: true },
    availableTo: { wire: "available_to", optional: true },
  },
  ShiftableLoad: {
    assetType: { wire: "asset_type", const: "shiftable_load" },
    label: { wire: "label" },
    subsystem: { wire: "subsystem" },
    maxPowerMw: { wire: "max_power_mw" },
    maxShiftMw: { wire: "max_shift_mw" },
    shiftWindowHours: { wire: "shift_window_hours" },
    dailyEnergyMwh: { wire: "daily_energy_mwh" },
    recoveryTimeHours: { wire: "recovery_time_hours", optional: true },
    availableFrom: { wire: "available_from", optional: true },
    availableTo: { wire: "available_to", optional: true },
  },
  ForecastDayAhead: {
    subsystem: { wire: "subsystem" },
    onsDisplayName: { wire: "ons_display_name" },
    targetDate: { wire: "target_date" },
    thresholdMw: { wire: "threshold_mw" },
    forecastOrigin: { wire: "forecast_origin", shape: "ForecastOrigin" },
    vintageFidelity: { wire: "vintage_fidelity" },
    artifact: { wire: "artifact", shape: "ForecastArtifact" },
    riskBins: { wire: "risk_bins", shape: "RiskBins" },
    dayOccurrenceProbability: { wire: "day_occurrence_probability" },
    riskClass: { wire: "risk_class" },
    dayEnergyMwh: { wire: "day_energy_mwh", shape: "Band" },
    peakPowerMw: { wire: "peak_power_mw", shape: "Band" },
    dayExpectedMwh: { wire: "day_expected_mwh" },
    split: { wire: "split", shape: "TechnologySplit" },
    hoursP50Nonzero: { wire: "hours_p50_nonzero" },
    hours: { wire: "hours", shape: "CurtailmentHourForecast", list: true },
  },
  ForecastArtifact: {
    artifactId: { wire: "artifact_id" },
    featureSet: { wire: "feature_set" },
    trainedThrough: { wire: "trained_through" },
  },
  CurtailmentHourForecast: {
    validTime: { wire: "valid_time" },
    hourLocal: { wire: "hour_local" },
    constrainedOffMwh: { wire: "constrained_off_mwh", shape: "Band" },
    expectedMwh: { wire: "expected_mwh" },
    occurrenceProbability: { wire: "occurrence_probability" },
    split: { wire: "split", shape: "TechnologySplit" },
  },
  GridNow: {
    asOf: { wire: "as_of" },
    latestSettledHour: { wire: "latest_settled_hour" },
    lagHours: { wire: "lag_hours" },
    vintageFidelity: { wire: "vintage_fidelity" },
    subsystems: { wire: "subsystems", shape: "SubsystemNow", list: true },
    national: { wire: "national", shape: "NationalNow" },
  },
  SubsystemNow: {
    subsystem: { wire: "subsystem" },
    onsDisplayName: { wire: "ons_display_name" },
    last24hConstrainedOffMwh: { wire: "last_24h_constrained_off_mwh" },
    latestHourConstrainedOffMwh: { wire: "latest_hour_constrained_off_mwh" },
    split: { wire: "split", shape: "TechnologySplit" },
  },
  NationalNow: {
    last24hConstrainedOffMwh: { wire: "last_24h_constrained_off_mwh" },
    derived: { wire: "derived" },
  },
  GridOutlook: {
    targetDate: { wire: "target_date" },
    thresholdMw: { wire: "threshold_mw" },
    forecastOrigin: { wire: "forecast_origin", shape: "ForecastOrigin" },
    vintageFidelity: { wire: "vintage_fidelity" },
    riskBins: { wire: "risk_bins", shape: "RiskBins" },
    subsystems: { wire: "subsystems", shape: "SubsystemOutlook", list: true },
    national: { wire: "national", shape: "NationalOutlook" },
  },
  SubsystemOutlook: {
    subsystem: { wire: "subsystem" },
    onsDisplayName: { wire: "ons_display_name" },
    dayOccurrenceProbability: { wire: "day_occurrence_probability" },
    riskClass: { wire: "risk_class" },
    dayEnergyMwh: { wire: "day_energy_mwh", shape: "Band" },
    peakPowerMw: { wire: "peak_power_mw", shape: "Band" },
    dayExpectedMwh: { wire: "day_expected_mwh" },
    split: { wire: "split", shape: "TechnologySplit" },
  },
  NationalOutlook: {
    expectedMwh: { wire: "expected_mwh" },
    riskClassCounts: {
      wire: "risk_class_counts",
      shape: "NationalOutlookRiskClassCounts",
    },
    band: { wire: "band", shape: "Band" },
    bandUnavailableReason: { wire: "band_unavailable_reason" },
  },
  Meta: {
    service: { wire: "service" },
    version: { wire: "version" },
    environment: { wire: "environment" },
    serverTime: { wire: "server_time" },
    window: { wire: "window", shape: "MetaWindow" },
    defaults: { wire: "defaults", shape: "MetaDefaults" },
    gates: { wire: "gates", shape: "MetaGate", list: true },
    model: { wire: "model", shape: "MetaModel" },
    forecast: { wire: "forecast", shape: "MetaForecastState" },
    data: { wire: "data", shape: "MetaData" },
    referenceFleet: { wire: "reference_fleet", shape: "MetaReferenceFleet" },
    declines: { wire: "declines", shape: "MetaDeclines" },
    caveats: { wire: "caveats", shape: "MetaCaveats" },
    attribution: { wire: "attribution", shape: "SourceAttribution", map: true },
  },
  MetaDeclines: {
    figures: { wire: "figures", shape: "DeclinedFigure", list: true },
    incompleteReason: { wire: "incomplete_reason" },
  },
  DeclinedFigure: {
    name: { wire: "name" },
    declaredIn: { wire: "declared_in" },
    figure: { wire: "figure" },
    kind: { wire: "kind" },
    reason: { wire: "reason" },
    surface: { wire: "surface" },
    fault: { wire: "fault", optional: true },
  },
  MetaCaveats: {
    figures: { wire: "figures", shape: "CaveatedFigure", list: true },
    incompleteReason: { wire: "incomplete_reason" },
  },
  CaveatedFigure: {
    name: { wire: "name" },
    declaredIn: { wire: "declared_in" },
    figure: { wire: "figure" },
    caveat: { wire: "caveat" },
    misreading: { wire: "misreading" },
    surface: { wire: "surface" },
    fault: { wire: "fault", optional: true },
  },
  MetaGate: {
    profile: { wire: "profile" },
    publishesAtLocal: { wire: "publishes_at_local" },
    timezone: { wire: "timezone" },
    weatherRun: { wire: "weather_run" },
  },
  MetaLane: {
    lane: { wire: "lane" },
    state: { wire: "state" },
    fault: { wire: "fault", optional: true },
    usable: { wire: "usable", optional: true },
    retrainOwed: { wire: "retrain_owed", optional: true },
    contractFault: { wire: "contract_fault", optional: true },
    cardError: { wire: "card_error", optional: true },
    unusableReason: { wire: "unusable_reason", optional: true },
    artifactId: { wire: "artifact_id", optional: true },
    trainedThrough: { wire: "trained_through", optional: true },
    vintageFidelity: { wire: "vintage_fidelity", optional: true },
  },
  MetaModel: {
    reachable: { wire: "reachable" },
    unreachableReason: { wire: "unreachable_reason", optional: true },
    lanes: { wire: "lanes", shape: "MetaLane", list: true },
    volume: { wire: "volume", shape: "MetaModelVolume" },
  },
  MetaForecastState: {
    latestPublished: {
      wire: "latest_published",
      shape: "MetaForecastStateLatestPublishedItem",
      list: true,
    },
    nextPublicationAt: { wire: "next_publication_at" },
  },
  MetaFreshness: {
    source: { wire: "source" },
    latestValidTime: { wire: "latest_valid_time" },
    latestIngestedAt: { wire: "latest_ingested_at" },
    lagHours: { wire: "lag_hours" },
  },
  ReferenceBattery: {
    assetType: { wire: "asset_type", const: "battery" },
    label: { wire: "label" },
    maxPowerMw: { wire: "max_power_mw" },
    energyCapacityMwh: { wire: "energy_capacity_mwh" },
    roundTripEfficiency: { wire: "round_trip_efficiency" },
    initialStateOfCharge: { wire: "initial_state_of_charge" },
  },
  ReferenceShiftableLoad: {
    assetType: { wire: "asset_type", const: "shiftable_load" },
    label: { wire: "label" },
    maxPowerMw: { wire: "max_power_mw" },
    maxShiftMw: { wire: "max_shift_mw" },
    shiftWindowHours: { wire: "shift_window_hours" },
    dailyEnergyMwh: { wire: "daily_energy_mwh" },
  },
  SourceAttribution: {
    name: { wire: "name" },
    licence: { wire: "licence" },
    url: { wire: "url" },
    derivativeDatabase: { wire: "derivative_database", optional: true },
    machineReadableAt: { wire: "machine_readable_at", optional: true },
  },
  ModelCard: {
    lane: { wire: "lane" },
    laneState: { wire: "lane_state", const: "promoted" },
    artifact: { wire: "artifact", shape: "CardArtifact" },
    fold: { wire: "fold", shape: "CardFold" },
    windows: { wire: "windows", shape: "CardWindows" },
    reliability: { wire: "reliability", shape: "Reliability" },
    riskBins: { wire: "risk_bins", shape: "RiskBins" },
    band: { wire: "band", shape: "BandCalibration" },
    ensemble: { wire: "ensemble", shape: "EnsembleSummary" },
    metrics: { wire: "metrics", shape: "MetricsRow", list: true },
    metricsAbsentReason: { wire: "metrics_absent_reason" },
    decision: { wire: "decision", shape: "GateDecision" },
    cardUrl: { wire: "card_url" },
  },
  CardWindow: {
    start: { wire: "start" },
    end: { wire: "end" },
  },
  CardArtifact: {
    artifactId: { wire: "artifact_id" },
    createdAt: { wire: "created_at" },
    estimatorFamily: { wire: "estimator_family" },
    modelConfigVersion: { wire: "model_config_version" },
    featureSet: { wire: "feature_set" },
    featureSetVersion: { wire: "feature_set_version" },
    gateProfile: { wire: "gate_profile" },
    thresholdMw: { wire: "threshold_mw" },
    featureHash: { wire: "feature_hash" },
    gitShaMl: { wire: "git_sha_ml" },
    gitShaApi: { wire: "git_sha_api" },
  },
  CardFold: {
    foldId: { wire: "fold_id" },
    foldHash: { wire: "fold_hash" },
    rulesDigest: { wire: "rules_digest" },
  },
  CardWindows: {
    training: { wire: "training", shape: "CardWindow" },
    baseFit: { wire: "base_fit", shape: "CardWindow" },
    calibration: { wire: "calibration", shape: "CardWindow" },
    test: { wire: "test", shape: "CardWindow" },
    rowsByVintageFidelity: { wire: "rows_by_vintage_fidelity" },
  },
  ReliabilityPoint: {
    binLower: { wire: "bin_lower" },
    binUpper: { wire: "bin_upper" },
    binCentre: { wire: "bin_centre" },
    meanPredicted: { wire: "mean_predicted" },
    observedFrequency: { wire: "observed_frequency" },
    hourCount: { wire: "hour_count" },
    merged: { wire: "merged" },
  },
  Reliability: {
    points: { wire: "points", shape: "ReliabilityPoint", list: true },
    sampleHours: { wire: "sample_hours" },
    window: { wire: "window", shape: "CardWindow" },
    vintageFidelity: { wire: "vintage_fidelity" },
    folds: { wire: "folds" },
    excludedCalibrationHours: { wire: "excluded_calibration_hours" },
    ece: { wire: "ece" },
    mce: { wire: "mce" },
    topBinGap: { wire: "top_bin_gap" },
  },
  LowerTailCoverage: {
    coverageP10: { wire: "coverage_p10" },
    statedRows: { wire: "stated_rows" },
    coverageP10WhereStated: { wire: "coverage_p10_where_stated" },
    correctionApplied: { wire: "correction_applied" },
    quotedAs: { wire: "quoted_as", const: "recovered_floor_mwh" },
  },
  UpperTailCoverage: {
    coverageP90: { wire: "coverage_p90" },
    statedRows: { wire: "stated_rows" },
    coverageP90WhereStated: { wire: "coverage_p90_where_stated" },
    correctionApplied: { wire: "correction_applied" },
    upperCorrectionRealised: { wire: "upper_correction_realised" },
    upperCorrectionNote: { wire: "upper_correction_note" },
  },
  Coverage: {
    foldId: { wire: "fold_id" },
    population: { wire: "population", const: "curtailed_hours" },
    rows: { wire: "rows" },
    target: { wire: "target" },
    guardrail: { wire: "guardrail" },
    guardrailSatisfied: { wire: "guardrail_satisfied" },
    nominalClaim: { wire: "nominal_claim" },
    claimNote: { wire: "claim_note" },
    lower: { wire: "lower", shape: "LowerTailCoverage" },
    upper: { wire: "upper", shape: "UpperTailCoverage" },
    p50Unbiasedness: { wire: "p50_unbiasedness" },
    crossingRate: { wire: "crossing_rate" },
  },
  BandCalibration: {
    correctionRegime: { wire: "correction_regime" },
    deltaLo: { wire: "delta_lo" },
    deltaHi: { wire: "delta_hi" },
    method: { wire: "method" },
    miscoverage: { wire: "miscoverage" },
    targetCoverage: { wire: "target_coverage" },
    calibrationRows: { wire: "calibration_rows" },
    rank: { wire: "rank" },
    window: { wire: "window", shape: "CardWindow" },
    guarantee: { wire: "guarantee" },
    coverage: { wire: "coverage", shape: "Coverage" },
    coverageAbsentReason: { wire: "coverage_absent_reason" },
  },
  DayGrainCoverage: {
    foldId: { wire: "fold_id" },
    days: { wire: "days" },
    dayTotalCoverage: { wire: "day_total_coverage" },
    peakCoverage: { wire: "peak_coverage" },
    target: { wire: "target" },
    population: { wire: "population", const: "complete_settled_days" },
  },
  EnsembleSummary: {
    ensembleDraws: { wire: "ensemble_draws" },
    pitRows: { wire: "pit_rows" },
    pitDroppedDays: { wire: "pit_dropped_days" },
    pitColumns: { wire: "pit_columns" },
    pitWindow: { wire: "pit_window", shape: "CardWindow" },
    pitDroppedDaysRule: { wire: "pit_dropped_days_rule" },
    pitMaxKs: { wire: "pit_max_ks" },
    pitKsTolerance: { wire: "pit_ks_tolerance" },
    pitUniformWithinTolerance: { wire: "pit_uniform_within_tolerance" },
    dayGrain: { wire: "day_grain", shape: "DayGrainCoverage" },
    dayGrainAbsentReason: { wire: "day_grain_absent_reason" },
  },
  MetricsRow: {
    run: { wire: "run" },
    rung: { wire: "rung" },
    rungNumber: { wire: "rung_number" },
    foldId: { wire: "fold_id" },
    vintageFidelity: { wire: "vintage_fidelity" },
    rows: { wire: "rows" },
    prevalence: { wire: "prevalence" },
    prAuc: { wire: "pr_auc" },
    brier: { wire: "brier" },
    ece: { wire: "ece" },
    mce: { wire: "mce" },
    topBinGap: { wire: "top_bin_gap" },
    maePositivesMwh: { wire: "mae_positives_mwh" },
    pinball10: { wire: "pinball_10" },
    pinball50: { wire: "pinball_50" },
    pinball90: { wire: "pinball_90" },
  },
  GateDecision: {
    decision: { wire: "decision" },
    reason: { wire: "reason" },
    at: { wire: "at" },
    bootstrapP: { wire: "bootstrap_p" },
    comparedAgainst: { wire: "compared_against" },
  },
  OptimizationResult: {
    scenarioHash: { wire: "scenario_hash" },
    forecastOrigin: { wire: "forecast_origin" },
    vintageFidelity: { wire: "vintage_fidelity" },
    thresholdMw: { wire: "threshold_mw" },
    planningBasis: { wire: "planning_basis" },
    executionRule: { wire: "execution_rule" },
    baselineCurtailmentMwh: { wire: "baseline_curtailment_mwh" },
    optimizedCurtailmentMwh: { wire: "optimized_curtailment_mwh" },
    avoidedEnergyMwh: { wire: "avoided_energy_mwh" },
    avoidability: { wire: "avoidability" },
    recoveredFloorMwh: { wire: "recovered_floor_mwh" },
    scored: { wire: "scored", shape: "OptimizationResultScored" },
    dispatch: { wire: "dispatch", shape: "DispatchHour", list: true },
    storedAtHorizonEndMwh: { wire: "stored_at_horizon_end_mwh" },
    roundTripLossMwh: { wire: "round_trip_loss_mwh" },
    economicScenario: { wire: "economic_scenario", shape: "EconomicScenario" },
    solver: { wire: "solver", shape: "SolverReceipt" },
  },
  PlantRegistry: {
    asOf: { wire: "as_of" },
    fleetDate: { wire: "fleet_date" },
    vintageFidelity: { wire: "vintage_fidelity" },
    filters: { wire: "filters", shape: "RegistryFilters" },
    plantCount: { wire: "plant_count" },
    licence: { wire: "licence", shape: "RegistryLicence" },
    attribution: { wire: "attribution", shape: "SourceAttribution", map: true },
    plants: { wire: "plants", shape: "RegistryPlantRow", list: true },
  },
  RegistryFilters: {
    subsystem: { wire: "subsystem" },
    technology: { wire: "technology" },
  },
  RegistryLicence: {
    database: { wire: "database" },
    url: { wire: "url" },
    derivativeDatabase: { wire: "derivative_database" },
    alterationsAt: { wire: "alterations_at" },
    attributionRequired: { wire: "attribution_required" },
  },
  RegistryCoordinate: {
    latitude: { wire: "latitude" },
    longitude: { wire: "longitude" },
  },
  RegistryPlantRow: {
    onsPlantCode: { wire: "ons_plant_code" },
    cegCore: { wire: "ceg_core" },
    name: { wire: "name" },
    subsystem: { wire: "subsystem" },
    stateCode: { wire: "state_code" },
    technology: { wire: "technology" },
    operationModality: { wire: "operation_modality" },
    municipality: { wire: "municipality" },
    ownerName: { wire: "owner_name" },
    operatorName: { wire: "operator_name" },
    installedCapacityMw: { wire: "installed_capacity_mw" },
    generatingUnits: { wire: "generating_units" },
    coordinate: { wire: "coordinate", shape: "RegistryCoordinate" },
    locationSource: { wire: "location_source" },
  },
  ReplayObservedOnly: {
    targetDate: { wire: "target_date" },
    subsystem: { wire: "subsystem" },
    thresholdMw: { wire: "threshold_mw" },
    maxGapHours: { wire: "max_gap_hours" },
    scenarioHash: { wire: "scenario_hash" },
    replayable: { wire: "replayable" },
    refusal: { wire: "refusal", shape: "ReplayRefusal" },
    vintageFidelity: { wire: "vintage_fidelity" },
    actual: { wire: "actual", shape: "ReplayActual" },
    upperBound: { wire: "upper_bound", shape: "PerfectForesightBound" },
    episodes: { wire: "episodes", shape: "CurtailmentEpisode", list: true },
  },
  PerfectForesightBound: {
    label: { wire: "label" },
    recoveredMwh: { wire: "recovered_mwh" },
    avoidability: { wire: "avoidability" },
  },
  ReplayRefusal: {
    code: { wire: "code" },
    status: { wire: "status" },
    message: { wire: "message" },
    details: { wire: "details" },
  },
  Replay: {
    targetDate: { wire: "target_date" },
    subsystem: { wire: "subsystem" },
    thresholdMw: { wire: "threshold_mw" },
    maxGapHours: { wire: "max_gap_hours" },
    scenarioHash: { wire: "scenario_hash" },
    integrity: { wire: "integrity", shape: "ReplayIntegrity" },
    vintageFidelity: { wire: "vintage_fidelity" },
    forecastOrigin: { wire: "forecast_origin", shape: "ForecastOrigin" },
    actual: { wire: "actual", shape: "ReplayActual" },
    forecast: { wire: "forecast", shape: "ReplayForecast" },
    planningBasis: { wire: "planning_basis" },
    executionRule: { wire: "execution_rule" },
    scoredOn: { wire: "scored_on" },
    baselineCurtailmentMwh: { wire: "baseline_curtailment_mwh" },
    optimizedCurtailmentMwh: { wire: "optimized_curtailment_mwh" },
    avoidedEnergyMwh: { wire: "avoided_energy_mwh" },
    avoidability: { wire: "avoidability" },
    recoveredFloorMwh: { wire: "recovered_floor_mwh" },
    floorMet: { wire: "floor_met" },
    floorMarginMwh: { wire: "floor_margin_mwh" },
    scored: { wire: "scored", shape: "ReplayScored" },
    upperBound: { wire: "upper_bound", shape: "ReplayUpperBound" },
    dispatch: { wire: "dispatch", shape: "DispatchHour", list: true },
    executed: { wire: "executed", shape: "DispatchHour", list: true },
    storedAtHorizonEndMwh: { wire: "stored_at_horizon_end_mwh" },
    roundTripLossMwh: { wire: "round_trip_loss_mwh" },
    economicScenario: { wire: "economic_scenario", shape: "EconomicScenario" },
    episodes: { wire: "episodes", shape: "CurtailmentEpisode", list: true },
    solver: { wire: "solver", shape: "SolverReceipt" },
  },
  ReplayIntegrity: {
    provenance: { wire: "provenance" },
    modelSawThisDay: { wire: "model_saw_this_day" },
    heldOutBy: { wire: "held_out_by", shape: "ReplayIntegrityHeldOutBy" },
    vintageFidelity: { wire: "vintage_fidelity" },
    vintageAffects: { wire: "vintage_affects" },
    vintageExempt: { wire: "vintage_exempt" },
    revisionPremiumRecoveredMwh: { wire: "revision_premium_recovered_mwh" },
  },
  ReplayActual: {
    totalMwh: { wire: "total_mwh" },
    peakMw: { wire: "peak_mw" },
    hours: { wire: "hours" },
    dataVersion: { wire: "data_version" },
  },
  ReplayForecast: {
    hours: { wire: "hours", shape: "ReplayForecastHour", list: true },
    dayTotal: { wire: "day_total", shape: "Band" },
    peakPower: { wire: "peak_power", shape: "Band" },
    dayOccurrenceProbability: { wire: "day_occurrence_probability" },
  },
  ReplayForecastHour: {
    constrainedOffMwh: { wire: "constrained_off_mwh", shape: "Band" },
    expectedMwh: { wire: "expected_mwh" },
    occurrenceProbability: { wire: "occurrence_probability" },
  },
  Scenario: {
    v: { wire: "v" },
    subsystem: { wire: "subsystem" },
    targetDate: { wire: "target_date" },
    forecastOrigin: { wire: "forecast_origin", optional: true },
    assets: { wire: "assets", shape: "FlexibilityAsset", list: true },
    economicAssumptions: {
      wire: "economic_assumptions",
      shape: "ScenarioEconomicAssumptions",
      optional: true,
    },
  },
  DiagnosisNarrationInputForecastOrigin: {
    runLabel: { wire: "run_label" },
    gateProfile: { wire: "gate_profile" },
    publishedAt: { wire: "published_at" },
  },
  DiagnosisNarrationInputRisk: {
    dayOccurrenceProbability: { wire: "day_occurrence_probability" },
    riskClass: { wire: "risk_class" },
    hoursP50Nonzero: { wire: "hours_p50_nonzero" },
  },
  DiagnosisNarrationInputMagnitude: {
    dayExpectedMwh: { wire: "day_expected_mwh" },
    baselineExpectedMwh: { wire: "baseline_expected_mwh" },
    dayEnergyP10Mwh: { wire: "day_energy_p10_mwh" },
    dayEnergyP50Mwh: { wire: "day_energy_p50_mwh" },
    dayEnergyP90Mwh: { wire: "day_energy_p90_mwh" },
    peakPowerP50Mw: { wire: "peak_power_p50_mw" },
    peakHourLocal: { wire: "peak_hour_local" },
  },
  DiagnosisNarrationInputAttribution: {
    target: { wire: "target", const: "expected_mwh_day" },
    totalAttributedMwh: { wire: "total_attributed_mwh" },
    sumAbsAttributedMwh: { wire: "sum_abs_attributed_mwh" },
    stderrMwh: { wire: "stderr_mwh" },
    topTwoShare: { wire: "top_two_share" },
    groups: { wire: "groups", shape: "Driver", list: true },
  },
  ErrorEnvelopeError: {
    code: { wire: "code" },
    message: { wire: "message" },
    details: { wire: "details", optional: true },
    requestId: { wire: "request_id", optional: true },
  },
  NationalOutlookRiskClassCounts: {
    low: { wire: "low" },
    elevated: { wire: "elevated" },
    high: { wire: "high" },
  },
  MetaWindow: {
    opensOn: { wire: "opens_on" },
    ingestionGoLive: { wire: "ingestion_go_live" },
    firstHoldoutFoldStart: { wire: "first_holdout_fold_start" },
  },
  MetaDefaults: {
    subsystemThresholdMw: { wire: "subsystem_threshold_mw" },
    reportingEntityThresholdMw: { wire: "reporting_entity_threshold_mw" },
    maxGapHours: { wire: "max_gap_hours" },
    brlPerMwh: { wire: "brl_per_mwh" },
  },
  MetaData: {
    freshness: { wire: "freshness", shape: "MetaFreshness", list: true },
  },
  MetaReferenceFleet: {
    battery: { wire: "battery", shape: "ReferenceBattery" },
    shiftableLoad: { wire: "shiftable_load", shape: "ReferenceShiftableLoad" },
  },
  MetaModelVolume: {
    mounted: { wire: "mounted" },
    writable: { wire: "writable" },
  },
  MetaForecastStateLatestPublishedItem: {
    targetDate: { wire: "target_date" },
    gateProfile: { wire: "gate_profile" },
    publishedAt: { wire: "published_at" },
    ageHours: { wire: "age_hours" },
    subsystems: { wire: "subsystems" },
  },
  OptimizationResultScored: {
    p10: { wire: "p10", shape: "ScoredRealisation" },
    p50: { wire: "p50", shape: "ScoredRealisation" },
    p90: { wire: "p90", shape: "ScoredRealisation" },
  },
  ReplayScored: {
    p10: { wire: "p10", shape: "ScoredRealisation" },
    p50: { wire: "p50", shape: "ScoredRealisation" },
    p90: { wire: "p90", shape: "ScoredRealisation" },
    observed: { wire: "observed", shape: "ScoredRealisation" },
  },
  ReplayUpperBound: {
    label: { wire: "label" },
    recoveredMwh: { wire: "recovered_mwh" },
    avoidability: { wire: "avoidability" },
    forecastValueGapMwh: { wire: "forecast_value_gap_mwh" },
  },
  ReplayIntegrityHeldOutBy: {
    fold: { wire: "fold" },
    artifactId: { wire: "artifact_id" },
    trainWindow: { wire: "train_window" },
    calibrationWindow: { wire: "calibration_window" },
  },
  ScenarioEconomicAssumptions: {
    brlPerMwh: { wire: "brl_per_mwh" },
  },
} as const satisfies Record<string, WireShape>;

/** The name of a generated wire object. */
export type WireShapeName = keyof typeof WIRE_SHAPES;

/**
 * Every error code, as a type, derived from the same schema the gateway
 * validates against. `packages/core/src/errors.ts` holds the authority — the
 * code-to-status table — and this is the wire's view of it;
 * `test/schema-generated-types.test.ts` asserts the two agree member for
 * member, so neither can gain a code the other has not heard of.
 */
export type WireErrorCode = ErrorEnvelopeError["code"];

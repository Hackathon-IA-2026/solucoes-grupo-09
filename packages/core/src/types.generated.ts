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
 * not: `national.band` is `null` with `band_unavailable_reason` until the path
 * ensemble shares its draw index across subsystems.
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
 * key rather than as a fifth row. The band is `null` and says why: the median
 * of a sum is not the sum of the medians, and the four subsystems' curtailment
 * is not comonotone.
 */
export interface NationalOutlook {
  /**
   * The sum of the four `day_expected_mwh`. Expectations add exactly; this is
   * the only additive forecast quantity.
   */
  expectedMwh: number;
  riskClassCounts: NationalOutlookRiskClassCounts;
  /**
   * `null` until the path ensemble shares one drawn day-row index across the
   * four subsystems. A national band needs a joint distribution and no published
   * quantity supports one today.
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
 * Asserted at read time, never computed hopefully.
 * `revision_premium_recovered_mwh` is `null` when unmeasured, and says so,
 * rather than standing in as a zero.
 */
export interface ReplayIntegrity {
  provenance: "served" | "fold_holdout";
  modelSawThisDay: boolean;
  heldOutBy: ReplayIntegrityHeldOutBy | null;
  vintageAffects: string[];
  vintageExempt: string[];
  revisionPremiumRecoveredMwh: number | null;
}

export type ReplayDateWindow = [CivilDate, CivilDate];

export interface ReplayActual {
  totalMwh: number;
  peakMw: number;
  hours: number[];
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
    attribution: { wire: "attribution", shape: "SourceAttribution", map: true },
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
    vintageAffects: { wire: "vintage_affects" },
    vintageExempt: { wire: "vintage_exempt" },
    revisionPremiumRecoveredMwh: { wire: "revision_premium_recovered_mwh" },
  },
  ReplayActual: {
    totalMwh: { wire: "total_mwh" },
    peakMw: { wire: "peak_mw" },
    hours: { wire: "hours" },
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

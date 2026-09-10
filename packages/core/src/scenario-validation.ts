/**
 * The validation table: a nonsensical scenario is refused, never corrected.
 *
 * `docs/specs/flex-optimizer.md` §Validation is the authority, and its posture
 * is one sentence: **nothing is coerced.** An initial state of charge outside
 * its own bounds is a `422` and not a clamp; a battery given half an efficiency
 * pair is a `422` and not a symmetric guess. The reason is the same one the
 * data-platform spec already ruled on — a repaired input produces a plan for an
 * asset the caller did not describe, and nothing in the response says so. A
 * refusal is legible; a repair is a plausible answer to a question nobody
 * asked.
 *
 * There is no `clamp`, no `??` supplying a magnitude, and no `Math.min` in this
 * file. The only values it substitutes are the four the spec *states* as
 * defaults for absent fields — `min`/`max_state_of_charge`, `available_from`,
 * `available_to` — and a default for an absent field is not a correction of a
 * supplied one.
 *
 * ### Where this runs, and why twice
 *
 * In the Elysia gateway, **before the request reaches the solver**, because
 * model construction rather than solving dominates the request and a rejected
 * scenario should never build one. And again in `apps/ml`, which trusts nothing
 * it did not validate itself: `apps/ml/src/wattsteer_ml/scenario_validation.py`
 * is this module in Python, and neither is generated from the other. What binds
 * them is `packages/core/fixtures/scenario-validation/`, which both test suites
 * read — see that directory's README.
 *
 * ### What it validates, and in what order
 *
 * The wire form (`snake_case`), which is what
 * {@link canonicalizeScenarioWire} produced and what the hash was taken over —
 * so the object validated is provably the object the answer will be stamped
 * with, rather than a second derivation of it.
 *
 * One failure is reported, not a list, because the envelope carries one `code`.
 * The order is therefore part of the contract and is fixed here: the
 * scenario's own fields first (version, size, subsystem, date, economics), then
 * each asset in index order, and inside an asset its identity (`asset_type`,
 * then the key set that identity admits) before any of the numbers that
 * identity gives meaning to. A battery carrying `max_shift_mw` is
 * `FIELD_NOT_ON_VARIANT` whatever else is wrong with it, because until the
 * variant is settled "the field is out of range" is not a statement anyone can
 * make.
 *
 * ### The one code that is defined here and thrown elsewhere
 *
 * `FORECAST_UNAVAILABLE` is in the spec's table but is not a fact about the
 * scenario: it is the answer to a database question, and the query belongs to
 * flex-optimizer ticket 07. {@link forecastUnavailable} builds it here so that
 * its code, its status and its `details` shape have exactly one definition, and
 * nothing in this module ever throws it.
 */

import { ApiError } from "./client.js";
import { SUBSYSTEM_DISPLAY_ORDER } from "./constants.js";
import { type ErrorCode, type ErrorDetails, statusForCode } from "./errors.js";
import { type JsonValue, SCENARIO_VERSION } from "./scenario.js";
import { WIRE_SHAPES } from "./types.generated.js";

/**
 * A scenario this build refuses to plan for, named by the code that says why.
 *
 * The sibling of `ScenarioTransportError`, and deliberately a second class: a
 * transport refusal says the *bytes* could not be read, this one says the
 * bytes were read and describe something that is not a fleet. Both extend
 * `ApiError`, so both reach the gateway's one envelope with a code from the one
 * closed enum, and neither can be constructed without one.
 */
export class ScenarioValidationError extends ApiError {
  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super({ status: statusForCode(code), code, message, details });
    this.name = "ScenarioValidationError";
  }
}

// --- the published bounds ----------------------------------------------------
//
// Every number the table names, as a constant, because a screen that greys out
// a slider at 10 000 and a gateway that refuses at 10 000 have to be reading
// the same 10 000. `apps/ml/src/wattsteer_ml/scenario_validation.py` declares
// the same set and the shared fixtures pin every boundary from both sides.

/** `SCENARIO_TOO_LARGE`: the cap on asset count. The blob cap is in `scenario.ts`. */
export const MAX_ASSETS = 20;

/** `MAGNITUDE_OUT_OF_RANGE`: `max_power_mw` and every power in MW, `(0, 10 000]`. */
export const MAX_POWER_MW = 10_000;

/** `MAGNITUDE_OUT_OF_RANGE`: `energy_capacity_mwh` / `daily_energy_mwh`, `(0, 100 000]`. */
export const MAX_ENERGY_MWH = 100_000;

/** `RTE_OUT_OF_RANGE`: `[0.50, 1.00)`, inclusive below and exclusive above. */
export const MIN_EFFICIENCY = 0.5;

/** `SHIFT_WINDOW_OUT_OF_RANGE`: `L ∈ [1, 8]`, an integer. */
export const MIN_SHIFT_WINDOW_HOURS = 1;
export const MAX_SHIFT_WINDOW_HOURS = 8;

/** `RECOVERY_TIME_OUT_OF_RANGE`: `[1, 24]` when present at all. */
export const MIN_RECOVERY_TIME_HOURS = 1;
export const MAX_RECOVERY_TIME_HOURS = 24;

/** `ECONOMIC_ASSUMPTION_OUT_OF_RANGE`: `brl_per_mwh ∈ (0, 10 000]`. */
export const MAX_BRL_PER_MWH = 10_000;

/** The spec's defaults for a battery that does not state its SOC window. */
export const DEFAULT_MIN_STATE_OF_CHARGE = 0.05;
export const DEFAULT_MAX_STATE_OF_CHARGE = 0.95;

/** The default availability: the whole local day, half-open `[from, to)`. */
export const DEFAULT_AVAILABLE_FROM = "00:00";
export const DEFAULT_AVAILABLE_TO = "24:00";

/**
 * `TARGET_DATE_OUT_OF_RANGE`: the first civil date WattSteer has data for.
 *
 * The window opens 2024-04 — the same window `apps/api`'s ingest calls
 * `WINDOW_OPENS_ON` and the forecaster's folds are cut inside. A scenario
 * before it cannot be planned against anything.
 */
export const DATA_WINDOW_OPENS_ON = "2024-04-01";

/** Brasília civil time: the horizon is a local day, so "tomorrow" is a local one. */
export const GRID_TIME_ZONE = "America/Sao_Paulo";

const MS_PER_DAY = 86_400_000;

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `"HH:00"` — minutes are always `00`, and `24:00` ends the day. */
const CLOCK_TIME = /^([01]\d|2[0-4]):(\d\d)$/;

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: GRID_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The `YYYY-MM-DD` Brasília civil day an instant falls in. */
export function civilDay(now: Date): string {
  return dayFormatter.format(now);
}

/** The civil date one day after `date`. ISO dates compare lexicographically. */
function nextDay(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return new Date(parsed + MS_PER_DAY).toISOString().slice(0, 10);
}

/** The last `target_date` this API will plan for: tomorrow, in Brasília. */
export function latestTargetDate(now: Date): string {
  return nextDay(civilDay(now));
}

// --- reading the wire --------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A finite number, or `undefined` for anything else — including `null`, a
 * numeric string and `NaN`.
 *
 * Deliberately not a coercion: `"100"` is not a hundred megawatts, it is a
 * caller who sent the wrong type, and `Number("100")` would hide that. Every
 * caller of this treats `undefined` as "absent or unreadable" and refuses.
 */
function num(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function has(asset: Record<string, JsonValue>, key: string): boolean {
  return asset[key] !== undefined;
}

/** The wire keys one variant of the sum type admits, read from the schema. */
interface VariantField {
  readonly wire: string;
  readonly const?: string;
}

function variantKeys(assetType: string): Set<string> | undefined {
  const shapes = Object.values(WIRE_SHAPES) as readonly Readonly<
    Record<string, VariantField>
  >[];
  for (const shape of shapes) {
    const fields = Object.values(shape);
    if (fields.find((field) => field.wire === "asset_type")?.const === assetType) {
      return new Set(fields.map((field) => field.wire));
    }
  }
  return undefined;
}

// --- the checks --------------------------------------------------------------

/**
 * The one clause of the table an endpoint is allowed to substitute.
 *
 * Everything else — the version, the subsystem, the asset cap, every magnitude
 * and every physical bound — is identical at `/v1/optimize` and `/v1/replay`,
 * because it is the same solver behind the same public surface and a blob
 * accepted by one and refused by the other would make a shared link mean two
 * things. The date is the exception `docs/specs/replay.md` names, and it is a
 * parameter so the exception is one argument wide and visible in every caller
 * rather than a branch hidden inside the table.
 */
export type TargetDateRule = (raw: JsonValue | undefined, now: Date) => void;

/** What a validation run is told about the world outside the scenario. */
export interface ValidationOptions {
  /**
   * The instant "tomorrow" is measured from. Injected rather than read from the
   * clock so that a fixture asserting the boundary asserts a boundary rather
   * than the day the suite happened to run.
   */
  now?: Date;
  /**
   * Which date clause to run. Defaults to `planningTargetDate`, so a caller
   * that does not name one gets `/v1/optimize`'s table exactly.
   */
  targetDate?: TargetDateRule;
}

function refuse(code: ErrorCode, message: string, details?: ErrorDetails): never {
  throw new ScenarioValidationError(code, message, details);
}

/**
 * A required number that is absent or is not a number at all.
 *
 * `REQUEST_INVALID` rather than a table code, and the distinction is worth
 * keeping: the table answers "this fleet is not physical", and a missing
 * `max_power_mw` is not a claim about a battery — it is a request that never
 * described one. Giving it `MAGNITUDE_OUT_OF_RANGE` would tell a caller their
 * number is too big when they sent no number.
 */
function required(asset: Record<string, JsonValue>, key: string, field: string): number {
  const value = num(asset[key]);
  if (value === undefined) {
    refuse("REQUEST_INVALID", `${field} must be a finite number`, { field });
  }
  return value;
}

function magnitude(value: number, cap: number, field: string): void {
  if (!(value > 0 && value <= cap)) {
    refuse("MAGNITUDE_OUT_OF_RANGE", `${field} is ${value}; the range is (0, ${cap}]`, {
      field,
      limit: cap,
    });
  }
}

function efficiency(value: number, field: string): void {
  if (!(value >= MIN_EFFICIENCY && value < 1)) {
    refuse("RTE_OUT_OF_RANGE", `${field} is ${value}; the range is [0.5, 1.0)`, {
      field,
      limit: MIN_EFFICIENCY,
    });
  }
}

/**
 * `"HH:00"` → the hour, or a refusal.
 *
 * Minutes must be `"00"`: the horizon is 24 whole hours and a window opening at
 * 11:30 would have to be rounded to be usable, which is the coercion this whole
 * module exists to refuse.
 */
function clockHour(raw: JsonValue | undefined, field: string): number {
  if (typeof raw !== "string") {
    refuse("AVAILABILITY_INVALID", `${field} must be an "HH:00" string`, { field });
  }
  const match = CLOCK_TIME.exec(raw);
  if (match === null || match[2] !== "00") {
    refuse(
      "AVAILABILITY_INVALID",
      `${field} is ${JSON.stringify(raw)}; availability is "HH:00" on the hour`,
      { field },
    );
  }
  return Number(match[1]);
}

function checkAvailability(asset: Record<string, JsonValue>, path: string): void {
  const from = clockHour(
    asset.available_from ?? DEFAULT_AVAILABLE_FROM,
    `${path}.available_from`,
  );
  const to = clockHour(
    asset.available_to ?? DEFAULT_AVAILABLE_TO,
    `${path}.available_to`,
  );
  if (to <= from) {
    // Half-open `[from, to)`: `to == from` is an asset available for no hours,
    // which is a scenario that says nothing rather than one that says zero.
    refuse(
      "AVAILABILITY_INVALID",
      `${path} is available from ${from}:00 to ${to}:00, which is not a window`,
      { field: `${path}.available_to` },
    );
  }
}

function checkBattery(asset: Record<string, JsonValue>, path: string): void {
  const maxPower = required(asset, "max_power_mw", `${path}.max_power_mw`);
  magnitude(maxPower, MAX_POWER_MW, `${path}.max_power_mw`);
  magnitude(
    required(asset, "energy_capacity_mwh", `${path}.energy_capacity_mwh`),
    MAX_ENERGY_MWH,
    `${path}.energy_capacity_mwh`,
  );

  // --- the efficiency pair, before either half is range-checked -------------
  //
  // "One number or two, never one and a half." A datasheet prints a round-trip
  // figure and the SOC balance needs `ηc` and `ηd`; a modeller who has the
  // asymmetric pair supplies both. Half a pair is refused rather than mirrored,
  // because mirroring invents the number the caller did not have — and RTE
  // *beside* a half is refused because the two would have to be reconciled, and
  // reconciling means picking one and silently discarding the other.
  const roundTrip = has(asset, "round_trip_efficiency");
  const charge = has(asset, "charge_efficiency");
  const discharge = has(asset, "discharge_efficiency");
  if (charge !== discharge) {
    refuse(
      "EFFICIENCY_PAIR_INCOMPLETE",
      `${path} supplies ${charge ? "charge_efficiency" : "discharge_efficiency"} without its pair`,
      { field: `${path}.${charge ? "charge_efficiency" : "discharge_efficiency"}` },
    );
  }
  if (roundTrip && (charge || discharge)) {
    refuse(
      "EFFICIENCY_PAIR_INCOMPLETE",
      `${path} supplies round_trip_efficiency alongside an explicit pair`,
      { field: `${path}.round_trip_efficiency` },
    );
  }
  if (!(roundTrip || charge)) {
    refuse("REQUEST_INVALID", `${path} states no efficiency`, {
      field: `${path}.round_trip_efficiency`,
    });
  }
  if (roundTrip) {
    efficiency(
      required(asset, "round_trip_efficiency", `${path}.round_trip_efficiency`),
      `${path}.round_trip_efficiency`,
    );
  } else {
    efficiency(
      required(asset, "charge_efficiency", `${path}.charge_efficiency`),
      `${path}.charge_efficiency`,
    );
    efficiency(
      required(asset, "discharge_efficiency", `${path}.discharge_efficiency`),
      `${path}.discharge_efficiency`,
    );
  }

  // --- the state-of-charge window, then the point inside it ----------------
  const minSoc = has(asset, "min_state_of_charge")
    ? required(asset, "min_state_of_charge", `${path}.min_state_of_charge`)
    : DEFAULT_MIN_STATE_OF_CHARGE;
  const maxSoc = has(asset, "max_state_of_charge")
    ? required(asset, "max_state_of_charge", `${path}.max_state_of_charge`)
    : DEFAULT_MAX_STATE_OF_CHARGE;
  if (!(minSoc >= 0 && minSoc < maxSoc && maxSoc <= 1)) {
    refuse(
      "SOC_BOUNDS_INVALID",
      `${path} has min_state_of_charge ${minSoc} and max_state_of_charge ${maxSoc}; the rule is 0 ≤ min < max ≤ 1`,
      { field: `${path}.min_state_of_charge` },
    );
  }
  const initial = required(
    asset,
    "initial_state_of_charge",
    `${path}.initial_state_of_charge`,
  );
  if (initial < minSoc || initial > maxSoc) {
    // **The clamp that does not happen.** `docs/specs/flex-optimizer.md` names
    // this case on its own: an initial SOC outside its bounds is an error,
    // never a clamp, because the plan would otherwise be computed for a battery
    // the user did not describe and the response would not say so.
    refuse(
      "SOC_INITIAL_OUT_OF_BOUNDS",
      `${path} starts at ${initial}, outside its own bounds [${minSoc}, ${maxSoc}]`,
      { field: `${path}.initial_state_of_charge` },
    );
  }

  // --- the per-direction limits, against the inverter ----------------------
  for (const key of ["max_charge_mw", "max_discharge_mw"] as const) {
    if (!has(asset, key)) {
      continue;
    }
    const value = required(asset, key, `${path}.${key}`);
    // The table names three magnitudes explicitly; the same code covers the
    // rest, because a negative `max_charge_mw` has no other code in the closed
    // enum and admitting it would hand the solver an unbounded direction.
    magnitude(value, MAX_POWER_MW, `${path}.${key}`);
    if (value > maxPower) {
      refuse(
        "POWER_LIMIT_INCONSISTENT",
        `${path}.${key} is ${value}, above max_power_mw ${maxPower}`,
        { field: `${path}.${key}`, limit: maxPower },
      );
    }
  }
}

function checkShiftableLoad(asset: Record<string, JsonValue>, path: string): void {
  const maxPower = required(asset, "max_power_mw", `${path}.max_power_mw`);
  magnitude(maxPower, MAX_POWER_MW, `${path}.max_power_mw`);
  const dailyEnergy = required(asset, "daily_energy_mwh", `${path}.daily_energy_mwh`);
  magnitude(dailyEnergy, MAX_ENERGY_MWH, `${path}.daily_energy_mwh`);
  const maxShift = required(asset, "max_shift_mw", `${path}.max_shift_mw`);
  magnitude(maxShift, MAX_POWER_MW, `${path}.max_shift_mw`);

  if (maxShift > maxPower) {
    refuse(
      "SHIFT_EXCEEDS_CONNECTION",
      `${path}.max_shift_mw is ${maxShift}, above the connection limit ${maxPower}`,
      { field: `${path}.max_shift_mw`, limit: maxPower },
    );
  }

  // The one physical check the formulation cannot make for itself. Zerrahn &
  // Schill's (D1) conserves daily energy by construction, so nothing in the
  // model stops a load being shed by more power than it draws; with no baseline
  // profile supplied the flat baseline is `daily_energy_mwh / 24`, and this is
  // what makes the prototype's 70 MW against 1 200 MWh/day a `422`.
  const baseline = dailyEnergy / 24;
  if (maxShift > baseline) {
    refuse(
      "SHIFT_EXCEEDS_BASELINE",
      `${path}.max_shift_mw is ${maxShift}, above the flat baseline ${baseline} (daily_energy_mwh / 24)`,
      { field: `${path}.max_shift_mw`, limit: baseline },
    );
  }

  const window = required(asset, "shift_window_hours", `${path}.shift_window_hours`);
  if (
    !Number.isInteger(window) ||
    window < MIN_SHIFT_WINDOW_HOURS ||
    window > MAX_SHIFT_WINDOW_HOURS
  ) {
    refuse(
      "SHIFT_WINDOW_OUT_OF_RANGE",
      `${path}.shift_window_hours is ${window}; the range is [${MIN_SHIFT_WINDOW_HOURS}, ${MAX_SHIFT_WINDOW_HOURS}] whole hours`,
      { field: `${path}.shift_window_hours`, limit: MAX_SHIFT_WINDOW_HOURS },
    );
  }

  // `null` is a stated member of the contract and means "no (D5) block", which
  // is a different scenario from a recovery time of zero. Absent and null are
  // the same thing here and neither is a refusal.
  const recovery = asset.recovery_time_hours;
  if (recovery !== undefined && recovery !== null) {
    const hours = num(recovery);
    if (
      hours === undefined ||
      hours < MIN_RECOVERY_TIME_HOURS ||
      hours > MAX_RECOVERY_TIME_HOURS
    ) {
      refuse(
        "RECOVERY_TIME_OUT_OF_RANGE",
        `${path}.recovery_time_hours is ${JSON.stringify(recovery)}; the range is [${MIN_RECOVERY_TIME_HOURS}, ${MAX_RECOVERY_TIME_HOURS}]`,
        { field: `${path}.recovery_time_hours`, limit: MAX_RECOVERY_TIME_HOURS },
      );
    }
  }
}

function checkAsset(raw: JsonValue, index: number, scenarioSubsystem: string): void {
  const path = `assets[${index}]`;
  if (!isPlainObject(raw)) {
    refuse("ASSET_TYPE_UNKNOWN", `${path} is not an object`, { field: path });
  }
  const assetType = raw.asset_type;
  const allowed = typeof assetType === "string" ? variantKeys(assetType) : undefined;
  if (allowed === undefined) {
    refuse(
      "ASSET_TYPE_UNKNOWN",
      `${path}.asset_type is ${JSON.stringify(assetType) ?? "absent"}`,
      { field: `${path}.asset_type` },
    );
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      refuse("FIELD_NOT_ON_VARIANT", `${key} is not a field of ${String(assetType)}`, {
        field: `${path}.${key}`,
      });
    }
  }

  // One subsystem per scenario: `curt[t]` is a subsystem-level series and an
  // asset somewhere else cannot absorb it. Mixed-subsystem scenarios are
  // rejected, never summed — summing them would report Northeast curtailment
  // absorbed by a battery in the South.
  if (raw.subsystem !== scenarioSubsystem) {
    refuse(
      "SUBSYSTEM_MISMATCH",
      `${path}.subsystem is ${JSON.stringify(raw.subsystem) ?? "absent"}; the scenario is ${scenarioSubsystem}`,
      { field: `${path}.subsystem` },
    );
  }

  if (assetType === "battery") {
    checkBattery(raw, path);
  } else {
    checkShiftableLoad(raw, path);
  }
  checkAvailability(raw, path);
}

/**
 * Refuse a scenario that is not one, or return.
 *
 * Takes the wire form — `snake_case`, as `decodeScenarioParam` and
 * `decodeScenarioBody` produce it and as the hash was taken over it. Returns
 * nothing: there is no repaired scenario to hand back, which is the API making
 * the ticket's point structurally rather than in prose.
 */
export function validateScenarioWire(
  wire: JsonValue,
  options: ValidationOptions = {},
): void {
  if (!isPlainObject(wire)) {
    refuse("BAD_INPUT", "a scenario is a JSON object");
  }
  if (wire.v !== SCENARIO_VERSION) {
    refuse(
      "SCENARIO_VERSION_UNSUPPORTED",
      `v must be ${SCENARIO_VERSION}; this scenario carries ${JSON.stringify(wire.v) ?? "nothing"}`,
      { field: "v", limit: SCENARIO_VERSION },
    );
  }

  const subsystem = wire.subsystem;
  if (
    typeof subsystem !== "string" ||
    !(SUBSYSTEM_DISPLAY_ORDER as readonly string[]).includes(subsystem)
  ) {
    refuse(
      "SUBSYSTEM_UNKNOWN",
      `subsystem is ${JSON.stringify(subsystem) ?? "absent"}; the four are ${SUBSYSTEM_DISPLAY_ORDER.join(", ")}`,
      { field: "subsystem" },
    );
  }

  (options.targetDate ?? planningTargetDate)(wire.target_date, options.now ?? new Date());

  const assets = wire.assets;
  if (!Array.isArray(assets) || assets.length === 0) {
    refuse("REQUEST_INVALID", "a scenario describes at least one asset", {
      field: "assets",
    });
  }
  if (assets.length > MAX_ASSETS) {
    // The other half of `SCENARIO_TOO_LARGE`. The blob cap bounds what is
    // parsed; this bounds what is *modelled*, because the endpoint is public
    // and unauthenticated and every asset is a block of MILP variables.
    refuse(
      "SCENARIO_TOO_LARGE",
      `the scenario carries ${assets.length} assets; the cap is ${MAX_ASSETS}`,
      { field: "assets", limit: MAX_ASSETS },
    );
  }
  for (const [index, asset] of assets.entries()) {
    checkAsset(asset, index, subsystem);
  }

  checkEconomicAssumptions(wire.economic_assumptions);
}

/**
 * The half of the date clause that is a statement about the *bytes*.
 *
 * Shared by every rule below: a `target_date` that is not a date is
 * `REQUEST_INVALID` on any endpoint, and no endpoint can disagree about that
 * without disagreeing about the transport.
 */
function checkTargetDateShape(raw: JsonValue | undefined): asserts raw is string {
  if (typeof raw !== "string" || !CIVIL_DATE.test(raw)) {
    refuse("REQUEST_INVALID", `target_date must be YYYY-MM-DD`, {
      field: "target_date",
    });
  }
  // `2026-02-31` matches the pattern and names no day. Refused as malformed
  // rather than as out of range: it is not a date that is outside the window,
  // it is not a date.
  if (new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) {
    refuse("REQUEST_INVALID", `target_date ${raw} is not a calendar date`, {
      field: "target_date",
    });
  }
}

/**
 * `/v1/optimize`'s clause: inside the data window, and not past tomorrow.
 *
 * The published rule, and the default, because planning is what a `Scenario` is
 * for and a replay is the one endpoint that reads the same document with a
 * different question in mind.
 */
export const planningTargetDate: TargetDateRule = (raw, now) => {
  checkTargetDateShape(raw);
  const latest = latestTargetDate(now);
  if (raw < DATA_WINDOW_OPENS_ON || raw > latest) {
    refuse(
      "TARGET_DATE_OUT_OF_RANGE",
      `target_date ${raw} is outside [${DATA_WINDOW_OPENS_ON}, ${latest}]`,
      { field: "target_date" },
    );
  }
};

/**
 * `/v1/replay`'s clause: the shape, and then somebody else's judgement.
 *
 * `docs/specs/replay.md` seam 10 states the parity claim and its one exception
 * in the same breath — "scenario validation parity with `/v1/optimize` **minus
 * its date clause**" — because the two endpoints cannot agree there and an
 * implementation that made them agree would be wrong about one of them. A
 * 2024-06 target is a perfectly good planning date (the data window opens
 * 2024-04) and is refused by a replay as pre-F1; tomorrow is a planning date
 * and is not a day that has happened.
 *
 * So this rule checks the shape and stops. Every window verdict belongs to the
 * replayable predicate in `apps/ml`, which reads the fold calendar for where
 * the holdout window opens and answers with the code of the clause that failed
 * — `REPLAY_DATE_BEFORE_HOLDOUT_WINDOW` and `REPLAY_DATE_OUT_OF_RANGE` are two
 * different sentences and `TARGET_DATE_OUT_OF_RANGE` is neither. Restating any
 * of it here would put a second implementation of that predicate on the far
 * side of a network hop from the fold calendar it is a function of.
 */
export const replayTargetDate: TargetDateRule = (raw) => {
  checkTargetDateShape(raw);
};

function checkEconomicAssumptions(raw: JsonValue | undefined): void {
  if (raw === undefined) {
    // Absent means the published `BRL_PER_MWH` is used and stamped on the
    // answer. Not a default substituted for a bad value — there is no value.
    return;
  }
  if (!isPlainObject(raw)) {
    refuse("REQUEST_INVALID", "economic_assumptions is an object", {
      field: "economic_assumptions",
    });
  }
  const rate = num(raw.brl_per_mwh);
  if (rate === undefined) {
    refuse("REQUEST_INVALID", "economic_assumptions.brl_per_mwh must be a number", {
      field: "economic_assumptions.brl_per_mwh",
    });
  }
  if (!(rate > 0 && rate <= MAX_BRL_PER_MWH)) {
    refuse(
      "ECONOMIC_ASSUMPTION_OUT_OF_RANGE",
      `economic_assumptions.brl_per_mwh is ${rate}; the range is (0, ${MAX_BRL_PER_MWH}]`,
      { field: "economic_assumptions.brl_per_mwh", limit: MAX_BRL_PER_MWH },
    );
  }
}

/**
 * `FORECAST_UNAVAILABLE` — defined here, thrown by flex-optimizer ticket 07.
 *
 * The table lists it beside the other refusals, but it is the only one that is
 * not a fact about the scenario: the scenario is well-formed and describes a
 * real fleet, and there is simply no forecast for that subsystem, date and
 * origin to plan against. Deciding that needs the query ticket 07 owns, so
 * nothing in this module throws it — and it is constructed here anyway so that
 * its status and its `details` shape have one definition rather than being
 * invented at the throw site.
 *
 * It answers `404`, which is the status the closed enum already publishes it
 * under for the four "no forecast" states. That is deliberate and is the one
 * place this module departs from the spec's "validation → 422" row: a `422`
 * would say the caller's scenario is wrong, and it is not.
 */
export function forecastUnavailable(
  subsystem: string,
  targetDate: string,
  forecastOrigin?: string,
): ScenarioValidationError {
  return new ScenarioValidationError(
    "FORECAST_UNAVAILABLE",
    `No forecast exists for ${subsystem} on ${targetDate}${forecastOrigin ? ` at origin ${forecastOrigin}` : ""}`,
    {
      subsystem,
      target_date: targetDate,
      ...(forecastOrigin === undefined ? {} : { forecast_origin: forecastOrigin }),
    },
  );
}

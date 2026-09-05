/**
 * The Mitigate scenario, as it lives in the address bar.
 *
 * `docs/specs/flex-optimizer.md`: *"The URL is the storage; there is nothing to
 * persist and no identity to invent."* `params.ts` already recorded the
 * consequence — *"once the Mitigate screen's assets are in the URL, having its
 * subsystem and date somewhere else would be incoherent"* — and this module is
 * where that lands. It is deliberately free of React and of expo-router, the
 * same way `params.ts` is, so every rule below is unit-testable without a
 * renderer.
 *
 * **It owns no encoding of its own.** `@wattsteer/core`'s `encodeScenario` /
 * `decodeScenarioParam` are the canonical form and the transport, and
 * `validateScenarioWire` is the eighteen-rule refusal table — the *same*
 * functions the gateway runs before it builds a model. A second spelling of
 * either on this side would be a link the API rejects and the screen accepts,
 * which is the one failure a shareable URL cannot survive. So the screen holds
 * a whole {@link Scenario} rather than a bag of asset fields: a blob that
 * arrives carrying `available_from`, an explicit efficiency pair or a pinned
 * `forecast_origin` re-encodes to the *same bytes* it arrived as, because
 * nothing here rebuilds it from the handful of fields the editors happen to
 * touch.
 *
 * **A refusal is a code, never a sentence.** Everything below reports an
 * `ErrorCode` from the closed enum and the screen renders `copy.error[code]`
 * in the reader's locale, exactly as it would for a code the gateway returned.
 * That is what makes "no translated string arrives from the API" structural:
 * there is no path on this screen by which a refusal becomes prose anywhere
 * but the dictionaries.
 *
 * **`label` is carried, never rendered.** It is the one free-text field on an
 * attacker-controlled document. The screen names an asset from the dictionary
 * by its `assetType`, so the label survives a round trip — a shared link keeps
 * its bytes — without ever reaching a text node or a tooltip.
 */

import {
  BRL_PER_MWH,
  decodeScenarioParam,
  type ErrorCode,
  encodeScenario,
  type JsonValue,
  REFERENCE_FLEET,
  SCENARIO_PARAM,
  type SubsystemCode,
  type TargetDateRule,
  validateScenarioWire,
} from "@wattsteer/core";
import type { Battery, Scenario, ShiftableLoad } from "@wattsteer/core/api";
import type { BatteryAsset, ShiftableLoadAsset } from "@/lib/fixtures";

/** The query parameter the scenario travels in — core's, not a second one. */
export { SCENARIO_PARAM };

/**
 * A scenario that decoded and passed the table, or the code that refused it.
 *
 * One code and not a list, because the envelope carries one — and because a
 * screen that showed five refusals at once would be describing a document
 * rather than telling a reader what to fix.
 */
export type ScenarioReadout =
  | { readonly ok: true; readonly scenario: Scenario }
  | { readonly ok: false; readonly code: ErrorCode };

/**
 * The screen's opening scenario: `REFERENCE_FLEET`, in the subsystem and on
 * the day the rest of the selection names.
 *
 * The sizes are not restated here. Floor coverage, `Δ recovered_floor_mwh`,
 * the featured-days list and the hot-swap guardrail are all measured against
 * one fleet, and they only mean what they say if it is the same one — so it is
 * spent from `@wattsteer/core`, never re-typed.
 */
export function defaultScenario(subsystem: SubsystemCode, targetDate: string): Scenario {
  return {
    v: 1,
    subsystem,
    targetDate,
    assets: [
      {
        assetType: "battery",
        label: REFERENCE_FLEET.battery.label,
        subsystem,
        maxPowerMw: REFERENCE_FLEET.battery.maxPowerMw,
        energyCapacityMwh: REFERENCE_FLEET.battery.energyCapacityMwh,
        roundTripEfficiency: REFERENCE_FLEET.battery.roundTripEfficiency,
        initialStateOfCharge: REFERENCE_FLEET.battery.initialStateOfCharge,
      },
      {
        assetType: "shiftable_load",
        label: REFERENCE_FLEET.shiftableLoad.label,
        subsystem,
        maxPowerMw: REFERENCE_FLEET.shiftableLoad.maxPowerMw,
        maxShiftMw: REFERENCE_FLEET.shiftableLoad.maxShiftMw,
        shiftWindowHours: REFERENCE_FLEET.shiftableLoad.shiftWindowHours,
        dailyEnergyMwh: REFERENCE_FLEET.shiftableLoad.dailyEnergyMwh,
      },
    ],
    economicAssumptions: { brlPerMwh: BRL_PER_MWH },
  };
}

/** The blob a link carries. Refuses over the published cap, as the API does. */
export function writeScenario(scenario: Scenario): string {
  return encodeScenario(scenario);
}

/**
 * The code off a refusal, whatever threw it.
 *
 * `ScenarioTransportError` and `ScenarioValidationError` both extend
 * `ApiError` and both are constructed with a member of the closed enum, so the
 * field is always there. The fallback exists for the one case neither covers —
 * a `JSON.parse` inside the decoder that got past its own wrapper — and
 * `BAD_INPUT` is what that is.
 */
export function refusalCode(cause: unknown): ErrorCode {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" ? (code as ErrorCode) : "BAD_INPUT";
}

/**
 * `?s=<blob>` → a scenario this screen can draw, or the code that refused it.
 *
 * Four gates, in the order the gateway applies them, because the order is the
 * contract: the blob's own size cap and its grammar (`decodeScenarioParam`),
 * then the refusal table (`validateScenarioWire`), then the one rule that is
 * this screen's own — the editors edit exactly one battery and one flexible
 * load, so a link describing anything else is a request this prototype cannot
 * honour and says so rather than drawing a fleet nobody asked for.
 *
 * `now` is injected for the same reason `ValidationOptions` injects it: a test
 * asserting the target-date boundary should assert a boundary rather than the
 * day the suite happened to run.
 */
export function readScenario(
  raw: string | undefined,
  fallback: Scenario,
  options: { now?: Date; targetDate?: TargetDateRule } = {},
): ScenarioReadout {
  if (raw === undefined || raw === "") {
    return { ok: true, scenario: fallback };
  }
  try {
    const decoded = decodeScenarioParam(raw);
    validateScenarioWire(JSON.parse(decoded.canonical) as JsonValue, {
      now: options.now,
      targetDate: options.targetDate,
    });
    const batteries = decoded.scenario.assets.filter(isBattery);
    const loads = decoded.scenario.assets.filter(isLoad);
    if (batteries.length !== 1 || loads.length !== 1) {
      // `REQUEST_INVALID` and not a table code: the table answers "this fleet
      // is not physical", and a two-battery scenario is perfectly physical —
      // it is this screen that has one battery editor. The distinction is the
      // same one `scenario-validation.ts` draws for an absent `max_power_mw`.
      return { ok: false, code: "REQUEST_INVALID" };
    }
    return { ok: true, scenario: decoded.scenario };
  } catch (cause) {
    return { ok: false, code: refusalCode(cause) };
  }
}

function isBattery(asset: Scenario["assets"][number]): asset is Battery {
  return asset.assetType === "battery";
}

function isLoad(asset: Scenario["assets"][number]): asset is ShiftableLoad {
  return asset.assetType === "shiftable_load";
}

/** The one battery. Only ever called on a scenario {@link readScenario} passed. */
export function scenarioBattery(scenario: Scenario): Battery {
  const found = scenario.assets.find(isBattery);
  if (found === undefined) {
    throw new Error("scenario carries no battery");
  }
  return found;
}

/** The one flexible load. */
export function scenarioLoad(scenario: Scenario): ShiftableLoad {
  const found = scenario.assets.find(isLoad);
  if (found === undefined) {
    throw new Error("scenario carries no shiftable load");
  }
  return found;
}

/** The assumed R$/MWh, defaulted where the scenario omits the block. */
export function scenarioBrlPerMwh(scenario: Scenario): number {
  return scenario.economicAssumptions?.brlPerMwh ?? BRL_PER_MWH;
}

/**
 * The wire battery, as the prototype heuristic reads it.
 *
 * A datasheet prints one round-trip number and the balance needs two, so the
 * contract accepts either — and `RTE = ηc·ηd`, derived and never stored twice.
 * Reading the pair back into a single round trip here is that same identity in
 * the other direction, not a repair of the scenario: the simulator splits it
 * straight back into `√RTE` per leg.
 */
export function fixtureBattery(battery: Battery): BatteryAsset {
  const pair =
    battery.chargeEfficiency !== undefined && battery.dischargeEfficiency !== undefined
      ? battery.chargeEfficiency * battery.dischargeEfficiency
      : undefined;
  return {
    assetType: "battery",
    maxPowerMw: battery.maxPowerMw,
    energyCapacityMwh: battery.energyCapacityMwh,
    roundTripEfficiency: battery.roundTripEfficiency ?? pair ?? 1,
    initialStateOfCharge: battery.initialStateOfCharge,
  };
}

/** The wire load, as the prototype heuristic reads it. */
export function fixtureLoad(load: ShiftableLoad): ShiftableLoadAsset {
  return {
    assetType: "shiftable_load",
    maxPowerMw: load.maxPowerMw,
    maxShiftMw: load.maxShiftMw,
    shiftWindowHours: load.shiftWindowHours,
    dailyEnergyMwh: load.dailyEnergyMwh,
  };
}

function replaceAsset(scenario: Scenario, next: Scenario["assets"][number]): Scenario {
  return {
    ...scenario,
    assets: scenario.assets.map((asset) =>
      asset.assetType === next.assetType ? next : asset,
    ),
  };
}

/**
 * A stepper's new value, folded back into the scenario **in place**.
 *
 * Spread over the existing asset rather than rebuilt from the four fields the
 * editor knows about: a battery that arrived with an availability window or an
 * explicit `max_charge_mw` keeps them, so a link edited on this screen is still
 * the link that was shared.
 */
export function withBattery(scenario: Scenario, next: BatteryAsset): Scenario {
  const current = scenarioBattery(scenario);
  return replaceAsset(scenario, {
    ...current,
    maxPowerMw: next.maxPowerMw,
    energyCapacityMwh: next.energyCapacityMwh,
    initialStateOfCharge: next.initialStateOfCharge,
    // The efficiency is only written back where the scenario states a round
    // trip. A modeller who supplied the asymmetric pair supplied two numbers a
    // one-number stepper cannot address, and overwriting them with a round trip
    // would be `EFFICIENCY_PAIR_INCOMPLETE` on the very next request.
    ...(current.roundTripEfficiency === undefined
      ? {}
      : { roundTripEfficiency: next.roundTripEfficiency }),
  });
}

/** The same, for the flexible load. */
export function withLoad(scenario: Scenario, next: ShiftableLoadAsset): Scenario {
  return replaceAsset(scenario, {
    ...scenarioLoad(scenario),
    maxPowerMw: next.maxPowerMw,
    maxShiftMw: next.maxShiftMw,
    shiftWindowHours: next.shiftWindowHours,
    dailyEnergyMwh: next.dailyEnergyMwh,
  });
}

/**
 * The assumed price, and **nothing else**.
 *
 * `brl_per_mwh` is a post-solve display multiplier and never enters the model —
 * the optimizer is denominated in MWh-equivalents precisely so that a user who
 * changes a price they made up does not watch the recommendation change under
 * them. This function touches one field, and a test asserts the plan either
 * side of it is identical.
 */
export function withBrlPerMwh(scenario: Scenario, brlPerMwh: number): Scenario {
  return { ...scenario, economicAssumptions: { brlPerMwh } };
}

/**
 * The scenario moved to another day.
 *
 * Its own function rather than a spread at the call site, because the day is
 * the one field that means something different on the two screens that carry a
 * scenario: on Mitigate it is the day being planned and it does not move, and
 * on the Time Machine it is the day being replayed and it is the selection. The
 * assets are untouched — a fleet is not a property of a date.
 */
export function withTargetDate(scenario: Scenario, targetDate: string): Scenario {
  return { ...scenario, targetDate };
}

/** The scenario moved to another subsystem, assets and all. */
export function withSubsystem(scenario: Scenario, subsystem: SubsystemCode): Scenario {
  return {
    ...scenario,
    subsystem,
    // `SUBSYSTEM_MISMATCH` is one subsystem per scenario: `curt[t]` is a
    // subsystem-level series and an asset somewhere else cannot absorb it.
    assets: scenario.assets.map((asset) => ({ ...asset, subsystem })),
  };
}

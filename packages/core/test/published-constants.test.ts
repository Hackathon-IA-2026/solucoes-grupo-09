import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRL_PER_MWH,
  MAX_GAP_HOURS,
  REFERENCE_FLEET,
  REPORTING_ENTITY_THRESHOLD_MW,
  SUBSYSTEM_THRESHOLD_MW,
  SUBSYSTEMS,
} from "../src/constants";
import { TECHNOLOGIES } from "../src/domain";

/**
 * Parity of the published constants with `apps/ml`.
 *
 * `apps/ml/tests/test_published_constants.py` reads the **same** file and
 * asserts the **same** values against `wattsteer_ml/constants.py`. The two
 * sides never compare against each other, only against the vector, so a shared
 * misunderstanding cannot cancel out — the property the sibling
 * `canonical-contract` suite exists to preserve, applied to the four numbers,
 * the enum and the fleet that both languages quote. See
 * `packages/core/fixtures/published-constants/README.md`.
 */

const VECTOR = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "fixtures", "published-constants", "constants.json"),
    "utf8",
  ),
) as Record<string, unknown>;

/**
 * What this side publishes, in the vector's `snake_case`.
 *
 * Built as one object and compared whole, rather than key by key: a value added
 * to the vector for the Python side and never implemented here then fails
 * THIS suite, which is the "neither language can quietly skip one" property
 * the fixture directories are for.
 */
const published = {
  defaults: {
    subsystem_threshold_mw: SUBSYSTEM_THRESHOLD_MW,
    reporting_entity_threshold_mw: REPORTING_ENTITY_THRESHOLD_MW,
    max_gap_hours: MAX_GAP_HOURS,
    brl_per_mwh: BRL_PER_MWH,
  },
  subsystems: SUBSYSTEMS.map((subsystem) => ({
    code: subsystem.code,
    ons_display_name: subsystem.onsDisplayName,
    short: subsystem.short,
  })),
  technologies: [...TECHNOLOGIES],
  reference_fleet: {
    battery: {
      asset_type: REFERENCE_FLEET.battery.assetType,
      label: REFERENCE_FLEET.battery.label,
      max_power_mw: REFERENCE_FLEET.battery.maxPowerMw,
      energy_capacity_mwh: REFERENCE_FLEET.battery.energyCapacityMwh,
      round_trip_efficiency: REFERENCE_FLEET.battery.roundTripEfficiency,
      initial_state_of_charge: REFERENCE_FLEET.battery.initialStateOfCharge,
    },
    shiftable_load: {
      asset_type: REFERENCE_FLEET.shiftableLoad.assetType,
      label: REFERENCE_FLEET.shiftableLoad.label,
      max_power_mw: REFERENCE_FLEET.shiftableLoad.maxPowerMw,
      max_shift_mw: REFERENCE_FLEET.shiftableLoad.maxShiftMw,
      shift_window_hours: REFERENCE_FLEET.shiftableLoad.shiftWindowHours,
      daily_energy_mwh: REFERENCE_FLEET.shiftableLoad.dailyEnergyMwh,
    },
  },
};

describe("the published constants match the shared vector", () => {
  test("every published value, compared whole", () => {
    expect(published).toEqual(VECTOR as typeof published);
  });

  test("the vector introduces no section this side does not publish", () => {
    expect(Object.keys(VECTOR).sort()).toEqual(Object.keys(published).sort());
  });
});

describe("the rules the constants have to satisfy to be publishable", () => {
  const load = REFERENCE_FLEET.shiftableLoad;

  test("the reference load cannot shed more power than it draws", () => {
    // `SHIFT_EXCEEDS_BASELINE` in `docs/specs/flex-optimizer.md`. The
    // prototype's 70 MW against 1,200 MWh/day failed this, which is why the
    // constant exists in this shape at all.
    expect(load.maxShiftMw).toBeLessThanOrEqual(load.dailyEnergyMwh / 24);
  });

  test("the reference load's shift fits inside its connection", () => {
    // `SHIFT_EXCEEDS_CONNECTION`.
    expect(load.maxShiftMw).toBeLessThanOrEqual(load.maxPowerMw);
  });

  test("the fleet is not one rounding away from a 422", () => {
    // The reason neither single-field repair was taken: both sat at 98.8 % and
    // exactly 100 % of the cap. Anything above ~90 % is back on the boundary.
    expect(load.maxShiftMw / (load.dailyEnergyMwh / 24)).toBeLessThan(0.9);
  });

  test("the battery's state of charge and efficiency are fractions", () => {
    expect(REFERENCE_FLEET.battery.initialStateOfCharge).toBeGreaterThanOrEqual(0);
    expect(REFERENCE_FLEET.battery.initialStateOfCharge).toBeLessThanOrEqual(1);
    // `RTE_OUT_OF_RANGE`: [0.50, 1.00).
    expect(REFERENCE_FLEET.battery.roundTripEfficiency).toBeGreaterThanOrEqual(0.5);
    expect(REFERENCE_FLEET.battery.roundTripEfficiency).toBeLessThan(1);
  });

  test("there are exactly four subsystems and SIN is not one of them", () => {
    expect(SUBSYSTEMS).toHaveLength(4);
    expect(SUBSYSTEMS.map((s) => String(s.code))).not.toContain("SIN");
  });
});

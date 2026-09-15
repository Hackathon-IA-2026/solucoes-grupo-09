import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REFERENCE_FLEET } from "../src/constants.js";
import { ERROR_CODES, type ErrorCode, statusForCode } from "../src/errors.js";
import type { JsonValue } from "../src/scenario.js";
import { decodeScenarioBody } from "../src/scenario.js";
import {
  DATA_WINDOW_OPENS_ON,
  forecastUnavailable,
  latestTargetDate,
  MAX_ASSETS,
  ScenarioValidationError,
  validateScenarioWire,
} from "../src/scenario-validation.js";

/**
 * The validation table, against the shared vectors — and the one property the
 * table exists for: **rejection, never coercion.**
 *
 * `apps/ml/tests/test_scenario_validation.py` reads the **same** directory and
 * asserts the **same** expected codes against the Python implementation.
 * Neither side is asserted against the other, and both fail on a file they did
 * not enumerate — see
 * `packages/core/fixtures/scenario-validation/README.md`.
 *
 * Every refusal here is checked twice: that it *is* refused with the code the
 * spec names, and that the scenario object is **byte-identical afterwards**.
 * The second half is the ticket. A validator that quietly clamps an initial
 * state of charge into its bounds passes every "is it a 422?" test ever
 * written, because it never gets to the 422 — it returns a plan for a battery
 * nobody described, and no assertion about status codes can see that.
 */

const FIXTURES = join(import.meta.dir, "..", "fixtures", "scenario-validation");

interface Vector {
  file: string;
  name: string;
  description: string;
  now: string;
  scenario: Record<string, JsonValue>;
  expected_code?: ErrorCode;
  expected_field?: string;
}

function vectors(subdirectory: string): Vector[] {
  return readdirSync(join(FIXTURES, subdirectory))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      ...(JSON.parse(readFileSync(join(FIXTURES, subdirectory, file), "utf8")) as Omit<
        Vector,
        "file"
      >),
    }));
}

const REFUSALS = vectors("refusals");
const ADMISSIONS = vectors("admissions");

function refusal(vector: Vector): ScenarioValidationError {
  try {
    validateScenarioWire(vector.scenario, { now: new Date(vector.now) });
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error(`${vector.file} was admitted; it must be refused`);
}

describe("the vector directories", () => {
  it("are populated, so a passing run means something", () => {
    expect(REFUSALS.length).toBeGreaterThan(0);
    expect(ADMISSIONS.length).toBeGreaterThan(0);
  });

  it("hold no file this suite did not enumerate", () => {
    // The half that stops a vector added for the Python side being ignored
    // here. Every `.json` under the directory is run by one of the suites below.
    const consumed = new Set([
      ...REFUSALS.map((vector) => `refusals/${vector.file}`),
      ...ADMISSIONS.map((vector) => `admissions/${vector.file}`),
    ]);
    const onDisk = new Set(
      ["refusals", "admissions"].flatMap((sub) =>
        readdirSync(join(FIXTURES, sub))
          .filter((file) => file.endsWith(".json"))
          .map((file) => `${sub}/${file}`),
      ),
    );
    expect([...onDisk].sort()).toEqual([...consumed].sort());
  });
});

// --- the refusals ------------------------------------------------------------

describe("a scenario that is not one is refused", () => {
  for (const vector of REFUSALS) {
    describe(`${vector.file}: ${vector.name}`, () => {
      it(`is ${vector.expected_code}`, () => {
        expect(refusal(vector).code).toBe(vector.expected_code as ErrorCode);
      });

      it("names the field that broke the rule", () => {
        if (vector.expected_field === undefined) {
          return;
        }
        expect(refusal(vector).details?.field).toBe(vector.expected_field);
      });

      it("answers at the status its code is published under", () => {
        // The status is a property of the code and not of the throw site, so
        // two rules cannot answer one condition with different numbers.
        const error = refusal(vector);
        expect(error.status).toBe(statusForCode(error.code as ErrorCode));
        expect(error.status).toBe(422);
      });

      it("carries a code, and a message no client is meant to render", () => {
        const error = refusal(vector);
        expect(ERROR_CODES).toContain(error.code as ErrorCode);
        // `docs/specs/i18n.md`: the API returns codes, never translated
        // strings. A message exists for logs and `/docs`, and the client
        // renders `t("error." + code)` instead — so the only thing the wire has
        // to carry is the code.
        expect(typeof error.message).toBe("string");
      });

      it("leaves the scenario exactly as it arrived", () => {
        // **The ticket, as an assertion.** Nothing is clamped, defaulted into
        // place or rounded on the way to the refusal, so the object a caller
        // handed in is the object they get back on the floor.
        const before = JSON.stringify(vector.scenario);
        refusal(vector);
        expect(JSON.stringify(vector.scenario)).toBe(before);
      });
    });
  }

  it("every code in the spec's table has a case, except the one that needs a database", () => {
    // The table is `docs/specs/flex-optimizer.md` §Validation, transcribed. The
    // suite fails if a rule is added to the spec and never given a vector, and
    // it fails if a vector claims a code the closed enum does not have.
    const table: ErrorCode[] = [
      "SCENARIO_VERSION_UNSUPPORTED",
      "SCENARIO_TOO_LARGE",
      "ASSET_TYPE_UNKNOWN",
      "SUBSYSTEM_MISMATCH",
      "FIELD_NOT_ON_VARIANT",
      "MAGNITUDE_OUT_OF_RANGE",
      "RTE_OUT_OF_RANGE",
      "EFFICIENCY_PAIR_INCOMPLETE",
      "SOC_BOUNDS_INVALID",
      "SOC_INITIAL_OUT_OF_BOUNDS",
      "POWER_LIMIT_INCONSISTENT",
      "SHIFT_EXCEEDS_CONNECTION",
      "SHIFT_EXCEEDS_BASELINE",
      "SHIFT_WINDOW_OUT_OF_RANGE",
      "RECOVERY_TIME_OUT_OF_RANGE",
      "AVAILABILITY_INVALID",
      "TARGET_DATE_OUT_OF_RANGE",
      "ECONOMIC_ASSUMPTION_OUT_OF_RANGE",
    ];
    const covered = new Set(REFUSALS.map((vector) => vector.expected_code));
    expect([...covered].sort()).toEqual([...new Set(table)].sort());
    for (const code of table) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});

// --- what must be admitted ---------------------------------------------------

describe("a scenario that describes a real fleet is admitted", () => {
  for (const vector of ADMISSIONS) {
    it(`${vector.file}: ${vector.name}`, () => {
      expect(() =>
        validateScenarioWire(vector.scenario, { now: new Date(vector.now) }),
      ).not.toThrow();
    });
  }

  it("the published REFERENCE_FLEET is a scenario this build will plan", () => {
    // Not a re-run of the vector: the vector is a copy of the fleet's numbers
    // and this is the constant itself. Floor coverage, `Δ recovered_floor_mwh`,
    // the featured-days list and the hot-swap guardrail are all measured
    // against it, so it must sit inside the rules rather than one rounding
    // outside them — and it sits at 71 % of the shift cap deliberately.
    const load = REFERENCE_FLEET.shiftableLoad;
    const battery = REFERENCE_FLEET.battery;
    expect(() =>
      validateScenarioWire(
        {
          v: 1,
          subsystem: "NE",
          target_date: "2026-08-29",
          assets: [
            {
              asset_type: battery.assetType,
              label: battery.label,
              subsystem: "NE",
              max_power_mw: battery.maxPowerMw,
              energy_capacity_mwh: battery.energyCapacityMwh,
              round_trip_efficiency: battery.roundTripEfficiency,
              initial_state_of_charge: battery.initialStateOfCharge,
            },
            {
              asset_type: load.assetType,
              label: load.label,
              subsystem: "NE",
              max_power_mw: load.maxPowerMw,
              max_shift_mw: load.maxShiftMw,
              shift_window_hours: load.shiftWindowHours,
              daily_energy_mwh: load.dailyEnergyMwh,
            },
          ],
        },
        { now: new Date("2026-08-28T12:00:00Z") },
      ),
    ).not.toThrow();
    expect(load.maxShiftMw / (load.dailyEnergyMwh / 24)).toBeCloseTo(0.71, 2);
  });
});

// --- the rules that are easier to state than to read out of a vector ---------

describe("the refusals a clamp would have hidden", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  const battery = (over: Record<string, JsonValue>): JsonValue => ({
    v: 1,
    subsystem: "NE",
    target_date: "2026-08-29",
    assets: [
      {
        asset_type: "battery",
        label: "Battery",
        subsystem: "NE",
        max_power_mw: 100,
        energy_capacity_mwh: 300,
        round_trip_efficiency: 0.92,
        initial_state_of_charge: 0.2,
        ...over,
      },
    ],
  });

  function code(wire: JsonValue): ErrorCode | null {
    try {
      validateScenarioWire(wire, { now });
    } catch (error) {
      return (error as ScenarioValidationError).code as ErrorCode;
    }
    return null;
  }

  it("an initial SOC below its floor is refused, not raised to it", () => {
    // The mirror of the vector, from the other side of the window. Both
    // directions matter: a clamp is symmetric and a rule has to be too.
    expect(code(battery({ initial_state_of_charge: 0.01 }))).toBe(
      "SOC_INITIAL_OUT_OF_BOUNDS",
    );
    expect(code(battery({ initial_state_of_charge: 0.05 }))).toBeNull();
  });

  it("either half of the efficiency pair alone is refused", () => {
    for (const half of ["charge_efficiency", "discharge_efficiency"]) {
      const wire = battery({ [half]: 0.959 }) as Record<string, JsonValue>;
      const assets = wire.assets as Record<string, JsonValue>[];
      const asset = { ...(assets[0] as Record<string, JsonValue>) };
      delete asset.round_trip_efficiency;
      expect(code({ ...wire, assets: [asset] })).toBe("EFFICIENCY_PAIR_INCOMPLETE");
    }
  });

  it("a round trip beside either half is refused", () => {
    expect(code(battery({ charge_efficiency: 0.959, discharge_efficiency: 0.959 }))).toBe(
      "EFFICIENCY_PAIR_INCOMPLETE",
    );
  });

  it("a mixed-subsystem scenario is refused rather than summed", () => {
    expect(
      code({
        v: 1,
        subsystem: "NE",
        target_date: "2026-08-29",
        assets: [
          {
            asset_type: "battery",
            label: "NE battery",
            subsystem: "NE",
            max_power_mw: 100,
            energy_capacity_mwh: 300,
            round_trip_efficiency: 0.92,
            initial_state_of_charge: 0.2,
          },
          {
            asset_type: "battery",
            label: "S battery",
            subsystem: "S",
            max_power_mw: 100,
            energy_capacity_mwh: 300,
            round_trip_efficiency: 0.92,
            initial_state_of_charge: 0.2,
          },
        ],
      }),
    ).toBe("SUBSYSTEM_MISMATCH");
  });

  it("a magnitude is refused at zero as well as above the cap", () => {
    expect(code(battery({ max_power_mw: 0 }))).toBe("MAGNITUDE_OUT_OF_RANGE");
    expect(code(battery({ energy_capacity_mwh: -1 }))).toBe("MAGNITUDE_OUT_OF_RANGE");
    expect(code(battery({ max_power_mw: 10_000 }))).toBeNull();
  });

  it("a numeric string is not a number", () => {
    // `Number("100")` would admit this and the plan would be right by accident.
    // A caller sending the wrong type is a caller to tell, not to guess for.
    expect(code(battery({ max_power_mw: "100" }))).toBe("REQUEST_INVALID");
  });

  it("the target date's own boundaries", () => {
    const wire = (date: string): JsonValue => ({
      ...(battery({}) as Record<string, JsonValue>),
      target_date: date,
    });
    expect(code(wire(DATA_WINDOW_OPENS_ON))).toBeNull();
    expect(code(wire("2024-03-31"))).toBe("TARGET_DATE_OUT_OF_RANGE");
    expect(code(wire(latestTargetDate(now)))).toBeNull();
    expect(code(wire("2026-08-31"))).toBe("TARGET_DATE_OUT_OF_RANGE");
    // A pattern-shaped string that names no day is malformed, not out of range.
    expect(code(wire("2026-02-31"))).toBe("REQUEST_INVALID");
  });

  it("the asset cap is on the count, not only on the bytes", () => {
    const one = (label: string): JsonValue => ({
      asset_type: "battery",
      label,
      subsystem: "NE",
      max_power_mw: 100,
      energy_capacity_mwh: 300,
      round_trip_efficiency: 0.92,
      initial_state_of_charge: 0.2,
    });
    const many = (count: number): JsonValue => ({
      v: 1,
      subsystem: "NE",
      target_date: "2026-08-29",
      assets: Array.from({ length: count }, (_, index) => one(`B${index}`)),
    });
    expect(code(many(MAX_ASSETS))).toBeNull();
    expect(code(many(MAX_ASSETS + 1))).toBe("SCENARIO_TOO_LARGE");
  });
});

// --- the transport and the table, on the same object -------------------------

describe("validation runs on the bytes the hash was taken over", () => {
  it("a decoded scenario's canonical text is what the validator reads", () => {
    // The two halves of the request path meet here: `decodeScenarioBody`
    // produces the canonical bytes and the hash, and the validator runs on the
    // same document rather than on a second parse of the original body. A
    // scenario that passed validation is therefore provably the scenario the
    // answer will be stamped with.
    const decoded = decodeScenarioBody({
      target_date: "2026-08-29",
      subsystem: "NE",
      v: 1,
      assets: [
        {
          asset_type: "shiftable_load",
          label: "Flexible load",
          subsystem: "NE",
          max_power_mw: 70,
          max_shift_mw: 70,
          shift_window_hours: 3,
          daily_energy_mwh: 1200,
        },
      ],
    });
    const wire = JSON.parse(decoded.canonical) as JsonValue;
    expect(() =>
      validateScenarioWire(wire, { now: new Date("2026-08-28T12:00:00Z") }),
    ).toThrow(ScenarioValidationError);
    expect(decoded.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// --- the code defined here and thrown by ticket 07 ---------------------------

describe("FORECAST_UNAVAILABLE", () => {
  it("has one definition, with the status the closed enum publishes it under", () => {
    // Defined here and thrown nowhere in this module: it is the only row of the
    // table that is not a fact about the scenario. The scenario is well formed
    // and the fleet is real; there is simply no forecast to plan against, and
    // deciding that needs the query flex-optimizer ticket 07 owns.
    const error = forecastUnavailable("NE", "2026-08-29", "2026-08-28T12:00:00Z");
    expect(error.code).toBe("FORECAST_UNAVAILABLE");
    expect(error.status).toBe(statusForCode("FORECAST_UNAVAILABLE"));
    expect(error.details).toEqual({
      subsystem: "NE",
      target_date: "2026-08-29",
      forecast_origin: "2026-08-28T12:00:00Z",
    });
  });

  it("carries no origin when none was resolved", () => {
    expect(forecastUnavailable("S", "2026-08-29").details).toEqual({
      subsystem: "S",
      target_date: "2026-08-29",
    });
  });
});

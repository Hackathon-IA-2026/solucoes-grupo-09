import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRL_PER_MWH,
  canonicalScenarioJson,
  ERROR_CODES,
  encodeScenario,
  REFERENCE_FLEET,
  scenarioHash,
  toBase64Url,
} from "@wattsteer/core";
import type { Battery, Scenario, ShiftableLoad } from "@wattsteer/core/api";
import {
  defaultScenario,
  fixtureBattery,
  fixtureLoad,
  readScenario,
  scenarioBattery,
  scenarioBrlPerMwh,
  scenarioLoad,
  withBattery,
  withBrlPerMwh,
  withLoad,
  writeScenario,
} from "../src/components/app/scenario";
import { en } from "../src/i18n/copy.en";
import { pt } from "../src/i18n/copy.pt";
import { debounce, type Timers } from "../src/lib/debounce";
import {
  ASSET_LIMITS,
  DEFAULT_BATTERY,
  DEFAULT_LOAD,
  PLANNING_BASIS,
} from "../src/lib/fixtures";

/**
 * Mitigate's scenario: the URL is the storage, and the posture is not a control.
 *
 * These are the assertions `docs/specs/flex-optimizer.md` makes load-bearing
 * rather than the ones a screen test would usually make. The screen is a
 * rendering of four facts — one plan, one promise, one price that moves only
 * itself, and a link that means the same thing twice — and all four are
 * checkable without a renderer.
 */

const DEFAULT = defaultScenario("NE", "2026-08-29");
const NOW = new Date("2026-08-28T12:00:00Z");

function decoded(scenario: Scenario): Scenario {
  const readout = readScenario(writeScenario(scenario), DEFAULT, { now: NOW });
  if (!readout.ok) {
    throw new Error(`the scenario was refused: ${readout.code}`);
  }
  return readout.scenario;
}

describe("the scenario is the URL", () => {
  test("the screen's default fleet is REFERENCE_FLEET, not a local restatement", () => {
    const battery = scenarioBattery(DEFAULT);
    const load = scenarioLoad(DEFAULT);
    expect(battery.maxPowerMw).toBe(REFERENCE_FLEET.battery.maxPowerMw);
    expect(battery.energyCapacityMwh).toBe(REFERENCE_FLEET.battery.energyCapacityMwh);
    expect(battery.roundTripEfficiency).toBe(REFERENCE_FLEET.battery.roundTripEfficiency);
    expect(battery.initialStateOfCharge).toBe(
      REFERENCE_FLEET.battery.initialStateOfCharge,
    );
    expect(load.maxShiftMw).toBe(REFERENCE_FLEET.shiftableLoad.maxShiftMw);
    expect(load.dailyEnergyMwh).toBe(REFERENCE_FLEET.shiftableLoad.dailyEnergyMwh);
    // The corrected fleet, at 71 % of the `SHIFT_EXCEEDS_BASELINE` cap rather
    // than on the boundary. A default that is one rounding from a 422 is not a
    // default a backtest can be measured against.
    expect(load.maxShiftMw / (load.dailyEnergyMwh / 24)).toBeLessThan(0.75);
  });

  test("the fixture defaults and the scenario defaults are the same fleet", () => {
    expect(fixtureBattery(scenarioBattery(DEFAULT))).toEqual(DEFAULT_BATTERY);
    expect(fixtureLoad(scenarioLoad(DEFAULT))).toEqual(DEFAULT_LOAD);
  });

  test("a scenario URL round-trips to byte-identical bytes and the same hash", () => {
    // What a bookmark and a paste into Slack actually do: the canonical bytes
    // out and the canonical bytes back have to be the same bytes, or the cache
    // key on the other side means something else.
    const there = writeScenario(DEFAULT);
    const back = decoded(DEFAULT);
    expect(writeScenario(back)).toBe(there);
    expect(canonicalScenarioJson(back)).toBe(canonicalScenarioJson(DEFAULT));
    expect(scenarioHash(back)).toBe(scenarioHash(DEFAULT));
  });

  test("and therefore to a byte-identical question for the solver", () => {
    // The plan used to be recomputed here and compared. It is solved on the
    // server now, so what a round trip has to preserve is the *request*: the
    // canonical bytes are what `POST /v1/optimize` answers and what its cache is
    // keyed on, so identical bytes are identical plans by construction rather
    // than by a second evaluation agreeing with the first.
    expect(encodeScenario(decoded(DEFAULT))).toBe(encodeScenario(DEFAULT));
  });

  test("an edit round-trips too, and keeps the fields the editors never touch", () => {
    // A blob carrying an availability window and a per-direction limit is
    // edited on this screen and comes back still carrying them. The editors
    // spread over the asset rather than rebuilding it from four fields.
    const battery: Battery = {
      ...scenarioBattery(DEFAULT),
      availableFrom: "11:00",
      availableTo: "18:00",
      maxChargeMw: 80,
    };
    const rich: Scenario = {
      ...DEFAULT,
      assets: [battery, scenarioLoad(DEFAULT)],
    };
    const edited = withBattery(rich, { ...DEFAULT_BATTERY, maxPowerMw: 150 });
    const after = scenarioBattery(decoded(edited));
    expect(after.maxPowerMw).toBe(150);
    expect(after.availableFrom).toBe("11:00");
    expect(after.availableTo).toBe("18:00");
    expect(after.maxChargeMw).toBe(80);
  });

  test("an absent blob is the default, not a refusal", () => {
    const readout = readScenario(undefined, DEFAULT, { now: NOW });
    expect(readout.ok).toBe(true);
  });
});

describe("one plan, one promise", () => {
  test("the plan is built against the median, and the basis is not a parameter", () => {
    expect(PLANNING_BASIS).toBe("p50");
  });

  test("the basis toggle is gone from the screen and from both dictionaries", () => {
    // The acceptance box, asserted rather than reviewed. A control the spec
    // removed is the kind of thing that comes back as "just an option", so the
    // absence is a test: no state for it on the screen, and no words for it in
    // either locale.
    const screen = readFileSync(
      join(import.meta.dir, "..", "src", "app", "app", "mitigate.tsx"),
      "utf8",
    );
    for (const token of ["setBasis", "CurtailmentBasis", "basisMedianPill"]) {
      expect(screen).not.toContain(token);
    }
    for (const dictionary of [pt, en]) {
      const keys = Object.keys(dictionary.app.mitigate);
      expect(keys.filter((key) => key.startsWith("basis"))).toEqual([]);
      // ...and the sentence that replaces it is there, in both.
      expect(dictionary.app.mitigate.postureRule.length).toBeGreaterThan(40);
    }
  });

  /**
   * The plan's own properties — the floor below the median, the three shares
   * that are not an interval, absorption never above what was offered, no hour
   * charging and discharging at once — are properties of the **execution rule**
   * and of the MILP, and they are asserted where those live: `apps/ml`'s
   * `test_optimizer_simulator.py` and the golden vectors in
   * `packages/core/fixtures/execution-rule/`. They used to be asserted here
   * against a second implementation of the rule that ran in the browser;
   * `docs/specs/api-surface.md` decision 6 deleted it, and re-asserting them
   * over a fixture written by hand on this side would be a test of the fixture.
   *
   * What is still this app's own is the mapping from the answer to the reveal,
   * and that is `optimization.test.ts`.
   */
});

describe("R$ moves the money and nothing else", () => {
  test("changing the assumed price leaves the plan and every KPI identical", () => {
    const cheap = withBrlPerMwh(DEFAULT, 90);
    const dear = withBrlPerMwh(DEFAULT, 420);
    expect(scenarioBrlPerMwh(cheap)).toBe(90);
    expect(scenarioBrlPerMwh(dear)).toBe(420);
    // The optimizer is denominated in MWh and the price is a post-solve
    // multiplier, so the two scenarios differ in exactly one field and in
    // nothing the model reads. Asserted on the document the solver is handed,
    // which is the only place this app can assert it now.
    const before = JSON.parse(canonicalScenarioJson(cheap)) as Record<string, unknown>;
    const after = JSON.parse(canonicalScenarioJson(dear)) as Record<string, unknown>;
    delete before.economic_assumptions;
    delete after.economic_assumptions;
    expect(after).toEqual(before);
  });

  test("the default assumption is the one published rate", () => {
    expect(scenarioBrlPerMwh(DEFAULT)).toBe(BRL_PER_MWH);
    expect(ASSET_LIMITS.brlPerMwh.min).toBeGreaterThan(0);
  });
});

describe("a nonsensical link is refused, never quietly corrected", () => {
  /** A hand-edited `?s=` blob, built the way an attacker or a typo would. */
  function blobOf(wire: unknown): string {
    return toBase64Url(new TextEncoder().encode(JSON.stringify(wire)));
  }

  function wireOf(scenario: Scenario): Record<string, unknown> {
    return JSON.parse(canonicalScenarioJson(scenario)) as Record<string, unknown>;
  }

  const base = wireOf(DEFAULT);
  const batteryWire = (base.assets as Record<string, unknown>[])[0];
  const loadWire = (base.assets as Record<string, unknown>[])[1];

  const cases: { name: string; wire: unknown; code: string }[] = [
    {
      name: "an old link",
      wire: { ...base, v: 2 },
      code: "SCENARIO_VERSION_UNSUPPORTED",
    },
    {
      name: "a subsystem that is not one",
      wire: { ...base, subsystem: "XX" },
      code: "SUBSYSTEM_UNKNOWN",
    },
    {
      name: "a battery carrying max_shift_mw",
      wire: { ...base, assets: [{ ...batteryWire, max_shift_mw: 50 }, loadWire] },
      code: "FIELD_NOT_ON_VARIANT",
    },
    {
      name: "an asset in another subsystem",
      wire: { ...base, assets: [{ ...batteryWire, subsystem: "S" }, loadWire] },
      code: "SUBSYSTEM_MISMATCH",
    },
    {
      name: "an inverter the size of the grid",
      wire: { ...base, assets: [{ ...batteryWire, max_power_mw: 99_000 }, loadWire] },
      code: "MAGNITUDE_OUT_OF_RANGE",
    },
    {
      name: "a battery that beats thermodynamics",
      wire: {
        ...base,
        assets: [{ ...batteryWire, round_trip_efficiency: 1.1 }, loadWire],
      },
      code: "RTE_OUT_OF_RANGE",
    },
    {
      name: "half an efficiency pair",
      wire: {
        ...base,
        assets: [{ ...batteryWire, charge_efficiency: 0.96 }, loadWire],
      },
      code: "EFFICIENCY_PAIR_INCOMPLETE",
    },
    {
      name: "an initial state of charge outside its own bounds — an error, never a clamp",
      wire: {
        ...base,
        assets: [{ ...batteryWire, initial_state_of_charge: 0.99 }, loadWire],
      },
      code: "SOC_INITIAL_OUT_OF_BOUNDS",
    },
    {
      name: "a load shedding more than it is connected for",
      wire: { ...base, assets: [batteryWire, { ...loadWire, max_shift_mw: 90 }] },
      code: "SHIFT_EXCEEDS_CONNECTION",
    },
    {
      name: "the prototype's old default: 70 MW of shift against 1,200 MWh/day",
      wire: {
        ...base,
        assets: [
          batteryWire,
          { ...loadWire, max_power_mw: 100, max_shift_mw: 70, daily_energy_mwh: 1200 },
        ],
      },
      code: "SHIFT_EXCEEDS_BASELINE",
    },
    {
      name: "a shift window longer than the rule allows",
      wire: { ...base, assets: [batteryWire, { ...loadWire, shift_window_hours: 12 }] },
      code: "SHIFT_WINDOW_OUT_OF_RANGE",
    },
    {
      name: "availability that is not on the hour",
      wire: { ...base, assets: [{ ...batteryWire, available_from: "11:30" }, loadWire] },
      code: "AVAILABILITY_INVALID",
    },
    {
      name: "a day outside the data window",
      wire: { ...base, target_date: "2019-01-01" },
      code: "TARGET_DATE_OUT_OF_RANGE",
    },
    {
      name: "a price nobody would assume",
      wire: { ...base, economic_assumptions: { brl_per_mwh: 50_000 } },
      code: "ECONOMIC_ASSUMPTION_OUT_OF_RANGE",
    },
    {
      name: "a fleet this screen has no editor for",
      wire: { ...base, assets: [batteryWire, batteryWire, loadWire] },
      code: "REQUEST_INVALID",
    },
  ];

  for (const { name, wire, code } of cases) {
    test(`${name} → ${code}`, () => {
      const readout = readScenario(blobOf(wire), DEFAULT, { now: NOW });
      expect(readout.ok).toBe(false);
      if (!readout.ok) {
        expect(readout.code).toBe(code as (typeof ERROR_CODES)[number]);
      }
    });
  }

  test("every code the screen can produce has a sentence in both locales", () => {
    // The i18n rule, on this screen specifically: the API returns codes and the
    // screen owns the strings. `error-copy.test.ts` already guarantees the
    // dictionaries cover the whole enum; this asserts the codes this screen
    // actually reaches are inside it, so a code invented here would fail rather
    // than render a key.
    for (const { code } of cases) {
      expect(ERROR_CODES).toContain(code as (typeof ERROR_CODES)[number]);
      const ptSentence = (pt.error as Record<string, string>)[code];
      const enSentence = (en.error as Record<string, string>)[code];
      expect(ptSentence?.trim().length ?? 0).toBeGreaterThan(0);
      expect(enSentence?.trim().length ?? 0).toBeGreaterThan(0);
      expect(ptSentence).not.toBe(enSentence);
    }
  });

  test("a blob over the published cap is refused before it is parsed", () => {
    const huge: Scenario = {
      ...DEFAULT,
      assets: Array.from({ length: 40 }, () => scenarioBattery(DEFAULT)),
    };
    const readout = readScenario(
      toBase64Url(new TextEncoder().encode(canonicalScenarioJson(huge))),
      DEFAULT,
      { now: NOW },
    );
    expect(readout.ok).toBe(false);
    if (!readout.ok) {
      expect(readout.code).toBe("SCENARIO_TOO_LARGE");
    }
  });

  test("a blob that is not a blob is refused rather than crashing the screen", () => {
    const readout = readScenario("not-base64url-json", DEFAULT, { now: NOW });
    expect(readout.ok).toBe(false);
  });

  test("the editors cannot reach a refusal on their own", () => {
    // Every stepper floor and ceiling, driven to both ends. The cross-field
    // rules are deliberately reachable (a stepper cannot express "at most the
    // other stepper"); the single-field ones must not be, or a reader who held
    // a minus key would be shown a refusal for a fleet the screen offered them.
    for (const end of ["min", "max"] as const) {
      const battery = withBattery(DEFAULT, {
        ...DEFAULT_BATTERY,
        maxPowerMw: ASSET_LIMITS.batteryPowerMw[end],
        energyCapacityMwh: ASSET_LIMITS.batteryEnergyMwh[end],
        roundTripEfficiency: ASSET_LIMITS.roundTripEfficiency[end],
        initialStateOfCharge: ASSET_LIMITS.initialStateOfCharge[end],
      });
      const both = withLoad(battery, {
        ...DEFAULT_LOAD,
        // Held at the default so the cross-field rules are not what is under
        // test here — the single-field ranges are.
        maxPowerMw: DEFAULT_LOAD.maxPowerMw,
        maxShiftMw: DEFAULT_LOAD.maxShiftMw,
        shiftWindowHours: ASSET_LIMITS.shiftWindowHours[end],
        dailyEnergyMwh: DEFAULT_LOAD.dailyEnergyMwh,
      });
      const priced = withBrlPerMwh(both, ASSET_LIMITS.brlPerMwh[end]);
      const readout = readScenario(writeScenario(priced), DEFAULT, { now: NOW });
      expect(readout.ok).toBe(true);
    }
  });
});

describe("a stepper drag is one commit, not thirty", () => {
  /** A clock that does not tick until it is told to. */
  function fakeTimers() {
    let now = 0;
    let next = 1;
    const armed = new Map<number, { at: number; run: () => void }>();
    const timers: Timers = {
      setTimeout: (handler, ms) => {
        const id = next++;
        armed.set(id, { at: now + ms, run: handler });
        return id;
      },
      clearTimeout: (handle) => {
        armed.delete(handle);
      },
    };
    return {
      timers,
      advance(ms: number) {
        now += ms;
        for (const [id, timer] of [...armed]) {
          if (timer.at <= now) {
            armed.delete(id);
            timer.run();
          }
        }
      },
    };
  }

  test("thirty presses inside the window commit once, with the last value", () => {
    const clock = fakeTimers();
    const written: number[] = [];
    const commit = debounce((value: number) => written.push(value), 400, clock.timers);
    for (let press = 1; press <= 30; press++) {
      commit.call(press);
      clock.advance(20);
    }
    // Still nothing in the address bar: every press re-armed the timer.
    expect(written).toEqual([]);
    clock.advance(400);
    expect(written).toEqual([30]);
  });

  test("a press after the window is its own commit", () => {
    const clock = fakeTimers();
    const written: number[] = [];
    const commit = debounce((value: number) => written.push(value), 400, clock.timers);
    commit.call(1);
    clock.advance(400);
    commit.call(2);
    clock.advance(400);
    expect(written).toEqual([1, 2]);
  });

  test("cancelling forgets the pending write — an unmounted screen writes nothing", () => {
    const clock = fakeTimers();
    const written: number[] = [];
    const commit = debounce((value: number) => written.push(value), 400, clock.timers);
    commit.call(7);
    expect(commit.pending()).toBe(true);
    commit.cancel();
    clock.advance(1000);
    expect(written).toEqual([]);
    expect(commit.pending()).toBe(false);
  });

  test("each committed scenario is a distinct hash, and a re-press is not", () => {
    // Why the debounce is worth having on this screen and not just on this
    // control: the hash is the cache key, so an uncommitted intermediate fleet
    // would be a distinct key and, on a miss, a distinct solve.
    const a = withBattery(DEFAULT, { ...DEFAULT_BATTERY, maxPowerMw: 125 });
    const b = withBattery(DEFAULT, { ...DEFAULT_BATTERY, maxPowerMw: 150 });
    expect(scenarioHash(a)).not.toBe(scenarioHash(b));
    expect(scenarioHash(withBattery(DEFAULT, DEFAULT_BATTERY))).toBe(
      scenarioHash(DEFAULT),
    );
  });
});

describe("the untrusted field", () => {
  test("a label survives a round trip and is never a screen string", () => {
    const nasty = "</Text><script>alert(1)</script>";
    const battery: Battery = { ...scenarioBattery(DEFAULT), label: nasty };
    const load: ShiftableLoad = scenarioLoad(DEFAULT);
    const scenario: Scenario = { ...DEFAULT, assets: [battery, load] };
    // Carried, byte for byte, because a shared link keeps its bytes...
    expect(scenarioBattery(decoded(scenario)).label).toBe(nasty);
    // ...and dropped on the way to the heuristic, which is the only thing the
    // screen renders from. The two asset kinds are named in the dictionaries by
    // their `assetType`; nothing on the screen reads a label.
    expect(Object.keys(fixtureBattery(battery))).not.toContain("label");
  });
});

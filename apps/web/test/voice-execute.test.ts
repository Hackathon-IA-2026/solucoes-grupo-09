import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubsystemCode } from "@wattsteer/core";
import {
  REFERENCE_FLEET,
  SCENARIO_PARAM,
  SUBSYSTEM_DISPLAY_ORDER,
} from "@wattsteer/core";
import type { Scenario } from "@wattsteer/core/api";
import {
  type AppParams,
  parseAppParams,
  writeParams,
} from "../src/components/app/params";
import {
  defaultScenario,
  readScenario,
  scenarioBattery,
  scenarioLoad,
} from "../src/components/app/scenario";
import { ASSET_LIMITS, REPLAY_DAYS, RUN_LABELS } from "../src/lib/fixtures";
import { QUESTION_KINDS } from "../src/lib/voice/briefing/types";
import {
  executeTool,
  type NavigationIntent,
  SCREEN_PATHS,
  TOOL_REFUSAL_CODES,
  type ToolCall,
  type ToolRefusalCode,
} from "../src/lib/voice/execute";
import { DRIVER_CODES, TOOL_NAMES } from "../src/lib/voice/tools";

/**
 * The agent's whole behaviour, asserted as arithmetic.
 *
 * `executeTool` is the only thing between a sentence spoken into a microphone
 * and the URL the four screens render from, and the plan's §3.3 split exists so
 * that it can be examined here — every tool, every argument arm, every refusal
 * — with no audio stack in the room.
 *
 * **Exhaustive, not representative.** Each of the six tools is driven through
 * each of its arguments present, absent and hallucinated, because the failure
 * this file exists to prevent is not a crash: it is a confident answer about
 * the wrong region, which no smoke test would notice.
 */

const NOW = new Date("2026-09-15T12:00:00Z");

/** The selection the demo starts from, and the base for every case below. */
const NE: AppParams = {
  subsystem: "NE",
  technology: "WIND",
  run: "12Z",
  date: "2026-09-16",
  episode: REPLAY_DAYS[0].id,
};

function run(name: string, args?: unknown, params: AppParams = NE, scenario?: Scenario) {
  return executeTool({ name, arguments: args } as ToolCall, params, scenario);
}

function refusal(intent: NavigationIntent): ToolRefusalCode {
  if (intent.kind !== "refused") {
    throw new Error(`expected a refusal, got ${intent.kind}`);
  }
  return intent.reason.code;
}

function navigation(intent: NavigationIntent): {
  pathname: string;
  params: Record<string, string>;
} {
  if (intent.kind !== "navigate") {
    throw new Error(`expected a navigation, got ${intent.kind}`);
  }
  return { pathname: intent.pathname, params: { ...intent.params } };
}

/** The scenario a navigation's link carries, decoded through the real codec. */
function linkedScenario(intent: NavigationIntent): Scenario {
  const blob = navigation(intent).params[SCENARIO_PARAM];
  const readout = readScenario(blob, defaultScenario("NE", NE.date), { now: NOW });
  if (!readout.ok) {
    throw new Error(`the agent wrote a link the screen refuses: ${readout.code}`);
  }
  return readout.scenario;
}

describe("executeTool is total", () => {
  it("every malformed shape returns an intent rather than throwing", () => {
    const shapes: ToolCall[] = [
      { name: "" },
      { name: "promote_model" },
      { name: "SHOW_GRID" },
      { name: "explain", arguments: "not json" },
      { name: "explain", arguments: "{" },
      { name: "explain", arguments: 7 },
      { name: "explain", arguments: [] },
      { name: "explain", arguments: true },
      { name: "explain", arguments: null },
      { name: "explain", arguments: undefined },
      { name: "focus", arguments: '{"subsystem":"NE"}' },
    ];
    for (const call of shapes) {
      // The caller is a socket message handler mid-sentence; a throw there ends
      // the session rather than the turn.
      expect(() => executeTool(call, NE)).not.toThrow();
      expect(typeof executeTool(call, NE).kind).toBe("string");
    }
  });

  it("a name that is not one of the six is unknown_tool", () => {
    for (const name of ["", "promote", "show grid", "SHOW_GRID", "highlight "]) {
      expect(refusal(run(name, {}))).toBe("unknown_tool");
    }
  });

  it("arguments that are not an object are malformed_arguments", () => {
    for (const args of ["not json", "{", "[1,2]", 7, true, ["a"]]) {
      expect(refusal(run("explain", args))).toBe("malformed_arguments");
    }
  });

  it("absent, null and empty-string arguments all mean 'no arguments'", () => {
    // The realtime protocol sends `""` for a no-argument call. Reading that as
    // malformed would make `show_grid` — the most-used tool — always refuse.
    for (const args of [undefined, null, "", "  ", {}, "{}"]) {
      expect(run("show_grid", args).kind).toBe("navigate");
    }
  });

  it("a JSON string is parsed exactly like the object it encodes", () => {
    expect(run("focus", '{"subsystem":"S"}')).toEqual(run("focus", { subsystem: "S" }));
  });

  it("every refusal code is one of the published ones", () => {
    const seen = new Set<string>();
    const calls: ToolCall[] = [
      { name: "nope" },
      { name: "explain", arguments: "{" },
      { name: "show_grid", arguments: { subsystem: "NE" } },
      { name: "focus", arguments: {} },
      { name: "explain", arguments: { subsystem: "SUDESTE" } },
      { name: "focus", arguments: { technology: "hydro" } },
      { name: "focus", arguments: { run: "06Z" } },
      { name: "explain", arguments: { driver: "vibes" } },
      { name: "replay", arguments: { episode: "1999-01-01-ne" } },
      { name: "mitigate", arguments: { battery_mwh: 1 } },
      { name: "replay", arguments: { episode: REPLAY_DAYS[0].id, relative_day: -1 } },
      { name: "replay", arguments: { relative_day: -3000 } },
      { name: "mitigate", arguments: { load_mwh: 100 } },
      // A question kind the composer does not branch on. The model can
      // name one; `compose.ts` would have nothing to do with it.
      { name: "brief", arguments: { question_kind: "vibes" } },
    ];
    for (const call of calls) {
      seen.add(refusal(executeTool(call, NE)));
    }
    // Every published code is reachable, and nothing outside the list is
    // produced: a taxonomy with an unreachable member is a taxonomy that is
    // wrong about something.
    expect([...seen].sort()).toEqual([...TOOL_REFUSAL_CODES].sort());
  });
});

describe("show_grid", () => {
  it("opens the overview carrying the selection", () => {
    const { pathname, params } = navigation(run("show_grid", {}));
    expect(pathname).toBe(SCREEN_PATHS.overview);
    expect(params).toEqual({ subsystem: "NE", technology: "wind", run: "12Z" });
  });

  it("carries whatever the selection happens to be", () => {
    const { params } = navigation(
      run("show_grid", {}, { ...NE, subsystem: "S", technology: "SOLAR", run: "00Z" }),
    );
    expect(params).toEqual({ subsystem: "S", technology: "solar", run: "00Z" });
  });

  it("any argument at all is unexpected_argument", () => {
    for (const args of [{ subsystem: "NE" }, { driver: "net_surplus" }, { x: 1 }]) {
      // A `show_grid` carrying a subsystem is a model that meant `focus` or
      // `highlight`. Ignoring the key would answer a question nobody asked.
      expect(refusal(run("show_grid", args))).toBe("unexpected_argument");
    }
  });
});

describe("explain", () => {
  it("no arguments keeps the current selection", () => {
    const { pathname, params } = navigation(run("explain", {}));
    expect(pathname).toBe(SCREEN_PATHS.explain);
    expect(params).toEqual({ subsystem: "NE", technology: "wind", run: "12Z" });
  });

  for (const subsystem of SUBSYSTEM_DISPLAY_ORDER) {
    it(`subsystem ${subsystem} moves the selection and keeps the rest`, () => {
      const { pathname, params } = navigation(run("explain", { subsystem }));
      expect(pathname).toBe(SCREEN_PATHS.explain);
      expect(params.subsystem).toBe(subsystem);
      expect(params.technology).toBe("wind");
      expect(params.run).toBe("12Z");
    });
  }

  for (const driver of DRIVER_CODES) {
    it(`driver ${driver} is carried`, () => {
      expect(navigation(run("explain", { driver })).params.driver).toBe(driver);
    });
  }

  it("no driver means no driver parameter", () => {
    expect(navigation(run("explain", {})).params.driver).toBeUndefined();
  });

  it("a hallucinated subsystem refuses and names the value", () => {
    const intent = run("explain", { subsystem: "SUDESTE" });
    expect(refusal(intent)).toBe("unknown_subsystem");
    if (intent.kind === "refused") {
      expect(intent.reason.field).toBe("subsystem");
      expect(intent.reason.value).toBe("SUDESTE");
    }
  });

  it("every near-miss on subsystem refuses rather than coercing", () => {
    // `parseAppParams` would answer `NE` for every one of these, correctly, for
    // a hand-edited URL. Here it would be the screen, the numbers and the
    // spoken sentence all agreeing and all wrong.
    for (const value of ["SUDESTE", "ne", "Ne", "NORDESTE", "SECO", "", " NE", 1, null]) {
      expect(refusal(run("explain", { subsystem: value }))).toBe("unknown_subsystem");
    }
  });

  it("a hallucinated driver refuses", () => {
    for (const value of ["other", "wind", "", 3]) {
      expect(refusal(run("explain", { driver: value }))).toBe("unknown_driver");
    }
  });

  it("a property explain does not have is unexpected_argument", () => {
    expect(refusal(run("explain", { run: "12Z" }))).toBe("unexpected_argument");
    expect(refusal(run("explain", { battery_mwh: 500 }))).toBe("unexpected_argument");
  });
});

describe("focus changes the selection and not the screen", () => {
  it("one field named writes one field", () => {
    const intent = run("focus", { subsystem: "S" });
    expect(intent).toEqual({ kind: "params", params: { subsystem: "S" } });
  });

  for (const run_ of RUN_LABELS) {
    it(`run ${run_} is written`, () => {
      expect(run("focus", { run: run_ })).toEqual({
        kind: "params",
        params: { run: run_ },
      });
    });
  }

  it("technology is written in the URL's spelling", () => {
    expect(run("focus", { technology: "solar" })).toEqual({
      kind: "params",
      params: { technology: "solar" },
    });
    // The domain's spelling is accepted — it is the same fleet, unambiguously —
    // and normalised on the way out.
    expect(run("focus", { technology: "SOLAR" })).toEqual({
      kind: "params",
      params: { technology: "solar" },
    });
  });

  it("three fields named writes three", () => {
    expect(run("focus", { subsystem: "N", technology: "wind", run: "00Z" })).toEqual({
      kind: "params",
      params: { subsystem: "N", technology: "wind", run: "00Z" },
    });
  });

  it("the fields not named are not written", () => {
    // `router.setParams` merges. Writing the other two back would silently undo
    // a pill the reader pressed while the model was thinking.
    const intent = run("focus", { technology: "solar" });
    expect(intent.kind === "params" && Object.keys(intent.params)).toEqual([
      "technology",
    ]);
  });

  it("an empty focus is missing_argument, not a no-op", () => {
    expect(refusal(run("focus", {}))).toBe("missing_argument");
    expect(refusal(run("focus", undefined))).toBe("missing_argument");
  });

  it("each hallucinated value has its own code", () => {
    expect(refusal(run("focus", { subsystem: "SUDESTE" }))).toBe("unknown_subsystem");
    expect(refusal(run("focus", { technology: "hydro" }))).toBe("unknown_technology");
    expect(refusal(run("focus", { run: "06Z" }))).toBe("unknown_run");
    expect(refusal(run("focus", { run: "" }))).toBe("unknown_run");
    expect(refusal(run("focus", { technology: 1 }))).toBe("unknown_technology");
  });

  it("a bad value refuses the whole call, even beside a good one", () => {
    // Half-applying would move the reader's subsystem and leave them wondering
    // why the fleet did not change.
    expect(refusal(run("focus", { subsystem: "NE", run: "06Z" }))).toBe("unknown_run");
  });

  it("a property focus does not have is unexpected_argument", () => {
    expect(refusal(run("focus", { episode: REPLAY_DAYS[0].id }))).toBe(
      "unexpected_argument",
    );
  });
});

describe("highlight does not navigate", () => {
  for (const subsystem of SUBSYSTEM_DISPLAY_ORDER) {
    it(`${subsystem} lights, and nothing moves`, () => {
      const intent = run("highlight", { subsystem });
      expect(intent).toEqual({ kind: "highlight", subsystem });
    });
  }

  it("an explicit null clears the highlight", () => {
    expect(run("highlight", { subsystem: null })).toEqual({
      kind: "highlight",
      subsystem: null,
    });
  });

  it("no subsystem at all is missing_argument", () => {
    expect(refusal(run("highlight", {}))).toBe("missing_argument");
    expect(refusal(run("highlight", undefined))).toBe("missing_argument");
  });

  it("a hallucinated subsystem refuses", () => {
    expect(refusal(run("highlight", { subsystem: "SUDESTE" }))).toBe("unknown_subsystem");
  });

  it("a property highlight does not have is unexpected_argument", () => {
    expect(refusal(run("highlight", { subsystem: "NE", technology: "wind" }))).toBe(
      "unexpected_argument",
    );
  });

  it("no highlight call ever produces a navigation", () => {
    for (const subsystem of [...SUBSYSTEM_DISPLAY_ORDER, null]) {
      expect(run("highlight", { subsystem }).kind).toBe("highlight");
    }
  });
});

describe("replay", () => {
  for (const day of REPLAY_DAYS) {
    it(`episode ${day.id} opens the Time Machine on it`, () => {
      const { pathname, params } = navigation(run("replay", { episode: day.id }));
      expect(pathname).toBe(SCREEN_PATHS.replay);
      expect(params.episode).toBe(day.id);
      expect(params.subsystem).toBe("NE");
    });
  }

  it("an unknown episode refuses rather than falling back to the first day", () => {
    // `replayDay()` falls back, correctly, for a hand-edited URL. Here it would
    // replay a different day than the one asked about.
    for (const value of ["", "2026-08-11", "yesterday", 1, null]) {
      expect(refusal(run("replay", { episode: value }))).toBe("unknown_episode");
    }
  });

  it("a relative day resolves to the nearest replayable day at or before it", () => {
    // 2026-09-16 − 7 = 2026-09-09; the catalogue's most recent day at or before
    // that is 2026-08-11. Rounding forward would answer about a day the reader
    // has not had yet.
    expect(navigation(run("replay", { relative_day: -7 })).params.episode).toBe(
      "2026-08-11-ne",
    );
    expect(navigation(run("replay", { relative_day: -40 })).params.episode).toBe(
      "2026-06-18-ne",
    );
    expect(navigation(run("replay", { relative_day: -400 })).params.episode).toBe(
      "2024-11-05-ne",
    );
  });

  it("a day older than the catalogue refuses rather than clamping", () => {
    expect(refusal(run("replay", { relative_day: -3000 }))).toBe(
      "no_episode_for_relative_day",
    );
  });

  it("relative_day must be a past integer inside the floor", () => {
    for (const value of [0, 1, 7, -0.5, -3651, Number.NaN, "-7", null]) {
      expect(refusal(run("replay", { relative_day: value }))).toBe("value_out_of_range");
    }
  });

  it("both an episode and a relative day is ambiguous_replay", () => {
    expect(refusal(run("replay", { episode: REPLAY_DAYS[0].id, relative_day: -7 }))).toBe(
      "ambiguous_replay",
    );
  });

  it("neither is missing_argument", () => {
    expect(refusal(run("replay", {}))).toBe("missing_argument");
  });

  it("a property replay does not have is unexpected_argument", () => {
    expect(refusal(run("replay", { subsystem: "NE" }))).toBe("unexpected_argument");
  });
});

describe("mitigate", () => {
  it("with no sizes it navigates and writes no scenario", () => {
    const { pathname, params } = navigation(run("mitigate", {}));
    expect(pathname).toBe(SCREEN_PATHS.mitigate);
    expect(params[SCENARIO_PARAM]).toBeUndefined();
    expect(params.subsystem).toBe("NE");
  });

  it("with a subsystem only it carries the subsystem and no scenario", () => {
    const { params } = navigation(run("mitigate", { subsystem: "S" }));
    expect(params.subsystem).toBe("S");
    expect(params[SCENARIO_PARAM]).toBeUndefined();
  });

  it("a battery energy is written through the codec, not assembled", () => {
    const scenario = linkedScenario(run("mitigate", { battery_mwh: 500 }));
    expect(scenarioBattery(scenario).energyCapacityMwh).toBe(500);
    // The rest of the fleet is untouched: `withBattery` spreads over the asset
    // rather than rebuilding it from the fields the caller happened to name.
    expect(scenarioBattery(scenario).maxPowerMw).toBe(REFERENCE_FLEET.battery.maxPowerMw);
    expect(scenarioLoad(scenario).dailyEnergyMwh).toBe(
      REFERENCE_FLEET.shiftableLoad.dailyEnergyMwh,
    );
  });

  it("a battery power is written", () => {
    const scenario = linkedScenario(run("mitigate", { battery_mw: 300 }));
    expect(scenarioBattery(scenario).maxPowerMw).toBe(300);
    expect(scenarioBattery(scenario).energyCapacityMwh).toBe(
      REFERENCE_FLEET.battery.energyCapacityMwh,
    );
  });

  it("a load energy is written", () => {
    const scenario = linkedScenario(run("mitigate", { load_mwh: 2000 }));
    expect(scenarioLoad(scenario).dailyEnergyMwh).toBe(2000);
  });

  it("all three at once", () => {
    const scenario = linkedScenario(
      run("mitigate", { battery_mwh: 800, battery_mw: 200, load_mwh: 1500 }),
    );
    expect(scenarioBattery(scenario).energyCapacityMwh).toBe(800);
    expect(scenarioBattery(scenario).maxPowerMw).toBe(200);
    expect(scenarioLoad(scenario).dailyEnergyMwh).toBe(1500);
  });

  it("a subsystem moves the whole scenario, assets and all", () => {
    const scenario = linkedScenario(
      run("mitigate", { subsystem: "S", battery_mwh: 500 }),
    );
    expect(scenario.subsystem).toBe("S");
    // `SUBSYSTEM_MISMATCH` is one subsystem per scenario — an asset left in NE
    // would be a link the gateway refuses and the screen accepted.
    for (const asset of scenario.assets) {
      expect(asset.subsystem).toBe("S");
    }
  });

  it("a supplied scenario is edited in place, not replaced", () => {
    const supplied: Scenario = {
      ...defaultScenario("NE", NE.date),
      assets: defaultScenario("NE", NE.date).assets.map((asset) =>
        asset.assetType === "battery"
          ? { ...asset, label: "Parque piloto", initialStateOfCharge: 0.25 }
          : asset,
      ),
    };
    const scenario = linkedScenario(run("mitigate", { battery_mwh: 700 }, NE, supplied));
    expect(scenarioBattery(scenario).energyCapacityMwh).toBe(700);
    // The label survives a round trip — a shared link keeps its bytes.
    expect(scenarioBattery(scenario).label).toBe("Parque piloto");
    expect(scenarioBattery(scenario).initialStateOfCharge).toBe(0.25);
  });

  it("the day the scenario plans is the day the selection names", () => {
    expect(linkedScenario(run("mitigate", { battery_mwh: 500 })).targetDate).toBe(
      NE.date,
    );
  });

  it("every size outside the steppers' own range refuses", () => {
    const outside: [string, unknown][] = [
      ["battery_mwh", ASSET_LIMITS.batteryEnergyMwh.min - 1],
      ["battery_mwh", ASSET_LIMITS.batteryEnergyMwh.max + 1],
      ["battery_mw", ASSET_LIMITS.batteryPowerMw.min - 1],
      ["battery_mw", ASSET_LIMITS.batteryPowerMw.max + 1],
      ["load_mwh", ASSET_LIMITS.loadDailyEnergyMwh.min - 1],
      ["load_mwh", ASSET_LIMITS.loadDailyEnergyMwh.max + 1],
      ["battery_mwh", Number.NaN],
      ["battery_mwh", Number.POSITIVE_INFINITY],
      ["battery_mwh", "500"],
      ["battery_mwh", null],
    ];
    for (const [field, value] of outside) {
      // The voice may not build a fleet the mouse cannot: a link the steppers
      // immediately clamp would show a different plan than the one spoken.
      expect(refusal(run("mitigate", { [field]: value }))).toBe("value_out_of_range");
    }
  });

  it("the range's own endpoints are accepted", () => {
    for (const value of [
      ASSET_LIMITS.batteryEnergyMwh.min,
      ASSET_LIMITS.batteryEnergyMwh.max,
    ]) {
      expect(
        scenarioBattery(linkedScenario(run("mitigate", { battery_mwh: value })))
          .energyCapacityMwh,
      ).toBe(value);
    }
  });

  it("a hallucinated subsystem refuses before anything is written", () => {
    expect(refusal(run("mitigate", { subsystem: "SUDESTE", battery_mwh: 500 }))).toBe(
      "unknown_subsystem",
    );
  });

  it("a property mitigate does not have is unexpected_argument", () => {
    expect(refusal(run("mitigate", { run: "00Z" }))).toBe("unexpected_argument");
  });

  it("every link the agent writes is one the screen can read back", () => {
    // The one failure a shareable URL cannot survive is a link the API rejects
    // and the screen accepts. `linkedScenario` decodes through the real codec
    // and the real refusal table, so this is that assertion.
    for (const args of [
      { battery_mwh: 500 },
      { battery_mw: 25 },
      { load_mwh: 6000 },
      { subsystem: "N", battery_mwh: 2400 },
      { subsystem: "SE", battery_mw: 600, load_mwh: 6000 },
    ]) {
      expect(() => linkedScenario(run("mitigate", args))).not.toThrow();
    }
  });

  it("a fleet the refusal table rejects is refused, not linked to", () => {
    // `load_mwh: 100` is the stepper's own minimum and still trips
    // `SHIFT_EXCEEDS_BASELINE`: the rule is about the combination, not the
    // field, so no per-argument range could have caught it. This case is why
    // the assembled scenario goes through `validateScenarioWire` before a link
    // is written — otherwise the agent would navigate to a screen showing a
    // refusal it caused.
    const intent = run("mitigate", { load_mwh: 100 });
    expect(refusal(intent)).toBe("scenario_refused");
    if (intent.kind === "refused") {
      expect(intent.reason.value).toBe("SHIFT_EXCEEDS_BASELINE");
    }
  });
});

describe("property: any valid call leaves the URL parseable", () => {
  const VALID_CALLS: ToolCall[] = [
    { name: "show_grid", arguments: {} },
    ...SUBSYSTEM_DISPLAY_ORDER.map((subsystem) => ({
      name: "explain",
      arguments: { subsystem },
    })),
    ...DRIVER_CODES.map((driver) => ({ name: "explain", arguments: { driver } })),
    { name: "mitigate", arguments: {} },
    { name: "mitigate", arguments: { battery_mwh: 500 } },
    { name: "mitigate", arguments: { subsystem: "S", load_mwh: 4000 } },
    ...REPLAY_DAYS.map((day) => ({ name: "replay", arguments: { episode: day.id } })),
    { name: "replay", arguments: { relative_day: -7 } },
    ...SUBSYSTEM_DISPLAY_ORDER.map((subsystem) => ({
      name: "focus",
      arguments: { subsystem },
    })),
    { name: "focus", arguments: { technology: "solar" } },
    ...QUESTION_KINDS.map((question_kind) => ({
      name: "brief",
      arguments: { question_kind },
    })),
    { name: "brief", arguments: { question_kind: "why", subsystem: "S" } },
    { name: "focus", arguments: { run: "00Z" } },
    ...SUBSYSTEM_DISPLAY_ORDER.map((subsystem) => ({
      name: "highlight",
      arguments: { subsystem },
    })),
  ];

  const EVERY_PARAMS: AppParams[] = SUBSYSTEM_DISPLAY_ORDER.flatMap((subsystem) =>
    (["WIND", "SOLAR"] as const).flatMap((technology) =>
      RUN_LABELS.map((label) => ({
        subsystem: subsystem as SubsystemCode,
        technology,
        run: label,
        date: NE.date,
        episode: REPLAY_DAYS[0].id,
      })),
    ),
  );

  it("no valid call is ever refused", () => {
    for (const params of EVERY_PARAMS) {
      for (const call of VALID_CALLS) {
        const intent = executeTool(call, params);
        expect(intent.kind).not.toBe("refused");
      }
    }
  });

  it("the params of every intent parse back through parseAppParams", () => {
    for (const params of EVERY_PARAMS) {
      for (const call of VALID_CALLS) {
        const intent = executeTool(call, params);
        if (intent.kind !== "navigate" && intent.kind !== "params") {
          continue;
        }
        // A `params` intent merges onto the current URL, so it is parsed on top
        // of the selection it is being applied to — which is what
        // `router.setParams` does.
        const merged =
          intent.kind === "params"
            ? {
                subsystem: params.subsystem,
                technology: "wind",
                run: params.run,
                ...intent.params,
              }
            : intent.params;
        const parsed = parseAppParams(merged, NOW);
        expect(SUBSYSTEM_DISPLAY_ORDER).toContain(parsed.subsystem);
        expect(RUN_LABELS).toContain(parsed.run);
        expect(["WIND", "SOLAR"]).toContain(parsed.technology);
        expect(REPLAY_DAYS.some((day) => day.id === parsed.episode)).toBe(true);
      }
    }
  });

  it("a navigation's selection round-trips exactly, SOLAR included", () => {
    // `sharedParams` alone emits `SOLAR`, which `parseAppParams` does not read —
    // it falls back to wind. From a tab press that is a wrong pill; from the
    // agent it would be the voice saying "solar" over a wind screen.
    const solar: AppParams = { ...NE, technology: "SOLAR" };
    const { params } = navigation(executeTool({ name: "show_grid" }, solar));
    expect(parseAppParams(params, NOW).technology).toBe("SOLAR");
  });

  it("every tool is exercised by the property set", () => {
    expect([...new Set(VALID_CALLS.map((call) => call.name))].sort()).toEqual(
      [...TOOL_NAMES].sort(),
    );
  });
});

/**
 * The demo script, run from the Gherkin file.
 *
 * There is no Cucumber in this repo and six scenarios do not justify adding
 * one, so the subset of the language the feature file uses is parsed here and
 * each step is bound to the pure layer. The parser throws on a step it does not
 * recognise and the suite asserts the scenario count, so a scenario cannot pass
 * by quietly not running — which is the only way a hand-rolled runner is worse
 * than no runner at all.
 */
describe("the demo script (plan §6), as gherkin", () => {
  interface World {
    params: AppParams;
    intent?: NavigationIntent;
  }

  const STEPS: [RegExp, (world: World, ...groups: string[]) => void][] = [
    [
      /^the reader is looking at (\w+) · (\w+) · run (\w+) on ([\d-]+)$/,
      (world, subsystem, technology, label, date) => {
        world.params = {
          subsystem: subsystem as SubsystemCode,
          technology: technology.toUpperCase() as AppParams["technology"],
          run: label as AppParams["run"],
          date,
          episode: REPLAY_DAYS[0].id,
        };
      },
    ],
    [
      /^the model calls (\w+) with (.+)$/,
      (world, name, args) => {
        world.intent = executeTool({ name, arguments: JSON.parse(args) }, world.params);
      },
    ],
    [
      /^the intent kind is "(\w+)"$/,
      (world, kind) => {
        expect(String(world.intent?.kind)).toBe(kind);
      },
    ],
    [
      /^the route is "([^"]+)"$/,
      (world, path) => {
        expect(navigation(world.intent as NavigationIntent).pathname).toBe(path);
      },
    ],
    [
      /^the param "(\w+)" is "([^"]*)"$/,
      (world, key, value) => {
        expect(navigation(world.intent as NavigationIntent).params[key]).toBe(value);
      },
    ],
    [
      /^the highlighted subsystem is "(\w+)"$/,
      (world, subsystem) => {
        const intent = world.intent as NavigationIntent;
        expect(intent.kind === "highlight" && String(intent.subsystem)).toBe(subsystem);
      },
    ],
    [
      /^no route change happens$/,
      (world) => {
        // The step that proves the thesis: the assistant answers where the
        // reader already is.
        expect(world.intent?.kind).not.toBe("navigate");
      },
    ],
    [
      /^the link carries no scenario$/,
      (world) => {
        expect(
          navigation(world.intent as NavigationIntent).params[SCENARIO_PARAM],
        ).toBeUndefined();
      },
    ],
    [
      /^the link carries a scenario$/,
      (world) => {
        expect(
          navigation(world.intent as NavigationIntent).params[SCENARIO_PARAM],
        ).toBeTypeOf("string");
      },
    ],
    [
      /^the scenario battery energy is (\d+) MWh$/,
      (world, mwh) => {
        expect(
          scenarioBattery(linkedScenario(world.intent as NavigationIntent))
            .energyCapacityMwh,
        ).toBe(Number(mwh));
      },
    ],
    [
      /^the scenario battery power is unchanged$/,
      (world) => {
        expect(
          scenarioBattery(linkedScenario(world.intent as NavigationIntent)).maxPowerMw,
        ).toBe(REFERENCE_FLEET.battery.maxPowerMw);
      },
    ],
  ];

  interface ParsedScenario {
    readonly name: string;
    readonly steps: readonly string[];
  }

  function parseFeature(text: string): ParsedScenario[] {
    const background: string[] = [];
    const scenarios: ParsedScenario[] = [];
    let current: { name: string; steps: string[] } | undefined;
    let inBackground = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("Feature:")) {
        continue;
      }
      if (line.startsWith("Background:")) {
        inBackground = true;
        continue;
      }
      if (line.startsWith("Scenario:")) {
        if (current !== undefined) {
          scenarios.push(current);
        }
        inBackground = false;
        current = { name: line.slice("Scenario:".length).trim(), steps: [...background] };
        continue;
      }
      const step = /^(Given|When|Then|And)\s+(.*)$/.exec(line);
      if (step === null) {
        throw new Error(`unparseable line in the feature file: ${line}`);
      }
      (inBackground ? background : (current?.steps as string[])).push(step[2]);
    }
    if (current !== undefined) {
      scenarios.push(current);
    }
    return scenarios;
  }

  const FEATURES = join(import.meta.dir, "features");
  const files = readdirSync(FEATURES).filter((file) => file.endsWith(".feature"));
  const scenarios = files.flatMap((file) =>
    parseFeature(readFileSync(join(FEATURES, file), "utf8")),
  );

  it("the feature files carry the six steps of the script", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(scenarios.length).toBe(6);
  });

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const world: World = { params: NE };
      for (const step of scenario.steps) {
        const bound = STEPS.find(([pattern]) => pattern.test(step));
        if (bound === undefined) {
          // A runner that skipped unknown steps would let a scenario pass by
          // asserting nothing, which is worse than having no runner.
          throw new Error(`no step definition for: ${step}`);
        }
        const groups = (bound[0].exec(step) as RegExpExecArray).slice(1);
        bound[1](world, ...groups);
      }
    });
  }
});

/**
 * **The demo script, walked end to end.** Plan §6, as one sequence.
 *
 * Every step below is already covered somewhere in this file — the highlight
 * that does not navigate, the relative day that resolves to an episode, the
 * battery that reaches the scenario codec. What none of those tests can assert
 * is the property the script's last row actually claims: *"→ Visão da rede,
 * **selection intact**"*. Intact after what? After five prior turns, each of
 * which wrote into the selection the next one reads. That is a fact about the
 * accumulated state, and a test that runs one tool against a fixed `AppParams`
 * cannot see it — it starts from `NE` every time and therefore proves that the
 * sixth step preserves a selection nothing had disturbed.
 *
 * So this threads the params through: each intent's output becomes the next
 * call's input, exactly as `voice-provider.tsx` does it via `liveRef`, and the
 * script is driven in the order a person would speak it.
 *
 * **Non-vacuity.** The thread has to actually carry something, or the final
 * assertion is trivially true. Step 3 moves the subsystem to `SE` — a departure
 * from the starting selection that every later step must preserve — and the
 * assertions demand `SE` at the end rather than `NE`. An `executeTool` that
 * dropped the incoming params and rebuilt defaults would answer `NE` and fail
 * here while passing every other test in this file.
 */
describe("the demo script (plan §6), driven as one conversation", () => {
  it("six turns, each reading the selection the last one left", () => {
    const transcript: { step: number; kind: string; where: string }[] = [];
    let params: AppParams = NE;
    let scenario: Scenario | undefined;
    /*
      A holder rather than a `let`, because the only assignment happens inside
      `turn` and TypeScript's flow analysis cannot see through the closure: it
      narrows the variable to `null` at the assertion and then rejects `"NE"` as
      the expected value. The property is what the script claims — step 1
      highlights without navigating — so the fix is to keep the assertion and
      stop narrowing it away.
    */
    const highlighted: { current: SubsystemCode | null } = { current: null };

    /** Apply an intent the way the provider does, and record what happened. */
    const turn = (step: number, name: string, args: Record<string, unknown>) => {
      const intent = executeTool({ name, arguments: args } as ToolCall, params, scenario);
      if (intent.kind === "navigate" || intent.kind === "params") {
        params = parseAppParams({ ...writeParams(params), ...intent.params }, NOW);
        const blob = intent.params[SCENARIO_PARAM];
        if (blob !== undefined) {
          const readout = readScenario(
            blob,
            defaultScenario(params.subsystem, params.date),
            {
              now: NOW,
            },
          );
          if (!readout.ok) {
            throw new Error(
              `step ${step} wrote a link the screen refuses: ${readout.code}`,
            );
          }
          scenario = readout.scenario;
        }
      }
      if (intent.kind === "highlight") {
        highlighted.current = intent.subsystem;
      }
      transcript.push({
        step,
        kind: intent.kind,
        where: intent.kind === "navigate" ? intent.pathname : "(no navigation)",
      });
      return intent;
    };

    // 1 — "Qual região devo me preocupar mais amanhã?"
    //     The step that proves the thesis: it must NOT navigate.
    turn(1, "highlight", { subsystem: "NE" });
    expect(highlighted.current).toBe("NE");

    // 2 — "Por quê?"  → Explicar, the subsystem carried.
    turn(2, "explain", { subsystem: "NE" });
    expect(params.subsystem).toBe("NE");

    // 3 — "O que eu poderia fazer?" → Mitigar. Moved to SE deliberately: the
    //     rest of the script has to carry a selection that is not the default.
    turn(3, "mitigate", { subsystem: "SE" });
    expect(params.subsystem).toBe("SE");

    // 4 — "E se eu tivesse uma bateria de 500 MWh?"  The step to demo: the
    //     agent writes a query parameter and the real codec reads it back.
    turn(4, "mitigate", { battery_mwh: 500 });
    expect(scenario).toBeDefined();
    expect(scenarioBattery(scenario as Scenario).energyCapacityMwh).toBe(500);

    // 5 — "Isso teria funcionado na semana passada?" → the Time Machine.
    turn(5, "replay", { relative_day: -7 });

    // 6 — "Volta pra visão geral" → Visão da rede, selection intact.
    const last = turn(6, "show_grid", {});
    expect(navigation(last).pathname).toBe(SCREEN_PATHS.overview);

    // The claim the script's last row makes, and the reason this test exists:
    // `SE` survived four turns after the one that chose it.
    expect(params.subsystem).toBe("SE");

    /*
      **The scenario does not survive the crossing, and that is the product's
      rule rather than this agent's omission.**

      Plan §6 step 5 is *"Isso teria funcionado na semana passada?"* — where
      "isso" is the 500 MWh battery step 4 just described — and the plan expects
      the Time Machine to open on it. It does not, and neither does the tab row:
      `sharedParams` is the one crossing between these four screens and it emits
      `subsystem`, `technology` and `run`. A reader pressing "Máquina do tempo"
      after editing a battery loses it in exactly the same way.

      So the agent is *consistent with the interface it is driving*, which is
      the property worth protecting: an agent that carried state the tab row
      drops would make the same sentence mean two different things depending on
      whether it was spoken or clicked. The assertion below pins that, rather
      than pinning the plan's wish.

      The gap is real and it is a product decision, not a bug to be fixed
      quietly here: Replay *does* read `?s=` (`use-replay.ts` posts the scenario
      to `/v1/replay`), so the screen would honour a carried scenario if the
      crossing carried one. Making it do so is a change to `sharedParams` and
      therefore to every tab press, which is a decision about the product's
      cross-screen contract and is recorded as one.
    */
    expect(navigation(last).params[SCENARIO_PARAM]).toBeUndefined();
    // Non-vacuity for the sentence above: the scenario *was* written, by the
    // step that had something to say about it. It is the crossing that drops
    // it, not the agent that never built it.
    expect(scenario).toBeDefined();
    expect(scenarioBattery(scenario as Scenario).energyCapacityMwh).toBe(500);

    // The shape of the whole run, in one assertion: step 1 is the only turn
    // that does not move the reader, and every other step lands somewhere.
    expect(transcript).toEqual([
      { step: 1, kind: "highlight", where: "(no navigation)" },
      { step: 2, kind: "navigate", where: SCREEN_PATHS.explain },
      { step: 3, kind: "navigate", where: SCREEN_PATHS.mitigate },
      { step: 4, kind: "navigate", where: SCREEN_PATHS.mitigate },
      { step: 5, kind: "navigate", where: SCREEN_PATHS.replay },
      { step: 6, kind: "navigate", where: SCREEN_PATHS.overview },
    ]);
  });
});

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core";
import { ASSET_LIMITS, REPLAY_DAYS, RUN_LABELS } from "../src/lib/fixtures";
import {
  DRIVER_CODES,
  isToolName,
  RELATIVE_DAY_FLOOR,
  TECHNOLOGY_VALUES,
  TOOL_NAMES,
  toolNamed,
  VOICE_TOOLS,
} from "../src/lib/voice/tools";

/**
 * The schema the model reads, and the property that makes the rest testable.
 *
 * Two things are asserted here and they are different in kind. The first is
 * that the six tools describe the enums the app actually has — a tool offering
 * a subsystem the executor refuses would look, from the outside, exactly like
 * the model hallucinating, and would be debugged as such. The second is the
 * structural one: **the four pure modules reach no React, no React Native and
 * no expo-router at runtime.** The plan calls that *"the single most important
 * structural decision in this document"*, which makes it the one property worth
 * proving mechanically rather than by reading the imports.
 */

const SRC = resolve(import.meta.dir, "..", "src");
const VOICE = join(SRC, "lib", "voice");

const PURE_MODULES = ["tools.ts", "execute.ts", "context.ts", "instructions.ts"].map(
  (file) => join(VOICE, file),
);

/** The three things that must not be in the graph, and what each would cost. */
const FORBIDDEN = [
  "react",
  "react-dom",
  "react-native",
  "react-native-web",
  "expo-router",
];

function sourceOf(file: string): string {
  // Comments are stripped before the statements are split on `;`, so a
  // semicolon inside the long prose headers above each module cannot be read as
  // the end of an import.
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

interface Edge {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/**
 * The module's imports, with `import type` marked.
 *
 * A type-only import is erased by TypeScript and is not an edge in the runtime
 * graph — which is what lets `context.ts` take a `NetworkState` by name without
 * pulling `use-network.ts`, and through it React, into the bundle. Treating it
 * as an edge would have forced a fourth copy of those state unions, and four
 * copies of a discriminated union is how two of them drift.
 */
function edgesOf(file: string): Edge[] {
  const out: Edge[] = [];
  for (const raw of sourceOf(file).split(";")) {
    const statement = raw.trim();
    if (!/^(import|export)\b/.test(statement)) {
      continue;
    }
    const match = /from\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/.exec(statement);
    if (match === null) {
      continue;
    }
    out.push({
      specifier: match[1] ?? match[2],
      typeOnly: /^(import|export)\s+type\b/.test(statement),
    });
  }
  return out;
}

/** `@/x` and `./x` to a file on disk. Bare specifiers are not followed. */
function resolveLocal(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : undefined;
  if (base === undefined) {
    return;
  }
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
}

/** Every file reachable from `entry` by a runtime import, and the bare names. */
function runtimeGraph(entry: string): { files: Set<string>; bare: Map<string, string> } {
  const files = new Set<string>();
  const bare = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    for (const edge of edgesOf(file)) {
      if (edge.typeOnly) {
        continue;
      }
      const local = resolveLocal(file, edge.specifier);
      if (local === undefined) {
        bare.set(edge.specifier, relative(SRC, file));
        continue;
      }
      queue.push(local);
    }
  }
  return { files, bare };
}

describe("the pure layer is pure", () => {
  for (const module of PURE_MODULES) {
    it(`${relative(VOICE, module)} reaches no React, no React Native and no router`, () => {
      const { bare } = runtimeGraph(module);
      const offending = [...bare.entries()].filter(([specifier]) =>
        FORBIDDEN.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
      );
      // Named rather than counted: the failure message has to say *which*
      // module reintroduced the dependency, because by then it is three hops
      // away from the file someone edited.
      expect(offending).toEqual([]);
    });
  }

  it("the guard actually looks at a graph, not just at four files", () => {
    // Without this, the check above would pass on a `tools.ts` that imported a
    // component that imported React. `execute.ts` reaches `params.ts` and
    // `scenario.ts` — both deliberately React-free — so the graph is bigger
    // than the entry point and the walk is doing work.
    const { files } = runtimeGraph(join(VOICE, "execute.ts"));
    expect(files.size).toBeGreaterThan(3);
    expect([...files].some((file) => file.endsWith("components/app/scenario.ts"))).toBe(
      true,
    );
  });

  it("a React-importing module would be caught", () => {
    // Non-vacuity, proved in-process rather than by hand: `use-serving.ts` does
    // import React, and the same walk over it finds it. If the walker were
    // broken — a regex that matched nothing, a resolver that returned
    // `undefined` for everything — this assertion would fail too.
    const { bare } = runtimeGraph(join(SRC, "components", "app", "use-serving.ts"));
    expect([...bare.keys()]).toContain("react");
  });
});

describe("the six tools", () => {
  it("there are exactly six, in the order the plan fixes", () => {
    expect(TOOL_NAMES).toEqual([
      "show_grid",
      "explain",
      "mitigate",
      "replay",
      "focus",
      "highlight",
    ]);
    expect(VOICE_TOOLS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  });

  it("isToolName refuses everything else", () => {
    for (const name of TOOL_NAMES) {
      expect(isToolName(name)).toBe(true);
    }
    for (const value of ["", "show grid", "SHOW_GRID", "navigate", null, 7, {}, []]) {
      expect(isToolName(value)).toBe(false);
    }
  });

  it("every tool is a function tool that forbids extra properties", () => {
    for (const tool of VOICE_TOOLS) {
      expect(tool.type).toBe("function");
      expect(tool.parameters.type).toBe("object");
      // The executor refuses an undeclared property. Saying so in the schema
      // turns that refusal into something the model can avoid.
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it("every required property is a declared property", () => {
    for (const tool of VOICE_TOOLS) {
      for (const key of tool.parameters.required) {
        expect(Object.keys(tool.parameters.properties)).toContain(key);
      }
    }
  });

  it("highlight is the only tool with a required argument", () => {
    const withRequired = VOICE_TOOLS.filter(
      (tool) => tool.parameters.required.length > 0,
    );
    expect(withRequired.map((tool) => tool.name)).toEqual(["highlight"]);
    expect(toolNamed("highlight")?.parameters.required).toEqual(["subsystem"]);
  });

  it("show_grid takes nothing at all", () => {
    const tool = toolNamed("show_grid");
    expect(tool?.parameters.properties).toEqual({});
    expect(tool?.parameters.required).toEqual([]);
  });

  it("toolNamed answers for the six and for nothing else", () => {
    for (const name of TOOL_NAMES) {
      expect(toolNamed(name)?.name).toBe(name);
    }
    expect(toolNamed("promote_model")).toBeUndefined();
  });
});

describe("the enums are the app's, not a second opinion", () => {
  const subsystemEnums = VOICE_TOOLS.flatMap((tool) =>
    Object.entries(tool.parameters.properties)
      .filter(([key]) => key === "subsystem")
      .map(([, property]) => property.enum),
  );

  it("every subsystem enum is SUBSYSTEM_DISPLAY_ORDER", () => {
    expect(subsystemEnums.length).toBe(4);
    for (const values of subsystemEnums) {
      expect(values).toEqual([...SUBSYSTEM_DISPLAY_ORDER]);
    }
  });

  it("the run enum is RUN_LABELS and the technology enum is the URL spelling", () => {
    const focus = toolNamed("focus");
    expect(focus?.parameters.properties.run.enum).toEqual([...RUN_LABELS]);
    expect(focus?.parameters.properties.technology.enum).toEqual([...TECHNOLOGY_VALUES]);
    // The URL spelling, not the domain's: `params.ts` owns that boundary and
    // `technologyParam` is the one translator.
    expect(TECHNOLOGY_VALUES).toEqual(["wind", "solar"]);
  });

  it("the episode enum is the replay catalogue", () => {
    expect(toolNamed("replay")?.parameters.properties.episode.enum).toEqual(
      REPLAY_DAYS.map((day) => day.id),
    );
  });

  it("the driver enum is the eight groups the diagnosis contract publishes", () => {
    // `DriverCode` is a type and has no runtime list, so the union is read off
    // the source of `packages/core`. A ninth driver group is then a failing
    // test here rather than a row the model can never be pointed at.
    const domain = readFileSync(
      resolve(import.meta.dir, "..", "..", "..", "packages", "core", "src", "domain.ts"),
      "utf8",
    );
    const union = /export type DriverCode =([\s\S]*?);/.exec(domain);
    const published = [...(union?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map(
      (match) => match[1],
    );
    expect(published.length).toBe(8);
    expect([...DRIVER_CODES].map(String).sort()).toEqual(published.sort());
    // `other` is the client's merged remainder and never travels.
    expect(DRIVER_CODES).not.toContain("other" as never);
  });

  it("the size bounds are the steppers' own", () => {
    const mitigate = toolNamed("mitigate");
    const properties = mitigate?.parameters.properties ?? {};
    expect(properties.battery_mwh.minimum).toBe(ASSET_LIMITS.batteryEnergyMwh.min);
    expect(properties.battery_mwh.maximum).toBe(ASSET_LIMITS.batteryEnergyMwh.max);
    expect(properties.battery_mw.minimum).toBe(ASSET_LIMITS.batteryPowerMw.min);
    expect(properties.battery_mw.maximum).toBe(ASSET_LIMITS.batteryPowerMw.max);
    expect(properties.load_mwh.minimum).toBe(ASSET_LIMITS.loadDailyEnergyMwh.min);
    expect(properties.load_mwh.maximum).toBe(ASSET_LIMITS.loadDailyEnergyMwh.max);
  });

  it("relative_day is past-only and bounded", () => {
    const relative_day = toolNamed("replay")?.parameters.properties.relative_day;
    expect(relative_day?.type).toBe("integer");
    expect(relative_day?.maximum).toBe(-1);
    expect(relative_day?.minimum).toBe(RELATIVE_DAY_FLOOR);
  });

  it("highlight's description says it does not navigate", () => {
    // The step that proves the thesis (plan §6, step 1). If the model is not
    // told this, it opens Explain to answer a question that fits where the
    // reader already is, and the demo loses its best moment.
    expect(toolNamed("highlight")?.description).toContain("WITHOUT navigating");
  });
});

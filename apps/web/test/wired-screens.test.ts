/**
 * The Overview and Explain read the gateway — and keep reading it honestly.
 *
 * Four properties, each of which was true at the moment this was written and
 * each of which has a cheap way to stop being true. Every one is asserted
 * against the source, and every one was checked by reintroducing the defect and
 * watching the named test fail:
 *
 *  1. **Neither screen builds a figure from a fixture.** This is the one the
 *     whole ticket is about. A `buildForecast` left behind anywhere in these
 *     two files would put fixture numbers back on a screen that now looks real.
 *  2. **Every request goes through the one client.** A second `fetch` would be
 *     a second casing boundary and a second opinion about what a failure is.
 *  3. **The chrome badge is derived, not declared.** The reason the user asked
 *     why `FIXTURE DATA` was still there is that it was a constant. It is a
 *     read now, and a constant `true` would be the same bug wearing the fix.
 *  4. **The forecast half is absent when it refuses.** A screen that rendered a
 *     band from an `observedOnly` state would be the failure mode this whole
 *     split exists to prevent.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8");
}

/** Source with comments removed — a claim in prose is not a claim in code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Whitespace collapsed, so an assertion survives the formatter.
 *
 * A guard that fails when `biome check --write` wraps a JSX line is a guard
 * that will be deleted the first time it cries wolf, and it is the wolf-crying
 * that gets it deleted rather than the property being wrong.
 */
function flat(text: string): string {
  return code(text).replace(/\s+/g, " ");
}

const OVERVIEW = code(read("app", "app", "index.tsx"));
const OVERVIEW_FLAT = flat(read("app", "app", "index.tsx"));
const EXPLAIN_FLAT = flat(read("app", "app", "explain.tsx"));
const EXPLAIN = code(read("app", "app", "explain.tsx"));
const SHELL = code(read("components", "app", "app-shell.tsx"));
const NETWORK_HOOK = code(read("components", "app", "use-network.ts"));
const EXPLAIN_HOOK = code(read("components", "app", "use-explain.ts"));
const SERVING = code(read("components", "app", "use-serving.ts"));

describe("the two screens read the gateway and not a fixture", () => {
  /**
   * The fixture builders that used to produce every number on these screens.
   * `subsystemMeta`, `SUBSYSTEM_DISPLAY_ORDER` and `FIXTURE_LANE` are *not*
   * here: the first two are published constants re-exported through the
   * fixtures barrel, and the third is a lane name, which is configuration.
   */
  const BUILDERS = [
    "buildForecast",
    "buildAllForecasts",
    "buildExplain",
    "buildModelCard",
    "TARGET_DATE",
  ];

  for (const [name, source] of [
    ["the Overview", OVERVIEW],
    ["Explain", EXPLAIN],
  ] as const) {
    test(`${name} calls no fixture builder`, () => {
      const found = BUILDERS.filter((builder) =>
        new RegExp(`\\b${builder}\\b`).test(source),
      );
      expect({ screen: name, found }).toEqual({ screen: name, found: [] });
    });
  }

  test("each screen drives one hook, and the hook is its own", () => {
    expect(OVERVIEW).toContain("useNetwork({");
    expect(EXPLAIN).toContain("useExplain({");
    // Not each other's: one hook per screen is the pattern `use-replay.ts` and
    // `use-optimization.ts` set, and two screens sharing one would make a
    // change for one of them a change for both.
    expect(OVERVIEW).not.toContain("useExplain");
    expect(EXPLAIN).not.toContain("useNetwork");
  });
});

describe("one client, one casing boundary", () => {
  const REQUESTING = [
    ["use-network.ts", NETWORK_HOOK],
    ["use-explain.ts", EXPLAIN_HOOK],
    ["use-serving.ts", SERVING],
  ] as const;

  for (const [name, source] of REQUESTING) {
    test(`${name} reaches the gateway only through \`api\``, () => {
      expect(source).toContain('from "@/lib/api"');
      // A bare `fetch`, an `XMLHttpRequest` or a second `ApiClient` would each
      // be a second translator between the wire's snake_case and this app's
      // camelCase, and a second opinion about what an error envelope is.
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toContain("XMLHttpRequest");
      expect(source).not.toContain("new ApiClient");
    });
  }

  test("every request this work added is a method on the one client", () => {
    const client = readFileSync(
      join(import.meta.dir, "..", "..", "..", "packages", "core", "src", "client.ts"),
      "utf8",
    );
    for (const method of [
      "gridNow",
      "gridOutlook",
      "forecastDayAhead",
      "diagnosisDayAhead",
      "curtailmentHours",
      "curtailmentEpisodes",
      "observedReasons",
      "modelCard",
      "meta",
    ]) {
      expect(client).toContain(`${method}(`);
    }
  });
});

describe("the chrome badge is a fact, not a label", () => {
  test("`FIXTURE DATA` is gone from both dictionaries", () => {
    for (const locale of ["copy.en.ts", "copy.pt.ts"] as const) {
      // Comments stripped: the badge's own doc comment quotes the string it
      // used to say, which is the explanation and not the label.
      const dict = code(read("i18n", locale));
      expect(dict).not.toContain("FIXTURE DATA");
      expect(dict).not.toContain("DADOS DE FIXTURE");
    }
  });

  test("the badge's second half is read from /v1/meta, never declared", () => {
    // Non-vacuity rests on this pair: the badge renders `noModelBadge` only
    // under a value `useServing` computed, and `useServing` only ever reports
    // `known` after `api.meta` answered.
    expect(SHELL).toContain("useServing()");
    expect(SHELL).toContain('serving.status === "known" && !serving.serving');
    expect(SERVING).toContain("api\n      .meta(controller.signal)");
    expect(SERVING).toContain("serving: anyLaneServing(lanes)");
  });

  test("a lane counts as serving only when promoted and not reported unusable", () => {
    const absence = code(read("lib", "absence.ts"));
    expect(absence).toContain(
      'lanes.some((lane) => lane.condition === "promoted" && lane.usable !== false)',
    );
  });
});

describe("a refused forecast renders no forecast", () => {
  test("the Overview's forecast panels are behind the `read` state alone", () => {
    // `forecast` is `null` in every state but `read`, and each forecast panel
    // is inside the component that takes it. A panel moved outside this guard
    // would draw a band from a state that has none.
    expect(OVERVIEW_FLAT).toContain(
      'const forecast = state.status === "read" ? state.forecast : null;',
    );
    expect(OVERVIEW_FLAT).toContain(
      "{forecast === null ? null : ( <ForecastPanels forecast={forecast} onSelect={select} /> )}",
    );
    for (const panel of ["<SubsystemMap", "<FanChart", "<BandCard", "<SubsystemRow"]) {
      const inPanels =
        OVERVIEW.indexOf(panel) > OVERVIEW.indexOf("function ForecastPanels");
      expect({ panel, inForecastPanels: inPanels }).toEqual({
        panel,
        inForecastPanels: true,
      });
    }
  });

  test("Explain's diagnosis panels are behind the `explained` state alone", () => {
    expect(EXPLAIN_FLAT).toContain(
      'const day = state.status === "explained" ? state.day : null;',
    );
    expect(EXPLAIN_FLAT).toContain("day === null ? null : <DiagnosedPanels day={day} />");
    for (const panel of ["<RiskChip", "<BandFigure", "<DriverBars", "renderNarration("]) {
      const inPanels =
        EXPLAIN.indexOf(panel) > EXPLAIN.indexOf("function DiagnosedPanels");
      expect({ panel, inDiagnosedPanels: inPanels }).toEqual({
        panel,
        inDiagnosedPanels: true,
      });
    }
  });

  test("the refusal is rendered from the code, never from the envelope's message", () => {
    for (const [name, source] of [
      ["the Overview", OVERVIEW],
      ["Explain", EXPLAIN],
    ] as const) {
      expect({ name, renders: source.includes("copy.error[") }).toEqual({
        name,
        renders: true,
      });
    }
    const absent = code(read("components", "app", "forecast-absent.tsx"));
    expect(absent).toContain("copy.error[code]");
    // The gate's own prose is English and is developer prose in the same status
    // as an error `message`. It may reach an operator on `/v1/meta` and it may
    // not reach a screen.
    expect(absent).not.toContain("unusableReason");
    expect(absent).not.toContain("contractFault");
    expect(absent).not.toContain("cardError");
  });
});

describe("the observed half needs no model", () => {
  test("the Overview's observed reads are the three that answer with nothing promoted", () => {
    for (const call of [
      "api.gridNow(",
      "api.curtailmentHours(",
      "api.curtailmentEpisodes(",
    ]) {
      expect(NETWORK_HOOK).toContain(call);
    }
    // And they are grouped apart from the forecast's two, so a refusal of one
    // group cannot take the other down with it.
    const observedAt = NETWORK_HOOK.indexOf("const observed = Promise.all");
    const forecastAt = NETWORK_HOOK.indexOf("const forecast = Promise.all");
    expect(observedAt).toBeGreaterThan(0);
    expect(forecastAt).toBeGreaterThan(observedAt);
  });

  test("Explain's observed read is the restriction reasons, and it is not grouped with the day", () => {
    expect(EXPLAIN_HOOK).toContain("api.observedReasons(");
    const observedAt = EXPLAIN_HOOK.indexOf("const observed = Promise.all");
    const dayAt = EXPLAIN_HOOK.indexOf("const day = Promise.all");
    expect(observedAt).toBeGreaterThan(0);
    expect(dayAt).toBeGreaterThan(observedAt);
  });

  /**
   * Read off the exported union itself, not off any mention of a name in the
   * file. An earlier version of this test looked for the literals anywhere in
   * the source and passed while the union member had been renamed, because the
   * old spelling survived in a `setState` call — a guard that could not tell a
   * renamed state from a working one.
   *
   * Four and exactly four, because that is the claim both hook headers make and
   * the one a fifth state would quietly break: the pressure is always towards a
   * "stale" or "partial" status, and both of those are a number rendered under
   * a label that is no longer true.
   */
  function statesOf(source: string, typeName: string): string[] {
    const start = source.indexOf(`export type ${typeName} =`);
    expect(start).toBeGreaterThan(-1);
    const union = source.slice(
      start,
      source.indexOf(";", source.lastIndexOf("}", source.indexOf("\n\n", start))),
    );
    return [...union.matchAll(/readonly status: "(\w+)"/g)].map((m) => m[1]).sort();
  }

  test("the Overview's hook has exactly its four states", () => {
    expect(statesOf(NETWORK_HOOK, "NetworkState")).toEqual([
      "observedOnly",
      "read",
      "reading",
      "refused",
    ]);
  });

  test("Explain's hook has exactly its four states, named to match", () => {
    expect(statesOf(EXPLAIN_HOOK, "ExplainState")).toEqual([
      "explained",
      "observedOnly",
      "reading",
      "refused",
    ]);
  });
});

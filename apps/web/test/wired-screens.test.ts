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

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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

/**
 * **The Overview is a directory now, and these guards follow it there.**
 *
 * `app/app/index.tsx` reached 1095 lines and was decomposed: the route kept the
 * decision it makes — settled or forecast, and in which order — and the eight
 * panel components moved to `components/app/overview/`. Every structural guard
 * below is about the screen as a whole, so the screen as a whole is what they
 * read: the route concatenated with the panels, discovered from the directory
 * rather than listed, so a panel split out tomorrow is covered on the day it is
 * written.
 *
 * The concatenation is deliberate and is *not* a loosening. Three of these
 * guards are `not.toContain` assertions — the Overview calls no fixture
 * builder, and reads its own hook and not Explain's — and a `not` over a larger
 * string is a strictly stronger claim. The one guard that genuinely needs a
 * single component's boundary reads that component's own file instead, which
 * the split made possible: see `OBSERVED_STACK`.
 */
const OVERVIEW_PARTS = [
  read("app", "app", "index.tsx"),
  ...readdirSync(join(SRC, "components", "app", "overview"))
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => read("components", "app", "overview", name)),
];
const OVERVIEW = OVERVIEW_PARTS.map(code).join("\n");
const OVERVIEW_FLAT = OVERVIEW_PARTS.map(flat).join(" ");

/**
 * The observed stack, alone, as its own file.
 *
 * Before the split this was a `slice` between two `indexOf` calls into one big
 * string — a range that was correct only while the two functions stayed
 * adjacent and in that order, and that would have gone quietly wrong the moment
 * either moved. The file boundary is the same claim with nothing to get wrong.
 */
const OBSERVED_STACK = code(read("components", "app", "overview", "observed-panels.tsx"));
const FORECAST_STACK = code(read("components", "app", "overview", "forecast-panels.tsx"));
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
    it(`${name} calls no fixture builder`, () => {
      const found = BUILDERS.filter((builder) =>
        new RegExp(`\\b${builder}\\b`).test(source),
      );
      expect({ screen: name, found }).toEqual({ screen: name, found: [] });
    });
  }

  it("each screen drives one hook, and the hook is its own", () => {
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
    it(`${name} reaches the gateway only through \`api\``, () => {
      expect(source).toContain('from "@/lib/api"');
      // A bare `fetch`, an `XMLHttpRequest` or a second `ApiClient` would each
      // be a second translator between the wire's snake_case and this app's
      // camelCase, and a second opinion about what an error envelope is.
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toContain("XMLHttpRequest");
      expect(source).not.toContain("new ApiClient");
    });
  }

  it("every request this work added is a method on the one client", () => {
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
  it("`FIXTURE DATA` is gone from both dictionaries", () => {
    for (const locale of ["copy.en.ts", "copy.pt.ts"] as const) {
      // Comments stripped: the badge's own doc comment quotes the string it
      // used to say, which is the explanation and not the label.
      const dict = code(read("i18n", locale));
      expect(dict).not.toContain("FIXTURE DATA");
      expect(dict).not.toContain("DADOS DE FIXTURE");
    }
  });

  it("the badge's second half is read from /v1/meta, never declared", () => {
    // Non-vacuity rests on this pair: the badge renders `noModelBadge` only
    // under a value `useServing` computed, and `useServing` only ever reports
    // `known` after `api.meta` answered.
    expect(SHELL).toContain("useServing()");
    expect(SHELL).toContain('serving.status === "known" && !serving.serving');
    expect(SERVING).toContain("api\n      .meta(controller.signal)");
    expect(SERVING).toContain("serving: anyLaneServing(lanes)");
  });

  it("the badge reserves its width in every state, and shows in only one", () => {
    /*
      The regression this guards is a layout shift, not a wrong label.

      The badge used to be mounted behind `absent ?`, so it appeared when
      `/v1/meta` answered and pushed `PT / EN` and the voice trigger onto a
      second line of a `flexWrap` header — moving the whole screen below it down
      by 42px, about four seconds in. Measured on production at 412px that was
      the entirety of `/app`'s CLS: 0.215, against a 0.1 threshold.

      So the box is unconditional and `opacity` carries the fact. Asserting
      that pairing is what keeps someone from "simplifying" it back to a
      conditional mount, which would look tidier and reintroduce the jump.
    */
    expect(SHELL).toContain("opacity: absent ? 1 : 0");
    expect(SHELL).toContain('testID={absent ? "app-no-model-badge" : undefined}');
    // Reserved, therefore silent: a transparent pill must not be announced.
    expect(SHELL).toContain("aria-hidden={absent ? undefined : true}");
    // And never mounted conditionally again.
    expect(SHELL).not.toContain("{absent ? (");
  });

  it("a lane counts as serving only when promoted and not reported unusable", () => {
    const absence = code(read("lib", "absence.ts"));
    expect(absence).toContain(
      'lanes.some((lane) => lane.condition === "promoted" && lane.usable !== false)',
    );
  });
});

describe("a selector that cannot move anything says so", () => {
  it("the D−1 run pills go inert when no lane is promoted", () => {
    /*
      `subsystem` and `technology` steer the observed panels as well as the
      forecast ones, so they always change something. The run does not: it is
      read in exactly two places, the Overview's and Explain's forecast half,
      and with nothing promoted both refuse whatever it is set to. So every
      choice drew the same screen, on all four tabs, from a control that stayed
      bright and pressable.

      That is the one dishonesty this product cannot afford. Every panel on
      these screens withholds itself and names the clause that refused; a live
      control that moves nothing contradicts all of them at once, and the reader
      has no way to tell it from one that works.
    */
    expect(SHELL).toContain(
      'const runInert = serving.status === "known" && !serving.serving',
    );
    expect(SHELL).toContain("disabled={runInert}");
    expect(SHELL).toContain("disabledHint={copy.app.shell.selection.runUnavailable}");
  });

  it("only the run group is gated — the other two always move something", () => {
    // Non-vacuity: `disabled` must not have been sprinkled across the bar.
    expect(SHELL.match(/disabled=\{runInert\}/g)?.length).toBe(1);
  });

  it("inert is announced, not merely dimmed", () => {
    // Opacity alone says nothing to a screen reader, and `aria-disabled`
    // without a reason says only "no". The hint carries the why.
    expect(SHELL).toContain("aria-disabled={disabled || undefined}");
    expect(SHELL).toContain("accessibilityHint={disabled ? disabledHint : undefined}");
  });

  it("both dictionaries explain it, and differently", () => {
    const en = read("i18n", "copy.en.ts");
    const pt = read("i18n", "copy.pt.ts");
    expect(en).toContain("runUnavailable:");
    expect(pt).toContain("runUnavailable:");
    // Translated, not copy-pasted.
    const line = (dict: string) =>
      dict.split("\n").find((row) => row.includes("runUnavailable:")) ?? "";
    expect(line(en)).not.toBe(line(pt));
  });
});

describe("a refused forecast renders no forecast", () => {
  it("the Overview's forecast panels are behind the `read` state alone", () => {
    // `forecast` is `null` in every state but `read`, and each forecast panel
    // is inside the component that takes it. A panel moved outside this guard
    // would draw a band from a state that has none.
    expect(OVERVIEW_FLAT).toContain(
      'const forecast = state.status === "read" ? state.forecast : null;',
    );
    // The `null` side is a whole stack of its own now — the observed map, the
    // observed rows, the settled day, the settled split and the two settled
    // figures — rather than one strip saying the forecast is missing. The
    // property this guard is about is unchanged, and is asserted twice below:
    // the two stacks are exclusive, and nothing that states a forecast exists
    // inside the observed one.
    expect(OVERVIEW_FLAT).toContain(
      "{forecast === null ? ( <ObservedPanels observed={observed} subsystem={params.subsystem} onSelect={select} onExplain={explain} /> ) : ( <> <ForecastPanels forecast={forecast} onSelect={select} onExplain={explain} /> <SettledPanels observed={observed} subsystem={params.subsystem} onSelect={select} /> </> )}",
    );
    // Each forecast panel is inside `ForecastPanels`, which is now a file of
    // its own — so this is a containment check rather than the `indexOf`
    // ordering comparison it used to be. That comparison was true only while
    // the two functions stayed adjacent and in that order in one string; a
    // reordering would have silently inverted it while still passing.
    for (const panel of ["<SubsystemMap", "<FanChart", "<BandCard", "<SubsystemRow"]) {
      expect({ panel, inForecastPanels: FORECAST_STACK.includes(panel) }).toEqual({
        panel,
        inForecastPanels: true,
      });
    }
  });

  /**
   * The observed stack states no forecast, by construction.
   *
   * The screen now draws a full set of panels when nothing is promoted — a map,
   * four rows, a 24-hour profile, a split and two day figures — and every one
   * of them sits where a forecast panel sits in the other state. The failure
   * that buys is obvious and severe: a settled number under a forecast's label.
   *
   * So the guard is over the *source range* of `ObservedPanels`. Nothing that
   * can express a forecast may appear inside it: not the forecast components,
   * not the risk vocabulary, and not a quantile member — a band read is the
   * single clearest marker of model output, and there is no legitimate reason
   * for one to be in this function at all.
   *
   * Non-vacuity: rendering `<BandCard` or reading `.p50` anywhere inside
   * `ObservedPanels` fails this, and each was reintroduced once to check it.
   */
  it("the observed stack cannot state a forecast", () => {
    // The whole file, not a slice of a bigger one: `ObservedPanels` has its own
    // module now, so the boundary this guard is about is the boundary the
    // filesystem enforces. Non-vacuity is asserted first — an empty or renamed
    // file would make every `not.toContain` below trivially true.
    expect(OBSERVED_STACK).toContain("export function ObservedPanels");
    expect(OBSERVED_STACK).toContain("<SubsystemMap");
    // Flattened, so the assertions survive the formatter wrapping a JSX line.
    const observedStack = OBSERVED_STACK.replace(/\s+/g, " ");
    for (const forecastOnly of [
      "<FanChart",
      "<BandCard",
      "<BandStrip",
      "<SubsystemRow",
      "<RiskChip",
      "<TechnologySplitPanel",
      "<ForecastStamp",
      "riskColor",
      "RiskCaveat",
      ".p10",
      ".p50",
      ".p90",
      "forecast",
    ]) {
      expect({ forecastOnly, present: observedStack.includes(forecastOnly) }).toEqual({
        forecastOnly,
        present: false,
      });
    }
    // And it is not empty of the observed vocabulary, or the loop above would
    // pass against a function that renders nothing at all.
    for (const observedOnly of [
      '<SubsystemMap paint={{ kind: "observed", rows }}',
      "<ObservedSubsystemRow",
      "<ObservedCard",
      "<ObservedSplitPanel",
      "<ObservedBadge />",
      "<SettledDayPanel",
    ]) {
      expect({ observedOnly, present: observedStack.includes(observedOnly) }).toEqual({
        observedOnly,
        present: true,
      });
    }
  });

  it("Explain's diagnosis panels are behind the `explained` state alone", () => {
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

  it("the refusal is rendered from the code, never from the envelope's message", () => {
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
  it("the Overview's observed reads are the three that answer with nothing promoted", () => {
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

  it("Explain's observed read is the restriction reasons, and it is not grouped with the day", () => {
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

  it("the Overview's hook has exactly its four states", () => {
    expect(statesOf(NETWORK_HOOK, "NetworkState")).toEqual([
      "observedOnly",
      "read",
      "reading",
      "refused",
    ]);
  });

  it("Explain's hook has exactly its four states, named to match", () => {
    expect(statesOf(EXPLAIN_HOOK, "ExplainState")).toEqual([
      "explained",
      "observedOnly",
      "reading",
      "refused",
    ]);
  });
});

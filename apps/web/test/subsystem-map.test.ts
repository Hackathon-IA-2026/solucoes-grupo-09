import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBSYSTEM_DISPLAY_ORDER, type SubsystemCode } from "@wattsteer/core";
import { en as EN } from "../src/i18n/copy.en";
import { pt as PT } from "../src/i18n/copy.pt";
import { fill } from "../src/i18n/format";
import {
  BRAZIL_VIEWBOX,
  FEDERAL_UNITS,
  type FederalUnit,
  projectToViewBox,
  STATE_BORDER_D,
  SUBSYSTEM_LABEL_ANCHOR,
  SUBSYSTEM_PATH,
  SUBSYSTEM_UNITS,
  subsystemOf,
} from "../src/lib/geo/brazil-subsystems";

/**
 * The map of Brazil on the Grid Overview.
 *
 * Almost everything a map can get wrong is invisible in a screenshot and
 * invisible in a snapshot: a state grouped into the wrong subsystem still
 * renders as a plausible blob, and a copy-pasted path still fills. So the
 * assertions here are of two kinds, and neither is "it rendered".
 *
 *  - **Set assertions over the partition.** The union of the four groups is
 *    exactly the 27 federal units and no two groups share one. This is what
 *    catches the copy-paste — a unit duplicated into two groups or dropped
 *    from all four.
 *  - **Geometric assertions over the polygons.** Twelve cities are projected
 *    with the map's own projection and tested for containment in the path they
 *    should fall in. That is the only check here that can tell the *geometry*
 *    was grouped the way the list says, rather than that the list is
 *    self-consistent. Six of the twelve are in the states this feature had to
 *    research — MA, AC, RO, RR, TO — because those are the assignments a
 *    future edit is most likely to "correct" back to the geographic ones.
 *
 * The wiring assertions are structural, over the screen's own source. What
 * they guard is that the map and the rows call *one* handler: that is a
 * property of the file, not of a render, and a render test would pass just as
 * happily against two handlers that currently agree.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");
const SCREEN = join(ROOT, "apps", "web", "src", "app", "app", "index.tsx");
const MAP = join(ROOT, "apps", "web", "src", "components", "charts", "subsystem-map.tsx");

/**
 * **The map is two files now, and these guards read both.**
 *
 * `SubsystemMap` was 490 lines in one component and about a hundred of them
 * were its interaction policy — the platform branch, the keyboard ring, the
 * hover and focus pairs, and a `style` whose two lines each exist because of a
 * bug that shipped. That moved to `region-handlers.ts`, and eight guards in
 * this file went red at once: every one of them was about behaviour that had
 * simply left the file they were reading.
 *
 * Going red is the good outcome. The failure worth naming is the other one —
 * a guard whose subject moves out from under it and which keeps passing,
 * asserting nothing about a file that no longer contains the thing it names.
 * `MAP_SOURCE` is the pair, concatenated, so a future move between these two
 * files cannot quietly empty them.
 */
const REGION_HANDLERS = join(
  ROOT,
  "apps",
  "web",
  "src",
  "components",
  "charts",
  "region-handlers.ts",
);
const PANELS = join(ROOT, "apps", "web", "src", "components", "app", "overview");

/**
 * **The Overview, as source — the route and the panels it arranges.**
 *
 * These guards are about one screen, and that screen is no longer one file: at
 * 1095 lines it was decomposed, and the panels that draw the map and the rows
 * moved to `components/app/overview/`. A guard pinned to `index.tsx` alone
 * would have gone quiet at exactly that moment — still green, still asserting
 * nothing, because the props it looks for had left the file it was reading.
 *
 * So the unit is the directory plus the route, discovered rather than listed.
 * A panel split out tomorrow is covered the day it is written, and the
 * assertion below makes the discovery itself non-vacuous: an empty or renamed
 * directory fails here rather than silently narrowing every guard in this file
 * to the route's own two hundred lines.
 */
const OVERVIEW_FILES = [SCREEN, ...readdirSync(PANELS).map((name) => join(PANELS, name))];

function overviewSource(): string {
  return OVERVIEW_FILES.map(source).join("\n");
}

function overviewWithoutComments(): string {
  return OVERVIEW_FILES.map(sourceWithoutComments).join("\n");
}

function source(path: string): string {
  return readFileSync(path, "utf8");
}

/** The file with comments blanked, as `replay-screen.test.ts` does it. */
/** The map and its interaction policy, as one string. See `REGION_HANDLERS`. */
function mapSource(): string {
  return [MAP, REGION_HANDLERS].map(sourceWithoutComments).join("\n");
}

function sourceWithoutComments(path: string): string {
  return source(path).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/**
 * Even-odd containment against a path made only of `M`/`L`/`Z` subpaths.
 *
 * The generator emits nothing else — no curves, no relative commands, no
 * implicit `L` after `M` — so a parser this small is exact rather than
 * approximate. If that ever stops being true the first assertion below is what
 * says so.
 */
function ringsOf(d: string): [number, number][][] {
  return d
    .split("Z")
    .filter((sub) => sub.length > 0)
    .map((sub) =>
      sub
        .split(/[ML]/)
        .filter((pair) => pair.length > 0)
        .map((pair) => {
          const [x, y] = pair.split(" ").map(Number);
          return [x, y] as [number, number];
        }),
    );
}

function contains(d: string, px: number, py: number): boolean {
  let crossings = 0;
  for (const ring of ringsOf(d)) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        crossings++;
      }
    }
  }
  return crossings % 2 === 1;
}

describe("the UF → subsystem partition", () => {
  it("the four groups cover exactly the 27 federal units", () => {
    const union = SUBSYSTEM_DISPLAY_ORDER.flatMap((code) => SUBSYSTEM_UNITS[code]);
    expect([...union].sort()).toEqual([...FEDERAL_UNITS].sort());
    expect(union.length).toBe(27);
  });

  it("no federal unit is in two subsystems", () => {
    for (const a of SUBSYSTEM_DISPLAY_ORDER) {
      for (const b of SUBSYSTEM_DISPLAY_ORDER) {
        if (a === b) {
          continue;
        }
        const shared = SUBSYSTEM_UNITS[a].filter((uf) => SUBSYSTEM_UNITS[b].includes(uf));
        expect({ a, b, shared }).toEqual({ a, b, shared: [] });
      }
    }
  });

  it("every subsystem has at least one federal unit", () => {
    for (const code of SUBSYSTEM_DISPLAY_ORDER) {
      expect(SUBSYSTEM_UNITS[code].length).toBeGreaterThan(0);
    }
  });

  it("`subsystemOf` is total and agrees with the groups", () => {
    for (const uf of FEDERAL_UNITS) {
      expect(SUBSYSTEM_UNITS[subsystemOf(uf)]).toContain(uf);
    }
  });

  it("the three assignments that are not the geographic ones", () => {
    // Each of these is argued, with its source, in the module header. They are
    // asserted by name because the failure mode is somebody "fixing" them back
    // to the IBGE regions, which is what every intuition says they should be.
    expect(subsystemOf("MA")).toBe("N"); // Nordeste region, Norte subsystem
    expect(subsystemOf("AC")).toBe("SE"); // joined SE/CO in Nov 2009
    expect(subsystemOf("RO")).toBe("SE"); // same interconnection
    // Roraima has only been in any subsystem since September 2025.
    expect(subsystemOf("RR")).toBe("N");
    // Tocantins: load in N, some generation settles in SE. Drawn as N — the
    // forecast beside this map is a load-side one.
    expect(subsystemOf("TO")).toBe("N");
    // `SE` the subsystem and `SE` the federal unit are different things.
    expect(subsystemOf("SE")).toBe("NE");
  });
});

describe("the geometry", () => {
  it("every subsystem code has a path and an anchor", () => {
    for (const code of SUBSYSTEM_DISPLAY_ORDER) {
      expect(SUBSYSTEM_PATH[code].length).toBeGreaterThan(500);
      expect(SUBSYSTEM_PATH[code].startsWith("M")).toBe(true);
      expect(SUBSYSTEM_PATH[code].endsWith("Z")).toBe(true);
      expect(SUBSYSTEM_LABEL_ANCHOR[code]).toBeDefined();
    }
    expect(Object.keys(SUBSYSTEM_PATH).sort()).toEqual(
      [...SUBSYSTEM_DISPLAY_ORDER].sort(),
    );
  });

  it("the paths use only the commands the containment test understands", () => {
    for (const code of SUBSYSTEM_DISPLAY_ORDER) {
      expect(SUBSYSTEM_PATH[code]).toMatch(/^[ML0-9. Z-]+$/);
    }
  });

  it("the state borders are interior lines, not a fifth region", () => {
    // Open polylines: no `Z`, or the hairline would close across the map and
    // the 27 states would read as 27 filled shapes over the four regions.
    expect(STATE_BORDER_D).not.toContain("Z");
    expect(STATE_BORDER_D.length).toBeGreaterThan(5000);
    expect(STATE_BORDER_D.split("M").length - 1).toBeGreaterThan(20);
  });

  it("no two subsystems were given the same geometry", () => {
    const ds = SUBSYSTEM_DISPLAY_ORDER.map((code) => SUBSYSTEM_PATH[code]);
    expect(new Set(ds).size).toBe(4);
  });

  it("every path stays inside the viewBox", () => {
    for (const code of SUBSYSTEM_DISPLAY_ORDER) {
      for (const ring of ringsOf(SUBSYSTEM_PATH[code])) {
        for (const [x, y] of ring) {
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
          expect(x >= -0.5 && x <= BRAZIL_VIEWBOX.width + 0.5).toBe(true);
          expect(y >= -0.5 && y <= BRAZIL_VIEWBOX.height + 0.5).toBe(true);
        }
      }
    }
  });

  it("each label anchor falls inside its own region and no other", () => {
    for (const code of SUBSYSTEM_DISPLAY_ORDER) {
      const { x, y } = SUBSYSTEM_LABEL_ANCHOR[code];
      const inside = SUBSYSTEM_DISPLAY_ORDER.filter((other) =>
        contains(SUBSYSTEM_PATH[other], x, y),
      );
      expect({ code, inside }).toEqual({ code, inside: [code] });
    }
  });

  /**
   * The assertion that actually checks the grouping.
   *
   * Coordinates are the cities' own (WGS-84, to two decimals — well inside the
   * simplification error of any boundary they are near). A state moved between
   * groups changes which path its capital falls in, and nothing else here
   * would notice.
   */
  const CITIES: [string, number, number, SubsystemCode][] = [
    ["São Luís (MA)", -44.3, -2.53, "N"],
    ["Palmas (TO)", -48.33, -10.18, "N"],
    ["Boa Vista (RR)", -60.67, 2.82, "N"],
    ["Belém (PA)", -48.5, -1.46, "N"],
    ["Rio Branco (AC)", -67.81, -9.97, "SE"],
    ["Porto Velho (RO)", -63.9, -8.76, "SE"],
    ["Cuiabá (MT)", -56.1, -15.6, "SE"],
    ["Brasília (DF)", -47.88, -15.79, "SE"],
    ["São Paulo (SP)", -46.63, -23.55, "SE"],
    ["Recife (PE)", -34.88, -8.05, "NE"],
    ["Salvador (BA)", -38.5, -12.97, "NE"],
    ["Curitiba (PR)", -49.27, -25.43, "S"],
    ["Porto Alegre (RS)", -51.23, -30.03, "S"],
  ];

  for (const [name, lon, lat, expected] of CITIES) {
    it(`${name} falls in ${expected}`, () => {
      const { x, y } = projectToViewBox(lon, lat);
      const inside = SUBSYSTEM_DISPLAY_ORDER.filter((code) =>
        contains(SUBSYSTEM_PATH[code], x, y),
      );
      expect({ name, inside }).toEqual({ name, inside: [expected] });
    });
  }
});

describe("the map's wiring", () => {
  /**
   * The guard on the guards. Every structural assertion below reads
   * `OVERVIEW_FILES`, and a list that discovers its own members is only as
   * honest as the discovery: a renamed directory would make `readdirSync`
   * throw, but a directory that merely stopped holding the panels would leave
   * every one of them reading the route's two hundred lines and passing.
   */
  it("the Overview's panels are where these guards look for them", () => {
    const names = readdirSync(PANELS);
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names).toContain("forecast-panels.tsx");
    expect(names).toContain("observed-panels.tsx");
    // The props the wiring guards match on have to actually be in there, or
    // the concatenation is a longer string that says nothing more.
    expect(overviewWithoutComments()).toContain("hovered={active}");
  });

  it("the overview defines its selection once and hands it to both", () => {
    const screen = overviewWithoutComments();
    // One navigation call in the file. Two would be two selection models that
    // happen to agree today.
    expect(screen.match(/router\.push/g)?.length ?? 0).toBe(1);
    expect(screen).toContain("onSelect={select}");
    // The handler is defined once on the screen and handed down as `onSelect`
    // to the panels that draw the map and the rows, so the two affordances
    // cannot drift apart: there is one function and both call it.
    expect(screen).toContain("onPress={() => onSelect(row.subsystem)}");
  });

  it("the map renders one region per subsystem, from the shared order", () => {
    const map = mapSource();
    // Not four literals: the list the rest of the app iterates.
    expect(map).toContain("SUBSYSTEM_DISPLAY_ORDER.map");
    expect(map).not.toMatch(/\["N", "NE", "SE", "S"\]/);
  });

  it("the geometry's publisher is credited on the figure, not only in a comment", () => {
    // IBGE's mesh is open data, and open data still has a publisher. The
    // credit is rendered, so it survives a reader who never opens the source.
    expect(mapSource()).toContain("copy.app.overview.map.source");
    for (const dict of [PT, EN]) {
      expect(dict.app.overview.map.source).toContain("IBGE");
    }
  });

  it("the map colours regions with the risk palette, not its own", () => {
    const map = mapSource();
    expect(map).toContain('from "@/components/charts/risk-class"');
    expect(map).toContain("riskColor(colors, klass)");
    // No raw hex anywhere: every colour comes from the palette.
    expect(map).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("a region is focusable, activates on Enter and Space, and rings", () => {
    const map = mapSource();
    expect(map).toContain("tabIndex: 0");
    expect(map).toContain('event.key === "Enter"');
    expect(map).toContain('event.key === " "');
    // The ring is the path's own stroke, not a CSS outline — forecaster's
    // map shipped with `focusRing(...)` here, and a CSS outline on an SVG
    // element is drawn around its *bounding box*: focusing SE/CO painted a
    // rectangle spanning half the country instead of tracing the region.
    expect(map).not.toContain("focusRing(");
    expect(map).toContain('outlineStyle: "none"');
    expect(map).toContain("isFocused ? colors.focus");
    expect(map).toContain("strokeWidth={isFocused || isSelected ? 3.5 : 1.5}");
    // Native gets the RN affordance rather than the DOM one.
    expect(map).toContain("onPress: () => onSelect(code)");
    expect(map).toContain("accessibilityRole");
  });

  it("motion is asked about before it is applied", () => {
    const map = mapSource();
    expect(map).toContain("useReducedMotion()");
    expect(map).toContain("reduced ? {} : webTransition(");
  });
});

describe("the map's labels", () => {
  it("both locales carry every map string, and they differ", () => {
    for (const dict of [PT, EN]) {
      for (const key of [
        "title",
        "subtitle",
        "figure",
        "region",
        "boundaryNote",
        "source",
      ] as const) {
        expect(dict.app.overview.map[key].trim().length).toBeGreaterThan(0);
      }
    }
    expect(PT.app.overview.map.figure).not.toBe(EN.app.overview.map.figure);
    expect(PT.app.overview.map.boundaryNote).not.toBe(EN.app.overview.map.boundaryNote);
  });

  it("the region label resolves with nothing left unfilled, in both", () => {
    for (const dict of [PT, EN]) {
      for (const code of SUBSYSTEM_DISPLAY_ORDER) {
        for (const klass of ["low", "elevated", "high"] as const) {
          const label = fill(dict.app.overview.map.region, {
            subsystem: code,
            risk: dict.app.risk[klass],
            probability: "45%",
          });
          expect(label).not.toContain("{");
          expect(label).toContain(dict.app.risk[klass]);
        }
      }
    }
  });

  it("the boundary note names the states it exists to explain", () => {
    // The note is the answer to "why is the north-east corner blue?". A note
    // that has stopped naming Maranhão has stopped answering it.
    for (const dict of [PT, EN]) {
      expect(dict.app.overview.map.boundaryNote).toContain("Maranhão");
      expect(dict.app.overview.map.boundaryNote).toContain("Goiás");
      // Acre and Rondônia are the other pair that is not where the geography
      // says; the note is the only place the screen explains them.
      expect(dict.app.overview.map.boundaryNote).toContain("Acre");
      expect(dict.app.overview.map.boundaryNote).toContain("Rond");
    }
  });
});

describe("the map is legible without colour", () => {
  it("each region prints its own short code and the three-step glyph", () => {
    const map = mapSource();
    // `risk-class.tsx` argues that hue alone fails colour-vision-deficient
    // readers. The same argument binds the map: the class has to be readable
    // with the fills removed.
    expect(map).toContain("meta.short");
    expect(map).toContain("<Steps");
    expect(map).toMatch(/low: 1, elevated: 2, high: 3/);
  });
});

/**
 * Every federal unit named in the four groups is a real one. The type already
 * rejects a misspelling, so this only catches the case the type cannot: a unit
 * code that is valid and simply is not Brazil's — which is what a
 * copy-and-adapt from another country's map would leave behind.
 */
it("the 27 codes are Brazil's", () => {
  const CANON: FederalUnit[] = [
    "AC",
    "AL",
    "AM",
    "AP",
    "BA",
    "CE",
    "DF",
    "ES",
    "GO",
    "MA",
    "MG",
    "MS",
    "MT",
    "PA",
    "PB",
    "PE",
    "PI",
    "PR",
    "RJ",
    "RN",
    "RO",
    "RR",
    "RS",
    "SC",
    "SE",
    "SP",
    "TO",
  ];
  expect([...FEDERAL_UNITS].sort()).toEqual([...CANON].sort());
});

describe("the regions are drawn, not turned into buttons", () => {
  /**
   * The bug this shipped with, as a guard.
   *
   * `react-native-svg` renders `Path` through react-native-web's
   * `createElement`, and `propsToAccessibilityComponent` maps
   * `role`/`accessibilityRole` onto the *host element*. `role: "button"`
   * therefore produced a real `<button>` carrying `d`, `fill` and `stroke` as
   * unknown attributes — and a `<button>` draws no geometry. All four regions
   * vanished, leaving only the non-interactive interior-borders path: a map
   * that was uniformly dark grey and had nothing to click.
   *
   * Source-level, because the defect is in what is *passed*, not in what the
   * component computes: a render test would need the whole RNW host layer to
   * reproduce it, and the export assertion below covers the rendered side.
   */
  // Both files: the interaction policy these guards are about lives in
  // `region-handlers.ts` now. See `REGION_HANDLERS` above.
  const raw = [MAP, REGION_HANDLERS].map((path) => readFileSync(path, "utf8")).join("\n");
  /*
    Comments stripped first. The guard is about what the component *passes*,
    and the fix's own comment necessarily quotes the string being banned — so a
    guard over the raw file would fail on the explanation of why it exists.
  */
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  /*
    Only the *web* branch. `accessibilityRole` is correct on native, where there
    is no DOM host element to be replaced — so a blanket ban would be wrong, and
    would contradict the third case below.
  */
  const webBranch = stripped.slice(
    stripped.indexOf('Platform.OS === "web"'),
    stripped.indexOf("onPress: () => onSelect(code)"),
  );

  it("the web branch passes no role to the region path", () => {
    expect(webBranch.length).toBeGreaterThan(200); // the slice found both ends
    expect(webBranch).not.toMatch(/\brole:\s*["']button["']/);
    expect(webBranch).not.toMatch(/accessibilityRole:/);
  });

  it("still makes the region focusable and announced", () => {
    // The accessibility has to survive the fix, or the guard above would be
    // satisfied by deleting it.
    expect(stripped).toContain("tabIndex: 0");
    expect(stripped).toContain('"aria-label": label');
    // The *binding*, not one spelling of it. This read `isSelected` while the
    // handlers were inline in the component and that local was in scope; they
    // are a function of their own now and compare against the prop. A guard
    // pinned to the old identifier would have failed on a move that changed
    // nothing about what the attribute says.
    expect(stripped).toMatch(/"aria-pressed":\s*(isSelected|code === selected)/);
  });

  it("keeps the native branch on accessibilityRole, which is correct there", () => {
    // `onPress` + `accessibilityRole` is right on native, where there is no DOM
    // host element to be replaced. Only the web branch had the defect.
    expect(stripped).toContain('accessibilityRole: "button"');
  });
});

describe("the region responds to a pointer, and so does its row", () => {
  // Both files: the interaction policy these guards are about lives in
  // `region-handlers.ts` now. See `REGION_HANDLERS` above.
  const raw = [MAP, REGION_HANDLERS].map((path) => readFileSync(path, "utf8")).join("\n");
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const overview = overviewSource();

  /**
   * `onClick` alone did not fire. It was attached — the rendered path carries
   * it in `__reactProps$` — but react-native-web's press responder consumes the
   * event before React's own handler runs, so a click on a region did nothing
   * while `onMouseEnter` on the same element worked. Measured in a browser
   * against the deployed build: hover moved `fill-opacity` 0.5 → 0.72 and the
   * click left the URL unchanged. `onPress` is react-native-svg's own and does
   * fire; both are kept, because `onClick` is what a keyboard-less DOM test and
   * an `Enter` key press go through.
   */
  it("the region has onPress, not only onClick", () => {
    expect(stripped).toContain("onPress: () => onSelect(code)");
    // Read as "the `onClick` body selects" rather than matched literally: the
    // handler grew a line when arrow keys arrived (it clears a pending
    // keyboard-focus request, because a pointer does not want focus moved for
    // it), and a guard that pins the exact arrow function would have failed on
    // a change that leaves the property it is about untouched.
    const onClick = stripped.slice(
      stripped.indexOf("onClick:"),
      stripped.indexOf("onPress:"),
    );
    expect(onClick.length).toBeGreaterThan(10);
    expect(onClick).toContain("onSelect(code)");
  });

  /**
   * Hover had two ends and now has three. Held inside the map it could only
   * ever light the region; lifted to the overview it lights the row as well,
   * and hovering the row lights the region. The third end is the voice agent's
   * `highlight` tool, which lights both — `docs/plans/voice-copilot.md` §3.1
   * asked for exactly that and called it *"a one-line change to who can call
   * `setHovered`, and no new highlight mechanism at all"*.
   *
   * So the prop the children read is `active` — the pointer's hover where there
   * is one, the agent's emphasis otherwise — and the two children must read the
   * **same** one. A map wired to `active` and a row still wired to `hovered`
   * would light the region and not its row, which is precisely the defect
   * lifting the state was supposed to have ended.
   */
  it("hover is owned by the overview, not by either child", () => {
    expect(overview).toContain("const [hovered, setHovered]");
    expect(overview).toContain("const active = hovered ?? spoken");
    expect(overview).toContain("hovered={active}");
    expect(overview).toContain("onHoverChange={setHovered}");
    expect(overview).toContain("highlighted={row.subsystem === active}");
    // Non-vacuity: if the map kept its own *hover* state the prop would be
    // unused and the row would never light. The map does hold one piece of
    // state — which region the keyboard is on — and that is deliberately not
    // hover: see the focus test above. So the guard names the thing it forbids
    // rather than forbidding `useState` outright, which would have blocked the
    // fix that separated the two.
    expect(stripped).not.toMatch(/const \[hovered/);
    expect(stripped).not.toMatch(/setHovered/);
    expect(stripped).toContain("const active = hovered");
    expect(stripped).toContain("const [focusedCode, setFocusedCode]");
  });

  /**
   * Selecting and navigating are two actions, and a click makes the first one.
   *
   * The defect: `select` *was* the `router.push`, so a click on a region or a
   * row carried two plausible meanings — show me this region here, and go
   * explain this region — and silently did the second. The four panels below
   * the map could then only be re-pointed from the menu at the top, and a
   * reader clicking a region to change them was taken off the screen.
   *
   * `e2e/app-overview-selection.spec.ts` asserts the behaviour in a browser.
   * This is the cheap version that fails in 300 ms rather than after an export,
   * and it names the shape rather than the outcome: one handler that writes the
   * URL, one that pushes a route, and the map and the rows wired to the first.
   *
   * `docs/plans/voice-copilot.md` §3.1 drew this same line for the agent —
   * `highlight` never navigates, `explain` does — so after this the pointer and
   * the voice mean the same thing by picking a region.
   */
  it("a click selects, and only a named control navigates", () => {
    const code = overview.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain(
      "const select = (subsystem: SubsystemCode) => params.setParams({ subsystem });",
    );
    // Non-vacuity: `select` writing the URL is only half the claim. The other
    // half is that nothing in the click path pushes a route, which is what the
    // defect did — so the one `router.push` on this screen has to be reachable
    // from `explain` and from nowhere else.
    expect(code.match(/router\.push/g) ?? []).toHaveLength(1);
    const explain = code.slice(
      code.indexOf("const explain ="),
      code.indexOf("const frame ="),
    );
    expect(explain).toContain("router.push");
    expect(explain).toContain('pathname: "/app/explain"');
    // And both affordances are wired to the selector, not to the navigator.
    expect(code).toContain("onSelect={onSelect}");
    expect(code).toContain("onPress={() => onSelect(row.subsystem)}");
    expect(code).toContain("onExplain={() => onExplain(row.subsystem)}");
  });

  /**
   * The selection has to be visible where the reader is, or a click that
   * re-points four panels below the fold produces nothing they can see.
   */
  it("the pick is confirmed in place, and in both of the screen's states", () => {
    const code = overview.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // Twice: under the map in the `read` state, and at screen level when the
    // forecast refused and there is no map to sit under.
    expect(code.match(/<SelectedRegion/g) ?? []).toHaveLength(2);
    expect(code).toContain("row={null}");
    // The settled rows are a selector too, which is the only one the refusal
    // path has. They used to mark the selection and refuse to take one.
    expect(code).toContain("onPress={() => onSelect(row.subsystem)}");
    // And every panel that the selection re-points names the subsystem, or the
    // change has nothing on screen to attribute it to.
    for (const named of [
      "copy.app.split.subtitle",
      "copy.app.overview.dailyEnergy",
      "copy.app.overview.peakPower",
    ]) {
      const at = code.indexOf(named);
      expect({ named, present: at >= 0 }).toEqual({ named, present: true });
      expect(code.slice(at, at + 120)).toContain("subsystem: meta.onsDisplayName");
    }
  });

  /**
   * Arrow keys move the selection, and focus has to go with them.
   *
   * The focus move is deliberately not a call in the key handler: writing the
   * selection remounts this subtree, more than once, so the element the reader
   * was on is detached and the browser drops focus to the document. The request
   * is parked at module scope and re-asserted on every commit until it lands.
   */
  it("the arrow keys walk the selection, with the focus following", () => {
    expect(stripped).toContain("const ARROW_STEP");
    expect(stripped).toContain("const at = order.indexOf(selected)");
    expect(stripped).toContain("pendingArrowFocus = next");
    expect(stripped).toContain("let pendingArrowFocus");
    // The ring wraps, or the first and last regions are dead ends.
    expect(stripped).toContain("(at + step + order.length) % order.length");
    // The indicator stays geometry. A CSS outline on an SVG element is drawn
    // around its bounding box — the bug that painted a rectangle across half
    // the country — and arrow keys make focus far more reachable than before.
    expect(stripped).not.toContain("focusRing(");
    expect(stripped).toContain('outlineStyle: "none"');
    // The keyboard affordance is written down where a reader can find it.
    expect(stripped).toContain("copy.app.overview.map.keyboardNote");
  });
});

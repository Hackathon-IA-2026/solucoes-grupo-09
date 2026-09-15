import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
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

function source(path: string): string {
  return readFileSync(path, "utf8");
}

/** The file with comments blanked, as `replay-screen.test.ts` does it. */
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
  it("the overview defines its selection once and hands it to both", () => {
    const screen = sourceWithoutComments(SCREEN);
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
    const map = sourceWithoutComments(MAP);
    // Not four literals: the list the rest of the app iterates.
    expect(map).toContain("SUBSYSTEM_DISPLAY_ORDER.map");
    expect(map).not.toMatch(/\["N", "NE", "SE", "S"\]/);
  });

  it("the geometry's publisher is credited on the figure, not only in a comment", () => {
    // IBGE's mesh is open data, and open data still has a publisher. The
    // credit is rendered, so it survives a reader who never opens the source.
    expect(sourceWithoutComments(MAP)).toContain("copy.app.overview.map.source");
    for (const dict of [PT, EN]) {
      expect(dict.app.overview.map.source).toContain("IBGE");
    }
  });

  it("the map colours regions with the risk palette, not its own", () => {
    const map = sourceWithoutComments(MAP);
    expect(map).toContain('from "@/components/charts/risk-class"');
    expect(map).toContain("riskColor(colors, klass)");
    // No raw hex anywhere: every colour comes from the palette.
    expect(map).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("a region is focusable, activates on Enter and Space, and rings", () => {
    const map = sourceWithoutComments(MAP);
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
    const map = sourceWithoutComments(MAP);
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
    const map = sourceWithoutComments(MAP);
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
  const raw = readFileSync(
    join(import.meta.dir, "..", "src/components/charts/subsystem-map.tsx"),
    "utf8",
  );
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
    expect(stripped).toContain('"aria-pressed": isSelected');
  });

  it("keeps the native branch on accessibilityRole, which is correct there", () => {
    // `onPress` + `accessibilityRole` is right on native, where there is no DOM
    // host element to be replaced. Only the web branch had the defect.
    expect(stripped).toContain('accessibilityRole: "button"');
  });
});

describe("the region responds to a pointer, and so does its row", () => {
  const raw = readFileSync(
    join(import.meta.dir, "..", "src/components/charts/subsystem-map.tsx"),
    "utf8",
  );
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const overview = readFileSync(
    join(import.meta.dir, "..", "src/app/app/index.tsx"),
    "utf8",
  );

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
    expect(stripped).toContain("onClick: () => onSelect(code)");
  });

  /**
   * Hover has two ends. Held inside the map it could only ever light the
   * region; lifted to the overview it lights the row as well, and hovering the
   * row lights the region.
   */
  it("hover is owned by the overview, not by either child", () => {
    expect(overview).toContain("const [hovered, setHovered]");
    expect(overview).toContain("hovered={hovered}");
    expect(overview).toContain("onHoverChange={setHovered}");
    expect(overview).toContain("highlighted={row.subsystem === hovered}");
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
});

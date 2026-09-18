import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The tokens module directly, not the package entry: `@wattsteer/ui`'s index
// pulls in `react-native`, which this suite does not run. `tokens.ts` is plain
// TypeScript and is the module `usePalette` itself resolves to.
import { dark } from "../../../packages/ui/src/tokens";
import { LEGEND_STOPS, mix, observedFill } from "../src/components/charts/observed-scale";
import { riskColor } from "../src/components/charts/risk-color";
import { en } from "../src/i18n/copy.en";
import { pt } from "../src/i18n/copy.pt";
import {
  observedDay,
  observedHours,
  observedRows,
  observedSplit,
} from "../src/lib/network";

/**
 * The Overview in the state the product is actually in: **nothing promoted**.
 *
 * Every panel on that screen now shows the most it can honestly show from
 * settled data — the map, the four rows, the 24-hour profile, the wind/solar
 * split and the two day figures — where it previously showed a sentence saying
 * it could show nothing. That is a large gain and it buys one large risk, which
 * is the whole subject of this file:
 *
 * > **an observation rendered where a forecast was, in a way a reader takes for
 * > a forecast.**
 *
 * The guards are therefore of three kinds, and none of them is "it rendered":
 *
 *  1. **Palette disjointness.** No colour the observed ramp can produce, at any
 *     share, is a colour the risk palette can produce. This is the one that
 *     cannot be argued with: it holds over the whole domain rather than at the
 *     four values some fixture happens to carry.
 *  2. **Vocabulary separation.** No label in the observed dictionary claims a
 *     forecast, and no component in the observed stack can express one — they
 *     do not import the forecast vocabulary and do not read a quantile.
 *  3. **The arithmetic is the arithmetic of measurements.** Sums over settled
 *     hours, a largest hour that is `null` rather than zero on an empty day, and
 *     a civil-day cut that matches the profile beside it.
 *
 * `e2e/app-observed-overview.spec.ts` asserts the same separation from the other
 * end, in a browser, against a real export in both states.
 */

const SRC = join(import.meta.dir, "..", "src");
const colors = dark;

function source(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8");
}

/** Source with comments blanked — a claim in prose is not a claim in code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/** The body of one exported function, to the next one or to the end. */
function functionBody(text: string, name: string): string {
  const from = text.indexOf(`export function ${name}(`);
  expect({ name, found: from >= 0 }).toEqual({ name, found: true });
  const rest = text.slice(from + 1);
  const next = rest.indexOf("\nexport function ");
  return next < 0 ? rest : rest.slice(0, next);
}

describe("the observed ramp and the risk palette cannot be confused", () => {
  /**
   * `riskColor`'s three pairs — **called, not transcribed.**
   *
   * This used to be a hand-written list of six palette tokens, kept honest by a
   * second test that grepped `risk-class.tsx` for those same six names. The
   * reason was real: that file is a `.tsx` and pulls in `react-native`, which
   * this suite does not run, so the function could not be imported and the
   * duplicate list was the least-bad substitute.
   *
   * `riskColor` now lives in `risk-color.ts`, which imports two types and
   * nothing else, so the substitute is gone and so is the test that policed it.
   * The colours below are the colours the app paints, by construction — a
   * retuned palette moves this list on the same commit, with nothing to drift.
   */
  const RISK_COLOURS = (["low", "elevated", "high"] as const).flatMap((klass) => {
    const pair = riskColor(colors, klass);
    return [pair.fg, pair.bg];
  });

  it("the three classes resolve to six distinct colours", () => {
    // Non-vacuity for every assertion below: a `riskColor` that returned one
    // colour six times would make the collision check trivially satisfiable
    // against a single hue, and an all-`undefined` return would make it pass
    // against nothing at all.
    expect(new Set(RISK_COLOURS).size).toBe(6);
    // Hex or `rgba()` — the three `fg` hues are hex and the three `bg` tints
    // are the same hue at 15 %, which the palette expresses as `rgba`. The
    // assertion is that each is a colour at all, not that it is one notation:
    // the `bg` tints being `rgba` is precisely why the collision check below
    // can never trip on them, and pinning the notation would turn a change of
    // representation into a failure about nothing.
    for (const value of RISK_COLOURS) {
      expect(value).toMatch(/^(#[0-9a-fA-F]{6}|rgba?\([\d\s.,]+\))$/);
    }
  });

  /**
   * The guard the whole design rests on.
   *
   * Sampled at every whole percent of the domain rather than at the four shares
   * a fixture happens to produce: the failure being prevented is somebody
   * retuning one palette towards the other, which would show up at some shares
   * long before all of them.
   */
  it("no observed fill is a risk colour, at any share", () => {
    const collisions: string[] = [];
    for (let step = 0; step <= 100; step++) {
      const painted = observedFill(step / 100, colors).toLowerCase();
      for (const risk of RISK_COLOURS) {
        if (painted === risk.toLowerCase()) {
          collisions.push(`${step}% → ${painted}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it("the ramp is ordered, so a darker region is a larger settled figure", () => {
    const blues = LEGEND_STOPS.map((stop) =>
      Number.parseInt(observedFill(stop, colors).slice(5, 7), 16),
    );
    // `info` is cyan, so the blue channel rises monotonically with the share.
    for (let i = 1; i < blues.length; i++) {
      expect({ i, rises: blues[i] > blues[i - 1] }).toEqual({ i, rises: true });
    }
  });

  it("the ramp never reaches the land colour, so zero still reads as painted", () => {
    expect(observedFill(0, colors)).not.toBe(colors.surfaceSunken);
    expect(observedFill(0, colors)).not.toBe(colors.canvas);
  });

  it("`mix` clamps rather than extrapolating past either end", () => {
    expect(mix("#000000", "#ffffff", -1)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 2)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});

describe("no observed label claims a forecast", () => {
  /**
   * The keys that *name* a figure, as against the ones that explain an absence.
   *
   * The footnotes are deliberately exempt and that is not a loophole: their
   * entire job is to say the interval is missing and why, so they must be
   * allowed to write "P10–P90" and "forecast". A label is what a reader takes
   * the number to be; a footnote is what the screen says about it.
   */
  const LABELS = (dict: typeof en) => ({
    "observed.badge": dict.app.observed.badge,
    "observed.stamp": dict.app.observed.stamp,
    "observed.window24h": dict.app.observed.window24h,
    "observed.windowDay": dict.app.observed.windowDay,
    "observed.rowEnergy": dict.app.observed.rowEnergy,
    "observed.selectedFigure": dict.app.observed.selectedFigure,
    "observed.dayTotal": dict.app.observed.dayTotal,
    "observed.peakHour": dict.app.observed.peakHour,
    "observed.peakHourWindow": dict.app.observed.peakHourWindow,
    "observed.splitTitle": dict.app.observed.splitTitle,
    "observed.splitSubtitle": dict.app.observed.splitSubtitle,
    "observed.splitTotal": dict.app.observed.splitTotal,
    "observed.q1": dict.app.observed.q1,
    "observed.q1Yes": dict.app.observed.q1Yes,
    "observed.q1No": dict.app.observed.q1No,
    "observed.q1DetailNational": dict.app.observed.q1DetailNational,
    "observed.q1DetailRegion": dict.app.observed.q1DetailRegion,
    "observed.q2DetailNational": dict.app.observed.q2DetailNational,
    "observed.q2DetailRegion": dict.app.observed.q2DetailRegion,
    "observed.q3Detail": dict.app.observed.q3Detail,
    "observed.q3None": dict.app.observed.q3None,
    "observed.q3NoneDetail": dict.app.observed.q3NoneDetail,
    "observed.q5None": dict.app.observed.q5None,
    "observed.q5DetailNone": dict.app.observed.q5DetailNone,
    "observed.q5DetailOne": dict.app.observed.q5DetailOne,
    "observed.q5DetailMany": dict.app.observed.q5DetailMany,
    "map.subtitleObserved": dict.app.overview.map.subtitleObserved,
    "map.figureObserved": dict.app.overview.map.figureObserved,
    "map.regionObserved": dict.app.overview.map.regionObserved,
  });

  /** Words that would make a settled figure read as a model's output. */
  const FORECAST_WORDS: Record<"pt" | "en", string[]> = {
    pt: ["previs", "risco", "amanhã", "p10", "p50", "p90", "esperad"],
    en: ["forecast", "risk", "tomorrow", "p10", "p50", "p90", "expected"],
  };

  for (const [locale, dict] of [
    ["pt", pt as unknown as typeof en],
    ["en", en],
  ] as const) {
    it(`${locale}: no observed label uses the forecast vocabulary`, () => {
      const offences: string[] = [];
      for (const [key, value] of Object.entries(LABELS(dict))) {
        for (const word of FORECAST_WORDS[locale]) {
          if (value.toLowerCase().includes(word)) {
            offences.push(`${key}: ${word}`);
          }
        }
      }
      expect(offences).toEqual([]);
    });

    it(`${locale}: the labels that head a figure say it is settled`, () => {
      // Without this, the check above passes against a label that says nothing
      // at all — which is the other way to mislead a reader.
      const marker = locale === "pt" ? ["liquid", "observ"] : ["settl", "observ"];
      const headings = [
        dict.app.observed.badge,
        dict.app.observed.stamp,
        dict.app.observed.windowDay,
        dict.app.observed.selectedFigure,
        dict.app.observed.dayTotal,
        dict.app.observed.peakHour,
        dict.app.observed.splitSubtitle,
        dict.app.observed.splitTotal,
        dict.app.observed.q1DetailNational,
        dict.app.observed.q1DetailRegion,
        dict.app.observed.q2DetailNational,
        dict.app.observed.q2DetailRegion,
        dict.app.observed.q3Detail,
        dict.app.observed.q3NoneDetail,
        dict.app.observed.q5DetailNone,
        dict.app.observed.q5DetailOne,
        dict.app.observed.q5DetailMany,
        dict.app.overview.map.subtitleObserved,
        dict.app.overview.map.figureObserved,
        dict.app.overview.map.regionObserved,
      ];
      const silent = headings.filter(
        (value) => !marker.some((word) => value.toLowerCase().includes(word)),
      );
      expect(silent).toEqual([]);
    });
  }

  it("the absence note no longer says the map and the totals are missing", () => {
    // They are not missing any more — they are drawn from settled data — and a
    // note that says otherwise is the screen contradicting itself on the same
    // screenful. The sentence it was replaced with is asserted by shape: it
    // still names what *is* absent, which is the model's interval.
    for (const dict of [pt as unknown as typeof en, en]) {
      expect(dict.app.overview.absentNote.toLowerCase()).toContain("p10");
    }
    expect(pt.app.overview.absentNote).not.toContain("O mapa, as classes de risco");
    expect(en.app.overview.absentNote).not.toContain("The map, the risk classes");
  });
});

describe("the observed components cannot express a forecast", () => {
  /**
   * Each observed component sits in the same file as its forecast sibling, on
   * purpose — the two are read together and a reviewer should see both — so the
   * guard is over the function body rather than the file.
   *
   * Non-vacuity: adding `<RiskChip` to `ObservedSubsystemRow`, or `band.p50` to
   * `ObservedCard`, fails this. Both were reintroduced once to check it.
   */
  const OBSERVED_COMPONENTS: [string[], string][] = [
    [["components", "app", "subsystem-row.tsx"], "ObservedSubsystemRow"],
    [["components", "charts", "observed-profile.tsx"], "ObservedCard"],
    [["components", "charts", "observed-profile.tsx"], "ObservedEmptyCard"],
    [["components", "charts", "technology-split.tsx"], "ObservedSplitPanel"],
  ];

  const FORECAST_TOKENS = [
    "RiskChip",
    "RiskSteps",
    "riskColor",
    "BandStrip",
    "BandFigure",
    "FanChart",
    ".p10",
    ".p50",
    ".p90",
    "occurrenceProbability",
    "riskClass",
  ];

  for (const [parts, name] of OBSERVED_COMPONENTS) {
    it(`${name} reads no forecast quantity`, () => {
      const body = functionBody(code(source(...parts)), name);
      const found = FORECAST_TOKENS.filter((token) => body.includes(token));
      expect(found).toEqual([]);
    });

    it(`${name} says it is observed`, () => {
      const body = functionBody(code(source(...parts)), name);
      const marked =
        body.includes("<ObservedBadge />") || body.includes("copy.app.observed.");
      expect({ name, marked }).toEqual({ name, marked: true });
    });
  }
});

describe("the map speaks two languages and keeps them apart", () => {
  /*
  The map *and* its interaction policy. `subsystem-map.tsx` was decomposed and
  the platform branch — which is where both of the lines below live — moved to
  `region-handlers.ts`. A guard reading only the component would have gone
  quiet: `not.toContain("focusRing(")` is satisfied by a file that no longer
  contains the code it is about.
*/
  const MAP = [
    code(source("components", "charts", "subsystem-map.tsx")),
    code(source("components", "charts", "region-handlers.ts")),
    code(source("components", "charts", "region-paint.tsx")),
  ].join("\n");

  it("the paint is a discriminated union, not a nullable row", () => {
    expect(MAP).toContain(
      '{ readonly kind: "forecast"; readonly rows: readonly OutlookRow[] }',
    );
    expect(MAP).toContain(
      '{ readonly kind: "observed"; readonly rows: readonly ObservedRow[] }',
    );
    expect(MAP).toContain('paint.kind === "forecast"');
  });

  it("each mode has its own fill, its own glyph and its own spoken label", () => {
    // The forecast side is unchanged and still reads the wire's class.
    expect(MAP).toContain("riskColor(colors, klass)");
    expect(MAP).toContain("copy.app.overview.map.region,");
    expect(MAP).toContain("<Steps");
    // The observed side paints from the ramp and prints the figure itself.
    expect(MAP).toContain("observedFill(share, colors)");
    expect(MAP).toContain("copy.app.overview.map.regionObserved,");
    expect(MAP).toContain("f.compact(row.last24hMwh)");
    // And the figure's own accessible name differs by mode, so the two maps are
    // distinguishable with the screen turned off.
    expect(MAP).toContain("copy.app.overview.map.figureObserved");
  });

  it("the legend is drawn for the continuous scale only", () => {
    // The *property*, not one spelling of it. This pinned the inline ternary
    // `{paint.kind === "observed" ? (`; `MapLegend` is its own component now
    // and says the same thing as an early return, which the ternary match
    // would have failed on while nothing about the behaviour moved.
    expect(MAP).toMatch(/paint\.kind !== "observed"|paint\.kind === "observed" \? \(/);
    expect(MAP).toContain("LEGEND_STOPS.map");
    // And it is still conditional at all — a legend drawn on the forecast half
    // would be a key to a scale that is not there.
    expect(MAP).toContain("return null;");
  });

  it("the focus indicator is still geometry, in both modes", () => {
    // A CSS outline on an SVG element is drawn round its bounding box — the bug
    // that once painted a rectangle across half the country.
    expect(MAP).not.toContain("focusRing(");
    expect(MAP).toContain('outlineStyle: "none"');
  });
});

describe("the observed derivations are measurements, not estimates", () => {
  const hour = (hourLocal: number, mwh: number) => ({
    validTime: new Date(Date.parse("2026-09-14T00:00:00Z") + (hourLocal + 3) * 3_600_000)
      .toISOString()
      .slice(0, 19)
      .concat("Z"),
    hourLocal,
    constrainedOffMwh: mwh,
  });

  it("the day total is the settled hours added, exactly", () => {
    const day = observedDay([hour(1, 10.5), hour(2, 4.25), hour(3, 0)]);
    expect(day.totalMwh).toBeCloseTo(14.75, 10);
  });

  it("an empty day has no largest hour, rather than a zero one", () => {
    expect(observedDay([]).peakHour).toBeNull();
    expect(observedDay([]).totalMwh).toBe(0);
    // A day that settled at zero *does* have hours, and therefore has a peak.
    expect(observedDay([hour(4, 0)]).peakHour?.hourLocal).toBe(4);
  });

  it("the largest hour is the largest, not the last", () => {
    const day = observedDay([hour(1, 4), hour(2, 90), hour(3, 12)]);
    expect(day.peakHour?.hourLocal).toBe(2);
    expect(day.peakHour?.constrainedOffMwh).toBe(90);
  });

  const wire = {
    subsystem: "NE",
    technology: null,
    from: "2026-09-14T00:00:00Z",
    to: "2026-09-16T00:00:00Z",
    asOf: "2026-09-15T09:00:00Z",
    dataVersion: "ons-2026-09-15T09:00Z",
    vintageFidelity: "point_in_time",
    nextCursor: null,
    rows: [
      // Inside the Brasília civil day 2026-09-14 (03:00Z … 02:59Z next day).
      {
        subsystem: "NE",
        technology: "WIND",
        validTime: "2026-09-14T06:00:00Z",
        hourLocal: 3,
        constrainedOffMwh: 40,
      },
      {
        subsystem: "NE",
        technology: "SOLAR",
        validTime: "2026-09-14T06:00:00Z",
        hourLocal: 3,
        constrainedOffMwh: 10,
      },
      {
        subsystem: "NE",
        technology: "SOLAR",
        validTime: "2026-09-15T01:00:00Z",
        hourLocal: 22,
        constrainedOffMwh: 5,
      },
      // The hour before the civil day starts — a different day's row.
      {
        subsystem: "NE",
        technology: "WIND",
        validTime: "2026-09-14T02:00:00Z",
        hourLocal: 23,
        constrainedOffMwh: 999,
      },
    ],
  } as unknown as Parameters<typeof observedSplit>[0];

  it("the split is cut to the same civil day the profile draws", () => {
    // The 999 MWh row belongs to the previous civil day and must not appear in
    // either — this is the cut `observedHours` makes, applied to the split so
    // the two panels beside each other cover the same hours.
    expect(observedSplit(wire, "2026-09-14")).toEqual({ windMwh: 40, solarMwh: 15 });
    const hours = observedHours(wire, "2026-09-14");
    expect(hours.map((each) => each.constrainedOffMwh)).toEqual([50, 5]);
    expect(observedDay(hours).totalMwh).toBe(55);
    // And the split adds to the same total the profile does, or the two panels
    // would be describing different days under one date.
    const split = observedSplit(wire, "2026-09-14");
    expect(split.windMwh + split.solarMwh).toBe(observedDay(hours).totalMwh);
  });

  it("the four observed rows come back in the product's display order", () => {
    const subsystems = [
      {
        subsystem: "S",
        onsDisplayName: "SUL",
        last24hConstrainedOffMwh: 96.2,
        latestHourConstrainedOffMwh: 3.4,
        split: { windMwh: 88.7, solarMwh: 7.5 },
      },
      {
        subsystem: "NE",
        onsDisplayName: "NORDESTE",
        last24hConstrainedOffMwh: 1842.6,
        latestHourConstrainedOffMwh: 74.2,
        split: { windMwh: 1188.4, solarMwh: 654.2 },
      },
    ] as unknown as Parameters<typeof observedRows>[0];
    const rows = observedRows(subsystems, ["N", "NE", "SE", "S"]);
    // Absent subsystems are dropped rather than padded with a zero.
    expect(rows.map((row) => row.subsystem)).toEqual(["NE", "S"]);
    expect(rows[0].last24hMwh).toBe(1842.6);
  });
});

describe("`Observado` marks a contrast, and only where there is one", () => {
  /*
    The badge's gate used to be `anyLaneServing` — a global fact. The day a lane
    was promoted it flipped, and every badge returned to screens drawing nothing
    but settled data, because the date in question still had no forecast. Seven
    chips saying "observed" on a page where everything was.

    The gate is local now: the screen states whether it is drawing a forecast at
    all, and the badges under it read that. These are source-text checks in the
    style of the rest of this file — the rule is one boolean and it is worth
    holding at the two ends that have to agree.
  */
  const HONESTY = code(source("components", "app", "honesty.tsx"));
  const OVERVIEW = code(source("app", "app", "index.tsx"));

  it("the badge reads the screen's own answer first", () => {
    const body = functionBody(HONESTY, "ObservedBadge");
    expect(body).toContain("useContext(ForecastOnScreen)");
    expect(body).toContain("onScreen ??");
  });

  it("no provider is not the same as no forecast", () => {
    // `null` falls back to the serving rule. Dropping the mark off a screen
    // that *is* mixed is the failure worth avoiding, and it is the opposite of
    // the one being fixed.
    expect(HONESTY).toContain("createContext<boolean | null>(null)");
  });

  it("the overview states it from its own state", () => {
    expect(OVERVIEW).toContain("<ForecastPresence present={forecast !== null}>");
  });
});

describe("the observed screen names a cause only where `/v1/meta` proves it", () => {
  /*
    Two facts put this screen in its observed-only state, and they are owed two
    different sentences: nothing is promoted, or a promoted lane has published
    nothing for this day yet. The screens said the first one unconditionally,
    so the morning `gate_early` was promoted `/app` carried "nenhum modelo está
    promovido" above a lane `/v1/meta` reported as `promoted` and `usable` —
    measured on production, not hypothesised.

    The screen cannot tell them apart from its own refusal:
    `apps/api/src/api/forecast.ts` resolves from Postgres, has no view of the
    artifact volume, and never answers `MODEL_UNAVAILABLE`. So the cause is
    read from the one `/v1/meta` copy, and the fallback claims only what the
    refusal itself proves.
  */
  const HONESTY = code(source("components", "app", "honesty.tsx"));
  const OVERVIEW = code(source("app", "app", "index.tsx"));
  const SELECTED = code(source("components", "app", "selected-region.tsx"));

  const PROMOTION = { pt: "promovido", en: "promoted" } as const;

  it("the fallback sentence blames nothing it has not read", () => {
    expect(pt.app.overview.ledeUnpublished.toLowerCase()).not.toContain(PROMOTION.pt);
    expect(en.app.overview.ledeUnpublished.toLowerCase()).not.toContain(PROMOTION.en);
    expect(pt.app.overview.selectedUnpublished.toLowerCase()).not.toContain(PROMOTION.pt);
    expect(en.app.overview.selectedUnpublished.toLowerCase()).not.toContain(PROMOTION.en);
  });

  it("the sentence that does blame the gate is still the one for that state", () => {
    // Kept, not softened: with nothing promoted it is the more useful answer,
    // and it is the state production ran in for weeks.
    expect(pt.app.overview.ledeObserved.toLowerCase()).toContain(PROMOTION.pt);
    expect(en.app.overview.ledeObserved.toLowerCase()).toContain(PROMOTION.en);
    expect(pt.app.overview.selectedAbsent.toLowerCase()).toContain(PROMOTION.pt);
    expect(en.app.overview.selectedAbsent.toLowerCase()).toContain(PROMOTION.en);
  });

  it("an unknown lane table is not a claim that nothing is promoted", () => {
    const body = functionBody(HONESTY, "useNoModelPromoted");
    expect(body).toContain('serving.status === "known" && !serving.serving');
  });

  for (const [name, text] of [
    ["the lede", OVERVIEW],
    ["the selected region", SELECTED],
  ] as const) {
    it(`${name} reaches the promotion sentence only behind that read`, () => {
      expect(text).toContain("useNoModelPromoted()");
      // Both keys appear, and the blaming one is on the true branch of the
      // ternary — so no edit can reach it without the lane table.
      expect(text).toMatch(
        /noModelPromoted\s*\n?\s*\?\s*copy\.app\.overview\.(ledeObserved|selectedAbsent)/,
      );
    });
  }
});

describe("the five questions are answered in both states", () => {
  /*
    The row was gated on a published forecast, with a comment saying four of the
    five questions are about tomorrow. Three of them are not: how much was
    curtailed, in which hour and where are measurements, and this screen already
    draws all three in the panels below. So on every day before its gate strikes
    — every evening, and most of the day on a deployment whose gate is at 09:00
    — the page lost the five cards it is laid out around and showed a column of
    supporting panels with nothing at their head.

    `SettledQuestionRow` answers them from settled data. What must not travel
    across is the vocabulary, which is what the rest of this file is about and
    what the checks below extend to the cards.
  */
  const ROW = code(source("components", "app", "overview", "question-row.tsx"));
  const settled = ROW.slice(ROW.indexOf("export function SettledQuestionRow"));

  it("the settled cards read no forecast quantity", () => {
    for (const forbidden of [
      "riskColor",
      "riskClass",
      "dailyEnergy",
      "magnitudeBand",
      "occurrenceProbability",
      "criticalWindow",
    ]) {
      expect(settled).not.toContain(forbidden);
    }
  });

  it("the settled cards state no interval", () => {
    // The forecast row prints `P10 … · P90 …` in a footnote. A measurement has
    // no quantiles, so there is no expression here that could produce one.
    expect(settled).not.toContain("P10");
    expect(settled).not.toContain("p90");
  });

  it("the hero reaches the settled row whenever there is no forecast", () => {
    const hero = code(source("components", "app", "overview", "overview-hero.tsx"));
    expect(hero).toContain("settled !== null ? (");
    expect(hero).toContain("<SettledQuestionRow");
  });

  it("the derivation is null exactly where a forecast was published", () => {
    const figures = code(source("components", "app", "overview", "hero-figures.tsx"));
    expect(figures).toContain("forecast !== null\n      ? null");
    // The overall scope reads the national row the gateway publishes rather
    // than adding four bands, which is the rule the whole product turns on.
    expect(figures).toContain("observed.now.national.last24hConstrainedOffMwh");
  });
});

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReplayTimelineEvent } from "@wattsteer/core/api";
import { reviewGeometry } from "../src/components/charts/review-geometry";
import { en as EN } from "../src/i18n/copy.en";
import { pt as PT } from "../src/i18n/copy.pt";
import { formattersFor } from "../src/i18n/format";
import { eventLabel, signedMwh } from "../src/i18n/time-machine";
import type { CurtailmentHourForecast } from "../src/lib/fixtures";
import { signOf } from "../src/lib/time-machine";

/**
 * The Time Machine dashboard, `/app/time-machine`.
 *
 * It is a new layout over the replay, and the properties worth holding are the
 * ones a dashboard is most tempted to drop: the honesty block first, no day
 * graded with a percentage, no cause named, no issue instant drawn on the hour
 * axis, and a settled figure drawn as a different mark from a forecast one.
 *
 * Source-level where the property lives in *how* the screen is written rather
 * than in a value it returns — the same posture `replay-screen.test.ts` takes
 * for `/app/replay`, scoped to the files this screen owns.
 */

const WEB = join(import.meta.dir, "..", "src");
const read = (...parts: string[]) => readFileSync(join(WEB, ...parts), "utf8");

/** Source with comments removed, so an explanation cannot satisfy a guard. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SCREEN = code(read("app", "app", "time-machine.tsx"));
const OWNED = [
  SCREEN,
  code(read("components", "app", "time-machine", "kpi-card.tsx")),
  code(read("components", "app", "time-machine", "gate-timeline.tsx")),
  code(read("components", "app", "time-machine", "subsystem-table.tsx")),
  code(read("components", "app", "time-machine", "evidence-tabs.tsx")),
  code(read("components", "app", "time-machine", "traceability-panel.tsx")),
  code(read("components", "charts", "review-chart.tsx")),
  code(read("components", "charts", "review-geometry.ts")),
  code(read("lib", "time-machine.ts")),
  code(read("i18n", "time-machine.ts")),
].join("\n");

describe("the provenance comes first, as on /app/replay", () => {
  it("precedes every figure of the replayed day", () => {
    const replayed = SCREEN.slice(SCREEN.indexOf("const replay = state.replay;"));
    const strip = replayed.indexOf("<ProvenanceStrip");
    expect(strip).toBeGreaterThan(0);
    for (const figure of ["<Headline", "<Panel", "<ReviewChart", "<SubsystemTable"]) {
      expect(replayed.indexOf(figure)).toBeGreaterThan(strip);
    }
  });

  it("always draws both badges and the held-out mark, with no collapsed state", () => {
    const strip = code(read("components", "app", "time-machine", "provenance-strip.tsx"));
    expect(strip).toContain("<ProvenanceBadge");
    expect(strip).toContain("<VintageBadge");
    expect(strip).toContain("modelSawThisDay === false");
    // The marks are unconditional children of the strip; only the paragraphs
    // sit behind the ⓘ, and the strip itself holds no open/closed state.
    expect(strip).not.toMatch(/useState|collapsed|onPress/);
  });

  it("keeps every honesty paragraph one press away, word for word", () => {
    const strip = code(read("components", "app", "time-machine", "provenance-strip.tsx"));
    for (const call of [
      "provenanceNote(replay, copy, f)",
      "vintageNote(replay.vintageFidelity, copy, f)",
      "vintageExtent(replay.integrity, copy)",
      "copy.app.replay.claimsNote",
    ]) {
      expect(strip).toContain(call);
    }
  });
});

describe("no day is graded, and no cause is named", () => {
  it("computes no accuracy, MAPE or error percentage anywhere in the dashboard", () => {
    expect(OWNED).not.toMatch(/accuracy\s*=|mape|errorPct|percentError/i);
    // One day's deviation is the one subtraction `replay-accuracy.ts` owns.
    expect(SCREEN).toContain("forecastError(band, settled)");
    expect(OWNED).not.toMatch(/\/\s*band\.p50|\/\s*settled\b/);
  });

  it("has no probable-cause tab and no confidence score", () => {
    const tabs = read("components", "app", "time-machine", "evidence-tabs.tsx");
    expect(tabs).toContain('["drivers", "analogues", "reasons", "audit"]');
    for (const dict of [EN, PT]) {
      const labels = Object.values(dict.app.timeMachine.tabs).join(" ").toLowerCase();
      expect(labels).not.toMatch(/caus|confian|confidence|aderên|adherence/);
    }
  });

  it("never says 'accuracy' as a figure's name in either locale", () => {
    for (const dict of [EN, PT]) {
      const kpi = dict.app.timeMachine.kpi;
      for (const title of [
        kpi.forecastTitle,
        kpi.settledTitle,
        kpi.deviationTitle,
        kpi.coverageTitle,
      ]) {
        expect(title.toLowerCase()).not.toMatch(/acur|accura|mape/);
      }
    }
  });
});

describe("the gates are on the timeline, never on the hour axis", () => {
  it("the chart takes no instant", () => {
    const chart = code(read("components", "charts", "review-chart.tsx"));
    expect(chart).not.toMatch(/publishedAt|gateProfile|events/);
  });

  it("says there is no intraday revision, in both locales", () => {
    expect(EN.app.timeMachine.timeline.noIntraday).toContain("no intraday");
    expect(PT.app.timeMachine.timeline.noIntraday).toContain("intradiária");
  });
});

// --- the chart's geometry ---------------------------------------------------------

const hour = (hourLocal: number, p50: number): CurtailmentHourForecast => ({
  validTime: `2025-11-12T${String(hourLocal + 3).padStart(2, "0")}:00:00.000Z`,
  hourLocal,
  constrainedOff: { p10: p50 / 2, p50, p90: p50 * 2 },
  expectedMwh: p50,
  occurrenceProbability: p50 > 0 ? 0.8 : 0.1,
});

const HOURS = Array.from({ length: 24 }, (_, i) => hour(i, i >= 10 && i <= 14 ? 40 : 0));
const SETTLED = HOURS.map((h) => ({
  validTime: h.validTime,
  hourLocal: h.hourLocal,
  constrainedOffMwh: h.hourLocal === 12 ? 90 : 3,
}));

describe("the review chart's marks", () => {
  it("draws one bar per settled hour, and none when nothing settled", () => {
    const drawn = reviewGeometry(HOURS, SETTLED, 5, null);
    expect(drawn.bars).toHaveLength(24);
    expect(reviewGeometry(HOURS, undefined, 5, null).bars).toEqual([]);
  });

  it("scales to the settled peak, so a day bigger than its band is not clipped", () => {
    const drawn = reviewGeometry(HOURS, SETTLED, 5, null);
    expect(drawn.max).toBeGreaterThanOrEqual(90);
    const tallest = drawn.bars.find((bar) => bar.hourLocal === 12);
    expect(tallest?.y).toBeGreaterThanOrEqual(0);
  });

  it("spans the likely window exactly, hour edge to hour edge", () => {
    const drawn = reviewGeometry(HOURS, SETTLED, 5, { fromHour: 10, toHour: 14 });
    expect(drawn.window?.width).toBeCloseTo(drawn.slot * 5, 6);
    expect(drawn.window?.x).toBeCloseTo(drawn.x(10) - drawn.slot / 2, 6);
  });

  it("draws P10 and P90 as their own lines, twenty-four points each", () => {
    const drawn = reviewGeometry(HOURS, SETTLED, 5, null);
    for (const path of [drawn.p10Path, drawn.p90Path]) {
      expect(path.startsWith("M")).toBe(true);
      expect(path.split(" L")).toHaveLength(24);
    }
  });
});

// --- the sentences ---------------------------------------------------------------

describe("the change log names a reconstruction for what it is", () => {
  const f = formattersFor("en");
  const event = (over: Partial<ReplayTimelineEvent>): ReplayTimelineEvent => ({
    kind: "forecast_published",
    at: "2025-11-11T22:00:00Z",
    gateProfile: "gate_late",
    ...over,
  });

  it("never calls a counterfactual instant a publication", () => {
    const served = eventLabel(event({ counterfactual: false }), EN, f);
    const rebuilt = eventLabel(event({ counterfactual: true }), EN, f);
    expect(served).not.toBe(rebuilt);
    expect(rebuilt.toLowerCase()).not.toContain("forecast published");
    expect(
      eventLabel(event({ kind: "forecast_written", counterfactual: true }), EN, f),
    ).toContain("backtest");
  });

  it("states an ONS rewrite with its row count and version", () => {
    const line = eventLabel(
      event({
        kind: "settled_restated",
        rows: 6,
        dataVersion: "4",
        gateProfile: undefined,
      }),
      PT,
      formattersFor("pt"),
    );
    expect(line).toContain("6");
    expect(line).toContain("4");
  });

  it("signs a deviation with a minus sign, not a hyphen", () => {
    expect(signOf(-3)).toBe("−");
    expect(signOf(0)).toBe("");
    expect(signedMwh(-57_300, f).startsWith("−")).toBe(true);
    expect(signedMwh(64, f)).toMatch(/^\+64/);
  });
});

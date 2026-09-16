/**
 * The composer, which is where this feature is made safe.
 *
 * A briefing animates the product's own panels against the product's own reads.
 * The failure that would matter is not a mistimed scene — it is a briefing that
 * animates a **forecast the product does not have**, in the state production is
 * actually in today, where no model is promoted and every forecast read refuses.
 *
 * So the assertions below are mostly about absence: which scenes must *not*
 * appear, and under which state.
 */

import { describe, expect, it } from "bun:test";
import type { OptimizationResult } from "@wattsteer/core/api";
import type { AppParams } from "@/components/app/params";
import type { ExplainState } from "@/components/app/use-explain";
import type { NetworkState } from "@/components/app/use-network";
import type { ServingState } from "@/components/app/use-serving";
import { composeBriefing } from "@/lib/voice/briefing/compose";
import { planDuration, type SceneType } from "@/lib/voice/briefing/types";
import type { VoiceContextInput } from "@/lib/voice/context";

const PARAMS: AppParams = {
  subsystem: "NE",
  technology: "WIND",
  run: "12Z",
  date: "2026-09-17",
  episode: "",
};

const SERVING: ServingState = {
  status: "known",
  lanes: [],
  modelReachable: false,
  serving: false,
  voiceConfigured: true,
};

function context(over: Partial<VoiceContextInput> = {}): VoiceContextInput {
  return {
    locale: "pt",
    screen: "overview",
    params: PARAMS,
    serving: SERVING,
    ...over,
  };
}

/**
 * The shapes the composer branches on, kept minimal on purpose.
 *
 * Only the fields the composer reads are populated. A fuller fixture would
 * invite the composer to grow a dependency on something it has no business
 * reading, and the cast would hide it.
 */
const READ = {
  status: "read",
  observed: {
    now: { asOf: "2026-09-15T09:00:00Z", vintageFidelity: "point_in_time" },
  },
  forecast: {
    outlook: {
      forecastOrigin: { publishedAt: "2026-09-15T22:00:00Z" },
      vintageFidelity: "point_in_time",
    },
  },
} as unknown as NetworkState;

const OBSERVED_ONLY = {
  status: "observedOnly",
  observed: {
    now: { asOf: "2026-09-15T09:00:00Z", vintageFidelity: "point_in_time" },
  },
  code: "FORECAST_UNAVAILABLE",
} as unknown as NetworkState;

const REFUSED = {
  status: "refused",
  code: "FORECAST_UNAVAILABLE",
} as unknown as NetworkState;

const EXPLAIN_REFUSED = {
  status: "refused",
  code: "MODEL_UNAVAILABLE",
} as unknown as ExplainState;

const OPTIMIZATION = {
  baselineCurtailmentMwh: 423,
  optimizedCurtailmentMwh: 240,
} as unknown as OptimizationResult;

function types(plan: { scenes: readonly { scene: { type: SceneType } }[] }): SceneType[] {
  return plan.scenes.map((timed) => timed.scene.type);
}

describe("a day with a published forecast", () => {
  it("earns the full sequence", () => {
    const plan = composeBriefing({ context: context({ network: READ }), kind: "why" });

    expect(types(plan)).toEqual([
      "title",
      "map_focus",
      "forecast_curve",
      "cause",
      "sources",
    ]);
  });

  it("closes on the reads it used, with their vintage", () => {
    const plan = composeBriefing({
      context: context({ network: READ }),
      kind: "tomorrow",
    });

    // The last scene is always `sources`: a briefing is a claim, and the rule
    // this product keeps is that a claim says where it came from.
    expect(types(plan).at(-1)).toBe("sources");
    expect(plan.sources.map((source) => source.read)).toEqual([
      "GET /v1/grid/now",
      "GET /v1/grid/outlook",
      "GET /v1/forecast/day-ahead",
    ]);
    expect(plan.sources[0]?.fidelity).toBe("point_in_time");
  });

  it("varies by question kind rather than telling one story", () => {
    const why = composeBriefing({ context: context({ network: READ }), kind: "why" });
    const tomorrow = composeBriefing({
      context: context({ network: READ }),
      kind: "tomorrow",
    });

    expect(types(why)).toContain("cause");
    expect(types(why)).not.toContain("kpi");
    expect(types(tomorrow)).toContain("kpi");
    expect(types(tomorrow)).not.toContain("cause");
  });
});

describe("observedOnly — the state production is in", () => {
  it("never animates a forecast it does not have", () => {
    const plan = composeBriefing({
      context: context({ network: OBSERVED_ONLY }),
      kind: "why",
    });

    // The assertion this file exists for.
    expect(types(plan)).not.toContain("forecast_curve");
    expect(types(plan)).not.toContain("counterfactual");
    expect(types(plan)).not.toContain("kpi");
  });

  it("is a sequence of measurements, not the forecast one with holes in it", () => {
    const plan = composeBriefing({
      context: context({ network: OBSERVED_ONLY }),
      kind: "what_happened",
    });

    expect(types(plan)).toEqual([
      "title",
      "map_focus",
      "observed_curve",
      "constraint",
      "sources",
    ]);
  });

  it("holds the forecast back even when an optimizer result is in hand", () => {
    // A result can outlive the forecast it was solved against — the screen
    // keeps it while a re-read refuses. It must not resurrect the sequence.
    const plan = composeBriefing({
      context: context({ network: OBSERVED_ONLY }),
      kind: "what_if",
      optimization: OPTIMIZATION,
    });

    expect(types(plan)).not.toContain("counterfactual");
  });

  it("reads observed only, and says so in its sources", () => {
    const plan = composeBriefing({
      context: context({ network: OBSERVED_ONLY }),
      kind: "why",
    });

    expect(plan.sources.map((source) => source.read)).toEqual(["GET /v1/grid/now"]);
  });
});

describe("refused", () => {
  it("is one scene carrying the gateway's own code", () => {
    const plan = composeBriefing({
      context: context({ network: REFUSED }),
      kind: "tomorrow",
    });

    expect(types(plan)).toEqual(["refusal"]);
    expect(plan.scenes[0]?.scene).toMatchObject({ code: "FORECAST_UNAVAILABLE" });
  });

  it("takes the code from Explain when that is what refused", () => {
    const plan = composeBriefing({
      context: context({ screen: "explain", explain: EXPLAIN_REFUSED }),
      kind: "why",
    });

    expect(types(plan)).toEqual(["refusal"]);
    expect(plan.scenes[0]?.scene).toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });

  it("claims no sources, because it read nothing", () => {
    const plan = composeBriefing({
      context: context({ network: REFUSED }),
      kind: "why",
    });

    expect(plan.sources).toEqual([]);
  });
});

describe("the plan itself", () => {
  it("is the same twice for the same state", () => {
    const first = composeBriefing({ context: context({ network: READ }), kind: "why" });
    const second = composeBriefing({ context: context({ network: READ }), kind: "why" });

    expect(first).toEqual(second);
  });

  it("lays scenes end to end with no gap and no overlap", () => {
    const plan = composeBriefing({
      context: context({ network: READ }),
      kind: "why",
      optimization: OPTIMIZATION,
    });

    let expected = 0;
    for (const timed of plan.scenes) {
      expect(timed.start).toBe(expected);
      expect(timed.duration).toBeGreaterThan(0);
      expected += timed.duration;
    }
    expect(planDuration(plan)).toBe(expected);
  });

  it("carries the locale it was asked in", () => {
    const plan = composeBriefing({
      context: context({ locale: "en", network: READ }),
      kind: "why",
    });

    expect(plan.locale).toBe("en");
  });
});

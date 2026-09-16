/**
 * The one scene allowed to carry figures, and the fence around it.
 *
 * Every other scene names a *selector* — a subsystem, a date, a window — and
 * the renderer reads the number through the same client the screens use. The
 * model never types a megawatt-hour, which is what lets a spoken answer inherit
 * the guarantee the screens carry: every number traces to a published row.
 *
 * `counterfactual` breaks that pattern because "423 → 240 MWh" is the scene.
 * The rule that keeps it honest is narrow and absolute: **the figures are
 * copied off an `OptimizationResult` the composer is holding, or the scene does
 * not exist.** Not zero, not a placeholder, not a value the narration mentioned
 * — absent.
 *
 * `VISUAL_PLAN.md` §5.3.
 */

import { describe, expect, it } from "bun:test";
import type { OptimizationResult } from "@wattsteer/core/api";
import type { AppParams } from "@/components/app/params";
import type { NetworkState } from "@/components/app/use-network";
import type { ServingState } from "@/components/app/use-serving";
import { composeBriefing } from "@/lib/voice/briefing/compose";
import type { Scene } from "@/lib/voice/briefing/types";
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

const CONTEXT: VoiceContextInput = {
  locale: "pt",
  screen: "mitigate",
  params: PARAMS,
  serving: SERVING,
  network: READ,
};

const SOLVE = {
  baselineCurtailmentMwh: 423,
  optimizedCurtailmentMwh: 240,
} as unknown as OptimizationResult;

function counterfactual(scenes: readonly { scene: Scene }[]): Scene | undefined {
  return scenes
    .map((timed) => timed.scene)
    .find((scene) => scene.type === "counterfactual");
}

describe("the counterfactual scene", () => {
  it("does not exist without a solve behind it", () => {
    const plan = composeBriefing({ context: CONTEXT, kind: "what_if" });

    expect(counterfactual(plan.scenes)).toBeUndefined();
  });

  it("copies the optimizer's own two figures, unmodified", () => {
    const plan = composeBriefing({
      context: CONTEXT,
      kind: "what_if",
      optimization: SOLVE,
    });

    expect(counterfactual(plan.scenes)).toEqual({
      type: "counterfactual",
      action: "battery",
      baselineMwh: 423,
      optimizedMwh: 240,
    });
  });

  it("does not compute the difference — the scene shows two published numbers", () => {
    // 423 - 240 = 183, and a briefing that printed 183 would be this screen
    // deriving a quantity the optimizer never scored. `avoided_energy_mwh` is a
    // field on the answer for exactly this reason; if the scene ever needs it,
    // it reads it, and this assertion is what forces that conversation.
    const plan = composeBriefing({
      context: CONTEXT,
      kind: "what_if",
      optimization: SOLVE,
    });
    const scene = counterfactual(plan.scenes);

    expect(Object.values(scene ?? {})).not.toContain(183);
  });

  it("names the solve among the sources when it used one", () => {
    const withSolve = composeBriefing({
      context: CONTEXT,
      kind: "what_if",
      optimization: SOLVE,
    });
    const without = composeBriefing({ context: CONTEXT, kind: "what_if" });

    expect(withSolve.sources.map((source) => source.read)).toContain("POST /v1/optimize");
    expect(without.sources.map((source) => source.read)).not.toContain(
      "POST /v1/optimize",
    );
  });

  it("brings its recommendation with it, and only with it", () => {
    // The recommended action is what the solve recommends. Without a solve
    // there is nothing to recommend, and a briefing that recommended anyway
    // would be advice with no plan under it.
    const withSolve = composeBriefing({
      context: CONTEXT,
      kind: "what_if",
      optimization: SOLVE,
    });
    const without = composeBriefing({ context: CONTEXT, kind: "what_if" });

    expect(withSolve.scenes.map((timed) => timed.scene.type)).toContain("recommendation");
    expect(without.scenes.map((timed) => timed.scene.type)).not.toContain(
      "recommendation",
    );
  });
});

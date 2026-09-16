/**
 * Question kind + the live app state -> a `BriefingPlan`.
 *
 * **The model decides *that* a briefing is owed and about what. This function
 * decides what is in it.** `tools.ts` lets the model call `brief` with a
 * question kind and a subsystem; everything downstream of that is deterministic,
 * which is what makes the feature testable with `bun test`, identical twice for
 * the same state, and unable to emit a scene for data that is absent.
 *
 * The last property is the one that matters most here. In production today no
 * model is promoted: `use-network` answers `observedOnly` and `use-explain`
 * refuses. A briefing that animated a forecast in that state would be the worst
 * bug this feature could have — it would put a fabricated forecast on screen in
 * the one part of the product whose entire claim is that it does not do that.
 * So the state is consulted first and it decides the shape:
 *
 * | state | plan |
 * |---|---|
 * | forecast present | the full sequence |
 * | `observedOnly` | observed scenes only — no `forecast_curve`, no `counterfactual` |
 * | refused | exactly one `refusal` scene |
 *
 * See `VISUAL_PLAN.md` §3.
 */

import type { OptimizationResult } from "@wattsteer/core/api";
import {
  type BriefingPlan,
  type BriefingSource,
  DEFAULT_SCENE_MS,
  type QuestionKind,
  type Scene,
  type TimedScene,
} from "@/lib/voice/briefing/types";
import type { VoiceContextInput } from "@/lib/voice/context";
import { forecastRefusal, hasForecast } from "@/lib/voice/context";

/**
 * What the composer may be holding beyond the voice context.
 *
 * `optimization` is passed rather than fetched because a composer that fetches
 * is a composer that cannot be tested without a network, and because the
 * Mitigate screen already has the result in hand when the question is asked
 * there. Absent, the counterfactual scene is simply not emitted — never faked.
 */
export interface ComposeInput {
  readonly context: VoiceContextInput;
  readonly kind: QuestionKind;
  readonly optimization?: OptimizationResult;
}

/** Lay scenes end to end, each at the default length. */
function sequence(scenes: readonly Scene[]): readonly TimedScene[] {
  let start = 0;
  const timed: TimedScene[] = [];
  for (const scene of scenes) {
    timed.push({ scene, start, duration: DEFAULT_SCENE_MS });
    start += DEFAULT_SCENE_MS;
  }
  return timed;
}

/**
 * The reads behind the plan, named for the closing scene.
 *
 * A briefing is a claim, and this product's standing rule is that a claim says
 * where it came from — the same vocabulary `ForecastStamp`, `ObservedBadge` and
 * `VintageBadge` already carry on the screens.
 */
function sourcesFor(input: ComposeInput): readonly BriefingSource[] {
  const { context } = input;
  const out: BriefingSource[] = [];
  const network = context.network;
  if (network !== undefined && network.status !== "reading") {
    if (network.status !== "refused") {
      out.push({
        read: "GET /v1/grid/now",
        asOf: network.observed.now.asOf,
        fidelity: network.observed.now.vintageFidelity,
      });
    }
    if (network.status === "read") {
      // The outlook has no `as_of` — it is a forecast, so what dates it is
      // the instant its origin published, which is the field the screens stamp.
      out.push({
        read: "GET /v1/grid/outlook",
        asOf: network.forecast.outlook.forecastOrigin.publishedAt,
        fidelity: network.forecast.outlook.vintageFidelity,
      });
      out.push({ read: "GET /v1/forecast/day-ahead", asOf: null, fidelity: null });
    }
  }
  if (context.explain?.status === "explained") {
    out.push({ read: "GET /v1/diagnosis/day-ahead", asOf: null, fidelity: null });
  }
  if (input.optimization !== undefined) {
    out.push({ read: "POST /v1/optimize", asOf: null, fidelity: null });
  }
  return out;
}

/**
 * The counterfactual, or nothing.
 *
 * The figures are **copied off the optimizer's own answer**, never spoken and
 * never derived here. Without a result there is no scene — a briefing that
 * showed "423 → 240" with no solve behind it would be the exact failure this
 * whole design exists to prevent.
 */
function counterfactualScene(input: ComposeInput): Scene | null {
  const result = input.optimization;
  if (result === undefined) {
    return null;
  }
  return {
    type: "counterfactual",
    action: "battery",
    baselineMwh: result.baselineCurtailmentMwh,
    optimizedMwh: result.optimizedCurtailmentMwh,
  };
}

/** The scenes a day with a published forecast earns. */
function forecastScenes(input: ComposeInput): readonly Scene[] {
  const subsystem = input.context.params.subsystem;
  const scenes: Scene[] = [
    { type: "title", subsystem },
    { type: "map_focus", subsystem, emphasis: "risk" },
    { type: "forecast_curve", subsystem, window: null },
  ];
  if (input.kind === "why" || input.kind === "what_happened") {
    scenes.push({ type: "cause", subsystem });
  }
  if (input.kind === "tomorrow") {
    scenes.push({ type: "kpi", figure: "day_energy" });
  }
  const counterfactual = counterfactualScene(input);
  if (counterfactual !== null) {
    scenes.push(counterfactual, { type: "recommendation", window: null });
  }
  scenes.push({ type: "sources" });
  return scenes;
}

/**
 * The scenes a settled day earns when no forecast exists.
 *
 * Deliberately not the forecast sequence with holes in it. Every scene here is
 * a measurement, and the two that would be a model's opinion — the fan and the
 * counterfactual — are absent rather than empty, which is the same choice
 * `ObservedSubsystemRow` makes against `SubsystemRow`.
 */
function observedScenes(input: ComposeInput): readonly Scene[] {
  const subsystem = input.context.params.subsystem;
  return [
    { type: "title", subsystem },
    { type: "map_focus", subsystem, emphasis: "energy" },
    { type: "observed_curve", subsystem },
    { type: "constraint", subsystem },
    { type: "sources" },
  ];
}

export function composeBriefing(input: ComposeInput): BriefingPlan {
  const { context, kind } = input;
  const base = { locale: context.locale, kind, sources: sourcesFor(input) };

  if (hasForecast(context)) {
    return { ...base, scenes: sequence(forecastScenes(input)) };
  }

  const refusal = forecastRefusal(context);
  const observedOnly =
    context.network?.status === "observedOnly" ||
    context.explain?.status === "observedOnly";

  if (observedOnly) {
    return { ...base, scenes: sequence(observedScenes(input)) };
  }

  // Nothing to show and a reason for it. One scene, spoken plainly — a
  // sequence of empty panels would be a briefing pretending to brief.
  return {
    ...base,
    scenes: sequence([{ type: "refusal", code: refusal ?? "FORECAST_UNAVAILABLE" }]),
  };
}

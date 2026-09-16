/**
 * `WattSteerVisualLanguage` — the closed set of scenes a briefing may contain.
 *
 * A scene carries **selectors, never figures**. It names what to show — a
 * subsystem, a date, an hour window, a driver — and the renderer reads the
 * number through the same `ApiClient` every screen uses. The model is never
 * given the chance to type a megawatt-hour, which is the only way a spoken
 * answer can inherit the guarantee the screens already carry: that every number
 * traces to a published row.
 *
 * `counterfactual` is the one exception and it is fenced in `compose.ts` — it
 * may only be built from an `OptimizationResult` the composer is holding.
 *
 * See `VISUAL_PLAN.md` §2.
 */

import type { ErrorCode, SubsystemCode } from "@wattsteer/core";
import type { Locale } from "@/i18n/locale";

/** The kinds of question that earn a briefing rather than a spoken sentence. */
export const QUESTION_KINDS = ["why", "tomorrow", "what_happened", "what_if"] as const;

export type QuestionKind = (typeof QUESTION_KINDS)[number];

export function isQuestionKind(value: string): value is QuestionKind {
  return (QUESTION_KINDS as readonly string[]).includes(value);
}

/** An hour window inside a day, as the fan chart's own `HH:MM` spelling. */
export interface HourWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * The twelve scene types.
 *
 * Every one maps onto a component that already exists, which is the point: a
 * briefing is the product's own panels, sequenced, not a second visual language
 * that happens to describe the same data.
 */
export type Scene =
  | { readonly type: "title"; readonly subsystem: SubsystemCode | null }
  | {
      readonly type: "map_focus";
      readonly subsystem: SubsystemCode;
      readonly emphasis: "risk" | "energy";
    }
  | {
      readonly type: "forecast_curve";
      readonly subsystem: SubsystemCode;
      readonly window: HourWindow | null;
    }
  | { readonly type: "observed_curve"; readonly subsystem: SubsystemCode }
  | { readonly type: "kpi"; readonly figure: "day_energy" | "peak_power" }
  | { readonly type: "comparison"; readonly left: "plan"; readonly right: "executed" }
  | { readonly type: "cause"; readonly subsystem: SubsystemCode }
  | { readonly type: "constraint"; readonly subsystem: SubsystemCode }
  | {
      /**
       * The only scene carrying figures, and they are copied off an
       * `OptimizationResult` rather than spoken. `compose.ts` cannot build it
       * without one; `briefing-numbers.test.ts` is the standing guard.
       */
      readonly type: "counterfactual";
      readonly action: "battery" | "shiftable_load";
      readonly baselineMwh: number;
      readonly optimizedMwh: number;
    }
  | { readonly type: "recommendation"; readonly window: HourWindow | null }
  | { readonly type: "sources" }
  | { readonly type: "refusal"; readonly code: ErrorCode };

export type SceneType = Scene["type"];

/** Every scene type, for the exhaustiveness checks the renderer and tests want. */
export const SCENE_TYPES: readonly SceneType[] = [
  "title",
  "map_focus",
  "forecast_curve",
  "observed_curve",
  "kpi",
  "comparison",
  "cause",
  "constraint",
  "counterfactual",
  "recommendation",
  "sources",
  "refusal",
];

/**
 * One scene with its place on the timeline.
 *
 * `start` and `duration` are milliseconds from the beginning of the narration.
 * They are a *plan*, not a promise: `clock.ts` stretches or compresses them
 * against the audio that actually plays, because narration length is decided by
 * the speech model and not by this file.
 */
export interface TimedScene {
  readonly scene: Scene;
  readonly start: number;
  readonly duration: number;
}

/** A read that fed the briefing, named for the sources scene. */
export interface BriefingSource {
  readonly read: string;
  readonly asOf: string | null;
  readonly fidelity: string | null;
}

export interface BriefingPlan {
  readonly locale: Locale;
  readonly kind: QuestionKind;
  readonly scenes: readonly TimedScene[];
  readonly sources: readonly BriefingSource[];
}

/** The floor a scene may be compressed to before the sequence gives up on fitting. */
export const MIN_SCENE_MS = 1200;

/** What a scene gets when its type has no opinion. */
export const DEFAULT_SCENE_MS = 3500;

/**
 * How long each kind of scene wants, before the narration is fitted to it.
 *
 * A briefing read at one length throughout has no rhythm: a title card holding
 * as long as a fan chart makes the fan feel rushed and the title feel like a
 * stall. These are how long each scene takes to *read* — a headline is a
 * glance, a chart is a study — and `clock.ts` scales them together against the
 * narration that actually plays, so the proportions survive a short answer.
 */
export const SCENE_MS: Readonly<Record<SceneType, number>> = {
  title: 2200,
  map_focus: 3200,
  forecast_curve: 4800,
  observed_curve: 4200,
  kpi: 2800,
  comparison: 4200,
  cause: 4200,
  constraint: 3000,
  counterfactual: 4200,
  recommendation: 3400,
  sources: 3000,
  refusal: 4000,
};

/** Total of a plan's scene durations. */
export function planDuration(plan: BriefingPlan): number {
  const last = plan.scenes.at(-1);
  return last === undefined ? 0 : last.start + last.duration;
}

/**
 * The Time Machine dashboard's reading of its four answers.
 *
 * The same posture as `lib/replay.ts`, and stricter: **nothing here computes a
 * figure**. The deviation, the placement, the national settled total and the
 * joint band all arrive on the wire, computed where `no-summed-bands.test.ts`
 * cannot object to them — so this module selects, orders and adapts shapes,
 * and the one numeric decision it makes is which hours count as the likely
 * window, which `criticalWindow` owns.
 */

import type { ReplayCompare, ReplayTimeline } from "@wattsteer/core/api";
import { type CriticalWindow, criticalWindow } from "@/lib/critical-window";
import type { CurtailmentHourForecast, SubsystemCode } from "@/lib/fixtures";

/** The subsystem-day of the comparison the screen is focused on, or `undefined`. */
export function compareRowOf(
  compare: ReplayCompare,
  subsystem: SubsystemCode,
): ReplayCompare["subsystems"][number] | undefined {
  return compare.subsystems.find((row) => row.subsystem === subsystem);
}

/**
 * Whether the comparison says this subsystem can be opened as a replay.
 *
 * A subsystem pill is only pressable where it can answer: a control that moves
 * the screen onto a refusal is a dead end the comparison already knew about.
 */
export function replayableSubsystems(compare: ReplayCompare): ReadonlySet<SubsystemCode> {
  return new Set(
    compare.subsystems.filter((row) => row.replayable).map((row) => row.subsystem),
  );
}

/** The likely window of the replayed forecast, by the hours' own probabilities. */
export function likelyWindow(
  hours: readonly CurtailmentHourForecast[],
): CriticalWindow | null {
  return criticalWindow(hours);
}

/**
 * A signed figure's sign, spelled rather than implied.
 *
 * `−` is the minus sign, not a hyphen, so it reads as one at display sizes and
 * a screen reader announces it as "minus".
 */
export function signOf(value: number): "+" | "−" | "" {
  if (value > 0) {
    return "+";
  }
  return value < 0 ? "−" : "";
}

/** The timeline's events, oldest first — the wire's order, which is the rule. */
export function timelineEvents(timeline: ReplayTimeline): ReplayTimeline["events"] {
  return timeline.events;
}

/** The gate entry for one gate profile, or `undefined` when the lane is absent. */
export function gateEntry(
  timeline: ReplayTimeline,
  gateProfile: "gate_early" | "gate_late",
): ReplayTimeline["gates"][number] | undefined {
  return timeline.gates.find((gate) => gate.gateProfile === gateProfile);
}

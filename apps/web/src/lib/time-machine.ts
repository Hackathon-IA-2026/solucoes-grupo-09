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
import { replayDayId } from "@/lib/fixtures";

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

/** A replay day as the picker offers it: newest first. */
export interface OfferedDay {
  readonly id: string;
  readonly date: string;
  readonly subsystem: SubsystemCode;
}

/**
 * The day the dashboard should be on, or `null` when it already is.
 *
 * Two readers arrive here and they are owed different things:
 *
 * - **A link that names a replay day** (`episodeFromUrl`) is somebody pointing
 *   at that day. It is kept whenever the deployment can answer it.
 * - **A reader arriving from another tab** names none — `sharedParams` carries
 *   the Overview's `date` and `subsystem`, not an episode — and is owed the
 *   region and the day they were looking at. The Overview's date is a forecast
 *   day and usually tomorrow, so the answer is the newest replayable day **at or
 *   before** it: walked back to the 15th, the Time Machine opens on the 15th.
 *
 * A day the deployment cannot answer moves to the nearest earlier one that it
 * can, and to the newest one only when nothing earlier exists — never towards
 * a refusal. The subsystem is corrected first, because `viewable` is that
 * subsystem's list and a date chosen from another region's list is a guess.
 */
export function openingDay(
  viewable: readonly OfferedDay[],
  current: OfferedDay,
  wanted: {
    readonly fromUrl: boolean;
    readonly date: string;
    readonly subsystem: SubsystemCode;
  },
): string | null {
  const subsystem = wanted.fromUrl ? current.subsystem : wanted.subsystem;
  const date = wanted.fromUrl ? current.date : wanted.date;
  if (subsystem !== current.subsystem) {
    return replayDayId(date, subsystem);
  }
  if (viewable.length === 0) {
    return null;
  }
  if (wanted.fromUrl && viewable.some((day) => day.id === current.id)) {
    return null;
  }
  const pick = viewable.find((day) => day.date <= date) ?? viewable[0];
  return pick === undefined || pick.id === current.id ? null : pick.id;
}

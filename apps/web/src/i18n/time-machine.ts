/**
 * The Time Machine dashboard's sentences, built from the dictionaries.
 *
 * The sibling of `i18n/replay.ts`: every string a panel prints comes from here
 * or from the dictionary directly, so the dashboard and anything that later
 * narrates it quote the same words. Values are interpolated and prose never is.
 */

import type { ReplayTimelineEvent } from "@wattsteer/core/api";
import type { Copy, Formatters } from "@/i18n";
import { fill } from "@/i18n/format";
import { signOf } from "@/lib/time-machine";

type GateProfile = "gate_early" | "gate_late";

/**
 * A quantity of energy for a dashboard figure: whole MWh below a thousand,
 * compact above it. `compact` alone prints `64,0` for a figure whose tenth is
 * noise at day grain, and a column of `96,0 · 73,0 · 29,0` reads as precision
 * nobody measured.
 */
export function mwh(value: number, f: Formatters): string {
  return Math.abs(value) >= 1000 ? f.compact(value) : f.number(value);
}

/** A signed quantity of energy: `+64`, `−1,2 mil`. Never a percentage. */
export function signedMwh(value: number, f: Formatters): string {
  return `${signOf(value)}${mwh(Math.abs(value), f)}`;
}

/** Which D−1 gate a forecast came from, as the reader knows it. */
export function gateLabel(profile: GateProfile, copy: Copy): string {
  return copy.app.timeMachine.timeline.gate[profile];
}

/**
 * One change-log line.
 *
 * A reconstruction's two instants are named for what they are: its
 * `published_at` is the gate it stands in for, and its write is the backtest
 * run. Printing either as "published" would draw a forecast nobody published.
 */
export function eventLabel(
  event: ReplayTimelineEvent,
  copy: Copy,
  f: Formatters,
): string {
  const text = copy.app.timeMachine.timeline.events;
  const gate = event.gateProfile === undefined ? "" : gateLabel(event.gateProfile, copy);
  const rows = f.number(event.rows ?? 0);
  switch (event.kind) {
    case "forecast_published":
      return fill(
        event.counterfactual === true
          ? text.forecast_published_counterfactual
          : text.forecast_published,
        { gate },
      );
    case "forecast_written":
      return fill(
        event.counterfactual === true
          ? text.forecast_written_counterfactual
          : text.forecast_written,
        { gate },
      );
    case "settled_written":
      return fill(text.settled_written, { rows });
    case "settled_restated":
      return fill(text.settled_restated, { rows, version: event.dataVersion ?? "" });
  }
}

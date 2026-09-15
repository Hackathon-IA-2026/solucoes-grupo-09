/**
 * What lives in the URL, and why.
 *
 * The ticket asks whether subsystem and date belong in the URL. They do, and
 * so does more than that — the reasoning is already settled elsewhere and just
 * needs applying:
 *
 *  - The product is **public, read-only, with no accounts**. The URL is the
 *    only place cross-screen state can live that survives a reload or a paste
 *    into Slack.
 *  - `Scenario` is **URL-encoded by decision**, not persisted. Once the
 *    Mitigate screen's assets are in the URL, having its subsystem and date
 *    somewhere else would be incoherent.
 *  - The four screens are four views of **one selection**. Moving from Grid
 *    Overview to Explain must not lose which subsystem you were looking at,
 *    and the cheapest way to guarantee that is to make the selection part of
 *    the address rather than part of a provider.
 *
 * So: `subsystem`, `technology` and `run` are shared across all four screens;
 * `episode` is Time Machine's own.
 *
 * **`date` used to be pinned to the fixture day and is now the real one.** The
 * note that stood here said a date picker over fixtures would be furniture with
 * nothing behind it, which was true while Overview and Explain built their
 * numbers in the browser. They read `apps/api` now, so the day they ask about
 * has to be a day the gateway has an opinion on: `latestTargetDate` — tomorrow,
 * in Brasília — which is `@wattsteer/core`'s own function and exactly what
 * `apps/api/src/api/params.ts` defaults `target_date` to. Pinning `2026-08-29`
 * against a live gateway would have asked a real service about a day chosen to
 * make a fixture look good.
 *
 * There is still no picker in the URL, and that is now a product decision
 * rather than an absence: the forecast horizon is one day and the gateway
 * refuses anything past tomorrow with `TARGET_DATE_OUT_OF_RANGE`, so the only
 * other date a picker could offer is the past — which is the Time Machine, and
 * it has its own.
 *
 * **`run` is the gate profile.** `00Z` / `12Z` are the weather runs the two
 * gates see, and `gateProfileOf` is the one place the label becomes the
 * `gate_early` / `gate_late` the API takes. The mapping is read off
 * `@wattsteer/core`'s `GATES` rather than written out here, so a third gate
 * would be a compile error and not a silently unreachable pill.
 *
 * Everything is parsed defensively: a hand-edited URL yields a default, never
 * a crash and never an empty screen. This module is deliberately free of
 * React and of expo-router so the parsing rules stay unit-testable.
 */

import { GATES, latestTargetDate } from "@wattsteer/core";
import type { GateProfile } from "@wattsteer/core/api";
import {
  REPLAY_DAYS,
  RUN_LABELS,
  type RunLabel,
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  type Technology,
} from "@/lib/fixtures";

/**
 * The gate a weather-run label names.
 *
 * Derived from the published gate table rather than written as a literal pair:
 * `weatherRun` is a field on `GateSchedule`, so this stays correct if a gate's
 * run moves and fails to compile if a `RunLabel` ever names no gate at all.
 */
export function gateProfileOf(run: RunLabel): GateProfile {
  const gate = GATES.find((entry) => entry.weatherRun === run);
  if (gate === undefined) {
    // Unreachable through `RUN_LABELS`, and thrown rather than defaulted: a gate
    // guessed here would send the reader a forecast from a run other than the
    // one the pill they pressed says.
    throw new RangeError(`No published gate sees the ${run} weather run`);
  }
  return gate.profile;
}

export interface AppParams {
  subsystem: SubsystemCode;
  technology: Technology;
  run: RunLabel;
  date: string;
  episode: string;
}

/**
 * URL spelling of `Technology`, and the only place the two forms meet.
 *
 * The domain — and the database enum, and the API — say `WIND` / `SOLAR`.
 * A URL reads better lowercase, so the query string keeps its own spelling and
 * this module translates. Exactly the same shape of boundary as the ONS carga
 * API's `SECO` for the subsystem the rest of the system calls `SE`: the
 * transport form is owned by the transport layer and never leaks inward.
 */
const TECHNOLOGY_PARAM: Record<string, Technology> = {
  wind: "WIND",
  solar: "SOLAR",
};

/** Render a `Technology` back into its URL spelling. */
export function technologyParam(technology: Technology): string {
  return technology.toLowerCase();
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `now` is an argument so the parsing rules stay a pure function.
 *
 * The day being forecast is a function of the clock, and a module that read one
 * for itself would be a module whose tests drift into next week. The caller
 * that has a clock passes one; every test passes the instant it means.
 */
export function parseAppParams(
  raw: Record<string, string | string[] | undefined>,
  now: Date = new Date(),
): AppParams {
  const subsystem = first(raw.subsystem);
  const technology = first(raw.technology);
  const run = first(raw.run);
  const episode = first(raw.episode);
  return {
    subsystem: SUBSYSTEM_DISPLAY_ORDER.includes(subsystem as SubsystemCode)
      ? (subsystem as SubsystemCode)
      : "NE",
    technology: TECHNOLOGY_PARAM[technology ?? ""] ?? "WIND",
    run: RUN_LABELS.includes(run as RunLabel) ? (run as RunLabel) : "12Z",
    date: latestTargetDate(now),
    episode:
      episode !== undefined && REPLAY_DAYS.some((day) => day.id === episode)
        ? episode
        : REPLAY_DAYS[0].id,
  };
}

/**
 * The params that travel between screens when the user switches tab.
 *
 * **`technology` goes through `technologyParam`, and it did not used to.** This
 * function emitted the domain spelling `SOLAR` while `parseAppParams` reads only
 * the URL spelling `solar`, so a reader who selected Solar and pressed another
 * tab arrived back on Wind — the fallback did its job on a value this module had
 * written itself. It is the exact failure the docstring above warns about:
 *
 * > the transport form is owned by the transport layer and never leaks inward
 *
 * and the leak was outward instead. `technologyParam` exists precisely for this
 * crossing and was simply not called. Found by the voice agent's round-trip
 * property test — for any valid selection, the params a navigation carries must
 * parse back to the same selection — which is a stronger statement than any
 * example-based test here was making, and is now asserted of both callers.
 */
export function sharedParams(params: AppParams): Record<string, string> {
  return {
    subsystem: params.subsystem,
    technology: technologyParam(params.technology),
    run: params.run,
  };
}

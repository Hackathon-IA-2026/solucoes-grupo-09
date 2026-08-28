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
 * `episode` is Time Machine's own. `date` is in the shape but pinned to the
 * fixture day — a date picker over fixtures would be furniture with nothing
 * behind it, and the parameter is here so its absence is not mistaken for a
 * decision.
 *
 * Everything is parsed defensively: a hand-edited URL yields a default, never
 * a crash and never an empty screen. This module is deliberately free of
 * React and of expo-router so the parsing rules stay unit-testable.
 */

import {
  REPLAY_DAYS,
  RUN_LABELS,
  type RunLabel,
  SUBSYSTEM_CODES,
  type SubsystemCode,
  TARGET_DATE,
  type Technology,
} from "@/lib/fixtures";

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

export function parseAppParams(
  raw: Record<string, string | string[] | undefined>,
): AppParams {
  const subsystem = first(raw.subsystem);
  const technology = first(raw.technology);
  const run = first(raw.run);
  const episode = first(raw.episode);
  return {
    subsystem: SUBSYSTEM_CODES.includes(subsystem as SubsystemCode)
      ? (subsystem as SubsystemCode)
      : "NE",
    technology: TECHNOLOGY_PARAM[technology ?? ""] ?? "WIND",
    run: RUN_LABELS.includes(run as RunLabel) ? (run as RunLabel) : "12Z",
    date: TARGET_DATE,
    episode:
      episode !== undefined && REPLAY_DAYS.some((d) => d.episode.id === episode)
        ? episode
        : REPLAY_DAYS[0].episode.id,
  };
}

/** The params that travel between screens when the user switches tab. */
export function sharedParams(params: AppParams): Record<string, string> {
  return {
    subsystem: params.subsystem,
    technology: params.technology,
    run: params.run,
  };
}

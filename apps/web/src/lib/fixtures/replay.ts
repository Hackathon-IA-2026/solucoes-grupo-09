/**
 * The Time Machine's day catalogue — **which days to offer, and nothing else.**
 *
 * This module used to build a whole replayed day: a forecast, a settled
 * profile, an integrity statement, a scenario and a recovered figure. Every one
 * of those is now read off `GET /v1/replay`, for the reason
 * `docs/specs/replay.md` gives and `docs/specs/api-surface.md` decision 6
 * already applied to Mitigate — the simulator that scores a live plan and the
 * one that scores a replayed plan are the same function, imported rather than
 * reimplemented, and `test/one-execution-rule.test.ts` walks the repository to
 * keep it so. A fixture that produced a recovered number would have had to be
 * a second one.
 *
 * What could not come from the endpoint is the **list of days worth opening
 * on**. `docs/specs/replay.md` publishes a deterministic rule for that — the
 * featured eight, obliged to include the day WattSteer got most wrong — and
 * ticket 07 owns the query behind it; `/v1/replay/days` serves it. Until this
 * screen reads that route, the picker is seeded from here, and the seed is
 * deliberately **only dates**: a first-run experience that is a blank date
 * picker over seventeen months is the failure the featured list exists to
 * avoid, and a fixture that also asserted what those days *were* would be a
 * second opinion about the thing the endpoint answers.
 *
 * The four days span the three ranges the window partitions into, so the screen
 * cannot be built having only ever seen one of them:
 *
 *  - one in the **pre-F1 training block**, which every artifact was fitted on
 *    and which is therefore refused as a replay and rendered observed-only;
 *  - two inside walk-forward test folds, which the endpoint answers as
 *    `fold_holdout` + `revision_optimistic`;
 *  - one past ingestion go-live, which it answers as `served` +
 *    `point_in_time`.
 *
 * Those verdicts are the server's and are not restated here. They are named in
 * this comment because the point of the selection is that all three arms of the
 * screen are reachable — not because a fixture may decide them.
 */

import { DATA_WINDOW } from "@wattsteer/core";
import type { SubsystemCode } from "./types";

/**
 * WattSteer began ingesting on this date; before it, vintage is unrecoverable.
 *
 * The published constant, not a copy of it: `/v1/meta` returns the same date,
 * so a fixture that restated it could put the screen a quarter out of step with
 * the API without anything failing.
 */
export const INGESTION_GO_LIVE = DATA_WINDOW.ingestionGoLive;

/** One day the picker offers. A date and where to look; never a verdict. */
export interface ReplayCandidateDay {
  /** The URL's `episode` value, and the chip's identity. */
  id: string;
  /** The civil date, `America/Sao_Paulo`. */
  date: string;
  subsystem: SubsystemCode;
}

export const REPLAY_DAYS: readonly ReplayCandidateDay[] = [
  // Pre-F1: inside every artifact's training block, and therefore observed-only.
  { id: "2024-11-05-ne", date: "2024-11-05", subsystem: "NE" },
  // Inside F2 — the day the pitch quotes.
  { id: "2025-09-14-ne", date: "2025-09-14", subsystem: "NE" },
  // Inside F5, and still pre-go-live: held out, and revision-optimistic.
  { id: "2026-06-18-ne", date: "2026-06-18", subsystem: "NE" },
  // Past go-live: what WattSteer actually published, scored point-in-time.
  { id: "2026-08-11-ne", date: "2026-08-11", subsystem: "NE" },
] as const;

/**
 * An `episode` id: a civil date and a subsystem, `2026-08-11-ne`.
 *
 * The picker's days come from the gateway now (`use-replay-days.ts`), so the
 * id has to round-trip any date the deployment can answer rather than the four
 * this file names. The four remain what the screen lands on and what the tests
 * pin; they are no longer the set of ids that exist.
 */
const REPLAY_DAY_ID = /^(\d{4}-\d{2}-\d{2})-(n|ne|s|se)$/;

/**
 * Whether the URL's `episode` is an id at all — a real date and a subsystem.
 *
 * The calendar is checked, not just the shape: `2026-13-99-ne` matches the
 * pattern and is not a day, and a screen that forwarded it would spend a
 * request to be told so. Never a verdict about whether that day can be shown,
 * which is the gateway's to give.
 */
export function isReplayDayId(id: string): boolean {
  const parsed = REPLAY_DAY_ID.exec(id);
  if (parsed === null) {
    return false;
  }
  // Round-tripped, because `new Date("2026-02-30")` is the 2nd of March.
  const date = new Date(`${parsed[1]}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === parsed[1];
}

/** The day an id names, or the first fixture. Never a throw on a hand-edited URL. */
export function replayDay(id: string): ReplayCandidateDay {
  const named = REPLAY_DAYS.find((day) => day.id === id);
  if (named !== undefined) {
    return named;
  }
  if (!isReplayDayId(id)) {
    return REPLAY_DAYS[0];
  }
  const parsed = REPLAY_DAY_ID.exec(id) as RegExpExecArray;
  return { id, date: parsed[1], subsystem: parsed[2].toUpperCase() as SubsystemCode };
}

/** The id for a day the gateway named. The one spelling, written once. */
export function replayDayId(date: string, subsystem: SubsystemCode): string {
  return `${date}-${subsystem.toLowerCase()}`;
}

/**
 * When the product's data changes, and what window it covers — as **data**.
 *
 * `docs/specs/api-surface.md` §"The endpoint list" puts the gate table on
 * `GET /v1/meta` for one reason, and it is a product reason rather than a
 * diagnostic one: the Overview's "tomorrow's view publishes at 19:00 BRT"
 * sentence has to be *derived from* the schedule, not typed into a screen. A
 * hardcoded publication time is a sentence that keeps being said after the
 * schedule changes, in a product whose whole claim is that it says only what it
 * can defend.
 *
 * So the two gates live here, once, and the instants a client would otherwise
 * invent — "when does this change next?" — are computed here too, from the same
 * table. `docs/specs/api-surface.md` §"Out of scope" rules out webhooks and SSE
 * on exactly this basis: nothing here is push-shaped, the data changes twice a
 * day at known instants, and `next_publication_at` is what a client polls
 * against instead.
 *
 * ### Why this is not in `constants.ts`
 *
 * `GRID_TIME_ZONE` and the date the window opens are already published by
 * `scenario-validation.ts`, which imports `constants.ts`. Restating either here
 * would be a second definition of a published constant — the precise thing
 * `packages/core` exists to prevent — and importing them into `constants.ts`
 * would be a cycle. This module sits downstream of both and restates neither.
 *
 * The gate hours themselves are also written in SQL, by `gate_at(target_date,
 * gate_profile)` in `apps/api/drizzle/0016_the_feature_gate.sql`, and that is
 * unavoidable: the feature layer resolves the gate inside Postgres so that no
 * caller can pass one in. `test/schedule.test.ts` asserts the two spellings
 * agree, which is the seam this module can actually hold.
 */

import { civilDay, DATA_WINDOW_OPENS_ON, GRID_TIME_ZONE } from "./scenario-validation.js";
import type { GateProfile } from "./types.generated.js";

/** The civil dates that bound what WattSteer can say anything about. */
export interface DataWindow {
  /** The first civil date the ingestion window covers. */
  readonly opensOn: string;
  /** The date WattSteer's own ingestion started running, D+1 daily. */
  readonly ingestionGoLive: string;
  /** F1's first test day — the first date evaluated out of sample. */
  readonly firstHoldoutFoldStart: string;
}

/**
 * The window, as `/v1/meta` publishes it.
 *
 * `opensOn` is the same constant a scenario before the window is refused
 * against (`TARGET_DATE_OUT_OF_RANGE`), referenced rather than restated.
 * `ingestionGoLive` is where the vintage fidelity stops being reconstructed and
 * starts being observed — `apps/ml/src/wattsteer_ml/evaluation/vintage.py` puts
 * it at F6's start — and it is on this payload because "point in time" and
 * "reconstructed" are the difference between a backtest that means something
 * and one that does not.
 */
export const DATA_WINDOW: DataWindow = {
  opensOn: DATA_WINDOW_OPENS_ON,
  ingestionGoLive: "2026-07-01",
  firstHoldoutFoldStart: "2025-04-01",
};

/** One decision gate: when it publishes, and which weather run it saw. */
export interface GateSchedule {
  readonly profile: GateProfile;
  /** `HH:MM`, local. The gate is D−1 at this hour for target date D. */
  readonly publishesAtLocal: string;
  readonly timezone: typeof GRID_TIME_ZONE;
  readonly weatherRun: "00Z" | "12Z";
}

/**
 * The two gates, late first — the order `/v1/meta`'s example writes them in,
 * and the order that matters: the late gate is the one a reader is usually
 * waiting for, because it supersedes the early one as a newer vintage of the
 * same hours.
 */
export const GATES: readonly GateSchedule[] = [
  {
    profile: "gate_late",
    publishesAtLocal: "19:00",
    timezone: GRID_TIME_ZONE,
    weatherRun: "12Z",
  },
  {
    profile: "gate_early",
    publishesAtLocal: "09:00",
    timezone: GRID_TIME_ZONE,
    weatherRun: "00Z",
  },
];

const MS_PER_DAY = 86_400_000;

const WALL_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: GRID_TIME_ZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** How far `GRID_TIME_ZONE` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date): number {
  const parts = new Map(
    WALL_CLOCK.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const wall = Date.parse(
    `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}T` +
      `${(parts.get("hour") ?? "00").replace("24", "00")}:${parts.get("minute")}:${parts.get("second")}Z`,
  );
  return wall - instant.getTime();
}

/**
 * The UTC instant a local wall-clock time falls at.
 *
 * Two passes rather than one: the offset is a function of the instant, and the
 * first pass can only evaluate it at the wrong one. Brazil has observed no
 * summer time since 2019 so the second pass changes nothing today — which is
 * exactly why it is written now, while the arithmetic is visible, rather than
 * discovered by a publication landing an hour late if it is reinstated.
 */
export function localWallClock(date: string, time: string): Date {
  const naive = Date.parse(`${date}T${time}:00Z`);
  const firstPass = naive - zoneOffsetMs(new Date(naive));
  return new Date(naive - zoneOffsetMs(new Date(firstPass)));
}

/** The next civil date after `date`. ISO dates compare lexicographically. */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** A publication: the gate that produces it and the instant it happens at. */
export interface Publication {
  readonly profile: GateProfile;
  readonly at: Date;
}

/**
 * The next gate to publish, strictly after `now`.
 *
 * Strictly after: at exactly 19:00 BRT the late gate is publishing, not about
 * to, and a client that polls on the returned instant and is handed the same
 * instant back polls forever.
 *
 * Today and tomorrow are both considered because the last gate of a local day
 * is at 19:00, so after it the answer is tomorrow's 09:00 — which is a
 * different civil date and, in a zone with a transition, not simply "plus
 * fourteen hours".
 */
export function nextPublication(now: Date): Publication {
  const today = civilDay(now);
  const candidates = [today, nextDay(today)].flatMap((date) =>
    GATES.map((gate) => ({
      profile: gate.profile,
      at: localWallClock(date, gate.publishesAtLocal),
    })),
  );
  const upcoming = candidates
    .filter((candidate) => candidate.at.getTime() > now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const next = upcoming[0];
  if (next === undefined) {
    // Unreachable while `GATES` is non-empty: tomorrow's gates are always
    // ahead of now. Thrown rather than defaulted, because a `/v1/meta` that
    // invented a publication instant would be lying on the one endpoint whose
    // job is to be believed.
    throw new RangeError(`No gate publishes after ${now.toISOString()}`);
  }
  return next;
}

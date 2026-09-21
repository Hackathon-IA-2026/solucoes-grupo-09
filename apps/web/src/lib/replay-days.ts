/**
 * Which past days the Time Machine can show, asked of the gateway.
 *
 * ## Why this is a plain read and not a generated client method
 *
 * `GET /v1/replay/days` is forwarded from `apps/ml` body-and-all — the gateway
 * does not re-encode it, and `packages/core` generates no type for it. The same
 * reasoning as `lib/evidence.ts`: a type here would assert that the contract
 * governs a shape it only passes through. So this is a narrow read with a
 * narrow return, and everything that could be wrong with the body is handled by
 * `offeredDays`, which treats an unexpected shape as "no days" rather than as
 * an error — the picker states an empty list in words.
 *
 * ## Why a window, and why this one
 *
 * The route defaults to the whole data window, and answering that means
 * resolving every day since 2024-04-01. Measured on 20/09/2026 against the
 * event's instance over 5.2 million curtailment rows: 902 days took 21.4 s,
 * 262 days 4.7 s, 111 days 2.4 s. The gateway gives up at 5 s, so the whole
 * window can only answer `OPTIMIZER_TIMEOUT` — which is what
 * `use-replay-days.ts` used to work around by naming four days by hand.
 *
 * `REPLAY_WINDOW_DAYS` is therefore a *page size*, not a claim about which days
 * answer: the gateway still decides that, day by day, and a reader who wants an
 * older day passes `from` in the URL. The screen says which window it asked
 * for, because a picker that silently omits August is worse than one that says
 * where it stopped looking.
 */

import type { SubsystemCode } from "@wattsteer/core";
import { apiUrl } from "@/lib/api-url";
import { API_URL } from "@/lib/config";
import { type ReplayCandidateDay, replayDayId } from "@/lib/fixtures";

/** How far back the picker asks by default. See the header for the measurement. */
export const REPLAY_WINDOW_DAYS = 120;

/**
 * The refusal that still has a view behind it.
 *
 * A day inside every artifact's training block is refused *as a replay* and is
 * owed the observed-only view instead, so the picker offers it. Named here as
 * `use-replay.ts` names it, and for the same reason.
 */
const PRE_HOLDOUT = "REPLAY_DATE_BEFORE_HOLDOUT_WINDOW";

/** `now` minus `days`, as a Brasília civil date. */
export function windowStart(now: Date, days: number = REPLAY_WINDOW_DAYS): string {
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  // `sv-SE` renders `YYYY-MM-DD`, which is the wire's spelling of a civil date.
  return start.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
}

/** One row of the calendar, as much of it as the picker reads. */
interface CalendarRow {
  date?: unknown;
  replayable?: unknown;
  refusal?: { code?: unknown } | null;
}

/**
 * The days worth offering, newest first.
 *
 * Two kinds reach the screen: a replayable day, and a pre-holdout day whose
 * refusal *is* the route to its observed-only view. Every other refusal is a
 * dead end — press, wait, read a code — and is left out, which is the whole
 * point of asking the gateway rather than listing days by hand.
 */
export function offeredDays(
  body: unknown,
  subsystem: SubsystemCode,
): ReplayCandidateDay[] {
  const rows = (body as { days?: unknown } | null)?.days;
  if (!Array.isArray(rows)) {
    return [];
  }
  const offered: ReplayCandidateDay[] = [];
  for (const row of rows as CalendarRow[]) {
    const date = typeof row?.date === "string" ? row.date : null;
    if (date === null) {
      continue;
    }
    const open = row.replayable === true || row.refusal?.code === PRE_HOLDOUT;
    if (open) {
      offered.push({ id: replayDayId(date, subsystem), date, subsystem });
    }
  }
  return offered.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Ask the gateway. `null` when it refused or the network did, which the caller
 * reads as "say so" rather than as an empty calendar.
 */
export async function readReplayDays(
  query: { subsystem: SubsystemCode; lane: string; from: string },
  signal?: AbortSignal,
): Promise<ReplayCandidateDay[] | null> {
  const url = apiUrl(API_URL, "/v1/replay/days");
  url.searchParams.set("subsystem", query.subsystem);
  url.searchParams.set("lane", query.lane);
  url.searchParams.set("from", query.from);
  const response = await fetch(url, { signal }).catch(() => null);
  if (response === null || !response.ok) {
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  return offeredDays(body, query.subsystem);
}

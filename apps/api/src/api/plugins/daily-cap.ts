/**
 * The cap that counts calls rather than requests.
 *
 * The narration is the one thing behind this API that costs money per use, and
 * it is the one thing a rate limit cannot protect. `diagnosis.md` counts the
 * real volume: 4 subsystems × 2 locales × 2 gate profiles ≈ **16 distinct
 * narrations a day**, and everything else is a cache hit. An IP budget over
 * that is theatre — 16 calls threaten nobody, and the actual risk is a
 * thousand concurrent misses on one cold key becoming a thousand calls.
 *
 * So the scarce resource is metered directly:
 *
 * - a **rate limit** answers "has this client asked too often" and refuses
 *   with a 429; it is per client, per minute, and it is about fairness;
 * - a **daily cap** answers "has this deployment spent too much today" and
 *   never refuses at all: it is global rather than per client, its window is
 *   a civil day rather than a minute, and beyond it the endpoint serves the
 *   **template** narration and says so in `narration.source`. A 429 would be
 *   the wrong answer, because the request is perfectly reasonable and there
 *   is a truthful cheaper answer available.
 *
 * The counter lives in the same store the limiter uses, for the same reason:
 * a per-process cap of 200 is a 600-call cap on three replicas, which is the
 * defect this whole ticket exists to remove.
 *
 * The single-flight lock that collapses a stampede onto one call is the other
 * half of that protection and belongs with the narration itself; this module
 * is the budget, and it is what makes "beyond the cap, serve the template" a
 * mechanism rather than an intention.
 */

import type { LimitStore } from "./limit-store.js";

/** Brasília civil time: the gates publish on it, so the day rolls over on it. */
export const CAP_TIME_ZONE = "America/Sao_Paulo";

const MS_PER_DAY = 86_400_000;

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Pure: the `YYYY-MM-DD` civil day `now` falls in, in Brasília time.
 *
 * Not the UTC day. A cap that rolls over at 21:00 local would reset in the
 * middle of the evening gate's publication, which is the busiest hour the
 * narration has.
 */
export function dayKey(now: number, timeZone: string = CAP_TIME_ZONE): string {
  return timeZone === CAP_TIME_ZONE
    ? dayFormatter.format(now)
    : new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
}

/**
 * When the counter for `now`'s day may be dropped: a day later, plus an hour
 * of slack so a clock skew between replicas cannot expire a live counter.
 */
export function expiresAt(now: number): number {
  return now + MS_PER_DAY + 3_600_000;
}

/** What a cap says about one call. */
export interface CapDecision {
  /** May the call be made? `false` means "serve the cheaper answer". */
  allowed: boolean;
  /** Calls counted today, including this one. */
  used: number;
  /** The cap in force. */
  limit: number;
  /** The civil day the count belongs to, `YYYY-MM-DD` in Brasília time. */
  day: string;
}

export interface DailyCapOptions {
  /** What is being capped — the counter's name, so two caps never share one. */
  name: string;
  /** Calls allowed per civil day. `0` disables the cap (every call allowed). */
  limit: number;
  /** Where the counter lives. Redis in production; the map in tests. */
  store: LimitStore;
}

export interface DailyCap {
  /**
   * Count one call and say whether it may be made.
   *
   * Counts first and decides after, deliberately: an over-cap attempt is still
   * evidence of demand, and a caller that has to ask permission before
   * counting races with itself across replicas.
   */
  take: (now?: number) => Promise<CapDecision>;
}

/**
 * A global, shared, per-civil-day budget for something that costs money.
 *
 * The default of 200 is an order of magnitude above the expected 16 — placed
 * where being wrong is cheap: too low degrades prose to a template that the
 * panel already has a footnote for, too high is a bill.
 */
export function dailyCap(options: DailyCapOptions): DailyCap {
  return {
    take: async (now = Date.now()) => {
      const day = dayKey(now);
      if (options.limit <= 0) {
        return { allowed: true, used: 0, limit: options.limit, day };
      }
      const used = await options.store.bumpDaily(
        `${options.name}:${day}`,
        now,
        expiresAt(now),
      );
      return { allowed: used <= options.limit, used, limit: options.limit, day };
    },
  };
}

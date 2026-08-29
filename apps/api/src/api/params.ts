import { BadInputError, CodedError } from "../errors.js";
import { localDayInterval, ONS_TIME_ZONE, parseCalendarDate } from "../ingest/time.js";

/**
 * Query-parameter parsers shared by the routes.
 *
 * These live here because they were written twice, identically, by two tickets
 * that could not see each other — and a third route would have copied them
 * again. The rule they encode is worth stating once: **a parameter that cannot
 * be parsed is refused, never defaulted.** A route that quietly substitutes
 * `now()` for an unreadable `as_of` answers a question nobody asked, and the
 * caller cannot tell from the response that it happened.
 */

/** Parse an instant, refusing anything that is not one rather than defaulting. */
export function instant(label: string, raw: string): Date {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadInputError(`${label} must be an ISO-8601 instant, got "${raw}"`);
  }
  return parsed;
}

/** Parse the optional form. `undefined` stays `undefined`; junk still throws. */
export function optionalInstant(label: string, raw?: string): Date | undefined {
  return raw === undefined ? undefined : instant(label, raw);
}

/**
 * The observed reads' range cap, in days.
 *
 * `docs/specs/api-surface.md`'s error table: an observed range over 400 days is
 * a `DATE_RANGE_TOO_LARGE` (422), not a slow 200. The cap is a property of the
 * observed surface rather than of one route, which is why it lives here — the
 * hourly series and the episode view are the two routes it binds, and a second
 * copy of the number is how the two would come to disagree.
 */
export const MAX_OBSERVED_RANGE_DAYS = 400;

const DAY_MS = 86_400_000;

/** A half-open valid-time window, exactly as the canonical reads take one. */
export interface ObservedRange {
  from: Date;
  to: Date;
}

/**
 * Parse and bound `from`/`to` for an observed read.
 *
 * Three refusals, none of them a silently-clamped answer: an unparseable
 * instant, an empty or inverted window, and a window past the cap. A clamped
 * range would return real numbers for a range the caller did not ask for, and
 * nothing on the payload would say so.
 */
export function observedRange(rawFrom: string, rawTo: string): ObservedRange {
  const from = instant("from", rawFrom);
  const to = instant("to", rawTo);
  if (to.getTime() <= from.getTime()) {
    throw new BadInputError(
      `from must precede to; the window is half-open [from, to), got "${rawFrom}" and "${rawTo}"`,
    );
  }
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days > MAX_OBSERVED_RANGE_DAYS) {
    throw new CodedError(
      "DATE_RANGE_TOO_LARGE",
      `An observed range may span at most ${MAX_OBSERVED_RANGE_DAYS} days; this one spans ${Math.ceil(days)}`,
      {
        details: {
          from: from.toISOString(),
          to: to.toISOString(),
          max_days: MAX_OBSERVED_RANGE_DAYS,
        },
      },
    );
  }
  return { from, to };
}

/**
 * Resolve a Brasília civil date to the interval it actually occupied.
 *
 * `date=` on `/v1/curtailment/reasons` is a **civil date**, so the day it names
 * is 23, 24 or 25 hours long depending on the zone's history. Resolving it
 * through `localDayInterval` rather than by adding 24 hours to a UTC midnight
 * is what keeps "the reasons for the 3rd" from silently including an hour of
 * the 4th — and ONS's own timestamps are Brasília local civil time, so a UTC
 * day would be the wrong day by three hours every day of the year.
 */
export function civilDayWindow(label: string, raw: string): ObservedRange {
  const parsed = parseCalendarDate(raw);
  if (parsed === null) {
    throw new BadInputError(`${label} must be a civil date (YYYY-MM-DD), got "${raw}"`);
  }
  const day = localDayInterval(parsed);
  if (day === null) {
    throw new BadInputError(`${label} names no day in ${ONS_TIME_ZONE}: "${raw}"`);
  }
  return { from: day.start, to: new Date(day.start.getTime() + day.minutes * 60_000) };
}

/** Parse a positive number, refusing junk and zero rather than defaulting. */
export function positiveNumber(label: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadInputError(`${label} must be a number above zero, got "${raw}"`);
  }
  return parsed;
}

/** Parse a non-negative integer, refusing junk and fractions. */
export function nonNegativeInteger(label: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BadInputError(
      `${label} must be a whole number of zero or more, got "${raw}"`,
    );
  }
  return parsed;
}

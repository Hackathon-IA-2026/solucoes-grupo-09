import { BadInputError } from "../errors.js";

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

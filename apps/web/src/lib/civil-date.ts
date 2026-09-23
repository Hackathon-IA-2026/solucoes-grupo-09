/**
 * Walking a civil date, for the two controls that offer a day at a time.
 *
 * It lived in `map/scope-bar.tsx` and is shared now because the app bar grew
 * the same arrows: two copies of date arithmetic is the shape that drifts, and
 * a day is the axis every panel on the network view reads.
 *
 * **UTC midnight, deliberately, for a Brasília civil date.** The string is a
 * civil day — `2026-09-24` — not an instant, and the only thing being done to
 * it is ±1 day. Parsing at UTC midnight and formatting back to ten characters
 * is exact for that: no zone offset can move a date that is only ever
 * incremented by whole days. Parsing it as *local* midnight is what would
 * break, on the two days a year a local day is not 24 hours long — the class
 * of bug `api-routes.md` records as "a UTC day is the wrong day by three hours
 * every day of the year", arriving from the other side.
 */

/** The civil date `days` away, as `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

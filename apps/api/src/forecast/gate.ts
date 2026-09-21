/**
 * `gate_at(target_date, gate_profile)`, on this side of the wire.
 *
 * The gate is D−1 at the profile's local hour, in Brasília civil time. It is
 * spelled in three places and this is the third, which is worth being explicit
 * about rather than quietly adding a fourth:
 *
 * 1. `drizzle/0016_the_feature_gate.sql` — `gate_at(...)`, the authority for
 *    every feature row and therefore for every published `published_at`. The
 *    number that reaches the database comes from *there*, carried out on the
 *    feature rows and through the publication payload; nothing here ever
 *    supplies a `published_at` for a row.
 * 2. `packages/core`'s `GATES` — the published table, from which `/v1/meta`
 *    builds the "tomorrow's view publishes at 19:00 BRT" sentence.
 * 3. this function, which answers a *question about time* rather than producing
 *    a stored value: has the gate for this target date passed yet? That is what
 *    separates `FORECAST_NOT_YET_PUBLISHED` from `FORECAST_UNAVAILABLE`, and it
 *    is the difference between "come back at seven" and "something broke".
 *
 * It reads `GATES` rather than restating an hour, and `localWallClock` rather
 * than subtracting three hours — Brazil has observed no summer time since 2019
 * and a fixed offset would be wrong in every year before it and in any year
 * after a reinstatement.
 */
export { gateAt } from "@wattsteer/core/schedule";

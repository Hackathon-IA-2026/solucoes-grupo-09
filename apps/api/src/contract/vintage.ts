/**
 * The vintage algebra of the canonical read contract.
 *
 * Deliberately dependency-free — no Drizzle, no Postgres, no Elysia. Two
 * reasons, and the second is the load-bearing one:
 *
 * 1. It is the part of the contract that is *arithmetic* rather than I/O, so it
 *    is the part worth testing without a database.
 * 2. It is computed in **two languages**. `apps/ml` re-implements
 *    `vintageFidelity` because a Python consumer that receives rows must be able
 *    to say what it is holding without asking again. A module that dragged the
 *    database in could not be imported by the cross-workspace parity test that
 *    keeps the two implementations honest
 *    (`packages/core/test/canonical-contract.test.ts`).
 *
 * `docs/domain-model.md` §1 is the authority for every name here.
 */

/**
 * Whether an as-of read is honestly point-in-time.
 *
 * Restated from `docs/domain-model.md` §1 because this is the term the contract
 * exports and the modelling side stamps on artifacts:
 *
 * - `point_in_time` — the whole window post-dates WattSteer's ingestion
 *   go-live, so `AsOf` returns what was genuinely knowable.
 * - `revision_optimistic` — the window predates go-live, so the "past" is
 *   ONS's *current* restatement of it. ONS rewrites history in place and prior
 *   vintages are unrecoverable, so this can never be repaired retroactively.
 */
export type VintageFidelity = "point_in_time" | "revision_optimistic";

/**
 * The rule, in one place.
 *
 * A window is point-in-time when its **earliest** valid instant is at or after
 * the first row WattSteer ever ingested for that source. `windowStart` rather
 * than `windowEnd` because fidelity is a property of the weakest hour in the
 * window: one pre-go-live hour makes the whole answer a restatement, and
 * reporting the window as point-in-time because it *ends* after go-live would
 * be the exact dishonesty the enum exists to prevent.
 *
 * `goLiveAt === null` means the source has no rows at all. That is
 * `revision_optimistic`, not `point_in_time`: an empty table has ingested
 * nothing, so it cannot have been watching.
 */
export function vintageFidelity(
  windowStart: Date,
  goLiveAt: Date | null,
): VintageFidelity {
  if (goLiveAt === null) {
    return "revision_optimistic";
  }
  return windowStart.getTime() >= goLiveAt.getTime()
    ? "point_in_time"
    : "revision_optimistic";
}

/** One source's contribution to a composed answer. */
export interface VintageSource {
  /** The canonical read that produced it. */
  read: string;
  vintageFidelity: VintageFidelity;
  goLiveAt: Date | null;
}

/**
 * Fidelity of an answer composed from several reads — the weakest link.
 *
 * A bundle assembled from a point-in-time curtailment series and a
 * revision-optimistic weather series is revision-optimistic as a whole, because
 * a consumer cannot use half of it. Composing by `every` rather than by `some`
 * is what stops the honest half from laundering the other one.
 *
 * An **empty** list is `revision_optimistic`, not vacuously point-in-time: no
 * source was consulted, so nothing was knowable.
 */
export function combineFidelity(sources: readonly VintageSource[]): VintageFidelity {
  if (sources.length === 0) {
    return "revision_optimistic";
  }
  return sources.every((source) => source.vintageFidelity === "point_in_time")
    ? "point_in_time"
    : "revision_optimistic";
}

/**
 * The latest go-live among the sources consulted — the instant from which the
 * whole composition would have been point-in-time.
 *
 * `null` when any source has never ingested anything, because then there is no
 * such instant and reporting the maximum of the others would name a date at
 * which the answer still would not have been knowable.
 */
export function combineGoLive(sources: readonly VintageSource[]): Date | null {
  if (sources.length === 0) {
    return null;
  }
  let latest = 0;
  for (const source of sources) {
    if (source.goLiveAt === null) {
      return null;
    }
    latest = Math.max(latest, source.goLiveAt.getTime());
  }
  return new Date(latest);
}

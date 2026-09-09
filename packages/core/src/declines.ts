import type { BandUnavailableReason } from "./domain.js";

/**
 * The figures this gateway declines to state, and why.
 *
 * Forecaster 25 asks for one surface answering "what does WattSteer decline to
 * tell me, and why", **assembled from the named reasons and never
 * hand-written**. Most of those reasons live in `apps/ml`, where they are
 * assembled by walking the package (`wattsteer_ml/declined.py`) — a reason
 * constant there *is* its own census entry, so declaring one is the whole of
 * the work.
 *
 * This module is the other half, and it exists because one of the eight named
 * absences is not the modelling service's. `band_unavailable_reason` is
 * produced by `apps/api/src/api/grid.ts`: the modelling service publishes
 * `Publication.national = None` and never spells the identity, which is a
 * `packages/core` schema enum. Declaring it here rather than in Python keeps it
 * where it is produced, and keeps one fact from acquiring two spellings.
 *
 * ### What makes this derived rather than a list
 *
 * {@link BAND_UNAVAILABLE_DECLINES} is a `Record` keyed by
 * {@link BandUnavailableReason}, which is the schema's enum. A second member
 * added to `common.schema.json#/$defs/band_unavailable_reason` is therefore a
 * **compile error here** until it has an entry — the mechanism
 * `copy.band.noBand` already uses so that a null band cannot render without the
 * sentence for its absence. `test/declines.test.ts` asserts the same thing at
 * runtime against the schema file, with a non-vacuity guard, because a
 * regenerated type and a hand-edited schema can be one commit apart.
 *
 * An array of entries would have been a list: nothing would fail when a ninth
 * absence arrived without a row. A keyed record cannot be left short.
 *
 * ### Where it is served, and why not on the model card
 *
 * `GET /v1/meta`, merged with the modelling service's half. Not the model card:
 * a card is a property of *one lane's promoted artifact* and refuses with
 * `MODEL_UNAVAILABLE` when nothing is promoted, which is exactly the deployment
 * where a reviewer most needs to know what is not being claimed. `/v1/meta` is
 * already the request that asks what a deployment is, already `no-store`, and
 * already degrades rather than failing.
 *
 * ### Not a product surface
 *
 * Deliberately. These sentences are authored beside the code that withholds
 * the figure, in one language, in the register of a correction regime and a PIT
 * matrix. A bilingual screen over them would need one copy key per member in
 * two dictionaries — a hand-maintained list, keyed to a set that is assembled
 * precisely so that nobody has to maintain one. The screens that *do* meet an
 * individual absence keep rendering it in context and in both locales, which is
 * where a reader of the product needs it; this census is for a reviewer
 * deciding whether to trust the system, and it is on the endpoint a reviewer
 * reads.
 */

/**
 * Whether a figure **cannot** be produced or merely **has not** been.
 *
 * Two members, and they must stay two. `ARCHIVE_FEATURES_HAVE_NO_SHAPE` says a
 * thing cannot be built; forecaster 18 chose `NOT_RUN_YET` specifically so that
 * it would not read like that, and forecaster 24's
 * `MARGINAL_COVERAGE_NOT_RUN_YET` follows 18. A single "unavailable" bucket
 * would destroy the information three tickets were written to create.
 *
 * `/v1/meta` reports a third value, `unresolvable`, and it is not a third kind:
 * it is the gateway refusing to guess between these two for a `kind` a newer
 * modelling service reported and this build does not recognise. See
 * `apps/api/src/api/meta.ts`, which takes the same position on a lane state.
 */
export const DECLINE_KINDS = ["unrunnable", "unrun"] as const;

export type DeclineKind = (typeof DECLINE_KINDS)[number];

/** One figure that is not stated, in the shape `/v1/meta` publishes. */
export interface DeclinedFigure {
  /** The identity or constant name — a grep target, not a label. */
  readonly name: string;
  /** Where the reason is declared, as a repository path. */
  readonly declaredIn: string;
  /** Which figure is withheld, as a noun phrase. */
  readonly figure: string;
  /** `unrunnable` — it cannot be produced. `unrun` — nobody has produced it. */
  readonly kind: DeclineKind;
  /** The sentence, verbatim. */
  readonly reason: string;
  /** The response and field a caller actually meets the absence on. */
  readonly surface: string;
}

/**
 * Every `band_unavailable_reason`, with the figure it withholds.
 *
 * Keyed by the enum so that a new member cannot be added without one.
 */
export const BAND_UNAVAILABLE_DECLINES: Record<BandUnavailableReason, DeclinedFigure> = {
  no_joint_ensemble: {
    name: "no_joint_ensemble",
    declaredIn: "packages/core/src/declines.ts",
    figure: "the national day band — a P10, P50 and P90 over all four subsystems",
    // Unrunnable, not unrun. `api-surface.md`'s own table: a national band is
    // not additive across subsystems and needs a joint distribution. Where no
    // national row was published there is no ensemble to read a quantile off,
    // and nothing in this repository is allowed to fill it by adding the four
    // — a repo-wide scan fails the build on any line that does.
    kind: "unrunnable",
    reason:
      "A quantile of a sum is not the sum of the quantiles, and neither is a " +
      "median: four subsystems' curtailment is not comonotone, so a national " +
      "band can only be read off draws that were taken jointly. Where a " +
      "national day row was published it is exactly that — quantiles over the " +
      "four subsystems' day totals added under one shared draw index — and " +
      "where none was, there is no joint ensemble behind the day and the band " +
      "is withheld. An artifact trained before the shared draw index landed " +
      "published none, and a day whose four subsystem rows disagree about the " +
      "threshold has no single national key to read. Neither case is ever " +
      "filled by adding the four subsystem bands; the national expectation is " +
      "published instead, because expectations do add exactly.",
    surface: "`GET /v1/grid/outlook`, `national.band_unavailable_reason`",
  },
};

/** The table's entries, and never a second list beside it. */
export const GATEWAY_DECLINED_FIGURES: readonly DeclinedFigure[] = Object.values(
  BAND_UNAVAILABLE_DECLINES,
);

import type { Database } from "../database/connection.js";
import {
  type AttributionPublication,
  parseAttributionPublication,
  writeAttributionPublication,
} from "../diagnosis/publication.js";
import { UpstreamError } from "../errors.js";
import { isRecord } from "../json/shape.js";
import {
  type ForecastOriginKind,
  type ForecastPublication,
  type PublicationWriteResult,
  parsePublication,
  writePublication,
} from "./publication.js";

/**
 * The backtest's half of the forecast table: rows that were never published.
 *
 * `docs/specs/replay.md`'s one storage requirement. At the end of a backtest
 * run the modelling service holds a composed band for every held-out day of
 * every fold — `wattsteer_ml.evaluation.holdout` mints them — and this module
 * is where they land. The direction is the serving path's, unchanged: the
 * modelling service is read-only against Postgres, so it computes and this side
 * writes.
 *
 * **Why this is a separate entry point rather than a flag on `publishForecast`.**
 * Two properties, and neither survives a boolean:
 *
 * 1. **This path cannot mint a `served` row.** Every publication in a backfill
 *    is checked to carry `origin_kind = 'backfilled_holdout'` before anything
 *    is written, so a reconstruction can never acquire a record's
 *    discriminator by way of a mis-set argument. `published_at` on these rows
 *    is a *counterfactual* instant — the gate that would have been — and a
 *    counterfactual instant wearing `served` is precisely the row the whole
 *    ticket exists to make unrepresentable.
 * 2. **The serving path is untouched.** `publishForecast` writes what the
 *    modelling service's own publication route returns and that route stamps
 *    `served`; nothing here reaches it and nothing here changes it.
 *
 * The unservability itself is **not** enforced here. It is enforced in
 * `reads.ts`, where `origin_kind = 'served'` is a constant in the SQL of every
 * read `/v1/forecast/day-ahead` and `/v1/meta` perform — no parameter reaches
 * that filter, so there is no query shape, from this module or any other, that
 * can return a backfilled row through the product. What this module guarantees
 * is the other direction: that a row *written* here carries the discriminator
 * that filter is looking for.
 *
 * **Vintage comes for free and is not written here.** `ingested_at` is the real
 * instant of the write — when the backtest ran — so a second backtest run
 * appends a new `data_version` beside the first rather than overwriting it, and
 * a replay pinned to the earlier `AsOf` still reconstructs the earlier numbers.
 * That is `writePublication`'s existing append-only discipline, reused rather
 * than restated: there is no insert in this file.
 */

/** The one origin kind a backfill may carry. A constant, not a parameter. */
export const BACKFILLED_HOLDOUT: ForecastOriginKind = "backfilled_holdout";

/** A backfill that cannot be persisted, and why. Never a partial write. */
export class HoldoutBackfillError extends UpstreamError {
  constructor(message: string) {
    super(`holdout backfill: ${message}`);
    this.name = "HoldoutBackfillError";
  }
}

/** One fold's held-out days, parsed. */
export interface HoldoutBackfill {
  foldId: string;
  /** The artifact that did *not* see these days — every row's `run_label`. */
  artifactId: string;
  lane: string;
  /** Days of the test block that composed no whole publication, named. */
  incompleteDays: string[];
  publications: ForecastPublication[];
  /**
   * What moved each reconstructed forecast — the serving path's own Shapley
   * game over the fold artifact, stamped `backfilled_holdout`. Optional on the
   * wire, because a run from before the backtest minted them carries none, and
   * an absent list is no attributions rather than a malformed run.
   */
  attributions: AttributionPublication[];
}

/** What one backfill did, summed over its days — the shape an operator wants. */
export interface HoldoutBackfillResult extends PublicationWriteResult {
  foldId: string;
  artifactId: string;
  /** How many held-out days were written. */
  days: number;
  /** How many of those days had an attribution written beside them. */
  attributionsWritten: number;
}

function text(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string" || value === "") {
    throw new HoldoutBackfillError(`${field} is ${String(value)}`);
  }
  return value;
}

/**
 * Read a backtest run's payload into publications this gateway can stand behind.
 *
 * The envelope's `origin_kind` and every publication's own must both say
 * `backfilled_holdout`. Both, because they are two different claims: the
 * envelope is what this writer refuses on, and the per-publication field is
 * what reaches the row. A payload in which they disagreed would write rows the
 * envelope does not describe, so it is refused whole rather than half-written.
 */
export function parseHoldoutBackfill(payload: unknown): HoldoutBackfill {
  if (!isRecord(payload)) {
    throw new HoldoutBackfillError("the body is not an object");
  }
  const envelope = text(payload, "origin_kind");
  if (envelope !== BACKFILLED_HOLDOUT) {
    throw new HoldoutBackfillError(
      "a backtest run persists reconstructions and nothing else; this one " +
        `claims origin_kind ${envelope}. A counterfactual published_at under ` +
        "the served discriminator is a forecast the product never made wearing " +
        "the badge of one it did",
    );
  }
  const raw = payload.publications;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HoldoutBackfillError(
      "a backtest run with no publications is not a backtest run. An absence " +
        "is reported upstream and never written as an empty forecast",
    );
  }
  const publications = raw.map((one) => parsePublication(one));
  for (const publication of publications) {
    if (publication.originKind !== BACKFILLED_HOLDOUT) {
      throw new HoldoutBackfillError(
        `${publication.targetDate} arrived in a backfill carrying ` +
          `origin_kind '${publication.originKind}'. The envelope and the rows ` +
          "must make the same claim, and this writer mints no records",
      );
    }
  }
  const artifactId = text(payload, "artifact_id");
  const named = publications.filter((one) => one.artifactId !== artifactId);
  if (named.length > 0) {
    // The `run_label` on every row is the fold artifact's id, and the run is
    // identified by exactly one artifact. A backfill carrying two would make
    // "which model did not see this day" unanswerable from the rows.
    throw new HoldoutBackfillError(
      `${named[0]?.targetDate} names artifact ${named[0]?.artifactId} in a run ` +
        `of ${artifactId}; one fold's holdout is one artifact's`,
    );
  }
  const incompleteDays = Array.isArray(payload.incomplete_days)
    ? payload.incomplete_days.map((day) => String(day))
    : [];
  const attributions = (
    Array.isArray(payload.attributions) ? payload.attributions : []
  ).map((one) => parseAttributionPublication(one));
  for (const attribution of attributions) {
    // The same two claims the forecasts make, for the same reason: an
    // explanation of a reconstruction wearing `served` would reach the live
    // Explain surface, whose read is pinned to that value.
    if (attribution.originKind !== BACKFILLED_HOLDOUT) {
      throw new HoldoutBackfillError(
        `the attribution of ${attribution.targetDate} arrived in a backfill ` +
          `carrying origin_kind '${attribution.originKind}'; this writer mints no records`,
      );
    }
    if (attribution.artifactId !== artifactId) {
      throw new HoldoutBackfillError(
        `the attribution of ${attribution.targetDate} names artifact ` +
          `${attribution.artifactId} in a run of ${artifactId}; the bars must ` +
          "decompose the band they are shown beside",
      );
    }
    const explained = publications.find(
      (one) =>
        one.targetDate === attribution.targetDate &&
        one.publishedAt.getTime() === attribution.publishedAt.getTime(),
    );
    if (explained === undefined) {
      throw new HoldoutBackfillError(
        `the attribution of ${attribution.targetDate} explains no forecast in ` +
          "this run. An explanation without its band is written nowhere",
      );
    }
  }
  return {
    foldId: text(payload, "fold_id"),
    artifactId,
    lane: text(payload, "lane"),
    incompleteDays,
    publications,
    attributions,
  };
}

/**
 * Persist one fold's held-out days.
 *
 * One transaction **per day**, not one for the run: a day is the unit a replay
 * reads and the unit `writePublication` already makes atomic, and a 90-day
 * fold's ~8,600 rows in a single transaction would buy nothing a replay can
 * observe. A run that fails halfway leaves whole days behind it, never a day
 * whose hours and day band came from different writes.
 */
export async function writeHoldoutBackfill(
  db: Database,
  backfill: HoldoutBackfill,
  options: { ingestedAt?: Date } = {},
): Promise<HoldoutBackfillResult> {
  const result: HoldoutBackfillResult = {
    foldId: backfill.foldId,
    artifactId: backfill.artifactId,
    days: 0,
    attributionsWritten: 0,
    hoursInserted: 0,
    hoursRevised: 0,
    hoursUnchanged: 0,
    daysInserted: 0,
    daysRevised: 0,
    daysUnchanged: 0,
    nationalInserted: 0,
    nationalRevised: 0,
    nationalUnchanged: 0,
  };
  for (const publication of backfill.publications) {
    // `ingestedAt` is the real instant the backtest's rows were written, and it
    // is the same one for every day of the run — so an `AsOf` between two runs
    // sees one whole run and never half of each.
    const written = await writePublication(db, publication, {
      ...(options.ingestedAt === undefined ? {} : { ingestedAt: options.ingestedAt }),
    });
    result.days += 1;
    result.hoursInserted += written.hoursInserted;
    result.hoursRevised += written.hoursRevised;
    result.hoursUnchanged += written.hoursUnchanged;
    result.daysInserted += written.daysInserted;
    result.daysRevised += written.daysRevised;
    result.daysUnchanged += written.daysUnchanged;
    result.nationalInserted += written.nationalInserted;
    result.nationalRevised += written.nationalRevised;
    result.nationalUnchanged += written.nationalUnchanged;
  }
  // After the forecasts, never before: an attribution names the publication it
  // explains, and a run that failed halfway must not leave bars behind with no
  // band to stand beside. Idempotent by digest, like the forecasts, so a retry
  // writes nothing twice.
  for (const attribution of backfill.attributions) {
    await writeAttributionPublication(db, attribution, {
      ...(options.ingestedAt === undefined ? {} : { ingestedAt: options.ingestedAt }),
    });
    result.attributionsWritten += 1;
  }
  return result;
}

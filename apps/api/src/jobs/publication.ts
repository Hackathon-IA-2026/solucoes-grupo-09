import { GRID_TIME_ZONE, latestTargetDate } from "@wattsteer/core/scenario-validation";
import type { MlEndpoint } from "../api/ml-proxy.js";
import type { Database } from "../database/connection.js";
import { AppError, CodedError } from "../errors.js";
import { gateAt } from "../forecast/gate.js";
import type { ForecastGateProfile } from "../forecast/publication.js";
import { type PublishForecastResult, publishForecast } from "../forecast/publish.js";
import type { Execute, JobSchedule, ReportProgress } from "./types.js";

/**
 * The forecast publication, as work the schedule owns.
 *
 * `docs/specs/api-surface.md`'s boundary decision, made real: **the forecast is
 * a row a schedule wrote, not an inference a page view triggered.** Ten minutes
 * after each gate the worker asks the modelling service for tomorrow, and
 * the *worker* writes what comes back. `forecast/publish.ts` is the unit of work;
 * this module is when it runs, which day it asks for, and what it does when the
 * answer is a refusal.
 *
 * Three things live here and nowhere else:
 *
 * 1. **The schedule table.** Two repeatable jobs, `10 9` and `10 19` in
 *    `America/Sao_Paulo`, on the existing queue and the existing Redis — no
 *    second scheduler, per `data-platform.md`. Ten minutes *after* the gate,
 *    not on it, because the gate is when the inputs become knowable, not when
 *    the job may start.
 * 2. **Which day is published.** Tomorrow in Brasília, resolved here from the
 *    clock rather than defaulted by the modelling service, so that the instant
 *    the row will carry — `gate_at(target_date, gate_profile)` — is known on
 *    this side *before* the call and can be checked against what comes back.
 * 3. **What a missing input means.** See `describeFailure` below: the measured
 *    behaviour of ONS's evening publication makes "the inputs are not there
 *    yet" a routine outcome of the 19:10 run rather than an exotic one, and it
 *    is named, logged and retried as its own condition instead of arriving as
 *    an anonymous 404 in a job log.
 */

/** The zone the two cron patterns are read in. Brasília civil time, always. */
export const PUBLICATION_TIME_ZONE = GRID_TIME_ZONE;

/**
 * The lanes the two gate jobs publish.
 *
 * The lane is the addressable unit — feature set, gate profile and threshold in
 * one directory name — so the schedule names one rather than three loose fields
 * that could disagree. `apps/ml`'s `Lane.parse` is the authority on the
 * spelling; these two are the promoted pair `docs/specs/api-surface.md` names.
 */
export const PUBLICATION_LANES: Readonly<Record<ForecastGateProfile, string>> = {
  gate_early: "dessem_free_v1__gate_early__thr5",
  gate_late: "dessem_free_v1__gate_late__thr5",
};

/** What the queue carries for one publication. */
export interface PublishForecastPayload {
  gateProfile: ForecastGateProfile;
  /** The lane directory name — `dessem_free_v1__gate_late__thr5`. */
  lane: string;
  /**
   * The civil day to publish. Absent means tomorrow in Brasília, resolved when
   * the job runs — which is what the two repeatable jobs carry, so that a
   * schedule registered once does not pin a date it will still be asking for a
   * year later.
   */
  targetDate?: string;
}

/** One repeatable publication, as the worker registers it. */
export interface PublicationSchedule {
  /** `publish-forecast:gate_late` — the id the spec's table names. */
  id: string;
  /** Cron, read in `PUBLICATION_TIME_ZONE`. */
  pattern: string;
  payload: PublishForecastPayload;
}

/**
 * The two repeatable jobs, exactly as `docs/specs/api-surface.md` tabulates
 * them. Late first, in the order `GATES` publishes: the late gate is the one a
 * reader is usually waiting for, because it supersedes the early one.
 */
export const FORECAST_PUBLICATIONS: readonly PublicationSchedule[] = [
  {
    id: "publish-forecast:gate_late",
    pattern: "10 19 * * *",
    payload: { gateProfile: "gate_late", lane: PUBLICATION_LANES.gate_late },
  },
  {
    id: "publish-forecast:gate_early",
    pattern: "10 9 * * *",
    payload: { gateProfile: "gate_early", lane: PUBLICATION_LANES.gate_early },
  },
];

/**
 * What one publication run did.
 *
 * `outcome` is a summary of the counts rather than a second source of truth:
 * `unchanged` is the re-run case — every digest matched, so the transaction
 * wrote no row and did not inflate `data_version`. It is called out because it
 * is what makes a redelivery, a manual re-submit and a catch-up run safe, and
 * an operator reading a job log should be able to see that nothing happened on
 * purpose.
 */
export type PublicationOutcome = "published" | "unchanged";

export interface ForecastPublicationResult
  extends Omit<PublishForecastResult, "publishedAt"> {
  gateProfile: ForecastGateProfile;
  outcome: PublicationOutcome;
  /** `gate_at(target_date, gate_profile)`, as an instant on the wire. */
  publishedAt: string;
}

export interface ForecastPublisherDeps {
  db: Database;
  /**
   * Where the modelling service is. Absent means `config.mlUrl` at the
   * publication timeout — overridable so a test can point at a stub over a
   * real socket without a network.
   */
  endpoint?: MlEndpoint;
  /** The clock, injected so "tomorrow in Brasília" is testable. */
  now?: () => Date;
}

/**
 * Why a publication did not happen, in the operator's vocabulary.
 *
 * **This is the missing-input decision, made explicit rather than incidental.**
 * `feature-engineering` ticket 12 measured ONS's evening publication landing at
 * 19:00:25–19:08 BRT — *after* the 19:00 late gate — and projected the balance
 * and curtailment files' staleness to ~43.7 h against a configured 40 h lag.
 * Nothing was changed there, because one day is not a series and a lag change
 * is a migration plus a retrain. But it makes this exact sentence routine: the
 * 19:10 job can find a promoted model and no feature rows.
 *
 * So the job does not treat that as an outage and does not invent a row:
 *
 * - it **writes nothing** — the refusal is raised by the modelling service
 *   before any payload exists, so there is no partial publication to roll back
 *   and no empty band to serve;
 * - it **rethrows**, so the queue's existing `attempts`/backoff policy retries
 *   it — which is the repair for inputs that are minutes late;
 * - on exhaustion it **leaves the previous origin serving**, with its real age
 *   on `forecast_origin` and on `/v1/meta`. That is the degradation the
 *   boundary decision promises, not a failure mode it forgot; the alternative,
 *   a publication of zeros, is the invented number the whole spec is against;
 * - and the next gate's job publishes the same target date independently, so a
 *   lost 09:10 run is superseded rather than compensated.
 *
 * A publication instant passing with no new origin is *visible* — `/v1/meta`
 * and `forecast_origin.age_hours` — and not *alerted*. The spec carries that
 * weakness deliberately and names the alert as the follow-up.
 */
function describeFailure(error: unknown): string {
  const code = error instanceof AppError ? error.code : undefined;
  switch (code) {
    case "FORECAST_UNAVAILABLE":
      return (
        "the model is promoted and its inputs are not there yet. ONS's evening " +
        "publication has been measured landing at 19:00:25–19:08 BRT, so a run " +
        "ten minutes after the gate can legitimately be early; the queue will " +
        "retry, nothing was written, and the previous origin keeps serving with " +
        "its real age"
      );
    case "MODEL_UNAVAILABLE":
      return "no artifact is promoted in this lane — a promotion, not a retry";
    case "DATA_UNAVAILABLE":
      return "the modelling service cannot reach Postgres";
    case "SERVICE_BUSY":
      return "the modelling service did not answer inside the publication budget";
    default:
      return `the publication did not complete: ${
        error instanceof Error ? error.message : String(error)
      }`;
  }
}

/**
 * Build the handler the worker runs for a `publish_forecast` task.
 *
 * Every write in this product belongs to the service that owns the Drizzle
 * schema, so the call is **worker → modelling service** and the write is
 * `writePublication`'s single transaction. Nothing in the request path reaches
 * this function: it is constructed in `worker.ts` and is not importable from a
 * route without importing the worker's dispatcher, which no route does.
 */
export function createForecastPublisher(
  deps: ForecastPublisherDeps,
): Execute<PublishForecastPayload, ForecastPublicationResult> {
  const clock = deps.now ?? (() => new Date());

  return async (
    payload: PublishForecastPayload,
    report: ReportProgress,
  ): Promise<ForecastPublicationResult> => {
    const now = clock();
    const targetDate = payload.targetDate ?? latestTargetDate(now);
    const gate = gateAt(targetDate, payload.gateProfile);

    // The gate is the publication instant of every row this run will write, so
    // a run that beats it would stamp rows with an assertion nobody has made
    // yet. Ten minutes of slack is the schedule's, not a tolerance: a job that
    // finds itself ahead of its own gate is a mis-set cron or a hand-submitted
    // day, and both are worth refusing before the modelling service spends two
    // minutes drawing an ensemble for them.
    if (now.getTime() < gate.getTime()) {
      throw new CodedError(
        "FORECAST_NOT_YET_PUBLISHED",
        `${payload.lane}: the ${payload.gateProfile} gate for ${targetDate} is at ` +
          `${gate.toISOString()} and it is ${now.toISOString()}. The publication ` +
          "instant is the gate, so there is nothing to publish yet.",
        { details: { lane: payload.lane, target_date: targetDate } },
      );
    }

    report({ done: 0, total: 1 });
    let published: PublishForecastResult;
    try {
      published = await publishForecast(deps.db, {
        lane: payload.lane,
        targetDate,
        // The instant the rows must carry, checked against the payload before
        // the first insert. `published_at` comes off the feature rows, which
        // Postgres stamped with `gate_at(target_date, gate_profile)`; this side
        // knows the same answer independently, and a disagreement is a bug in
        // one of the two rather than a row to write and find out about later.
        expectPublishedAt: gate,
        // The run's own clock, so that one publication has one `ingested_at`
        // and it is the instant the job started rather than whenever the
        // transaction happened to open. `ingested_at` is the `AsOf` axis — when
        // WattSteer *knew* this — and it is a different question from
        // `published_at`, which is when the producer asserted it.
        ingestedAt: now,
        ...(deps.endpoint === undefined ? {} : { endpoint: deps.endpoint }),
      });
    } catch (error) {
      console.warn(
        `⚠️  publish-forecast:${payload.gateProfile} ${targetDate} — ` +
          `${describeFailure(error)}`,
      );
      // Rethrown as itself: the modelling service's code — `MODEL_UNAVAILABLE`,
      // `FORECAST_UNAVAILABLE` — survived the crossing through `ml-proxy`'s
      // mapping, and flattening it here would cost the one bit an operator
      // needs, which is whether to wait or to promote.
      throw error;
    }
    report({ done: 1, total: 1 });

    const wrote =
      published.hoursInserted +
      published.hoursRevised +
      published.daysInserted +
      published.daysRevised;
    return {
      ...published,
      gateProfile: payload.gateProfile,
      outcome: wrote > 0 ? "published" : "unchanged",
      publishedAt: published.publishedAt.toISOString(),
    };
  };
}

/**
 * The two schedules, as `JobSchedule`s over the worker's task union.
 *
 * Registering is idempotent — the ids are stable, so N replicas starting at
 * once converge on one schedule apiece rather than N — and it is BullMQ's job
 * scheduler that makes the run leader-safe, which is the whole reason the
 * repeatable job lives on the queue rather than beside it.
 */
export function publicationSchedules<TPayload>(
  wrap: (payload: PublishForecastPayload) => TPayload,
): JobSchedule<TPayload>[] {
  return FORECAST_PUBLICATIONS.map((publication) => ({
    id: publication.id,
    pattern: publication.pattern,
    timeZone: PUBLICATION_TIME_ZONE,
    payload: wrap(publication.payload),
  }));
}

import type { MlEndpoint } from "../api/ml-proxy.js";
import type { Database } from "../database/connection.js";
import { type PublishDiagnosisResult, publishDiagnosis } from "../diagnosis/publish.js";
import { type ReasonMix, readRecentReasonMix } from "../diagnosis/reason-mix.js";
import { AppError } from "../errors.js";
import { gateAt } from "../forecast/gate.js";
import type { ForecastGateProfile } from "../forecast/publication.js";
import type { SubsystemCode } from "../ingest/normalise.js";
import type { Execute, ReportProgress } from "./types.js";

/**
 * The diagnosis publication, as work the schedule owns — but not as a cron.
 *
 * `docs/specs/api-surface.md`'s job table gives `publish-diagnosis` the trigger
 * **"on completion of each above"**, and that is the one entry in the table that
 * is not a cron pattern. It is a follow-on task, submitted onto the same queue
 * by the forecast publication that just finished, and `jobs/worker-tasks.ts` is
 * where the chaining happens.
 *
 * Three properties, each of which is why it is a *separate task* rather than a
 * second half of the forecast publisher:
 *
 * 1. **Separate retry budgets.** A forecast publication is an artifact load, a
 *    feature build and a 500-member ensemble draw; an attribution is a grouped
 *    Shapley decomposition on top of it. Retrying the pair because the second
 *    failed would redo the first — safe, because both are idempotent by digest,
 *    and wasteful twice a day forever. Failing the pair because the second
 *    failed would also mark a forecast publication that *did* write its rows as
 *    a failed job, which is the wrong signal to the one thing watching.
 * 2. **The day is pinned, not re-resolved.** The payload carries the target
 *    date the forecast publication actually wrote, so a follow-on that runs a
 *    few seconds after midnight in Brasília explains the day the forecast is
 *    for rather than the next one. Resolving "tomorrow" twice is how the two
 *    publications end up describing different days.
 * 3. **The reason mix is read here.** `unmodelled_outage_regime` needs the most
 *    recent settled day's reported reason shares for the subsystem, and it is
 *    the worker that holds the Postgres handle. See `diagnosis/reason-mix.ts`
 *    for the read and `diagnosis/publish.ts` for why it is read on this side.
 *
 * ## What is deliberately *not* here
 *
 * No cron pattern, because the trigger is a completion. No catch-up schedule,
 * for the reason the forecast publication has none: `writeAttributionPublication`
 * is idempotent by digest, so a re-submitted task writes nothing when the
 * numbers have not changed and appends a version when they have.
 */

/** What the queue carries for one diagnosis publication. */
export interface PublishDiagnosisPayload {
  gateProfile: ForecastGateProfile;
  /** The lane directory name — `dessem_free_v1__gate_late__thr5`. */
  lane: string;
  /**
   * The civil day to explain. **Required**, unlike the forecast publication's,
   * which resolves tomorrow from its own clock: this task is triggered by a
   * publication that has already decided which day it wrote.
   */
  targetDate: string;
}

/** What one diagnosis publication run did. */
export type DiagnosisOutcome = "published" | "unchanged";

export interface DiagnosisPublicationResult
  extends Omit<PublishDiagnosisResult, "publishedAt"> {
  outcome: DiagnosisOutcome;
  /** `gate_at(target_date, gate_profile)`, as an instant on the wire. */
  publishedAt: string;
}

export interface DiagnosisPublisherDeps {
  db: Database;
  /**
   * Where the modelling service is. Absent means `config.mlUrl` at the
   * publication timeout — overridable so a test can point at a stub over a
   * real socket without a network.
   */
  endpoint?: MlEndpoint;
  /** The clock, injected so one run has one `ingested_at`. */
  now?: () => Date;
}

/** The four subsystems a reason mix is read for. `SIN` is not one of them. */
const SUBSYSTEMS: readonly SubsystemCode[] = ["N", "NE", "S", "SE"];

/**
 * Why a diagnosis publication did not happen, in the operator's vocabulary.
 *
 * The forecast publisher's `describeFailure`, with the one condition that is
 * peculiar to this grain spelled out: an attribution needs a *matched
 * background* to measure "typical" against, and the artifact's frozen sample is
 * a hand-back `docs/specs/diagnosis.md` names and the forecaster has not
 * landed. Until it does, a live `apps/ml` has the rows and no `typical`, and
 * that is a promotion-shaped problem rather than a retry-shaped one — so it is
 * named rather than folded into "the inputs are not there".
 */
function describeFailure(error: unknown): string {
  const code = error instanceof AppError ? error.code : undefined;
  switch (code) {
    case "FORECAST_UNAVAILABLE":
      return (
        "the model is promoted and the attribution's inputs are not there yet " +
        "— either the day's feature rows or the matched background the bars " +
        "are measured against; the queue will retry and nothing was written"
      );
    case "MODEL_UNAVAILABLE":
      return "no artifact is promoted in this lane — a promotion, not a retry";
    case "DATA_UNAVAILABLE":
      return "the modelling service cannot reach Postgres";
    case "SERVICE_BUSY":
      return "the modelling service did not answer inside the publication budget";
    case "UPSTREAM_REJECTED":
      // What a missing route looks like through `ml-proxy`: a 404 that named no
      // code the closed enum knows keeps its status and becomes this. Named
      // because it is the *expected* answer today —
      // `/internal/publish/diagnosis` is `apps/ml`'s half of this chain and is
      // blocked on the forecaster's matched background sample in the artifact
      // bundle — and an operator reading a job log should be told that rather
      // than left to read "upstream rejected" as a bug in the payload.
      return (
        "the modelling service refused the attribution request. If this is a " +
        "404, it serves no /internal/publish/diagnosis route yet — that half " +
        "is blocked on the forecaster's matched background sample in the " +
        "artifact bundle. The forecast is unaffected and keeps serving without " +
        "an explanation beside it"
      );
    default:
      return `the publication did not complete: ${
        error instanceof Error ? error.message : String(error)
      }`;
  }
}

/**
 * Read the reason mix for every subsystem, as far as it is readable.
 *
 * One read per subsystem rather than one grouped read, because the qualifying
 * settled day is resolved *per subsystem* — the most recent day the N has
 * restricted energy for is not necessarily the NE's, and a single greatest date
 * across the four would silently report one subsystem's day as another's.
 *
 * A subsystem whose read finds nothing is left out of the map, and one whose
 * read *fails* is left out with a warning rather than failing the publication:
 * the attribution is the deliverable and `unmodelled_outage_regime` is one
 * annotation on it. That is the one place in this file where an absence is
 * tolerated, and it is tolerated in the direction that cannot invent anything —
 * the rule does not fire.
 */
async function readReasons(
  deps: DiagnosisPublisherDeps,
  payload: PublishDiagnosisPayload,
  asOf: Date,
): Promise<Partial<Record<SubsystemCode, ReasonMix>>> {
  const mixes: Partial<Record<SubsystemCode, ReasonMix>> = {};
  for (const subsystem of SUBSYSTEMS) {
    try {
      const mix = await readRecentReasonMix(deps.db, {
        subsystem,
        targetDate: payload.targetDate,
        gateProfile: payload.gateProfile,
        asOf,
      });
      if (mix !== null) {
        mixes[subsystem] = mix;
      }
    } catch (error) {
      console.warn(
        `⚠️  publish-diagnosis:${payload.gateProfile} ${payload.targetDate} — ` +
          `${subsystem}'s reason mix could not be read, so ` +
          "unmodelled_outage_regime cannot fire for it: " +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return mixes;
}

/**
 * Build the handler the worker runs for a `publish_diagnosis` task.
 *
 * Nothing in the request path reaches this function: it is constructed in
 * `worker.ts` and is not importable from a route without importing the worker's
 * dispatcher, which no route does — the same structural property
 * `forecast-publication-job.test.ts` asserts for the forecast half.
 */
export function createDiagnosisPublisher(
  deps: DiagnosisPublisherDeps,
): Execute<PublishDiagnosisPayload, DiagnosisPublicationResult> {
  const clock = deps.now ?? (() => new Date());

  return async (
    payload: PublishDiagnosisPayload,
    report: ReportProgress,
  ): Promise<DiagnosisPublicationResult> => {
    const now = clock();
    // The instant the rows will carry. Derived from the pinned target date and
    // the gate profile, so it is the same instant the forecast rows this
    // explains already carry — never this run's clock.
    const gate = gateAt(payload.targetDate, payload.gateProfile);

    report({ done: 0, total: 2 });
    const recentReasons = await readReasons(deps, payload, now);
    report({ done: 1, total: 2 });

    let published: PublishDiagnosisResult;
    try {
      published = await publishDiagnosis(deps.db, {
        lane: payload.lane,
        targetDate: payload.targetDate,
        expectPublishedAt: gate,
        recentReasons,
        // One publication, one `ingested_at`, and it is the instant the job
        // started — the `AsOf` axis, which is a different question from
        // `published_at`.
        ingestedAt: now,
        ...(deps.endpoint === undefined ? {} : { endpoint: deps.endpoint }),
      });
    } catch (error) {
      console.warn(
        `⚠️  publish-diagnosis:${payload.gateProfile} ${payload.targetDate} — ` +
          `${describeFailure(error)}`,
      );
      // Rethrown as itself, so the queue retries under the existing attempts
      // policy and an operator reads a cause rather than "job failed".
      throw error;
    }
    report({ done: 2, total: 2 });

    const wrote = published.attributionsInserted + published.attributionsRevised;
    return {
      ...published,
      outcome: wrote > 0 ? "published" : "unchanged",
      publishedAt: published.publishedAt.toISOString(),
    };
  };
}

/**
 * The follow-on task a finished forecast publication submits.
 *
 * A function rather than an inline object literal so that the one place that
 * knows how a forecast publication becomes a diagnosis publication is named,
 * and so a test can assert the mapping without running either.
 */
export function diagnosisFollowOn(publication: {
  gateProfile: ForecastGateProfile;
  lane: string;
  targetDate: string;
}): PublishDiagnosisPayload {
  return {
    gateProfile: publication.gateProfile,
    lane: publication.lane,
    targetDate: publication.targetDate,
  };
}

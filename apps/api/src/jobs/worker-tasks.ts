import {
  createIngestDispatcher,
  type IngestDispatcherDeps,
  type QueueTask,
  type QueueTaskResult,
} from "../ingest/index.js";
import {
  createDiagnosisPublisher,
  type DiagnosisPublicationResult,
  type DiagnosisPublisherDeps,
  diagnosisFollowOn,
  type PublishDiagnosisPayload,
} from "./diagnosis-publication.js";
import {
  createHoldoutBackfiller,
  type HoldoutBackfillerDeps,
  type HoldoutBackfillJobResult,
  type HoldoutBackfillPayload,
  holdoutBackfillSchedules,
} from "./holdout-backfill.js";
import {
  createForecastPublisher,
  type ForecastPublicationResult,
  type ForecastPublisherDeps,
  type PublishForecastPayload,
  publicationSchedules,
} from "./publication.js";
import {
  createRetrainer,
  type RetrainerDeps,
  type RetrainPayload,
  type RetrainResult,
  retrainSchedules,
} from "./retrain.js";
import type { Execute, JobSchedule } from "./types.js";

/**
 * Everything the worker's one queue carries.
 *
 * The queue already had a tagged union and one handler — `ingest/dispatch.ts`,
 * whose argument is that the alternative is a queue per source, which is a
 * second scheduler wearing a hat. The publication is the first task that is not
 * an ingestion at all: it acquires nothing from ONS, has no source, no period
 * and no vintage, and it *calls out to the modelling service*. So it joins the
 * union one level up rather than inside the ingest dispatcher, and the two
 * dispatchers compose: the ingest one still owns every ingestion, the sweep,
 * the retention pass and the drift watch, and this one adds the publication and
 * delegates the rest.
 *
 * That layering is also what keeps the boundary structural. `publish_forecast`
 * is reachable only from a module the worker imports; nothing under `src/api/`
 * imports this file, `jobs/publication.ts` or `forecast/publish.ts`, so
 * "the gateway never calls the modelling service for a forecast" is a property
 * of the dependency graph rather than a rule someone has to remember.
 */
export type WorkerTask =
  | QueueTask
  | { kind: "publish_forecast"; payload: PublishForecastPayload }
  | { kind: "publish_diagnosis"; payload: PublishDiagnosisPayload }
  | { kind: "retrain"; payload: RetrainPayload }
  | { kind: "holdout_backfill"; payload: HoldoutBackfillPayload };

/** What a worker task produced. */
export type WorkerTaskResult =
  | QueueTaskResult
  | { kind: "publish_forecast"; result: ForecastPublicationResult }
  | { kind: "publish_diagnosis"; result: DiagnosisPublicationResult }
  | { kind: "retrain"; result: RetrainResult }
  | { kind: "holdout_backfill"; result: HoldoutBackfillJobResult };

export interface WorkerDispatcherDeps extends IngestDispatcherDeps {
  /**
   * Where the modelling service is, and the clock the publication reads
   * "tomorrow" from. Both optional: the defaults are `config.mlUrl` at the
   * publication timeout and the system clock.
   */
  publication?: Omit<ForecastPublisherDeps, "db">;
  /**
   * Where the modelling service is, and the clock, for the attribution half.
   * Its own field rather than a reuse of `publication`'s: the two call
   * different routes with different budgets, and a test that wanted to stub one
   * and not the other could not say so through one setting.
   */
  diagnosis?: Omit<DiagnosisPublisherDeps, "db">;
  /**
   * How this dispatcher puts a follow-on task back on the queue.
   *
   * `docs/specs/api-surface.md` gives `publish-diagnosis` the trigger "on
   * completion of each" forecast publication — the one row of the job table
   * that is not a cron pattern. So the completion has to be able to enqueue,
   * and the dispatcher cannot reach the runner directly: the runner is
   * built *from* the dispatcher, so holding one would be a cycle.
   * `worker.ts` closes the loop by passing a thunk over the runner it is about
   * to build.
   *
   * Absent means the chain is off, which is what every test of the ingest
   * dispatcher and every in-process runner gets: a forecast publication still
   * publishes, and nothing is submitted. Said rather than defaulted, so a
   * deployment with no chain is a visible choice.
   */
  submit?: (task: WorkerTask) => Promise<unknown>;
  /**
   * Where the modelling service is, and the clock the retrain reads its run id
   * from. Both optional: the defaults are `config.mlUrl` at the retrain timeout
   * and the system clock.
   */
  retrain?: RetrainerDeps;
  /**
   * Where the modelling service is, the clock the backfill stamps a run's one
   * `ingested_at` from, and — for a test — the writer. `db` comes from the
   * dispatcher's own, because a backfill that wrote to a second database would
   * be a second gateway.
   */
  holdoutBackfill?: Omit<HoldoutBackfillerDeps, "db">;
}

/** Build the single handler `worker.ts` registers on the queue. */
export function createWorkerDispatch(
  deps: WorkerDispatcherDeps,
): Execute<WorkerTask, WorkerTaskResult> {
  const ingest = createIngestDispatcher(deps);
  const publish = createForecastPublisher({ db: deps.db, ...deps.publication });
  const explain = createDiagnosisPublisher({ db: deps.db, ...deps.diagnosis });
  const retrain = createRetrainer(deps.retrain);
  const backfill = createHoldoutBackfiller({ db: deps.db, ...deps.holdoutBackfill });

  return async (task, report) => {
    if (task.kind === "publish_forecast") {
      const result = await publish(task.payload, report);
      await chainDiagnosis(deps, task.payload.lane, result);
      return { kind: "publish_forecast", result };
    }
    if (task.kind === "publish_diagnosis") {
      return { kind: "publish_diagnosis", result: await explain(task.payload, report) };
    }
    if (task.kind === "retrain") {
      return { kind: "retrain", result: await retrain(task.payload, report) };
    }
    if (task.kind === "holdout_backfill") {
      return {
        kind: "holdout_backfill",
        result: await backfill(task.payload, report),
      };
    }
    return ingest(task, report);
  };
}

/**
 * Submit the diagnosis publication for a forecast publication that finished.
 *
 * **On completion, and after the return value is in hand** — so the day the
 * attribution explains is the day the forecast publication actually wrote,
 * read off its result rather than resolved from a clock a second time. A
 * follow-on that recomputed "tomorrow in Brasília" a few seconds after
 * midnight would explain the wrong day.
 *
 * **On `unchanged` as well as on `published`.** A forecast publication that
 * wrote nothing is a re-run whose numbers matched; it says nothing about
 * whether the *attribution* exists, and the attribution has its own digest, its
 * own vintage and its own way of having failed last time. The submission is
 * cheap and `writeAttributionPublication` is idempotent, so the cost of
 * chaining unconditionally is one modelling call and the cost of not doing so
 * is a day that never gets its explanation because the forecast half had
 * already succeeded.
 *
 * **A failed submission does not fail the forecast publication.** The rows are
 * written and the transaction is committed by the time this runs; throwing here
 * would mark a publication that succeeded as failed and hand the whole job back
 * for a retry that would rewrite nothing. So the failure is loud and the job
 * still reports what it did. What is lost is one day's explanation, which
 * `/v1/diagnosis/day-ahead` reports as its own absence, and which a
 * hand-submitted task repairs.
 */
async function chainDiagnosis(
  deps: WorkerDispatcherDeps,
  lane: string,
  result: ForecastPublicationResult,
): Promise<void> {
  if (deps.submit === undefined) {
    return;
  }
  const payload = diagnosisFollowOn({
    gateProfile: result.gateProfile,
    lane,
    targetDate: result.targetDate,
  });
  try {
    await deps.submit({ kind: "publish_diagnosis", payload });
  } catch (error) {
    console.warn(
      `⚠️  publish-forecast:${result.gateProfile} ${result.targetDate} published ` +
        "and the diagnosis publication could not be queued after it, so this " +
        "day will have a forecast and no explanation beside it: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The two repeatable publications, typed for this queue.
 *
 * Kept beside the union rather than in `publication.ts` so that the module
 * which knows the cron patterns does not have to know what else the queue
 * carries.
 */
export function forecastPublicationSchedules(): JobSchedule<WorkerTask>[] {
  return publicationSchedules<WorkerTask>((payload) => ({
    kind: "publish_forecast",
    payload,
  }));
}

/**
 * The one repeatable retrain, typed for this queue.
 *
 * Beside the publication's, for the same reason: the module that knows the cron
 * pattern does not have to know what else the queue carries. It is a separate
 * function rather than a second entry in `forecastPublicationSchedules` because
 * the two are registered under different conditions — the publications need a
 * modelling service to *ask*, the retrain needs one to *run in*, and the worker
 * says so about each of them separately.
 */
export function retrainScheduleForQueue(): JobSchedule<WorkerTask>[] {
  return retrainSchedules<WorkerTask>((payload) => ({ kind: "retrain", payload }));
}

/**
 * The one repeatable holdout backfill, typed for this queue.
 *
 * Beside the retrain's, and registered separately for the same reason the
 * retrain's is registered separately from the publications': the publications
 * need a modelling service to *ask*, the retrain needs one to *run in*, and
 * this one needs both that and a database to write into. The worker says so
 * about each of them on its own.
 */
export function holdoutBackfillScheduleForQueue(): JobSchedule<WorkerTask>[] {
  return holdoutBackfillSchedules<WorkerTask>((payload) => ({
    kind: "holdout_backfill",
    payload,
  }));
}

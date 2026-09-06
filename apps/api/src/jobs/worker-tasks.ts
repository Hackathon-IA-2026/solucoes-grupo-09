import {
  createIngestDispatcher,
  type IngestDispatcherDeps,
  type QueueTask,
  type QueueTaskResult,
} from "../ingest/index.js";
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
  | { kind: "retrain"; payload: RetrainPayload }
  | { kind: "holdout_backfill"; payload: HoldoutBackfillPayload };

/** What a worker task produced. */
export type WorkerTaskResult =
  | QueueTaskResult
  | { kind: "publish_forecast"; result: ForecastPublicationResult }
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
  const retrain = createRetrainer(deps.retrain);
  const backfill = createHoldoutBackfiller({ db: deps.db, ...deps.holdoutBackfill });

  return async (task, report) => {
    if (task.kind === "publish_forecast") {
      return { kind: "publish_forecast", result: await publish(task.payload, report) };
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

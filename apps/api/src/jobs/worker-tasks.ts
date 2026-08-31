import {
  createIngestDispatcher,
  type IngestDispatcherDeps,
  type QueueTask,
  type QueueTaskResult,
} from "../ingest/index.js";
import {
  createForecastPublisher,
  type ForecastPublicationResult,
  type ForecastPublisherDeps,
  type PublishForecastPayload,
  publicationSchedules,
} from "./publication.js";
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
  | { kind: "publish_forecast"; payload: PublishForecastPayload };

/** What a worker task produced. */
export type WorkerTaskResult =
  | QueueTaskResult
  | { kind: "publish_forecast"; result: ForecastPublicationResult };

export interface WorkerDispatcherDeps extends IngestDispatcherDeps {
  /**
   * Where the modelling service is, and the clock the publication reads
   * "tomorrow" from. Both optional: the defaults are `config.mlUrl` at the
   * publication timeout and the system clock.
   */
  publication?: Omit<ForecastPublisherDeps, "db">;
}

/** Build the single handler `worker.ts` registers on the queue. */
export function createWorkerDispatch(
  deps: WorkerDispatcherDeps,
): Execute<WorkerTask, WorkerTaskResult> {
  const ingest = createIngestDispatcher(deps);
  const publish = createForecastPublisher({ db: deps.db, ...deps.publication });

  return async (task, report) => {
    if (task.kind === "publish_forecast") {
      return { kind: "publish_forecast", result: await publish(task.payload, report) };
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

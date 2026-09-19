import type { Database } from "../database/connection.js";
import type { Execute, ReportProgress } from "../jobs/index.js";
import type { PayloadArchive } from "./archive.js";
import { createConstrainedOffDetailIngestor } from "./constrained-off-detail-job.js";
import { createConstrainedOffIngestor } from "./constrained-off-job.js";
import {
  enforceRetention,
  type RetentionPolicy,
  type RetentionResult,
} from "./custody.js";
import { createDailyLoadIngestor } from "./daily-load-job.js";
import { createDessemGeneralIngestor } from "./dessem-general-job.js";
import { createDessemIngestor } from "./dessem-job.js";
import { createInterchangeIngestor } from "./interchange-job.js";
import { createEnergyBalanceIngestor } from "./job.js";
import { createLoadIngestor } from "./load-job.js";
import {
  createRefreshSweep,
  type RefreshSweepPayload,
  type RefreshSweepResult,
} from "./refresh.js";
import { createPlantRegistryIngestor } from "./registry-job.js";
import { createSigaIngestor } from "./siga-job.js";
import type { IngestTask, IngestTaskResult } from "./tasks.js";
import {
  type CentroidDriftPayload,
  type CentroidDriftResult,
  createCentroidDriftCheck,
} from "./weather/centroid-job.js";
import { createWeatherIngestor } from "./weather-job.js";

/**
 * One queue, one handler, every ingestor behind it.
 *
 * The template's worker registered a single ingestion function, which was right
 * when there was one dataset and wrong the moment there were seven: the
 * alternative to this dispatch is a queue per source, which is a second
 * scheduler wearing a hat. The tagged payload keeps BullMQ's contract —
 * `Execute<TPayload, TResult>` — while letting the payload say which ingestor
 * it is for.
 *
 * The sweep is a queued task like any other, and it is the sweep that *plans*
 * the tasks. So the scheduler registers three repeatable jobs (one per tier)
 * and nothing else: the plan is recomputed from the clock every time it runs
 * rather than baked into a hundred cron entries that would drift the first time
 * a period boundary moved.
 */

/**
 * Everything the queue carries: an ingestion, a sweep, a retention pass, or the
 * centroid drift watch.
 *
 * The drift check is deliberately **not** an `IngestTask`: it ingests nothing
 * and has no source, no period and no vintage of its own. It reads the registry
 * WattSteer already holds and asks one question of it — has the fleet grown away
 * from the frozen weather geometry — so it belongs beside the sweep and the
 * retention pass rather than among the adapters.
 */
export type QueueTask =
  | IngestTask
  | { kind: "refresh_sweep"; payload: RefreshSweepPayload }
  | { kind: "retention"; payload: { policy?: RetentionPolicy } }
  | { kind: "centroid_drift"; payload: CentroidDriftPayload };

/** What a queued task produced. */
export type QueueTaskResult =
  | IngestTaskResult
  | { kind: "refresh_sweep"; result: RefreshSweepResult }
  | { kind: "retention"; result: RetentionResult }
  | { kind: "centroid_drift"; result: CentroidDriftResult };

export interface IngestDispatcherDeps {
  db: Database;
  /** Where raw payloads are retained. Absent means custody is off. */
  archive?: PayloadArchive;
  /** Injected so the whole dispatcher is testable without the network. */
  fetch?: typeof fetch;
  /** Retention policy override, mainly for tests. */
  retention?: RetentionPolicy;
}

/**
 * Build the one handler the worker registers.
 *
 * Every ingestor is constructed once, at wiring time, rather than per job: they
 * are closures over `db`, `fetch` and the archive, and rebuilding them per
 * message would make the hot path allocate ten objects to use one.
 */
export function createIngestDispatcher(
  deps: IngestDispatcherDeps,
): Execute<QueueTask, QueueTaskResult> {
  const shared = { db: deps.db, archive: deps.archive, fetch: deps.fetch };
  const energyBalance = createEnergyBalanceIngestor(shared);
  const constrainedOff = createConstrainedOffIngestor(shared);
  const constrainedOffDetail = createConstrainedOffDetailIngestor(shared);
  const interchange = createInterchangeIngestor(shared);
  const dailyLoad = createDailyLoadIngestor(shared);
  const dessem = createDessemIngestor(shared);
  const dessemGeneral = createDessemGeneralIngestor(shared);
  const load = createLoadIngestor(shared);
  const registry = createPlantRegistryIngestor(shared);
  const siga = createSigaIngestor(shared);
  const weather = createWeatherIngestor(shared);

  /** Run one ingestion task. Also what the sweep calls, in-process. */
  const runIngestion = async (
    task: IngestTask,
    report: ReportProgress,
  ): Promise<IngestTaskResult> => {
    switch (task.kind) {
      case "energy_balance":
        return { kind: task.kind, result: await energyBalance(task.payload, report) };
      case "constrained_off":
        return { kind: task.kind, result: await constrainedOff(task.payload, report) };
      case "constrained_off_detail":
        return {
          kind: task.kind,
          result: await constrainedOffDetail(task.payload, report),
        };
      case "interchange":
        return { kind: task.kind, result: await interchange(task.payload, report) };
      case "daily_load":
        return { kind: task.kind, result: await dailyLoad(task.payload, report) };
      case "dessem_balance":
        return { kind: task.kind, result: await dessem(task.payload, report) };
      case "dessem_general":
        return { kind: task.kind, result: await dessemGeneral(task.payload, report) };
      case "load":
        return { kind: task.kind, result: await load(task.payload, report) };
      case "siga":
        return { kind: task.kind, result: await siga(task.payload, report) };
      case "weather":
        return { kind: task.kind, result: await weather(task.payload, report) };
      default: {
        // Exhaustive: every other kind is handled above, and a payload that is
        // none of them cannot have been built from `IngestTask`.
        const exhaustive: "plant_registry" = task.kind;
        return { kind: exhaustive, result: await registry(task.payload, report) };
      }
    }
  };

  const sweep = createRefreshSweep({ db: deps.db, run: runIngestion });
  const centroidDrift = createCentroidDriftCheck({ db: deps.db });

  return async (task, report) => {
    if (task.kind === "refresh_sweep") {
      return { kind: "refresh_sweep", result: await sweep(task.payload, report) };
    }
    if (task.kind === "centroid_drift") {
      return {
        kind: "centroid_drift",
        result: await centroidDrift(task.payload, report),
      };
    }
    if (task.kind === "retention") {
      return {
        kind: "retention",
        result: await enforceRetention(deps.db, deps.archive, {
          policy: task.payload.policy ?? deps.retention,
        }),
      };
    }
    return runIngestion(task, report);
  };
}

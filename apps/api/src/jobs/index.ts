import { config } from "../config.js";
import { createBullMqRunner } from "./bullmq.js";
import { createInProcessRunner } from "./inprocess.js";
import type { Execute, JobRunner } from "./types.js";

export { createBullMqRunner, QUEUE_NAME } from "./bullmq.js";
export { createInProcessRunner } from "./inprocess.js";
// `publication.js` and `worker-tasks.js` are deliberately *not* re-exported
// here. Every ingest adapter imports this barrel for `Execute`, and routing the
// publication through it would put `forecast/publish.ts` — and with it
// `ml-proxy` — on a path that half the codebase already imports. The worker
// imports those two modules directly, which is what keeps "only the worker
// calls the modelling service for a forecast" a fact about the import graph.
export type {
  Execute,
  JobProgress,
  JobRecord,
  JobRunner,
  JobSchedule,
  JobStatus,
  ReportProgress,
} from "./types.js";

/**
 * Select the job-runner backend (Strategy): durable BullMQ/Redis when
 * `REDIS_URL` is configured, otherwise the in-process runner. Callers depend
 * only on the `JobRunner` interface, so this choice is invisible to them.
 */
export function createJobRunner<TPayload, TResult>(
  execute: Execute<TPayload, TResult>,
): JobRunner<TPayload, TResult> {
  if (config.redisUrl) {
    return createBullMqRunner(execute, config.redisUrl, {
      concurrency: config.jobConcurrency,
      // In `api` role the process enqueues only; workers run elsewhere.
      startWorker: config.role !== "api",
      completedRetentionSec: config.jobRetentionSec,
      failedRetentionSec: config.jobFailedRetentionSec,
      attempts: config.jobAttempts,
      backoffMs: config.jobBackoffMs,
      lockDurationMs: config.jobLockDurationMs,
    });
  }
  return createInProcessRunner(execute);
}

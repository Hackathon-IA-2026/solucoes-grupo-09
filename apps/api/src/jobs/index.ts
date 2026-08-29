import { config } from "../config.js";
import { createBullMqRunner } from "./bullmq.js";
import { createInProcessRunner } from "./inprocess.js";
import type { Execute, JobRunner } from "./types.js";

export { createBullMqRunner, QUEUE_NAME } from "./bullmq.js";
export { createInProcessRunner } from "./inprocess.js";
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
    });
  }
  return createInProcessRunner(execute);
}

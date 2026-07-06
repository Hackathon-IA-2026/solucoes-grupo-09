import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { toHttpError } from "../errors.js";
import type { ScrapeOptions, ScrapeResult } from "../types.js";
import type { Execute, JobProgress, JobRecord, JobRunner, JobStatus } from "./types.js";

export const QUEUE_NAME = "noviq-reviews";

export interface BullMqOptions {
  /** Worker concurrency — the real cap on simultaneous browsers per worker. */
  concurrency?: number;
  /** Run an embedded worker in this process (default true). False = enqueue/read only. */
  startWorker?: boolean;
  /** Auto-remove completed jobs after this many seconds (keeps the result poll-able). */
  completedRetentionSec?: number;
  /** Auto-remove failed jobs after this many seconds. */
  failedRetentionSec?: number;
  /** Bound on a single queue operation (ms) so a Redis stall can't hang a request. */
  opTimeoutMs?: number;
  /** Queue name override (mainly for tests / isolation). */
  queueName?: string;
  /** Attempts per job before it's marked failed (default 1). */
  attempts?: number;
  /** Base backoff (ms) for exponential retry between attempts. */
  backoffMs?: number;
}

function mapState(state: string): JobStatus {
  if (state === "completed" || state === "failed" || state === "active") return state;
  return "waiting"; // waiting | delayed | prioritized | paused | waiting-children
}

/** Own the redis connection so we can swallow the benign close-time error. */
function connect(url: string): Redis {
  const conn = new Redis(url, { maxRetriesPerRequest: null });
  conn.on("error", (err) => {
    if (!/connection is closed/i.test(err.message)) {
      console.error("redis error:", err);
    }
  });
  return conn;
}

/** Bound a queue op so a Redis stall surfaces as an error instead of hanging. */
function withOpTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

/**
 * Durable, multi-worker job runner backed by BullMQ + Redis. Jobs survive
 * restarts, can be processed by N workers, are observable, and are auto-removed
 * after a retention window so Redis doesn't accumulate finished jobs. The API
 * uses it transparently via the `JobRunner` interface; `execute` is injected so
 * the wiring is testable against a real Redis without a browser.
 */
export function createBullMqRunner(
  execute: Execute,
  redisUrl: string,
  opts: BullMqOptions = {},
): JobRunner {
  const opTimeoutMs = opts.opTimeoutMs ?? 10_000;
  const name = opts.queueName ?? QUEUE_NAME;
  const queueConn = connect(redisUrl);
  const connection = (c: Redis) => c as unknown as ConnectionOptions;

  const queue = new Queue<ScrapeOptions, ScrapeResult, string>(name, {
    connection: connection(queueConn),
    defaultJobOptions: {
      // Keep results poll-able for a window, then auto-clean (also count-capped
      // as a backstop). Failed jobs linger longer for debugging.
      removeOnComplete: { age: opts.completedRetentionSec ?? 3_600, count: 1_000 },
      removeOnFail: { age: opts.failedRetentionSec ?? 86_400, count: 5_000 },
      // Retry failed jobs with exponential backoff. Safe because the scrape
      // handler is idempotent (read-only — no side effects to replay).
      attempts: opts.attempts ?? 1,
      backoff: { type: "exponential", delay: opts.backoffMs ?? 5_000 },
    },
  });

  // The worker is optional so the API can run "enqueue-only" while dedicated
  // worker processes (`bun run worker`) do the scraping.
  let worker: Worker<ScrapeOptions, ScrapeResult, string> | undefined;
  let workerConn: Redis | undefined;
  if (opts.startWorker !== false) {
    workerConn = connect(redisUrl);
    worker = new Worker<ScrapeOptions, ScrapeResult, string>(
      name,
      // Handler is idempotent: scraping is read-only, so a retry (or BullMQ's
      // at-least-once redelivery after a crash) just re-scrapes — nothing to
      // corrupt. Throwing rejects the job so BullMQ retries up to `attempts`.
      async (job) => {
        try {
          return await execute({
            ...job.data,
            // Publish per-page progress to Redis (fire-and-forget — a progress
            // write failure must never fail the scrape itself).
            onProgress: (info) => {
              void job
                .updateProgress({ collected: info.collected, limit: job.data.limit })
                .catch(() => {});
            },
          });
        } catch (err) {
          // Persist only a client-safe message as the job's failedReason.
          throw new Error(toHttpError(err).body.error);
        }
      },
      { connection: connection(workerConn), concurrency: opts.concurrency ?? 2 },
    );
    worker.on("error", (err) => {
      if (!/connection is closed/i.test(err.message)) {
        console.error("bullmq worker error:", err);
      }
    });
  }

  return {
    mode: "bullmq",
    async submit(query) {
      const job = await withOpTimeout(queue.add("scrape", query), opTimeoutMs, "enqueue");
      return String(job.id);
    },
    async status(id) {
      const job = await withOpTimeout(queue.getJob(id), opTimeoutMs, "job lookup");
      if (!job) return null;
      const status = mapState(
        await withOpTimeout(job.getState(), opTimeoutMs, "job state"),
      );
      const record: JobRecord = { id, status };
      if (status === "completed") record.result = job.returnvalue;
      if (status === "failed") record.error = job.failedReason || "Scrape failed";
      if (
        status === "active" &&
        job.progress &&
        typeof job.progress === "object" &&
        "collected" in job.progress
      ) {
        record.progress = job.progress as JobProgress;
      }
      return record;
    },
    async close() {
      if (worker) await worker.close();
      await queue.close();
      queueConn.disconnect();
      workerConn?.disconnect();
    },
  };
}

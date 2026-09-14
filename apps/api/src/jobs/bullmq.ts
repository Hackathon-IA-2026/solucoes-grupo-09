import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { clientSafeMessage } from "../errors.js";
import type {
  Execute,
  JobProgress,
  JobRecord,
  JobRunner,
  JobSchedule,
  JobStatus,
} from "./types.js";

export const QUEUE_NAME = "wattsteer-jobs";

export interface BullMqOptions {
  /** Worker concurrency — jobs processed simultaneously per worker. */
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
  /**
   * How long this worker's claim on a running job survives without renewal.
   *
   * BullMQ renews the claim on a timer while the handler runs, and treats a
   * claim it could not renew in time as a *stalled* job: it hands the same job
   * to another processor and refuses the original's `moveToFinished`. So this
   * is not a tuning knob, it is an assertion about how long a job may run —
   * set it below the truth and a long job is silently run twice and recorded
   * never. `config.jobLockDurationMs` carries the measurement it is set from.
   */
  lockDurationMs?: number;
}

function mapState(state: string): JobStatus {
  if (state === "completed" || state === "failed" || state === "active") {
    return state;
  }
  return "waiting"; // waiting | delayed | prioritized | paused | waiting-children
}

/**
 * What a Redis connection error may be written to the log as.
 *
 * ioredis hangs the failed command off the error object — `err.command` is
 * `{ name: "auth", args: ["default", "<the password>"] }` — and every console
 * that formats an Error by inspecting its own properties (Bun's among them)
 * prints those args verbatim. A single WRONGPASS therefore writes the Redis
 * password into the deployment log, where it outlives the rotation that was
 * supposed to retire it. `toErrorEnvelope` guards the response path; this
 * guards the log path, and it does it by narrowing to the message rather than
 * by redacting the object, because a redactor has to be right about every
 * field ioredis might add and a narrowing has to be right about one.
 */
export function redactedRedisError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Own the redis connection so we can swallow the benign close-time error. */
function connect(url: string): Redis {
  const conn = new Redis(url, { maxRetriesPerRequest: null });
  conn.on("error", (err) => {
    if (!/connection is closed/i.test(err.message)) {
      console.error("redis error:", redactedRedisError(err));
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
export function createBullMqRunner<TPayload, TResult>(
  execute: Execute<TPayload, TResult>,
  redisUrl: string,
  opts: BullMqOptions = {},
): JobRunner<TPayload, TResult> {
  const opTimeoutMs = opts.opTimeoutMs ?? 10_000;
  const name = opts.queueName ?? QUEUE_NAME;
  const queueConn = connect(redisUrl);
  const connection = (c: Redis) => c as unknown as ConnectionOptions;

  // All six type parameters are supplied explicitly: BullMQ derives NameType
  // through a conditional type, which TypeScript cannot evaluate while the
  // payload is still generic, leaving `queue.add("job", …)` unassignable.
  const queue = new Queue<TPayload, TResult, string, TPayload, TResult, string>(name, {
    connection: connection(queueConn),
    defaultJobOptions: {
      // Keep results poll-able for a window, then auto-clean (also count-capped
      // as a backstop). Failed jobs linger longer for debugging.
      removeOnComplete: { age: opts.completedRetentionSec ?? 3600, count: 1000 },
      removeOnFail: { age: opts.failedRetentionSec ?? 86_400, count: 5000 },
      // Retry failed jobs with exponential backoff. Handlers are expected to
      // be idempotent, so a redelivery replays safely.
      attempts: opts.attempts ?? 1,
      backoff: { type: "exponential", delay: opts.backoffMs ?? 5000 },
    },
  });

  // The worker is optional so the API can run "enqueue-only" while dedicated
  // worker processes (`bun run worker`) do the work.
  let worker: Worker<TPayload, TResult, string> | undefined;
  let workerConn: Redis | undefined;
  if (opts.startWorker !== false) {
    workerConn = connect(redisUrl);
    worker = new Worker<TPayload, TResult, string>(
      name,
      // Handlers must be idempotent: BullMQ redelivers at least once after a
      // crash. Throwing rejects the job so BullMQ retries up to `attempts`.
      async (job) => {
        try {
          return await execute(job.data, (progress) => {
            // Fire-and-forget — a progress write must never fail the job.
            void job.updateProgress(progress).catch(() => {});
          });
        } catch (err) {
          // Persist only a client-safe message as the job's failedReason.
          throw new Error(clientSafeMessage(err));
        }
      },
      {
        connection: connection(workerConn),
        concurrency: opts.concurrency ?? 2,
        // Both derive from one number, and they have to: `stalledInterval` is
        // how often the checker looks for claims that lapsed, so a checker that
        // sweeps faster than the claim can lapse reclaims jobs that are merely
        // slow. BullMQ's own default keeps them equal; this keeps them equal
        // from a value that was measured rather than assumed.
        lockDuration: opts.lockDurationMs ?? 30_000,
        stalledInterval: opts.lockDurationMs ?? 30_000,
      },
    );
    worker.on("error", (err) => {
      if (!/connection is closed/i.test(err.message)) {
        console.error("bullmq worker error:", redactedRedisError(err));
      }
    });
  }

  return {
    mode: "bullmq",
    async submit(payload) {
      const job = await withOpTimeout(queue.add("job", payload), opTimeoutMs, "enqueue");
      return String(job.id);
    },
    async schedule({ id, pattern, timeZone, payload }: JobSchedule<TPayload>) {
      // Leader-safe across replicas: BullMQ's scheduler produces one delayed
      // job per interval however many workers are watching the queue.
      await withOpTimeout(
        queue.upsertJobScheduler(
          id,
          { pattern, tz: timeZone ?? "Etc/UTC" },
          { name: "job", data: payload },
        ),
        opTimeoutMs,
        "schedule",
      );
    },
    async status(id) {
      const job = await withOpTimeout(queue.getJob(id), opTimeoutMs, "job lookup");
      if (!job) {
        return null;
      }
      const status = mapState(
        await withOpTimeout(job.getState(), opTimeoutMs, "job state"),
      );
      const record: JobRecord<TResult> = { id, status };
      if (status === "completed") {
        record.result = job.returnvalue;
      }
      if (status === "failed") {
        record.error = job.failedReason || "Job failed";
      }
      if (
        status === "active" &&
        job.progress &&
        typeof job.progress === "object" &&
        "done" in job.progress
      ) {
        record.progress = job.progress as JobProgress;
      }
      return record;
    },
    async close() {
      if (worker) {
        await worker.close();
      }
      await queue.close();
      queueConn.disconnect();
      workerConn?.disconnect();
    },
  };
}

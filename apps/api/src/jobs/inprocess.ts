import { toHttpError } from "../errors.js";
import type { Execute, JobRecord, JobRunner } from "./types.js";

/** Cap on remembered job records (oldest evicted) so memory can't grow unbounded. */
const MAX_RECORDS = 1000;

/**
 * In-process job runner — the zero-dependency default. Jobs run in the
 * background and their records live in memory. Not durable across restarts;
 * for that, set `REDIS_URL` to use the BullMQ backend. `execute` is injected
 * so it's trivially testable.
 */
export function createInProcessRunner<TPayload, TResult>(
  execute: Execute<TPayload, TResult>,
): JobRunner<TPayload, TResult> {
  const jobs = new Map<string, JobRecord<TResult>>();

  function remember(record: JobRecord<TResult>): void {
    jobs.set(record.id, record);
    while (jobs.size > MAX_RECORDS) {
      const oldest = jobs.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      jobs.delete(oldest);
    }
  }

  async function process(id: string, payload: TPayload): Promise<void> {
    const existing = jobs.get(id);
    if (existing) {
      existing.status = "active";
    }
    try {
      const result = await execute(payload, (progress) => {
        const record = jobs.get(id);
        if (record && record.status === "active") {
          record.progress = progress;
        }
      });
      remember({ id, status: "completed", result });
    } catch (err) {
      remember({ id, status: "failed", error: toHttpError(err).body.error });
    }
  }

  return {
    mode: "inprocess",
    async schedule() {
      // Deliberately inert. The in-process runner exists so the API works with
      // no Redis; a timer here would make a laptop's `bun run api` start
      // sweeping ONS, and two developers running one would sweep it twice.
      // Recurring ingestion is a property of the deployed worker, and the
      // worker requires Redis.
    },
    async submit(payload) {
      const id = crypto.randomUUID();
      remember({ id, status: "waiting" });
      void process(id, payload);
      return id;
    },
    async status(id) {
      return jobs.get(id) ?? null;
    },
    async close() {},
  };
}

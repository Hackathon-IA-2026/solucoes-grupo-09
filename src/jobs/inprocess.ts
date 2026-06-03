import { toHttpError } from "../errors.js";
import type { ScrapeOptions } from "../types.js";
import type { Execute, JobRecord, JobRunner } from "./types.js";

/** Cap on remembered job records (oldest evicted) so memory can't grow unbounded. */
const MAX_RECORDS = 1000;

/**
 * In-process job runner — the zero-dependency default. Jobs run in the
 * background (bounded by the executor's own concurrency gate) and their records
 * live in memory. Not durable across restarts; for that, set `REDIS_URL` to use
 * the BullMQ backend. `execute` is injected so it's trivially testable.
 */
export function createInProcessRunner(execute: Execute): JobRunner {
  const jobs = new Map<string, JobRecord>();

  function remember(record: JobRecord): void {
    jobs.set(record.id, record);
    while (jobs.size > MAX_RECORDS) {
      const oldest = jobs.keys().next().value;
      if (oldest === undefined) break;
      jobs.delete(oldest);
    }
  }

  async function process(id: string, query: ScrapeOptions): Promise<void> {
    const existing = jobs.get(id);
    if (existing) existing.status = "active";
    try {
      const result = await execute(query);
      remember({ id, status: "completed", result });
    } catch (err) {
      remember({ id, status: "failed", error: toHttpError(err).body.error });
    }
  }

  return {
    mode: "inprocess",
    async submit(query) {
      const id = crypto.randomUUID();
      remember({ id, status: "waiting" });
      void process(id, query);
      return id;
    },
    async status(id) {
      return jobs.get(id) ?? null;
    },
    async close() {},
  };
}

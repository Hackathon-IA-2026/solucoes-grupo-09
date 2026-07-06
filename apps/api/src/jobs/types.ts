import type { ScrapeOptions, ScrapeResult } from "../types.js";

/** Lifecycle states of a scrape job (an ADT — see `JobRecord`). */
export type JobStatus = "waiting" | "active" | "completed" | "failed";

/** Live progress of an active scrape, for client progress bars. */
export interface JobProgress {
  /** Reviews collected so far (deduplicated). */
  collected: number;
  /** The requested cap, when the client set one (denominator for a bar). */
  limit?: number;
}

/** A point-in-time view of a job. */
export interface JobRecord {
  id: string;
  status: JobStatus;
  /** Present when `status === "completed"`. */
  result?: ScrapeResult;
  /** Client-safe message when `status === "failed"`. */
  error?: string;
  /** Live progress while `status === "active"` (best-effort). */
  progress?: JobProgress;
}

/** Executes the actual scrape for a queued job. Injected for composability/testing. */
export type Execute = (query: ScrapeOptions) => Promise<ScrapeResult>;

/**
 * Strategy: how scrape jobs are queued and processed. Two backends implement
 * it — an in-process runner (default) and a durable BullMQ/Redis runner —
 * selected by config without the API layer knowing which is in use.
 */
export interface JobRunner {
  readonly mode: "inprocess" | "bullmq";
  /** Enqueue a scrape; resolves to the job id. */
  submit(query: ScrapeOptions): Promise<string>;
  /** Look up a job's status/result, or `null` if the id is unknown. */
  status(id: string): Promise<JobRecord | null>;
  /** Release resources (worker, connections). */
  close(): Promise<void>;
}

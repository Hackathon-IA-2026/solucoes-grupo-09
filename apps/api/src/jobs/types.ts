/** Lifecycle states of a background job (an ADT — see `JobRecord`). */
export type JobStatus = "waiting" | "active" | "completed" | "failed";

/** Live progress of an active job, for client progress bars. */
export interface JobProgress {
  /** Units of work finished so far. */
  done: number;
  /** Total units, when known (denominator for a bar). */
  total?: number;
}

/** Reports progress from inside a running job. Best-effort; never throws. */
export type ReportProgress = (progress: JobProgress) => void;

/** A point-in-time view of a job. */
export interface JobRecord<TResult = unknown> {
  id: string;
  status: JobStatus;
  /** Present when `status === "completed"`. */
  result?: TResult;
  /** Client-safe message when `status === "failed"`. */
  error?: string;
  /** Live progress while `status === "active"` (best-effort). */
  progress?: JobProgress;
}

/**
 * Executes the actual work for a queued job. Injected for composability and
 * testing. Progress reporting is a separate argument rather than part of the
 * payload, so the payload stays a plain serialisable value.
 */
export type Execute<TPayload, TResult> = (
  payload: TPayload,
  report: ReportProgress,
) => Promise<TResult>;

/**
 * Strategy: how jobs are queued and processed. Two backends implement it —
 * an in-process runner (default) and a durable BullMQ/Redis runner — selected
 * by config without the API layer knowing which is in use.
 */
export interface JobRunner<TPayload, TResult> {
  readonly mode: "inprocess" | "bullmq";
  /** Enqueue work; resolves to the job id. */
  submit(payload: TPayload): Promise<string>;
  /** Look up a job's status/result, or `null` if the id is unknown. */
  status(id: string): Promise<JobRecord<TResult> | null>;
  /** Release resources (worker, connections). */
  close(): Promise<void>;
}

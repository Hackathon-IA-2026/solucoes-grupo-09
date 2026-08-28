// Bun auto-loads `.env` (and `.env.production`, etc.) — no dotenv needed.
// This module is the single place env vars are read and normalized.

function bool(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/** Parse an int env var, clamped to [min, max], falling back to `def`. */
function int(value: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) {
    return def;
  }
  return Math.min(max, Math.max(min, n));
}

export const config = {
  /** API server port (Railway/most PaaS inject PORT). */
  port: int(process.env.PORT, 3000, 1, 65_535),
  /** Node environment. */
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",
  /**
   * Public base URL for the OpenAPI `servers` entry. Omit to let Swagger UI use
   * the origin it was loaded from — correct for localhost and most deployments.
   */
  publicUrl: process.env.WATTSTEER_PUBLIC_URL || undefined,
  /**
   * Browser origins allowed by CORS in production (comma-separated). In
   * development every origin is allowed. Empty in production → no browser
   * origin is allowed (server-to-server callers are unaffected; CORS only
   * gates browsers).
   */
  corsOrigins: (process.env.WATTSTEER_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  // --- resilience / resource control ---
  /**
   * Per-client requests allowed per window on the metered surface. Bounds
   * request *rate* so an anonymous client can't monopolise the API.
   * 0 disables the limiter.
   */
  rateLimitMax: int(process.env.WATTSTEER_RATE_LIMIT, 60, 0, 100_000),
  /** Rate-limit window length (ms). */
  rateLimitWindowMs: int(process.env.WATTSTEER_RATE_WINDOW_MS, 60_000, 1000, 3_600_000),

  // --- jobs ---
  /**
   * Redis connection URL. When set, background jobs run on a durable BullMQ
   * queue (multi-worker); otherwise an in-process runner is used.
   */
  redisUrl: process.env.REDIS_URL || undefined,
  /**
   * Process role for the BullMQ setup:
   * - `all` (default): API also runs an embedded worker (single process).
   * - `api`: API only enqueues/reads — run workers separately (`bun run worker`).
   * - `worker`: used by the worker entrypoint.
   */
  role: (["all", "api", "worker"].includes(process.env.WATTSTEER_ROLE ?? "")
    ? process.env.WATTSTEER_ROLE
    : "all") as "all" | "api" | "worker",
  /** Jobs processed simultaneously per worker. */
  jobConcurrency: int(process.env.WATTSTEER_JOB_CONCURRENCY, 2, 1, 64),
  /** Keep completed jobs (with their result) this long, then auto-remove. */
  jobRetentionSec: int(process.env.WATTSTEER_JOB_RETENTION_SEC, 3600, 60, 2_592_000),
  /** Keep failed jobs this long (longer, for debugging), then auto-remove. */
  jobFailedRetentionSec: int(
    process.env.WATTSTEER_JOB_FAILED_RETENTION_SEC,
    86_400,
    60,
    2_592_000,
  ),
  /** Attempts per job before it's marked failed. */
  jobAttempts: int(process.env.WATTSTEER_JOB_ATTEMPTS, 3, 1, 10),
  /** Base backoff (ms) between job retries (exponential). */
  jobBackoffMs: int(process.env.WATTSTEER_JOB_BACKOFF_MS, 5000, 100, 120_000),

  // --- persistence ---
  /** Postgres URL. Unset → persistence disabled. */
  databaseUrl: process.env.DATABASE_URL || undefined,
  /**
   * Mount the BullMQ Workbench dashboard at /jobs (requires Redis). Off by
   * default — it exposes queue data/controls, so enable only behind your own
   * auth/network protection.
   */
  dashboard: bool(process.env.WATTSTEER_DASHBOARD),
} as const;

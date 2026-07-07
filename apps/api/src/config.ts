import type { StealthPreset } from "./types.js";

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

const stealth = process.env.NOVIQ_STEALTH;
const VALID_STEALTH: StealthPreset[] = ["max", "balanced", "fast"];

export const config = {
  /** API server port (Railway/most PaaS inject PORT). */
  port: int(process.env.PORT, 3000, 1, 65_535),
  /** Node environment. */
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",
  /**
   * Public base URL for the OpenAPI `servers` entry (e.g.
   * https://noviq.up.railway.app). Omit to let Swagger UI use the origin it was
   * loaded from — correct for both localhost and most deployments.
   */
  publicUrl: process.env.NOVIQ_PUBLIC_URL || undefined,
  /**
   * Browser origins allowed by CORS in production (comma-separated), e.g.
   * "https://noviq.app,https://www.noviq.app". In development every origin is
   * allowed. Empty in production → no browser origin is allowed (server-to-
   * server callers are unaffected; CORS only gates browsers).
   */
  corsOrigins: (process.env.NOVIQ_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  /** Default upstream proxy applied to scrapes when the caller omits one. */
  defaultProxy: process.env.NOVIQ_PROXY || undefined,
  /** Match browser geo/locale to the (proxy) exit IP by default. */
  geoip: bool(process.env.NOVIQ_GEOIP),
  /** Default stealth preset. */
  defaultStealth: (VALID_STEALTH.includes(stealth as StealthPreset)
    ? (stealth as StealthPreset)
    : "max") as StealthPreset,
  /**
   * Run Chromium without its setuid sandbox + small /dev/shm. Required inside
   * containers; left off locally so the sandbox (and full stealth) stays on.
   */
  noSandbox: bool(process.env.NOVIQ_NO_SANDBOX),

  // --- resilience / resource control ---
  /** Max scrapes running at once (each launches a Chromium). Tune to host RAM. */
  maxConcurrency: int(process.env.NOVIQ_MAX_CONCURRENCY, 2, 1, 64),
  /** Max scrapes allowed to queue before returning 503. */
  maxQueue: int(process.env.NOVIQ_MAX_QUEUE, 20, 0, 10_000),
  /**
   * Per-client requests allowed on the scrape surface (/reviews*, /app) per
   * window. Bounds request *rate* (the semaphore only bounds concurrency), so
   * an anonymous client can't monopolize the queue or burn proxy budget.
   * 0 disables the limiter.
   */
  rateLimitMax: int(process.env.NOVIQ_RATE_LIMIT, 30, 0, 100_000),
  /** Rate-limit window length (ms). */
  rateLimitWindowMs: int(process.env.NOVIQ_RATE_WINDOW_MS, 60_000, 1000, 3_600_000),
  /** Hard time budget per scrape (ms); partial results returned, else 504. */
  scrapeTimeoutMs: int(process.env.NOVIQ_SCRAPE_TIMEOUT_MS, 120_000, 5000, 600_000),
  /** Page-navigation timeout (ms). */
  navTimeoutMs: int(process.env.NOVIQ_NAV_TIMEOUT_MS, 60_000, 5000, 180_000),
  /** Per in-page fetch timeout (ms) — bounds a stalled network. */
  fetchTimeoutMs: int(process.env.NOVIQ_FETCH_TIMEOUT_MS, 30_000, 2000, 120_000),
  /** Bounded retries on transient navigation/network failures. */
  navRetries: int(process.env.NOVIQ_NAV_RETRIES, 2, 0, 5),
  /**
   * Redis connection URL. When set, scrape jobs run on a durable BullMQ queue
   * (async API + multi-worker); otherwise an in-process runner is used.
   */
  redisUrl: process.env.REDIS_URL || undefined,
  /**
   * Process role for the BullMQ setup:
   * - `all` (default): API also runs an embedded worker (single process).
   * - `api`: API only enqueues/reads — run workers separately (`bun run worker`).
   * - `worker`: used by the worker entrypoint.
   */
  role: (["all", "api", "worker"].includes(process.env.NOVIQ_ROLE ?? "")
    ? process.env.NOVIQ_ROLE
    : "all") as "all" | "api" | "worker",
  /** Keep completed jobs (with their result) this long, then auto-remove. */
  jobRetentionSec: int(process.env.NOVIQ_JOB_RETENTION_SEC, 3600, 60, 2_592_000),
  /** Keep failed jobs this long (longer, for debugging), then auto-remove. */
  jobFailedRetentionSec: int(
    process.env.NOVIQ_JOB_FAILED_RETENTION_SEC,
    86_400,
    60,
    2_592_000,
  ),
  /** Attempts per job before it's marked failed (scrapes are idempotent → safe). */
  jobAttempts: int(process.env.NOVIQ_JOB_ATTEMPTS, 3, 1, 10),
  /** Base backoff (ms) between job retries (exponential). */
  jobBackoffMs: int(process.env.NOVIQ_JOB_BACKOFF_MS, 5000, 100, 120_000),
  /**
   * Postgres URL. When set, scraped reviews are persisted (durable, queryable
   * via GET /reviews/stored); unset → scraping still works, results are just
   * transient (response + Redis job result).
   */
  databaseUrl: process.env.DATABASE_URL || undefined,
  /**
   * Mount the BullMQ Workbench dashboard at /jobs (requires Redis). Off by
   * default — it exposes queue data/controls, so enable only behind your own
   * auth/network protection.
   */
  dashboard: bool(process.env.NOVIQ_DASHBOARD),
} as const;

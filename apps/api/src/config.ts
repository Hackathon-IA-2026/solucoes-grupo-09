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
   * Read tier: per-client requests allowed per window on the cheap surface.
   * Almost every hit is a shared-cache hit, so this is generous by design.
   * 0 disables the tier's budget.
   */
  rateLimitMax: int(process.env.WATTSTEER_RATE_LIMIT, 120, 0, 100_000),
  /** Rate-limit window length (ms) — the window both tiers quote their rate over. */
  rateLimitWindowMs: int(process.env.WATTSTEER_RATE_WINDOW_MS, 60_000, 1000, 3_600_000),
  /**
   * Solve tier: sustained requests per window against the MILP and the replay.
   * A public branch-and-bound solver is not a free compute service.
   */
  rateLimitSolveMax: int(process.env.WATTSTEER_RATE_LIMIT_SOLVE, 30, 0, 100_000),
  /**
   * Solve tier burst: how many solves may arrive back to back before the
   * sustained rate takes over. `flex-optimizer.md` asks for "30/min burst 10",
   * which is a token bucket and not a window — moving a slider fires several
   * requests in a second and must not be throttled for it.
   */
  rateLimitSolveBurst: int(process.env.WATTSTEER_RATE_LIMIT_SOLVE_BURST, 10, 1, 10_000),
  /**
   * How many proxies sit in front of this process.
   *
   * The client a budget is charged to is the `n`-th `X-Forwarded-For` hop from
   * the end, because everything to its left was written by whoever was talking.
   * 1 is right behind a single load balancer (Railway, a CDN); 0 ignores the
   * header entirely and is right when the port is directly exposed. Getting
   * this too high hands an attacker a fresh budget per forged hop.
   */
  trustedProxyDepth: int(process.env.WATTSTEER_TRUSTED_PROXY_DEPTH, 1, 0, 16),
  /**
   * Global language-model calls per Brasília civil day for the narration.
   *
   * Not an IP limit: the real volume is ~16 distinct narrations a day and
   * everything else is a cache hit, so what needs a budget is the *call*, not
   * the request. Beyond the cap the endpoint serves the template narration and
   * says so, rather than refusing. 0 disables the cap.
   */
  narrationDailyCap: int(process.env.WATTSTEER_NARRATION_DAILY_CAP, 200, 0, 1_000_000),

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
  /**
   * How long a worker's claim on a running job survives without renewal.
   *
   * BullMQ's 30 s default is a claim on a job that finishes in seconds, and the
   * live refresh sweep is not that: measured in production on 2026-09-14 it ran
   * **12m 57s** (16:17:00 → 16:29:57 UTC), fetching and parsing ONS monthly
   * constrained-off files that are ~244 MB apiece. Thirty seconds in, the lock
   * expired; the stalled-job checker then handed the same sweep to a second
   * processor while the first was still ingesting, and both finished into a
   * `Lock mismatch … Cmd moveToFinished from active` — so the run did its work
   * twice and recorded it zero times.
   *
   * Twenty minutes is chosen against the *measured* run and the cadence that
   * bounds it: comfortably above 12m57s so a slow upstream does not expire the
   * claim, comfortably below the sweep's own hourly period so a genuinely wedged
   * worker is still reclaimed before the next one is due.
   */
  jobLockDurationMs: int(
    process.env.WATTSTEER_JOB_LOCK_DURATION_MS,
    1_200_000,
    30_000,
    3_600_000,
  ),

  // --- ingestion: refresh, custody, retention ---
  /**
   * Register the three repeatable refresh sweeps (live, recent, history) on the
   * worker. Off means the platform only ingests what is enqueued by hand —
   * useful for a one-off backfill process that must not also be sweeping.
   */
  refreshSchedules: (process.env.WATTSTEER_REFRESH ?? "on") !== "off",
  /**
   * S3-compatible bucket holding the raw-payload archive. Railway injects
   * `BUCKET`/`ACCESS_KEY_ID`/`SECRET_ACCESS_KEY`/`ENDPOINT`/`REGION` from the
   * bucket itself, so the fallbacks are the platform's own names and a
   * deployment needs no extra wiring. This is production custody; see
   * `ingest/archive.ts` for why it is a bucket and not a volume.
   */
  archiveBucket: process.env.WATTSTEER_ARCHIVE_BUCKET || process.env.BUCKET || undefined,
  archiveAccessKeyId:
    process.env.WATTSTEER_ARCHIVE_ACCESS_KEY_ID || process.env.ACCESS_KEY_ID || undefined,
  archiveSecretAccessKey:
    process.env.WATTSTEER_ARCHIVE_SECRET_ACCESS_KEY ||
    process.env.SECRET_ACCESS_KEY ||
    undefined,
  archiveEndpoint:
    process.env.WATTSTEER_ARCHIVE_ENDPOINT || process.env.ENDPOINT || undefined,
  archiveRegion: process.env.WATTSTEER_ARCHIVE_REGION || process.env.REGION || undefined,
  /** Directory archive — compose and local development, when no bucket is set. */
  archiveDir: process.env.WATTSTEER_ARCHIVE_DIR || undefined,
  /**
   * Days a payload that produced no revision is retained. Payloads that did
   * produce one are kept indefinitely and this does not apply to them.
   */
  archiveRetentionDays: int(process.env.WATTSTEER_ARCHIVE_RETENTION_DAYS, 90, 1, 36_500),

  // --- the ML service ---
  /**
   * Base URL of the Python service that owns modelling and optimisation.
   * Compose sets `http://ml:8000`; on Railway it is the private domain. Unset
   * → the gateway reports the capability as unavailable rather than 500ing.
   */
  mlUrl: process.env.WATTSTEER_ML_URL || undefined,
  /**
   * How long the gateway waits on the ML service before giving up.
   *
   * The optimizer solves in milliseconds and the forecaster serves a stored
   * artifact, so a slow answer means something is wrong rather than busy —
   * and a gateway that waits indefinitely turns one struggling service into
   * an exhausted connection pool.
   */
  mlTimeoutMs: int(process.env.WATTSTEER_ML_TIMEOUT_MS, 5000, 100, 60_000),
  /**
   * The optimizer build a cached plan is keyed on.
   *
   * `flex-optimizer.md` puts it in the cache key because a deploy that changes
   * the formulation must not serve yesterday's plan under today's code — a
   * staleness no TTL is short enough to prevent, because the entry is not stale,
   * the code underneath it is.
   *
   * It defaults to this repository's version, which is also `apps/ml`'s
   * `__version__`, so the two agree with nothing set. The ML service stamps the
   * build that actually solved on the response, and `/v1/optimize` declines to
   * store an answer whose build disagrees with this one: a cache that stops
   * working is a better failure than one that starts lying.
   */
  optimizerBuild: process.env.WATTSTEER_OPTIMIZER_BUILD || "0.1.0",

  // --- persistence ---
  /** Postgres URL. Unset → persistence disabled. */
  databaseUrl: process.env.DATABASE_URL || undefined,
  /**
   * Mount the BullMQ Workbench dashboard at /jobs (requires Redis). Off by
   * default — it exposes queue data/controls, so enable only behind your own
   * auth/network protection.
   */
  dashboard: bool(process.env.WATTSTEER_DASHBOARD),

  // --- weather (Open-Meteo Single Runs) ---
  /**
   * Host of the Single Runs API.
   *
   * Configuration rather than a constant because the whole historical family —
   * Historical Weather, Historical Forecast, Previous Model Runs and Single
   * Runs — sits behind Open-Meteo's Professional plan the moment WattSteer
   * monetises, and the commercial tier is a different hostname
   * (`https://customer-single-runs-api.open-meteo.com`) plus a key. Moving to
   * it must be an environment change, not a rewrite.
   */
  openMeteoHost: process.env.WATTSTEER_OPEN_METEO_HOST || undefined,
  /**
   * Commercial-tier API key, sent as `apikey`. Unset on the free tier, which is
   * non-commercial-only. It is redacted out of every stored request URL.
   */
  openMeteoApiKey: process.env.WATTSTEER_OPEN_METEO_KEY || undefined,
} as const;

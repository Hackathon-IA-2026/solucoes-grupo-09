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
   * Voice tier: ephemeral realtime credentials per window, per client.
   *
   * Six, against the read tier's 120, and the gap is the point. This product is
   * **public and unauthenticated** — `params.ts` records that as a product
   * decision, not an oversight — so anybody who can load the page can ask for a
   * credential that opens a live audio session billed by the minute. A reader
   * having one conversation needs one session, and re-mints only when the
   * 300-second token is about to lapse mid-sentence; six an minute covers that
   * with room and covers nothing else.
   *
   * 0 disables the tier's budget, which is how a test asks for many.
   */
  voiceSessionMax: int(process.env.WATTSTEER_RATE_LIMIT_VOICE, 6, 0, 10_000),
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

  // --- the voice copilot (docs/plans/voice-copilot.md) ---
  /**
   * The xAI key, held **here and only here**.
   *
   * The browser cannot hold it and cannot be given it: a WebSocket opened from
   * a browser can set no `Authorization` header, so the realtime API is reached
   * with a short-lived *ephemeral* credential that `GET /v1/voice/session`
   * mints on the caller's behalf. This value must never appear in a response
   * body, in a log line, or in an error's detail — `voice.ts` has a guard for
   * each, because ioredis once put a Redis password in a log and that is the
   * same mistake with a longer blast radius.
   *
   * Unset → `VOICE_NOT_CONFIGURED`, and the web app renders no dock at all. An
   * instance without a key is a product without voice, never a broken one.
   */
  xaiApiKey: process.env.XAI_API_KEY || undefined,
  /** The realtime model. Pinned in one place so a rename is one edit. */
  grokVoiceModel: process.env.GROK_VOICE_MODEL || "grok-voice-latest",
  /** The voice xAI speaks in. */
  grokVoice: process.env.GROK_VOICE || "eve",
  /**
   * How long a minted credential lives.
   *
   * Short, because it travels to the browser and is the only thing standing
   * between a page view and a billable audio stream. Long enough that a reader
   * is not re-minting mid-sentence: the client re-mints on expiry, and the
   * response echoes `expires_at` so it can.
   */
  voiceSessionTtlSec: int(process.env.WATTSTEER_VOICE_TTL_SEC, 300, 30, 3600),

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
  /**
   * Weighted call units one weather ingest may spend. **Unbounded with a key.**
   *
   * The free tier's allowance is a daily one — Open-Meteo publishes 600/min,
   * 5,000/hour, **10,000/day**, 300,000/month — and the endpoint returns no
   * `X-RateLimit-*` and no `Retry-After`, so a client can either count what it
   * spends or find the ceiling by being refused. Forecaster 37 measured the
   * second: `2 ok, 27 failed` in a UTC day, the head unmoved for 69 minutes,
   * and four forward attempts all refused before reaching a forward valid time.
   *
   * The default is derived rather than picked. The live sweep is hourly
   * (`REFRESH_CADENCE.live`), so 24 invocations share the day; at a third of
   * the published allowance the margin covers the other tiers' sweeps, the
   * retries a 429 costs before backoff gives up, and anything else on the same
   * IP:
   *
   *     floor(10_000 / 3 / 24) = 138
   *
   * A key means the commercial tier, where this bound is the wrong one to
   * apply, so it lifts entirely — `undefined`, which the ingestor reads as
   * unbounded. That keeps the whole tier difference an environment change,
   * which is what `openMeteoHost` above is also for.
   */
  /**
   * Cron for the weekly retrain, overriding `RETRAIN_PATTERN`.
   *
   * **This is the operator path to a catch-up run, and until now there was
   * none.** `retrainRunId`'s own docstring says the run instant "is floored to
   * the day rather than to the week so that a hand-submitted catch-up" resolves
   * to a stable id — so a hand-submitted retrain was anticipated by the design
   * and then had no way to be submitted. `scripts/ingest.ts task` reaches the
   * `IngestTask` kinds only; a `WorkerTask` has to go on the queue, and the
   * queue is on a private network by design.
   *
   * Overriding the pattern is the one lever that does not require exposing
   * Redis, the modelling service or the unauthenticated jobs dashboard to the
   * public internet. `upsertJobScheduler` is keyed on `RETRAIN_JOB_ID`, so
   * changing the pattern re-registers the same schedule rather than creating a
   * second one, and clearing the variable puts the weekly cadence back.
   *
   * Unset means `RETRAIN_PATTERN` — Friday 03:10 UTC. A malformed cron is
   * BullMQ's to refuse, loudly, at registration rather than silently at 03:10.
   */
  retrainPattern: process.env.WATTSTEER_RETRAIN_PATTERN || undefined,
  openMeteoMaxWeightedUnits: process.env.WATTSTEER_OPEN_METEO_KEY
    ? undefined
    : int(process.env.WATTSTEER_OPEN_METEO_MAX_UNITS, 138, 1, 300_000),
} as const;

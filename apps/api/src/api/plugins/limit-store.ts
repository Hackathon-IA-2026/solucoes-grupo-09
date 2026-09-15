/**
 * Where a budget is counted.
 *
 * The limiter used to be a `Map` in one process, with a comment admitting it:
 * "there is exactly one API process". Scaling the service is a checkbox, and
 * the moment it is ticked the published budget silently multiplies by the
 * replica count — 120/min becomes 360/min with three replicas and nothing in
 * the product says so. So the counter moves to Redis, which is already a
 * dependency, and the in-memory map stays as the fallback for a deployment
 * with no `REDIS_URL`.
 *
 * Two shapes, because the tiers need two:
 *
 * - **fixed window** for reads, where almost every hit is a shared-cache hit
 *   and the boundary effect (60 requests across two adjacent windows) is
 *   harmless;
 * - **token bucket** for the solve tier, where it is not: `flex-optimizer.md`
 *   asks for "30/minute, burst 10" and a fixed window cannot express a burst.
 *
 * The pure functions (`consume`, `consumeBucket`) are the memory store's
 * implementation and are tested directly; the Lua scripts are their Redis
 * counterparts and are asserted against a real Redis under
 * `WATTSTEER_TEST_REDIS_URL`. Both must agree — the same policy must produce
 * the same decision — which is why the arithmetic is written once per side and
 * the shared test asserts the two side by side.
 */

import { Redis } from "ioredis";

/** A budget shaped as a window: `max` requests per `windowMs`, then refused. */
export interface FixedWindowPolicy {
  kind: "fixed-window";
  /** Requests allowed per window; 0 disables the budget entirely. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

/** A budget shaped as a bucket: `max` tokens per `windowMs`, `burst` capacity. */
export interface TokenBucketPolicy {
  kind: "token-bucket";
  /** Sustained rate: tokens granted per window; 0 disables the budget. */
  max: number;
  /** The window the sustained rate is quoted over (ms). */
  windowMs: number;
  /** Bucket capacity — how many requests may arrive back to back. */
  burst: number;
}

export type LimitPolicy = FixedWindowPolicy | TokenBucketPolicy;

/** What a store says about one request. */
export interface Decision {
  limited: boolean;
  /** Whole seconds to wait; always ≥ 1 when limited, so `Retry-After` is legal. */
  retryAfterSec: number;
}

const ALLOWED: Decision = { limited: false, retryAfterSec: 0 };

/** A refusal's wait, in whole seconds and never zero. */
function waitSec(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

// --- fixed window, in memory ------------------------------------------------

export interface WindowState {
  count: number;
  resetAt: number;
}

/** Pure: advance/reset the client's window and report whether it's over. */
export function consume(
  windows: Map<string, WindowState>,
  key: string,
  now: number,
  options: Pick<FixedWindowPolicy, "max" | "windowMs">,
): Decision {
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + options.windowMs });
    return ALLOWED;
  }
  current.count += 1;
  if (current.count > options.max) {
    return { limited: true, retryAfterSec: waitSec(current.resetAt - now) };
  }
  return ALLOWED;
}

/** Drop expired windows so the map can't grow unbounded under churn. */
export function sweep(windows: Map<string, WindowState>, now: number): void {
  for (const [key, value] of windows) {
    if (value.resetAt <= now) {
      windows.delete(key);
    }
  }
}

// --- token bucket, in memory ------------------------------------------------

export interface BucketState {
  /** Tokens available at `ts`; fractional, because refill is continuous. */
  tokens: number;
  /** When `tokens` was last computed. */
  ts: number;
}

/** Tokens granted per millisecond by a policy. */
function refillRate(policy: Pick<TokenBucketPolicy, "max" | "windowMs">): number {
  return policy.max / policy.windowMs;
}

/**
 * Pure: take one token from the client's bucket, refilling for elapsed time.
 *
 * A fresh client starts full, so the first `burst` requests are free and the
 * sustained rate takes over from there — which is what "30/min burst 10"
 * means and what a fixed window cannot say.
 */
export function consumeBucket(
  buckets: Map<string, BucketState>,
  key: string,
  now: number,
  policy: Pick<TokenBucketPolicy, "max" | "windowMs" | "burst">,
): Decision {
  const rate = refillRate(policy);
  const previous = buckets.get(key);
  const elapsed = previous ? Math.max(0, now - previous.ts) : 0;
  const tokens = previous
    ? Math.min(policy.burst, previous.tokens + elapsed * rate)
    : policy.burst;
  if (tokens >= 1) {
    buckets.set(key, { tokens: tokens - 1, ts: now });
    return ALLOWED;
  }
  buckets.set(key, { tokens, ts: now });
  return { limited: true, retryAfterSec: waitSec((1 - tokens) / rate) };
}

/**
 * Drop buckets that have refilled to capacity: a full bucket is
 * indistinguishable from a client that has never been seen, so keeping it is
 * pure memory growth.
 */
export function sweepBuckets(
  buckets: Map<string, BucketState>,
  now: number,
  policy: Pick<TokenBucketPolicy, "max" | "windowMs" | "burst">,
): void {
  const rate = refillRate(policy);
  for (const [key, value] of buckets) {
    if (value.tokens + Math.max(0, now - value.ts) * rate >= policy.burst) {
      buckets.delete(key);
    }
  }
}

// --- the store --------------------------------------------------------------

/**
 * A counter the limiter and the daily cap both spend against.
 *
 * `kind` is not decoration: an operator has to be able to tell from one log
 * line whether the published budget is the real budget or a per-replica
 * fraction of it, which is exactly the defect this interface exists to fix.
 */
export interface LimitStore {
  readonly kind: "memory" | "redis";
  /** One line naming what is counting, for the boot log and `/v1/meta`. */
  readonly detail: string;
  /** Spend one request against `key` under `policy`. */
  consume: (policy: LimitPolicy, key: string, now: number) => Promise<Decision>;
  /**
   * Increment a counter that expires at `expiresAtMs` and return its new
   * value. The daily cap's whole mechanism.
   *
   * `now` is passed rather than read from the clock so that the store's own
   * eviction uses the same instant the caller reasoned about — a counter must
   * never be dropped out from under a caller that is still spending against it.
   */
  bumpDaily: (key: string, now: number, expiresAtMs: number) => Promise<number>;
  close: () => Promise<void>;
}

/** Sweep whenever a map crosses this size (amortized cleanup). */
const SWEEP_THRESHOLD = 10_000;

/**
 * The fallback: correct for one process, and honest that that is what it is.
 *
 * Also the store every test uses, which is why the default `bun test` path
 * needs no Redis.
 */
export function memoryStore(detail = "in-memory (per-process budget)"): LimitStore {
  const windows = new Map<string, WindowState>();
  const buckets = new Map<string, BucketState>();
  const counters = new Map<string, { count: number; expiresAtMs: number }>();
  return {
    kind: "memory",
    detail,
    consume: async (policy, key, now) => {
      if (policy.kind === "fixed-window") {
        if (windows.size > SWEEP_THRESHOLD) {
          sweep(windows, now);
        }
        return consume(windows, key, now, policy);
      }
      if (buckets.size > SWEEP_THRESHOLD) {
        sweepBuckets(buckets, now, policy);
      }
      return consumeBucket(buckets, key, now, policy);
    },
    bumpDaily: async (key, now, expiresAtMs) => {
      for (const [k, v] of counters) {
        if (v.expiresAtMs <= now) {
          counters.delete(k);
        }
      }
      const current = counters.get(key);
      const next = { count: (current?.count ?? 0) + 1, expiresAtMs };
      counters.set(key, next);
      return next.count;
    },
    close: async () => {
      windows.clear();
      buckets.clear();
      counters.clear();
    },
  };
}

/**
 * Fixed window in Redis. `INCR` then `PEXPIRE` on first sight, so N replicas
 * increment one counter and the published budget is the real budget.
 *
 * Returns `{limited, ttlMs}`; the TTL is the wait, read from the key rather
 * than recomputed, so two replicas with slightly different clocks still quote
 * the same `Retry-After`.
 */
const WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then ttl = tonumber(ARGV[1]) end
if count > tonumber(ARGV[2]) then
  return {1, ttl}
end
return {0, ttl}
`;

/**
 * Token bucket in Redis, as one atomic script: read tokens, refill for elapsed
 * time, spend one or refuse. `now` is the caller's clock rather than Redis's
 * `TIME` so the script stays deterministic; replica clock skew moves a refill
 * by milliseconds, which a burst of ten absorbs.
 *
 * Tokens are stored scaled by 1000 because Lua's return values are integers.
 */
const BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1]) * 1000
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * rate * 1000)
local limited = 0
local wait = 0
if tokens >= 1000 then
  tokens = tokens - 1000
else
  limited = 1
  wait = math.ceil((1000 - tokens) / (rate * 1000))
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], ttl)
return {limited, wait}
`;

/** `INCR` a counter and pin its expiry — the daily cap, shared across replicas. */
const DAILY_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
redis.call('PEXPIREAT', KEYS[1], ARGV[1])
return count
`;

interface ScriptedRedis extends Redis {
  wsWindow: (key: string, windowMs: string, max: string) => Promise<[number, number]>;
  wsBucket: (
    key: string,
    burst: string,
    rate: string,
    now: string,
    ttlMs: string,
  ) => Promise<[number, number]>;
  wsDaily: (key: string, expiresAtMs: string) => Promise<number>;
}

export interface RedisStoreOptions {
  /** Key prefix, so two deployments against one Redis do not share a budget. */
  prefix?: string;
  /**
   * How long a single Redis round trip may take before the request falls back
   * to the in-memory counter. A limiter that hangs is worse than a limiter
   * that is briefly per-process.
   */
  opTimeoutMs?: number;
}

/** How long a bucket's state is worth keeping after its last touch. */
function bucketTtlMs(policy: TokenBucketPolicy): number {
  return Math.ceil((policy.burst / policy.max) * policy.windowMs) + policy.windowMs;
}

/**
 * The shared counter.
 *
 * Every operation is bounded and every failure degrades to the in-memory
 * store rather than to an error or a hang: a Redis outage must not take the
 * public surface down, and it must not remove the budget either. The
 * degradation is logged once so it is diagnosable rather than silent.
 */
export function redisStore(url: string, options: RedisStoreOptions = {}): LimitStore {
  const prefix = options.prefix ?? "wattsteer:rl";
  const opTimeoutMs = options.opTimeoutMs ?? 250;
  const fallback = memoryStore("in-memory (Redis unreachable)");
  let degraded = false;

  const redis = new Redis(url, {
    // A limiter is on the request path, so no command may retry for long. The
    // offline queue stays *on* — it is what lets the first requests after boot
    // reach Redis rather than falling back before the socket is up — and every
    // command is bounded by `opTimeoutMs` below, so a queue that is not
    // draining degrades to the local counter instead of stalling a request.
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  }) as ScriptedRedis;
  redis.on("error", (err: Error) => {
    if (!(degraded || /connection is closed/i.test(err.message))) {
      console.error("rate limit: redis error, falling back in-memory:", err.message);
    }
  });
  redis.defineCommand("wsWindow", { numberOfKeys: 1, lua: WINDOW_SCRIPT });
  redis.defineCommand("wsBucket", { numberOfKeys: 1, lua: BUCKET_SCRIPT });
  redis.defineCommand("wsDaily", { numberOfKeys: 1, lua: DAILY_SCRIPT });

  /** Bound one round trip; on failure, say so once and use the local map. */
  async function guarded<T>(
    op: () => Promise<T>,
    onFailure: () => Promise<T>,
  ): Promise<T> {
    try {
      return await Promise.race([
        op(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("redis timed out")), opTimeoutMs).unref(),
        ),
      ]);
    } catch (error) {
      if (!degraded) {
        degraded = true;
        console.error(
          "rate limit: shared counter unavailable, budget is per-process until Redis returns:",
          error instanceof Error ? error.message : String(error),
        );
      }
      return onFailure();
    }
  }

  return {
    kind: "redis",
    detail: `redis (shared across replicas) at ${new URL(url).host}`,
    consume: (policy, key, now) => {
      if (policy.kind === "fixed-window") {
        return guarded(
          async () => {
            const [limited, ttl] = await redis.wsWindow(
              `${prefix}:w:${policy.max}:${policy.windowMs}:${key}`,
              String(policy.windowMs),
              String(policy.max),
            );
            return limited === 1
              ? { limited: true, retryAfterSec: waitSec(ttl) }
              : ALLOWED;
          },
          () => fallback.consume(policy, key, now),
        );
      }
      return guarded(
        async () => {
          const [limited, wait] = await redis.wsBucket(
            `${prefix}:b:${policy.max}:${policy.windowMs}:${policy.burst}:${key}`,
            String(policy.burst),
            String(refillRate(policy)),
            String(now),
            String(bucketTtlMs(policy)),
          );
          return limited === 1
            ? { limited: true, retryAfterSec: waitSec(wait) }
            : ALLOWED;
        },
        () => fallback.consume(policy, key, now),
      );
    },
    bumpDaily: (key, now, expiresAtMs) =>
      guarded(
        () => redis.wsDaily(`${prefix}:d:${key}`, String(expiresAtMs)),
        () => fallback.bumpDaily(key, now, expiresAtMs),
      ),
    close: async () => {
      await fallback.close();
      redis.disconnect();
    },
  };
}

/**
 * The store this deployment counts against: Redis when one is configured,
 * the per-process map otherwise.
 */
export function createLimitStore(
  redisUrl: string | undefined,
  options?: RedisStoreOptions,
): LimitStore {
  return redisUrl ? redisStore(redisUrl, options) : memoryStore();
}

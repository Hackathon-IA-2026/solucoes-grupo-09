/**
 * Where a solved plan is remembered — **a cache, not persistence.**
 *
 * `docs/specs/flex-optimizer.md` is precise about what this is allowed to be:
 * evictable at any time with no user-visible loss. Nothing here is a system of
 * record, nothing is read back to answer a question about the past, and losing
 * every entry costs 3 ms per subsequent request. That is why an unreachable
 * Redis is a *miss* and never an error — the same posture `limit-store.ts`
 * takes with a budget, for the same reason.
 *
 * **The key is a provenance, never a duration**, per `api-surface.md`'s caching
 * rule:
 *
 * ```
 * opt:v1:<sha256 of the canonical scenario>:<resolved forecast_origin>:<optimizer_build>
 * ```
 *
 * Three components and each is load-bearing. The scenario hash is over the
 * canonical bytes, so two spellings of one scenario share an entry and two
 * different scenarios cannot. The **forecast origin** is in the key because a
 * superseding 12Z run must not be served an 00Z plan — the plan is only as good
 * as the band it was built on. The **optimizer build** is in it because a deploy
 * that changes the formulation must not serve yesterday's plan under today's
 * code, which is a stale answer no TTL is short enough to prevent.
 *
 * What is stored is the **response text**, byte for byte, so a hit is
 * byte-identical to the miss that filled it. Storing a parsed object and
 * re-serialising would make that a property of two `JSON.stringify` calls
 * agreeing about key order, which is not a property anyone should have to rely
 * on when the thing being served carries a reproducibility hash.
 */

import { Redis } from "ioredis";

/** 24 hours, per the spec. A cache entry outliving the day it plans for is noise. */
export const OPTIMIZE_TTL_SEC = 24 * 60 * 60;

/** The key prefix, versioned so a shape change cannot read old entries. */
export const OPTIMIZE_KEY_PREFIX = "opt:v1";

/**
 * Build the key. Pure, and exported, because the argument above is only worth
 * as much as the test that a changed origin or build produces a different one.
 */
export function optimizeKey(parts: {
  scenarioHash: string;
  forecastOrigin: string;
  optimizerBuild: string;
}): string {
  return [
    OPTIMIZE_KEY_PREFIX,
    parts.scenarioHash,
    parts.forecastOrigin,
    parts.optimizerBuild,
  ].join(":");
}

/** Somewhere a solved plan can be put and later found, or not. */
export interface ResultCache {
  /** The stored response text, or `null` for a miss — including any failure. */
  get(key: string): Promise<string | null>;
  /** Store, with a TTL. A failure is swallowed: a cache that cannot write is a cache. */
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** For the boot log: where entries are actually going. */
  readonly detail: string;
  close(): Promise<void>;
}

/** The cache that remembers nothing. The default with no Redis configured. */
export function noCache(): ResultCache {
  return {
    get: async () => null,
    set: async () => {},
    detail: "off (no REDIS_URL) — every solve is computed",
    close: async () => {},
  };
}

/**
 * A per-process map with an expiry, for tests and single-process development.
 *
 * Not offered as a production story: with two replicas it is two caches, which
 * for a *cache* is a hit rate rather than a correctness problem — the entry is
 * keyed on its own provenance, so the worst outcome is a solve that did not
 * need to happen.
 */
export function memoryCache(now: () => number = Date.now): ResultCache {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  return {
    get: async (key) => {
      const entry = entries.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set: async (key, value, ttlSec) => {
      entries.set(key, { value, expiresAt: now() + ttlSec * 1000 });
    },
    detail: "in-memory (per process)",
    close: async () => {
      entries.clear();
    },
  };
}

/**
 * Redis, with every failure treated as a miss.
 *
 * A solver behind a cache that throws when Redis blinks is a solver that is
 * down when Redis is down, which trades a 3 ms saving for an outage.
 */
export function redisCache(url: string, opTimeoutMs = 100): ResultCache {
  const redis = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  let complained = false;
  redis.on("error", (error: Error) => {
    if (!complained) {
      complained = true;
      console.error("optimize cache: redis error, serving every solve:", error.message);
    }
  });

  /** Never let the cache be slower than the thing it is caching. */
  const bounded = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await Promise.race([
        work(),
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error("redis timed out")), opTimeoutMs).unref(),
        ),
      ]);
    } catch {
      return fallback;
    }
  };

  return {
    get: (key) => bounded(() => redis.get(key), null),
    set: async (key, value, ttlSec) => {
      await bounded(async () => {
        await redis.set(key, value, "EX", ttlSec);
      }, undefined);
    },
    detail: `redis (shared across replicas) at ${new URL(url).host}`,
    close: async () => {
      redis.disconnect();
    },
  };
}

/** Redis when there is one, and no cache at all when there is not. */
export function createResultCache(url?: string): ResultCache {
  return url ? redisCache(url) : noCache();
}

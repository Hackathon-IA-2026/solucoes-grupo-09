import { Redis } from "ioredis";

/**
 * A cache you can also take a lock in — the shape a single-flight needs.
 *
 * `./result-cache.ts` remembers a solved plan and `./limit-store.ts` counts a
 * budget; this is the third shape, and it exists because collapsing a stampede
 * needs **two** operations against one key: store the answer, and claim the
 * right to compute it. A lock in one store and an entry in another is a winner
 * nobody can wait on, so both live behind one interface.
 *
 * Generic on purpose. Nothing here knows what is being cached, how the key is
 * built, how long an entry is worth keeping or what to serve when the lock is
 * lost — those are the caller's decisions and they live with the caller
 * (`../../diagnosis/narration-cache.ts` is the first one). What lives here is
 * the plumbing and the posture every store in this directory takes:
 *
 * - **Every failure degrades; none throws.** A `get` failure is a miss, a `set`
 *   failure is a cache that could not write, and a failed `acquire` returns
 *   `true` — the caller proceeds. A cache that fails closed would take the
 *   surface down when Redis blinks, which trades a saving for an outage.
 * - **Every round trip is bounded.** A cache must never be slower than the
 *   thing it is caching.
 * - **The lock's safety is its TTL, not its release.** `release` is best
 *   effort, so a process that dies holding one does not wedge a key.
 */

/** A cache with a lock. Both against the same store, by construction. */
export interface LockedCache {
  /** For the boot log: where entries are actually going. */
  readonly detail: string;
  /** The stored text, or `null` for a miss — including any failure. */
  get(key: string): Promise<string | null>;
  /** Store with a TTL. A failure is swallowed: a cache that cannot write is a cache. */
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** `SET NX PX` — `true` when this caller won the right to do the work. */
  acquire(key: string, ttlMs: number): Promise<boolean>;
  /** Drop the lock. Best effort; the TTL is what makes it safe. */
  release(key: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * A per-process map with expiry, for tests and single-process development.
 *
 * Correct for one replica and honest that that is what it is: with two
 * replicas it is two caches and two locks, which for a single-flight means one
 * call per replica rather than one call — a hit rate, not a correctness
 * problem, and the reason `REDIS_URL` is what the boot log names.
 */
export function memoryLockedCache(now: () => number = Date.now): LockedCache {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  const locks = new Map<string, number>();
  const held = (key: string): boolean => {
    const until = locks.get(key);
    if (until === undefined) {
      return false;
    }
    if (until <= now()) {
      locks.delete(key);
      return false;
    }
    return true;
  };
  return {
    detail: "in-memory (per process)",
    get: async (key) => {
      const entry = entries.get(key);
      if (entry === undefined) {
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
    acquire: async (key, ttlMs) => {
      if (held(key)) {
        return false;
      }
      locks.set(key, now() + ttlMs);
      return true;
    },
    release: async (key) => {
      locks.delete(key);
    },
    close: async () => {
      entries.clear();
      locks.clear();
    },
  };
}

/** Redis, shared across replicas, with every failure degrading rather than throwing. */
export function redisLockedCache(url: string, opTimeoutMs = 100): LockedCache {
  const redis = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  let complained = false;
  redis.on("error", (error: Error) => {
    if (!complained) {
      complained = true;
      console.error("locked cache: redis error, degrading:", error.message);
    }
  });
  const bounded = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await Promise.race([
        work(),
        new Promise<T>((_resolve, reject) =>
          setTimeout(() => reject(new Error("redis timed out")), opTimeoutMs).unref(),
        ),
      ]);
    } catch {
      return fallback;
    }
  };
  return {
    detail: `redis (shared across replicas) at ${new URL(url).host}`,
    get: (key) => bounded(() => redis.get(key), null),
    set: async (key, value, ttlSec) => {
      await bounded(async () => {
        await redis.set(key, value, "EX", ttlSec);
      }, undefined);
    },
    // `true` on failure, deliberately: the alternative is work that silently
    // stops the moment Redis blinks. A caller that also flights in-process
    // degrades to one call per replica rather than to none at all.
    acquire: (key, ttlMs) =>
      bounded(async () => (await redis.set(key, "1", "PX", ttlMs, "NX")) !== null, true),
    release: async (key) => {
      await bounded(async () => {
        await redis.del(key);
      }, undefined);
    },
    close: async () => {
      redis.disconnect();
    },
  };
}

/** Redis when one is configured, the per-process map otherwise. */
export function createLockedCache(url?: string): LockedCache {
  return url ? redisLockedCache(url) : memoryLockedCache();
}

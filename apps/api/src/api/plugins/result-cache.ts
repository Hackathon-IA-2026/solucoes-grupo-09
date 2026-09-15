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

/** The replay key's prefix, versioned for the same reason the optimizer's is. */
export const REPLAY_KEY_PREFIX = "replay:v1";

/**
 * What the ML service publishes as `actual.data_version` when the day it read
 * had no settled rows to take a version from.
 *
 * Spelled rather than defaulted to `0`, which would assert a vintage that never
 * existed — the same word and the same argument as `NO_DATA_VERSION` in
 * `contract/curtailment-observed.ts`, and as `NO_OBSERVED_DATA_VERSION` on the
 * Python side. `/v1/replay` refuses a day whose twenty-four hours are not all
 * settled, so a successful replay never carries it; `../replay.ts` treats it as
 * the absence it is and builds no validator over it.
 */
export const NO_OBSERVED_DATA_VERSION = "none";

/**
 * Build the replay key — `docs/specs/replay.md`, "Cache", verbatim:
 *
 * ```
 * replay:v1:<sha256(canonical scenario)>:<target_date>:<forecast_origin>:<optimizer_build>
 * ```
 *
 * Four components, and the two that differ from the optimizer's are the two
 * that make a shared replay link honest.
 *
 * The **target date** is in the key even though the scenario hash already
 * covers it, because it is what a human reading `redis-cli --scan` needs in
 * order to evict one day, and the spec puts it there.
 *
 * The **forecast origin** is `<origin_kind>@<published_at>` and not the instant
 * alone. A `backfilled_holdout` row's `published_at` *equals*
 * `gate_at(target_date, gate_profile)` exactly — that is `replay.md` seam 6 —
 * so on a day WattSteer both served and later reconstructed, the record and the
 * reconstruction share a publication instant and an instant-only key would
 * serve one under the other's name. The kind is the discriminator that keeps
 * them apart everywhere else in this system, and it is the discriminator here.
 *
 * The **optimizer build** is in it because a formulation change must not serve
 * yesterday's plan under today's code — a stale answer no TTL is short enough
 * to prevent.
 *
 * ### The fifth component the caching table used to ask for, and where it went
 *
 * `api-surface.md`'s caching table wrote this key with a fifth component —
 * `…:<obs_data_version>` — on the argument that a replay's observed half is
 * read `AsOf(now)` against a record ONS restates in place, so a restatement
 * should evict the entries it invalidates rather than be waited out. The
 * argument is right. The component cannot live *here*, and api-surface 24
 * decided it on that ground rather than on effort:
 *
 * **A Redis lookup key must be computable before the call that produces an
 * answer; the observed vintage is knowable only from the answer.** The pinned
 * fast path above does its `get`s before it posts to the ML service, holding a
 * scenario, a pinned instant and a build — and this gateway reads no rows. A
 * component it could only learn from the answer cannot decide which entry to
 * look up, and an entry keyed on a vintage nobody can spell is an entry nobody
 * can ever hit. So the key is four components and the spec's table now says
 * four.
 *
 * **The version is published, and it goes on the validator instead.**
 * `replay_result` carries `actual.data_version` — the greatest `data_version`
 * among the settled rows the replay was scored on — and `../replay.ts` puts it
 * on the deep link's ETag as a fifth component, which it can, because an ETag
 * is built from the answer. That closes the sharper half of the hole: a
 * validator blind to the observed half never moves when ONS rewrites the day,
 * so a client that keeps revalidating keeps being told 304 against numbers that
 * changed — stale with no expiry. It now moves when the record moves.
 *
 * **What remains, stated rather than hidden.** A Redis entry stored before a
 * restatement is still served after it, for as long as the entry lives:
 * `REPLAY_TTL_SEC`, 24 hours, and no longer — this cache has no other eviction
 * and no manual one. Downstream of that, a shared cache may hold a copy for
 * `max-age=600`, ten minutes, and its next revalidation now sees the moved
 * validator. So the worst case a reader can observe is **24 hours of a
 * pre-restatement replay of one day, plus the ten-minute shared window**, and
 * during it the answer is true of the record when it was computed, names the
 * publication it planned against, and now names the vintage it was scored on as
 * well. `vintage_fidelity` is no longer the only thing saying the ground may
 * have moved.
 *
 * Shortening the TTL is not the fix and is not offered: that would be answering
 * a provenance question with a duration, which is the one thing this key is
 * not allowed to do.
 */
export function replayKey(parts: {
  scenarioHash: string;
  targetDate: string;
  forecastOrigin: string;
  optimizerBuild: string;
}): string {
  return [
    REPLAY_KEY_PREFIX,
    parts.scenarioHash,
    parts.targetDate,
    parts.forecastOrigin,
    parts.optimizerBuild,
  ].join(":");
}

/** Somewhere a solved plan can be put and later found, or not. */
export interface ResultCache {
  /** The stored response text, or `null` for a miss — including any failure. */
  get: (key: string) => Promise<string | null>;
  /** Store, with a TTL. A failure is swallowed: a cache that cannot write is a cache. */
  set: (key: string, value: string, ttlSec: number) => Promise<void>;
  /** For the boot log: where entries are actually going. */
  readonly detail: string;
  close: () => Promise<void>;
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

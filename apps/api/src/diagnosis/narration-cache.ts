import type { DiagnosisNarrationInput, Narration } from "@wattsteer/core/api";
import type { DailyCap } from "../api/plugins/daily-cap.js";
import type { LockedCache } from "../api/plugins/locked-cache.js";
import { narrationCacheKey, narrationPayloadDigest } from "./narration-canonical.js";
import {
  NARRATION_MODEL_ID,
  type NarrationMessages,
  renderDiagnosisNarration,
} from "./narration-client.js";
import { narrationDecision } from "./narration-gate.js";
import { toNarrationDocument } from "./narration-payload.js";
import { templateNarration } from "./narration-template.js";
import type { FiredRule } from "./publication.js";

/**
 * The two things that stand between a page view and a language-model call.
 *
 * `docs/specs/api-surface.md` is precise that this endpoint is protected by a
 * **lock**, not by an IP budget: the real volume is 4 subsystems × 2 locales ×
 * 2 gate profiles ≈ 16 distinct narrations a day, everything else is a cache
 * hit, and the risk worth engineering against is a **stampede** — a thousand
 * concurrent misses on one cold key becoming a thousand calls. Sixteen
 * narrations a day cannot be protected by counting requests.
 *
 * So this module holds exactly two mechanisms and no third:
 *
 * 1. **The cache under `diagnosis.md`'s own key.**
 *    `narration:v1:{prompt_version}:{model_id}:{locale}:{sha256(canonical(input))}`
 *    is built by `./narration-canonical.ts` and used verbatim here. TTL 26 h
 *    for a model paragraph; **5 min** for a template one, so an outage or a
 *    spent budget does not become a call per request and recovery is fast.
 *    The digest rounds every float to display precision *before* hashing, so a
 *    recomputation's jitter is a hit and a change a reader could see is a miss.
 *    There is deliberately **no second key**: the HTTP layer does not cache the
 *    composed response, whose identity is already the pair of the attribution
 *    row and this entry.
 * 2. **Single-flight on that same key**, in two layers, because there are two
 *    kinds of concurrency and one lock cannot see both:
 *    - **In-process**, a map from key to the in-flight promise. A thousand
 *      simultaneous requests inside one replica await one promise, so the
 *      collapse is a property of the control flow rather than of a timeout.
 *      This is what the "hundred concurrent misses, one call" test asserts, and
 *      it holds with no Redis configured at all.
 *    - **Across replicas**, a Redis `SET key NX PX ttl` lock. The winner calls;
 *      the losers poll the cache under a short deadline and fall back to the
 *      **template** on expiry rather than queueing behind a call they cannot
 *      see. A follower that waited forever would turn one slow call into a
 *      thousand slow requests, which is the stampede wearing a different hat.
 *
 * ### What this module refuses to do
 *
 * **It never reaches the cache on a withheld day.** `./narration-gate.ts`
 * decides first, and a withheld day renders the template without a read, a
 * write, a lock or a counted call. Reading the cache first would be a path on
 * which a previously stored *model* paragraph could be served for a day whose
 * rules said the model may not speak.
 *
 * **It never refuses.** Over the daily cap the answer is a 200 carrying the
 * template, and `narration.source` says `template` — which the response already
 * has a field for, so the panel's footnote stays true with no new mechanism.
 *
 * **A store failure is a miss, never an error.** A narration cache that throws
 * when Redis blinks is an endpoint that is down when Redis is down; the
 * in-process flight is still in force, so the degraded mode is "one call per
 * replica per key" rather than "one call per request".
 */

/** 26 h, per `docs/specs/diagnosis.md`. Longer than the day it explains. */
export const NARRATION_TTL_SEC = 26 * 60 * 60;

/**
 * 5 min for a template entry, per the same line of the spec.
 *
 * Short because a template entry is a record of something being *unavailable* —
 * an outage, a rejected paragraph, a spent budget — and none of those are
 * facts about the day. It exists so a thousand requests during an outage are
 * one call, and it expires fast so recovery is fast.
 */
export const NARRATION_TEMPLATE_TTL_SEC = 5 * 60;

/** How long the winner's lock lives if the winner dies holding it. */
export const NARRATION_LOCK_TTL_MS = 30_000;

/** How long a follower waits on the winner before serving the template. */
export const NARRATION_LOCK_WAIT_MS = 3000;

/** How often a follower looks for the winner's entry. */
export const NARRATION_LOCK_POLL_MS = 25;

/** The lock's key: the cache key with one suffix, so the two cannot diverge. */
export function narrationLockKey(key: string): string {
  return `${key}:lock`;
}

/**
 * Where a paragraph is remembered and where the lock is taken.
 *
 * One interface rather than two because the lock has to live beside the entry
 * it protects: a lock in one store and an entry in another is a winner nobody
 * can wait on. The store itself is `../api/plugins/locked-cache.ts` — plumbing
 * that knows nothing about a narration, beside the other stores — and what is
 * named here is only which of them this module needs.
 */
export type NarrationStore = LockedCache;

/** How a paragraph was obtained. Reported for the log, never for the wire. */
export type NarrationOrigin =
  | "withheld"
  | "cache"
  | "rendered"
  | "follower"
  | "deadline"
  | "capped";

/** A paragraph, the account of where it came from, and what it cost. */
export interface CachedNarration {
  narration: Narration;
  /** The rules that withheld the model narration, in the order they fired. */
  withheldBy: string[];
  /** `diagnosis.md`'s key. Exposed so a test can assert there is only one. */
  key: string;
  origin: NarrationOrigin;
  /** Model calls actually made by *this* request: 0 on every path but one. */
  attempts: number;
}

/** Everything the cached narration needs, all of it injectable. */
export interface CachedNarrationDeps {
  store: NarrationStore;
  /** The global, per-civil-day budget. Never refuses; degrades to the template. */
  cap: DailyCap;
  /**
   * The in-flight map. Shared across requests by construction: the route holds
   * one and hands it to every call, which is what makes the collapse a
   * property of this process rather than of a lock's timing.
   */
  inflight: Map<string, Promise<InFlightResult>>;
  /** The SDK's `messages`. Injected so a test needs no key and no network. */
  messages?: NarrationMessages;
  lockTtlMs?: number;
  waitMs?: number;
  pollMs?: number;
  /** Injected so a follower's wait is not a real delay in a test. */
  sleep?: (ms: number) => Promise<void>;
}

/** What the winner produced, as the followers receive it. */
export interface InFlightResult {
  narration: Narration;
  origin: NarrationOrigin;
  attempts: number;
}

export interface CachedNarrationRequest {
  payload: DiagnosisNarrationInput;
  /** Every rule that fired, as stored on the attribution row. */
  ruleFlags: readonly FiredRule[];
  /**
   * The request instant, in ms, and the instant the budget is counted at.
   *
   * Passed in rather than read from the clock for the reason `LimitStore` takes
   * one: the cap's window is a Brasília **civil day**, so the caller and the
   * counter have to agree about which day it is. A route holding a frozen clock
   * that spent against `Date.now()` would count today's calls against a day
   * nobody asked about.
   */
  now?: number;
}

/** The key this payload's paragraph is cached under. One key, built once. */
export function narrationKeyFor(payload: DiagnosisNarrationInput): string {
  return narrationCacheKey({
    promptVersion: payload.promptVersion,
    modelId: NARRATION_MODEL_ID,
    locale: payload.locale,
    digest: narrationPayloadDigest(toNarrationDocument(payload)),
  });
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * A stored entry, or `null` if there is nothing usable there.
 *
 * Junk is a miss rather than a throw: an entry written by an older shape of
 * this code is a cache problem and must not become a 500.
 */
function parseEntry(raw: string | null): Narration | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const source = (parsed as { source?: unknown }).source;
    return source === "model" || source === "template" ? (parsed as Narration) : null;
  } catch {
    return null;
  }
}

/**
 * The narration for one payload: from the gate, the cache, or one call.
 *
 * The order is the whole design and each step is a refusal to do the next one:
 *
 * 1. **The gate.** A `withhold` rule renders the template here, with no cache
 *    read, no lock, no counted call and no model call. That is
 *    `./narration-gate.ts`'s guarantee and this function's job is not to route
 *    around it.
 * 2. **The cache.** One key, `diagnosis.md`'s.
 * 3. **The in-process flight.** Concurrent misses on one key await one promise.
 * 4. **The cross-replica lock.** The winner calls; a follower waits on the
 *    entry under a deadline and serves the template if the deadline passes.
 * 5. **The budget.** Counted only where a call is about to be made, so a cache
 *    hit and a withheld day cost nothing.
 */
export async function cachedNarration(
  deps: CachedNarrationDeps,
  request: CachedNarrationRequest,
): Promise<CachedNarration> {
  const { payload, ruleFlags } = request;
  const key = narrationKeyFor(payload);
  const decision = narrationDecision(ruleFlags);
  if (decision.source === "template") {
    return {
      narration: templateNarration(payload),
      withheldBy: decision.withheldBy,
      key,
      origin: "withheld",
      attempts: 0,
    };
  }

  const hit = parseEntry(await deps.store.get(key));
  if (hit !== null) {
    return { narration: hit, withheldBy: [], key, origin: "cache", attempts: 0 };
  }

  const existing = deps.inflight.get(key);
  if (existing !== undefined) {
    const shared = await existing;
    return {
      narration: shared.narration,
      withheldBy: [],
      key,
      origin: "follower",
      attempts: 0,
    };
  }

  const work = fill(deps, request, key);
  deps.inflight.set(key, work);
  try {
    const result = await work;
    return {
      narration: result.narration,
      withheldBy: [],
      key,
      origin: result.origin,
      attempts: result.attempts,
    };
  } finally {
    deps.inflight.delete(key);
  }
}

/** The winner's path, and the follower's wait when another replica won. */
async function fill(
  deps: CachedNarrationDeps,
  request: CachedNarrationRequest,
  key: string,
): Promise<InFlightResult> {
  const { payload, ruleFlags } = request;
  const lock = narrationLockKey(key);
  const won = await deps.store.acquire(lock, deps.lockTtlMs ?? NARRATION_LOCK_TTL_MS);
  if (!won) {
    const waited = await waitForEntry(deps, key);
    return waited === null
      ? { narration: templateNarration(payload), origin: "deadline", attempts: 0 }
      : { narration: waited, origin: "follower", attempts: 0 };
  }
  try {
    // Under the lock, once: another replica may have filled the entry between
    // this request's miss and this request's lock.
    const late = parseEntry(await deps.store.get(key));
    if (late !== null) {
      return { narration: late, origin: "cache", attempts: 0 };
    }

    const budget = await deps.cap.take(request.now);
    if (!budget.allowed) {
      const narration = templateNarration(payload);
      await deps.store.set(key, JSON.stringify(narration), NARRATION_TEMPLATE_TTL_SEC);
      return { narration, origin: "capped", attempts: 0 };
    }

    const rendered = await renderDiagnosisNarration({
      payload,
      ruleFlags,
      ...(deps.messages === undefined ? {} : { messages: deps.messages }),
    });
    // The budget meters calls, and the validator's one retry is a second call.
    // Counted after the fact rather than reserved up front: a reservation would
    // charge two every day for the retry that almost never happens.
    for (let extra = 1; extra < rendered.attempts; extra += 1) {
      await deps.cap.take(request.now);
    }
    await deps.store.set(
      key,
      JSON.stringify(rendered.narration),
      rendered.narration.source === "model"
        ? NARRATION_TTL_SEC
        : NARRATION_TEMPLATE_TTL_SEC,
    );
    return {
      narration: rendered.narration,
      origin: "rendered",
      attempts: rendered.attempts,
    };
  } finally {
    await deps.store.release(lock);
  }
}

/** Poll for the winner's entry until the deadline. `null` means it passed. */
async function waitForEntry(
  deps: CachedNarrationDeps,
  key: string,
): Promise<Narration | null> {
  const waitMs = deps.waitMs ?? NARRATION_LOCK_WAIT_MS;
  const pollMs = deps.pollMs ?? NARRATION_LOCK_POLL_MS;
  const sleep = deps.sleep ?? delay;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const entry = parseEntry(await deps.store.get(key));
    if (entry !== null) {
      return entry;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(pollMs);
  }
}

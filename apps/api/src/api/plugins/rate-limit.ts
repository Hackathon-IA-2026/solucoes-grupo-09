/**
 * The published budget, and the three tiers it is published as.
 *
 * The surface is public, unauthenticated and account-free, so there is no key
 * to meter and no `Authorization` header to `Vary` on — and behind it sit a
 * branch-and-bound solver and a language model. One budget cannot protect
 * both, and neither is protected by counting page views:
 *
 * | Tier      | Routes                              | Budget              | Shape        |
 * |-----------|-------------------------------------|---------------------|--------------|
 * | Unmetered | `/`, `/health`, `/ready`, `/docs`    | ∞                   | as built     |
 * | Read      | every other `/v1` read              | 120 / min / IP      | fixed window |
 * | Solve     | `/v1/optimize`, `/v1/replay`        | 30 / min / IP, burst 10 | token bucket |
 *
 * Reads get a fixed window because almost every hit is a shared-cache hit and
 * the window boundary effect is harmless. The solve tier gets a bucket because
 * it is not: a fixed window lets 60 requests through across a boundary, and
 * `flex-optimizer.md` asked for a burst, which a window cannot express.
 *
 * ### What the solve tier actually buys, now that both routes are measured
 *
 * The 30/minute is `flex-optimizer.md`'s published number and it was sized
 * against the optimizer's **3.15 ms**. `apps/ml/tests/test_replay_cost.py`
 * since measured the other route on this tier: a replay on the published
 * `REFERENCE_FLEET` is **24.4 ms** — two MILP solves and five simulator passes
 * rather than one and one, which is **7.7×** the figure the budget was sized
 * against. So the arithmetic the tier was chosen on is not the arithmetic it is
 * now doing:
 *
 * | at full budget      | per IP, per minute | IPs to saturate one core |
 * |---------------------|--------------------|--------------------------|
 * | optimize · 3.15 ms  | 95 ms  (0.16 %)    | ~635                     |
 * | replay   · 24.4 ms  | 732 ms (1.2 %)     | ~82                      |
 *
 * **The number is kept and the reason is written down, rather than quietly
 * lowered.** Three things hold it up. The tier is a *count*, and 82 distinct
 * IPs each sustaining the full budget is a botnet rather than a bored user;
 * `mlTimeoutMs` is 5 s against a worst-case burst of 10 replays ≈ 244 ms, so
 * the burst allowance has two orders of magnitude of headroom and is not what
 * fails first; and the number is `flex-optimizer.md`'s published contract,
 * which `api-surface.md` may re-path and not re-shape — a gateway that halved a
 * published budget on its own authority would be the second place the budget is
 * specified. What the measurement does change is the *margin*: the tier is 7.7×
 * less protective than the sentence that chose it assumed, and
 * `WATTSTEER_RATE_LIMIT_SOLVE` is the knob, so the operational answer is a
 * number an operator can turn rather than a constant a reader has to rediscover.
 *
 * It also settles which way the tiers split if they ever do. They share one
 * budget today because they share one solver; the moment they do not, replay is
 * the dearer of the two by 7.7× and is therefore the one that must get the
 * **smaller** allowance — the failure to avoid is the cheap route's number
 * being inherited by the dear one a second time.
 *
 * The language model is deliberately **not** metered by IP. `diagnosis.md`
 * counts the real volume — 4 subsystems × 2 locales × 2 gates ≈ 16 distinct
 * narrations a day — so an IP budget would protect nothing while doing nothing
 * about the actual risk, a cache stampede. That is `dailyCap` in
 * `daily-cap.ts`, which counts *calls* rather than requests.
 *
 * Where the counting happens is `limit-store.ts`: Redis when configured, so
 * the published budget survives a second replica, and the in-memory map
 * otherwise.
 */

import { Elysia } from "elysia";
import { RateLimitedError, toErrorEnvelope } from "../../errors.js";
import {
  createLimitStore,
  type LimitPolicy,
  type LimitStore,
  memoryStore,
} from "./limit-store.js";
import { requestIdOf } from "./request-context.js";

export type { Decision, LimitPolicy, LimitStore } from "./limit-store.js";
export {
  consume,
  consumeBucket,
  createLimitStore,
  memoryStore,
  redisStore,
  sweep,
  sweepBuckets,
} from "./limit-store.js";

/** The tiers. `null` is the unmetered one — it spends nothing. */
export type Tier = "read" | "solve" | "voice";

/** Paths that are never metered: cheap probes a monitor must never be throttled on. */
export const UNMETERED_PATHS: ReadonlySet<string> = new Set(["/", "/health", "/ready"]);

/**
 * The solve tier's routes: the MILP and the replay, by `POST` and by the
 * shareable `GET ?s=` form alike — the budget is on the solver, not on the verb.
 */
export const SOLVE_PATHS: readonly string[] = ["/v1/optimize", "/v1/replay"];

/**
 * The voice tier's route: minting an ephemeral realtime credential.
 *
 * Its own tier because it is neither of the other two and is cheaper than both
 * to *serve* and far more expensive to *spend*. A read is a cached row; a solve
 * is 3 ms of branch-and-bound on our own CPU. This is one HTTPS round trip to
 * xAI that hands the caller a credential good for a live audio session billed
 * by the minute — and this product is **public and unauthenticated**, so anyone
 * who can load the page can ask for one. The budget is therefore small, and it
 * is not shared with the read tier where a generous allowance is correct
 * because almost every hit is a shared-cache hit.
 */
export const VOICE_PATHS: readonly string[] = ["/v1/voice/session"];

/** Pure: is this path one the solver answers (including sub-paths like `/v1/replay/days`)? */
export function isSolvePath(pathname: string): boolean {
  return SOLVE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Pure: which budget this request spends against, or `null` for unmetered.
 *
 * `/v1/replay/days` **and every day under it** are calendar reads and not
 * solves, so they are called out rather than swept in by the prefix: they run
 * two `group by`s and a card read, the shortlist is a cached list of dates, and
 * metering either at the solver's rate would throttle a date picker.
 *
 * `/v1/replay` and `/v1/replay/observed-only` are solves and are metered as
 * such — a replay is two MILP solves and five simulator passes, **24.4 ms
 * measured** against the optimizer's 3.15 ms, so if the two tiers ever part
 * company this is the one that must not be the cheaper. See the module comment
 * for what that 7.7× does to the budget's margin.
 */
export function classifyTier(_method: string, pathname: string): Tier | null {
  if (UNMETERED_PATHS.has(pathname) || pathname.startsWith("/docs")) {
    return null;
  }
  if (pathname === "/v1/replay/days" || pathname.startsWith("/v1/replay/days/")) {
    return "read";
  }
  if (VOICE_PATHS.includes(pathname)) {
    return "voice";
  }
  return isSolvePath(pathname) ? "solve" : "read";
}

/**
 * Pure: the client this request is charged to.
 *
 * The old rule was "the first `X-Forwarded-For` hop", which is correct behind
 * a proxy that *overwrites* the header and is a free budget reset for anyone
 * who can reach the port directly and send one: `X-Forwarded-For: <random>`
 * bought a fresh 120 requests every time.
 *
 * The rule is now positional. With `depth` trusted proxies in front, the only
 * hop none of them could have been lied to about is the `depth`-th from the
 * **end** — everything to its left was written by whoever was talking, and is
 * evidence about nothing. `depth = 0` ignores the header entirely (direct
 * exposure); a header too short for the configured depth is a header that did
 * not come through the expected proxy chain, so the socket address wins.
 */
export function clientKey(
  forwardedFor: string | null,
  socketIp: string,
  depth = 1,
): string {
  if (depth <= 0) {
    return socketIp;
  }
  const hops = (forwardedFor ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.at(-depth) || socketIp;
}

export interface RateLimitOptions {
  /** The policy each tier is metered under. */
  tiers: Record<Tier, LimitPolicy>;
  /** Which tier a request spends against; `null` is unmetered. */
  classify?: (method: string, pathname: string) => Tier | null;
  /** Where the counting happens. Defaults to the per-process map. */
  store?: LimitStore;
  /** How many proxies sit in front of this process. See `clientKey`. */
  trustedProxyDepth?: number;
}

/** The budgets the spec publishes, as policies. */
export function tiersFrom(limits: {
  readMax: number;
  windowMs: number;
  solveMax: number;
  solveBurst: number;
  voiceMax: number;
}): Record<Tier, LimitPolicy> {
  return {
    read: { kind: "fixed-window", max: limits.readMax, windowMs: limits.windowMs },
    solve: {
      kind: "token-bucket",
      max: limits.solveMax,
      windowMs: limits.windowMs,
      burst: limits.solveBurst,
    },
    // A fixed window rather than a bucket, and deliberately no burst: a reader
    // opens one voice session at a time and a burst of them is not a slider
    // being dragged, it is somebody minting credentials.
    voice: { kind: "fixed-window", max: limits.voiceMax, windowMs: limits.windowMs },
  };
}

export const rateLimit = (options: RateLimitOptions) => {
  const classify = options.classify ?? classifyTier;
  const store = options.store ?? memoryStore();
  const depth = options.trustedProxyDepth ?? 1;
  return new Elysia({ name: "rate-limit", seed: options.tiers })
    .onRequest(async ({ request, set, server }) => {
      if (request.method === "OPTIONS") {
        return; // a CORS preflight is never the thing being protected
      }
      const pathname = new URL(request.url).pathname;
      const tier = classify(request.method, pathname);
      if (!tier) {
        return;
      }
      const policy = options.tiers[tier];
      if (policy.max <= 0) {
        return; // this tier's budget is disabled
      }
      const key = clientKey(
        request.headers.get("x-forwarded-for"),
        server?.requestIP(request)?.address ?? "unknown",
        depth,
      );
      const { limited, retryAfterSec } = await store.consume(
        policy,
        `${tier}:${key}`,
        Date.now(),
      );
      if (!limited) {
        return;
      }
      // The envelope, not a bare string: a 429 is the failure a client is most
      // likely to handle programmatically, so it is the last one that should
      // arrive in a shape of its own. And the wait travels *inside the error*
      // — `Retry-After` and `details.retry_after_sec` are read off one object,
      // so the header and the body cannot disagree about how long to wait.
      const mapped = toErrorEnvelope(
        new RateLimitedError(
          retryAfterSec,
          "Too many requests — this endpoint is rate limited. Try again shortly.",
          { details: { tier, retry_after_sec: retryAfterSec } },
        ),
        requestIdOf(request),
      );
      set.status = mapped.status;
      set.headers["retry-after"] = String(mapped.retryAfterSec ?? retryAfterSec);
      return mapped.body;
    })
    .as("global");
};

/** Re-exported so a caller can build the configured store in one import. */
export const limitStoreFor = createLimitStore;

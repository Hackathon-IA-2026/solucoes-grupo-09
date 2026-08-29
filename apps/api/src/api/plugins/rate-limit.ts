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

/** The three tiers. `null` is the unmetered one — it spends nothing. */
export type Tier = "read" | "solve";

/** Paths that are never metered: cheap probes a monitor must never be throttled on. */
export const UNMETERED_PATHS: ReadonlySet<string> = new Set(["/", "/health", "/ready"]);

/**
 * The solve tier's routes: the MILP and the replay, by `POST` and by the
 * shareable `GET ?s=` form alike — the budget is on the solver, not on the verb.
 */
export const SOLVE_PATHS: readonly string[] = ["/v1/optimize", "/v1/replay"];

/** Pure: is this path one the solver answers (including sub-paths like `/v1/replay/days`)? */
export function isSolvePath(pathname: string): boolean {
  return SOLVE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Pure: which budget this request spends against, or `null` for unmetered.
 *
 * `/v1/replay/days` is a calendar read and not a solve, so it is called out
 * rather than swept in by the prefix: the shortlist is a cached list of dates
 * and metering it at the solver's rate would throttle a date picker.
 */
export function classifyTier(_method: string, pathname: string): Tier | null {
  if (UNMETERED_PATHS.has(pathname) || pathname.startsWith("/docs")) {
    return null;
  }
  if (pathname === "/v1/replay/days") {
    return "read";
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
  return hops[hops.length - depth] || socketIp;
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
}): Record<Tier, LimitPolicy> {
  return {
    read: { kind: "fixed-window", max: limits.readMax, windowMs: limits.windowMs },
    solve: {
      kind: "token-bucket",
      max: limits.solveMax,
      windowMs: limits.windowMs,
      burst: limits.solveBurst,
    },
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

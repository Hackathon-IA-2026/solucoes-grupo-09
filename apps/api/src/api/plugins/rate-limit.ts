import { Elysia } from "elysia";

/**
 * Fixed-window, per-client rate limiting for the expensive scrape surface.
 * Every counted request may launch a real Chromium session, so the budget is
 * deliberately small; cheap endpoints (/, /health, /ready, /docs) are exempt.
 *
 * In-memory by design: with the in-process runner there is exactly one API
 * process, and with BullMQ the API tier still fronts all submissions. Behind a
 * load balancer, enforce a shared limit at the proxy as well.
 */

export interface RateLimitOptions {
  /** Requests allowed per client per window; 0 disables the limiter. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
  /** Which requests count against the budget. */
  counts: (method: string, pathname: string) => boolean;
}

interface Window {
  count: number;
  resetAt: number;
}

/** Pure: first hop of X-Forwarded-For (set by the proxy), else the socket IP. */
export function clientKey(forwardedFor: string | null, socketIp: string): string {
  const first = forwardedFor?.split(",")[0]?.trim();
  return first || socketIp;
}

/** Pure: advance/reset the client's window and report whether it's over. */
export function consume(
  windows: Map<string, Window>,
  key: string,
  now: number,
  options: Pick<RateLimitOptions, "max" | "windowMs">,
): { limited: boolean; retryAfterSec: number } {
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + options.windowMs });
    return { limited: false, retryAfterSec: 0 };
  }
  current.count += 1;
  if (current.count > options.max) {
    return {
      limited: true,
      retryAfterSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  return { limited: false, retryAfterSec: 0 };
}

/** Drop expired windows so the map can't grow unbounded under churn. */
export function sweep(windows: Map<string, Window>, now: number): void {
  for (const [key, value] of windows) {
    if (value.resetAt <= now) {
      windows.delete(key);
    }
  }
}

/** Sweep whenever the map crosses this size (amortized cleanup). */
const SWEEP_THRESHOLD = 10_000;

export const rateLimit = (options: RateLimitOptions) => {
  const windows = new Map<string, Window>();
  return new Elysia({ name: "rate-limit", seed: options })
    .onRequest(({ request, set, server }) => {
      if (options.max <= 0 || request.method === "OPTIONS") {
        return; // disabled, or a CORS preflight (never a scrape)
      }
      const pathname = new URL(request.url).pathname;
      if (!options.counts(request.method, pathname)) {
        return;
      }
      const now = Date.now();
      if (windows.size > SWEEP_THRESHOLD) {
        sweep(windows, now);
      }
      const key = clientKey(
        request.headers.get("x-forwarded-for"),
        server?.requestIP(request)?.address ?? "unknown",
      );
      const { limited, retryAfterSec } = consume(windows, key, now, options);
      if (limited) {
        set.status = 429;
        set.headers["retry-after"] = String(retryAfterSec);
        return {
          error: "Too many requests — scraping is rate limited. Try again shortly.",
        };
      }
    })
    .as("global");
};

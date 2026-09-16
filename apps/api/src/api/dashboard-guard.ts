/**
 * Whether the BullMQ dashboard may be mounted, and who may reach it.
 *
 * The dashboard exposes job payloads **and controls** — retry, remove, drain —
 * over Redis. Two comments in this repo already said so, one of them naming it
 * "the unauthenticated jobs dashboard", and both asked the operator to protect
 * it: *"must be protected by auth/network in prod"*, *"Protect it in
 * production."* Neither was a control. They were a request, addressed to
 * whoever set `WATTSTEER_DASHBOARD=true`.
 *
 * `jobs-dashboard.ts` describes the exact moment that request gets ignored —
 * the flag is "the configuration most likely to be turned on by hand, in a
 * hurry, against a password somebody has just typed". A note in a source file
 * is not read at that moment. So the decision moves here and fails **closed**:
 * in production the dashboard does not mount at all unless a token is
 * configured, and when it does mount, the token is required on every request.
 *
 * Outside production nothing changes — a token is honoured if set, and its
 * absence still mounts, because that is the local workflow this flag exists for.
 *
 * Pure, so the whole decision table is testable without Redis, a server or an
 * environment. The wiring in `index.ts` does what this returns and nothing else.
 */

import { timingSafeEqual } from "node:crypto";

export interface DashboardEnvironment {
  /** `WATTSTEER_DASHBOARD`. */
  readonly dashboard: boolean;
  /** The dashboard needs a queue to read. */
  readonly redisUrl: string | undefined;
  readonly isProd: boolean;
  /** `WATTSTEER_DASHBOARD_TOKEN`, when one is configured. */
  readonly token: string | undefined;
}

export type DashboardDecision =
  | {
      readonly mount: false;
      /** Logged verbatim at boot. Says what to do, not merely what happened. */
      readonly reason: string;
      /** Whether the refusal is a misconfiguration rather than an opt-out. */
      readonly warn: boolean;
    }
  | { readonly mount: true; readonly token: string | null };

export function dashboardDecision(env: DashboardEnvironment): DashboardDecision {
  if (!env.dashboard) {
    return { mount: false, reason: "WATTSTEER_DASHBOARD is not set", warn: false };
  }
  if (!env.redisUrl) {
    return {
      mount: false,
      reason: "WATTSTEER_DASHBOARD is set but there is no REDIS_URL to read a queue from",
      warn: true,
    };
  }
  const token = env.token?.trim() ? env.token : null;
  if (env.isProd && token === null) {
    // The one case this module exists for. Refusing to serve a dashboard is
    // recoverable in a way that serving an open one is not.
    return {
      mount: false,
      reason:
        "refusing to mount the jobs dashboard in production without " +
        "WATTSTEER_DASHBOARD_TOKEN — it exposes job payloads and controls. " +
        "Set the token, or leave WATTSTEER_DASHBOARD unset.",
      warn: true,
    };
  }
  return { mount: true, token };
}

/**
 * Whether a request may reach a mounted dashboard.
 *
 * `Authorization: Bearer <token>`, compared in constant time. A plain `===` on
 * a secret leaks its length and its matching prefix to anyone who can measure
 * the response, which over a public route is a workable oracle.
 *
 * `token === null` means no token was configured, which `dashboardDecision`
 * only ever allows outside production.
 */
export function dashboardAuthorized(
  header: string | null | undefined,
  token: string | null,
): boolean {
  if (token === null) {
    return true;
  }
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) {
    return false;
  }
  const offered = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  // `timingSafeEqual` throws on a length mismatch, which would itself be the
  // timing signal it exists to remove. Compare lengths first and keep going,
  // so a wrong-length guess costs the same as a wrong-value one.
  const sameLength = offered.length === expected.length;
  const left = sameLength ? offered : expected;
  return timingSafeEqual(left, expected) && sameLength;
}

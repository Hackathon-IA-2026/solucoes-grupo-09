import { describe, expect, it } from "bun:test";
import { dashboardAuthorized, dashboardDecision } from "../src/api/dashboard-guard.js";

/**
 * The jobs dashboard fails closed in production.
 *
 * Two comments in this repo already said it had to be protected — one of them
 * calling it "the unauthenticated jobs dashboard" — and neither was a control.
 * `jobs-dashboard.ts` even names the moment the request gets ignored: the flag
 * is "the configuration most likely to be turned on by hand, in a hurry".
 *
 * So the decision is a pure function and this is its table. The property that
 * matters is the third case: production plus the flag plus no token must
 * **refuse**, because a dashboard that does not mount is recoverable and an
 * open one, exposing job payloads and retry/remove controls over Redis, is not.
 */
describe("whether the jobs dashboard mounts", () => {
  const base = {
    dashboard: true,
    redisUrl: "redis://localhost:6379",
    isProd: true,
    token: "s3cret",
  } as const;

  it("stays off when the flag is not set, and does not call that a problem", () => {
    const decision = dashboardDecision({ ...base, dashboard: false });
    expect(decision.mount).toBe(false);
    // Not a misconfiguration: off is the default and the common case.
    expect(decision.mount === false && decision.warn).toBe(false);
  });

  it("refuses in production with no token, and says what to do", () => {
    const decision = dashboardDecision({ ...base, token: undefined });
    expect(decision.mount).toBe(false);
    expect(decision.mount === false && decision.warn).toBe(true);
    expect(decision.mount === false && decision.reason).toContain(
      "WATTSTEER_DASHBOARD_TOKEN",
    );
  });

  it("treats a blank token as no token", () => {
    // An empty or whitespace variable is what a half-finished deploy sets, and
    // it must not read as "protected".
    for (const token of ["", "   "]) {
      expect(dashboardDecision({ ...base, token }).mount).toBe(false);
    }
  });

  it("mounts in production with a token", () => {
    const decision = dashboardDecision(base);
    expect(decision.mount).toBe(true);
    expect(decision.mount === true && decision.token).toBe("s3cret");
  });

  it("mounts outside production without one, which is what the flag is for", () => {
    const decision = dashboardDecision({ ...base, isProd: false, token: undefined });
    expect(decision.mount).toBe(true);
    expect(decision.mount === true && decision.token).toBeNull();
  });

  it("refuses with no queue to read, and calls that a problem", () => {
    const decision = dashboardDecision({ ...base, redisUrl: undefined });
    expect(decision.mount).toBe(false);
    expect(decision.mount === false && decision.warn).toBe(true);
  });
});

describe("who may reach a mounted dashboard", () => {
  it("accepts the configured bearer token", () => {
    expect(dashboardAuthorized("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong token, a wrong scheme, and a missing header", () => {
    expect(dashboardAuthorized("Bearer wrong!", "s3cret")).toBe(false);
    expect(dashboardAuthorized("Basic s3cret", "s3cret")).toBe(false);
    expect(dashboardAuthorized(null, "s3cret")).toBe(false);
    expect(dashboardAuthorized(undefined, "s3cret")).toBe(false);
  });

  it("rejects a prefix and an extension of the token", () => {
    // The length-mismatch path must be a plain `false` rather than a throw:
    // `timingSafeEqual` raises on unequal lengths, and an exception here would
    // be the timing signal the constant-time compare exists to remove.
    expect(dashboardAuthorized("Bearer s3cre", "s3cret")).toBe(false);
    expect(dashboardAuthorized("Bearer s3crets", "s3cret")).toBe(false);
    expect(dashboardAuthorized("Bearer ", "s3cret")).toBe(false);
  });

  it("lets everything through when no token is configured", () => {
    // Only reachable outside production — `dashboardDecision` never returns a
    // null token with `isProd`, which the table above holds.
    expect(dashboardAuthorized(null, null)).toBe(true);
  });
});

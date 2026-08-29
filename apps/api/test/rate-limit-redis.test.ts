import { afterAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { dailyCap } from "../src/api/plugins/daily-cap.js";
import {
  type LimitPolicy,
  type LimitStore,
  memoryStore,
  redisStore,
} from "../src/api/plugins/limit-store.js";
import { rateLimit, tiersFrom } from "../src/api/plugins/rate-limit.js";

/**
 * **The published budget is the real budget.**
 *
 * The property this file exists for cannot be asserted against the in-memory
 * store, because it is precisely the property the in-memory store does not
 * have: two API processes, one budget. Everything here therefore needs a live
 * Redis and is gated the way `bullmq.test.ts` is, so the default
 * `bun test test` path stays offline.
 *
 * Runs only when a test Redis is provided (the `test:redis` script sets it).
 * Spin one up with: docker run -d -p 6390:6379 redis:7-alpine
 */

const REDIS = process.env.WATTSTEER_TEST_REDIS_URL;
const suite = REDIS ? describe : describe.skip;

/** A prefix per run, so a re-run never inherits the previous run's counters. */
const prefix = () => `wattsteer:test:${crypto.randomUUID()}`;

suite("rate limiting · one budget across replicas (real Redis)", () => {
  const stores: LimitStore[] = [];
  const store = (p: string) => {
    const s = redisStore(REDIS as string, { prefix: p, opTimeoutMs: 2000 });
    stores.push(s);
    return s;
  };

  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()));
  });

  it("reports itself as the shared counter", () => {
    const s = store(prefix());
    expect(s.kind).toBe("redis");
    expect(s.detail).toContain("shared");
  });

  it("two API instances share one read budget", async () => {
    // The whole point: this is a 429 on the *fourth* request even though each
    // app has only seen two. In-memory, both would answer 200 forever.
    const p = prefix();
    const tiers = tiersFrom({
      readMax: 3,
      windowMs: 60_000,
      solveMax: 30,
      solveBurst: 10,
    });
    const make = () =>
      new Elysia()
        .use(rateLimit({ tiers, store: store(p), trustedProxyDepth: 1 }))
        .get("/v1/meta", () => ({ ok: true }));
    const a = make();
    const b = make();
    const hit = (app: Elysia) =>
      app.handle(
        new Request("http://localhost/v1/meta", {
          headers: { "x-forwarded-for": "10.0.0.42" },
        }),
      );

    expect((await hit(a)).status).toBe(200);
    expect((await hit(b)).status).toBe(200);
    expect((await hit(a)).status).toBe(200);
    const limited = await hit(b);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("the solve bucket permits a burst of ten across two instances, then throttles", async () => {
    const p = prefix();
    const policy: LimitPolicy = {
      kind: "token-bucket",
      max: 30,
      windowMs: 60_000,
      burst: 10,
    };
    const a = store(p);
    const b = store(p);
    const now = Date.now();
    const results: { limited: boolean; retryAfterSec: number }[] = [];
    for (let i = 0; i < 11; i++) {
      const target = i % 2 === 0 ? a : b;
      results.push(await target.consume(policy, "solve:10.0.0.43", now));
    }
    expect(results.slice(0, 10).every((r) => !r.limited)).toBe(true);
    expect(results[10]?.limited).toBe(true);
    expect(results[10]?.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("the Redis bucket refills at the same rate the pure function does", async () => {
    const p = prefix();
    const s = store(p);
    const policy: LimitPolicy = {
      kind: "token-bucket",
      max: 30,
      windowMs: 60_000,
      burst: 2,
    };
    const t0 = Date.now();
    expect((await s.consume(policy, "k", t0)).limited).toBe(false);
    expect((await s.consume(policy, "k", t0)).limited).toBe(false);
    expect((await s.consume(policy, "k", t0)).limited).toBe(true);
    // One token every two seconds at 30/min — asserted by advancing the clock
    // we pass in, not by sleeping.
    expect((await s.consume(policy, "k", t0 + 1000)).limited).toBe(true);
    expect((await s.consume(policy, "k", t0 + 2000)).limited).toBe(false);
  });

  it("the daily cap is one counter for the whole deployment", async () => {
    const p = prefix();
    const name = `narration-${crypto.randomUUID()}`;
    const a = dailyCap({ name, limit: 2, store: store(p) });
    const b = dailyCap({ name, limit: 2, store: store(p) });
    expect((await a.take()).allowed).toBe(true);
    expect((await b.take()).allowed).toBe(true);
    const over = await a.take();
    expect(over.allowed).toBe(false);
    expect(over.used).toBe(3);
  });

  it("falls back to the per-process budget when Redis is unreachable", async () => {
    // Fail-degraded, not fail-open and not fail-closed: a Redis outage must
    // not remove the budget and must not hang a request either.
    const dead = redisStore("redis://127.0.0.1:6399", {
      prefix: prefix(),
      opTimeoutMs: 150,
    });
    try {
      const policy: LimitPolicy = { kind: "fixed-window", max: 1, windowMs: 60_000 };
      expect((await dead.consume(policy, "k", Date.now())).limited).toBe(false);
      expect((await dead.consume(policy, "k", Date.now())).limited).toBe(true);
    } finally {
      await dead.close();
    }
  });

  it("agrees with the in-memory store on the same policy", async () => {
    const p = prefix();
    const redis = store(p);
    const memory = memoryStore();
    const policy: LimitPolicy = { kind: "fixed-window", max: 5, windowMs: 60_000 };
    const now = Date.now();
    for (let i = 0; i < 7; i++) {
      const fromRedis = await redis.consume(policy, "same", now);
      const fromMemory = await memory.consume(policy, "same", now);
      expect(fromRedis.limited).toBe(fromMemory.limited);
    }
  });
});

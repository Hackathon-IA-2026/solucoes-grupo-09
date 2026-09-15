import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import {
  type BucketState,
  consume,
  consumeBucket,
  memoryStore,
  sweep,
  sweepBuckets,
  type WindowState,
} from "../src/api/plugins/limit-store.js";
import {
  classifyTier,
  clientKey,
  isSolvePath,
  type LimitStore,
  rateLimit,
  tiersFrom,
} from "../src/api/plugins/rate-limit.js";
import { config } from "../src/config.js";
import type { ErrorEnvelope } from "../src/errors.js";

/**
 * **Seam 12.** The three tiers have three budgets; the solve tier is a bucket
 * that permits a burst of ten and then throttles; the client key ignores a
 * forwarded-for hop beyond the trusted depth; a 429 carries the envelope and
 * `Retry-After`; and the counter is a seam, so two processes pointed at one
 * store share one budget.
 *
 * Everything here runs against the in-memory store, which is what keeps the
 * default `bun test` path free of Redis. The same properties against a real
 * Redis are `rate-limit-redis.test.ts`, gated on `WATTSTEER_TEST_REDIS_URL`.
 */

describe("clientKey · the hop a trusted proxy set", () => {
  it("depth 1 takes the last hop, not the first", () => {
    // The first hop is whatever the client typed. Behind one proxy, the last
    // is the only one the proxy itself wrote.
    expect(clientKey("203.0.113.9, 10.0.0.1", "127.0.0.1", 1)).toBe("10.0.0.1");
  });

  it("a forged prefix buys no fresh budget", () => {
    const forged = (spoof: string) => clientKey(`${spoof}, 10.0.0.1`, "127.0.0.1", 1);
    expect(forged("1.2.3.4")).toBe(forged("5.6.7.8"));
    expect(forged("1.2.3.4")).toBe("10.0.0.1");
  });

  it("depth 2 takes the second hop from the end", () => {
    expect(clientKey("1.1.1.1, 203.0.113.9, 10.0.0.1", "127.0.0.1", 2)).toBe(
      "203.0.113.9",
    );
  });

  it("depth 0 ignores the header entirely", () => {
    expect(clientKey("203.0.113.9, 10.0.0.1", "127.0.0.1", 0)).toBe("127.0.0.1");
  });

  it("a chain shorter than the trusted depth falls back to the socket", () => {
    expect(clientKey("203.0.113.9", "192.168.1.5", 2)).toBe("192.168.1.5");
    expect(clientKey(null, "192.168.1.5")).toBe("192.168.1.5");
    expect(clientKey("", "192.168.1.5")).toBe("192.168.1.5");
    expect(clientKey("   ", "192.168.1.5")).toBe("192.168.1.5");
  });
});

describe("the published budgets", () => {
  it("are the three the spec publishes", () => {
    // 120 / 30 burst 10 / 200 a day. Invented constants, placed where being
    // wrong is conservative — but published, so they are asserted.
    expect(config.rateLimitMax).toBe(120);
    expect(config.rateLimitWindowMs).toBe(60_000);
    expect(config.rateLimitSolveMax).toBe(30);
    expect(config.rateLimitSolveBurst).toBe(10);
    expect(config.narrationDailyCap).toBe(200);
    expect(config.trustedProxyDepth).toBe(1);
  });
});

describe("classifyTier · three tiers", () => {
  it("the probes and the docs are unmetered", () => {
    for (const path of ["/", "/health", "/ready", "/docs", "/docs/json"]) {
      expect(classifyTier("GET", path)).toBe(null);
    }
  });

  it("the solver and the replay are the solve tier, by either verb", () => {
    expect(classifyTier("POST", "/v1/optimize")).toBe("solve");
    expect(classifyTier("GET", "/v1/optimize")).toBe("solve");
    expect(classifyTier("POST", "/v1/replay")).toBe("solve");
    expect(isSolvePath("/v1/optimize")).toBe(true);
  });

  it("the replay calendar is a read, not a solve", () => {
    // A date picker must not be throttled at the solver's rate.
    expect(classifyTier("GET", "/v1/replay/days")).toBe("read");
  });

  it("everything else is a read", () => {
    expect(classifyTier("GET", "/v1/forecast/day-ahead")).toBe("read");
    expect(classifyTier("GET", "/v1/meta")).toBe("read");
  });
});

describe("consume · the read tier's fixed window", () => {
  const opts = { max: 3, windowMs: 1000 } as const;

  it("allows up to max requests, limits the next", () => {
    const windows = new Map<string, WindowState>();
    for (let i = 0; i < 3; i++) {
      expect(consume(windows, "a", 0, opts).limited).toBe(false);
    }
    const fourth = consume(windows, "a", 100, opts);
    expect(fourth.limited).toBe(true);
    expect(fourth.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("resets after the window elapses", () => {
    const windows = new Map<string, WindowState>();
    for (let i = 0; i < 4; i++) {
      consume(windows, "a", 0, opts);
    }
    expect(consume(windows, "a", 1001, opts).limited).toBe(false);
  });

  it("tracks clients independently", () => {
    const windows = new Map<string, WindowState>();
    for (let i = 0; i < 4; i++) {
      consume(windows, "a", 0, opts);
    }
    expect(consume(windows, "b", 0, opts).limited).toBe(false);
  });
});

describe("consumeBucket · the solve tier's token bucket", () => {
  // The published budget: 30 a minute, burst 10.
  const policy = { max: 30, windowMs: 60_000, burst: 10 } as const;

  it("permits a burst of exactly ten, then throttles", () => {
    const buckets = new Map<string, BucketState>();
    for (let i = 0; i < 10; i++) {
      expect(consumeBucket(buckets, "a", 0, policy).limited).toBe(false);
    }
    const eleventh = consumeBucket(buckets, "a", 0, policy);
    expect(eleventh.limited).toBe(true);
    expect(eleventh.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("refills at the sustained rate — one token every two seconds at 30/min", () => {
    const buckets = new Map<string, BucketState>();
    for (let i = 0; i < 11; i++) {
      consumeBucket(buckets, "a", 0, policy);
    }
    // Half a token after one second: still refused.
    expect(consumeBucket(buckets, "a", 1000, policy).limited).toBe(true);
    // A whole token after two: allowed again, and only one.
    expect(consumeBucket(buckets, "a", 2000, policy).limited).toBe(false);
    expect(consumeBucket(buckets, "a", 2000, policy).limited).toBe(true);
  });

  it("never refills past the burst capacity", () => {
    const buckets = new Map<string, BucketState>();
    consumeBucket(buckets, "a", 0, policy);
    // An hour later the bucket is full, not overflowing.
    for (let i = 0; i < 10; i++) {
      expect(consumeBucket(buckets, "a", 3_600_000, policy).limited).toBe(false);
    }
    expect(consumeBucket(buckets, "a", 3_600_000, policy).limited).toBe(true);
  });

  it("is what a fixed window is not: no boundary double-spend", () => {
    // A 30/min fixed window lets 60 through across a boundary. The bucket
    // caps any 60-second span at burst + the sustained rate.
    const buckets = new Map<string, BucketState>();
    let allowed = 0;
    for (let t = 0; t <= 60_000; t += 100) {
      if (!consumeBucket(buckets, "a", t, policy).limited) {
        allowed += 1;
      }
    }
    expect(allowed).toBeLessThanOrEqual(policy.burst + policy.max + 1);
  });

  it("tracks clients independently", () => {
    const buckets = new Map<string, BucketState>();
    for (let i = 0; i < 11; i++) {
      consumeBucket(buckets, "a", 0, policy);
    }
    expect(consumeBucket(buckets, "b", 0, policy).limited).toBe(false);
  });
});

describe("sweeping · the maps cannot grow unbounded", () => {
  it("sweep drops only expired windows", () => {
    const windows = new Map([
      ["old", { count: 1, resetAt: 10 }],
      ["live", { count: 1, resetAt: 100 }],
    ]);
    sweep(windows, 50);
    expect(windows.has("old")).toBe(false);
    expect(windows.has("live")).toBe(true);
  });

  it("sweepBuckets drops buckets that have refilled to capacity", () => {
    const policy = { max: 30, windowMs: 60_000, burst: 10 };
    const buckets = new Map([
      ["full", { tokens: 10, ts: 0 }],
      ["spent", { tokens: 0, ts: 0 }],
    ]);
    sweepBuckets(buckets, 1000, policy);
    expect(buckets.has("full")).toBe(false);
    expect(buckets.has("spent")).toBe(true);
  });
});

// --- the plugin -------------------------------------------------------------

const TIERS = tiersFrom({
  readMax: 3,
  windowMs: 60_000,
  solveMax: 30,
  solveBurst: 10,
});

function makeApp(store?: LimitStore) {
  return new Elysia()
    .use(rateLimit({ tiers: TIERS, store, trustedProxyDepth: 1 }))
    .get("/v1/meta", () => ({ ok: true }))
    .post("/v1/optimize", () => ({ ok: true }))
    .get("/health", () => ({ ok: true }));
}

const hit = (app: ReturnType<typeof makeApp>, path: string, ip: string, method = "GET") =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "x-forwarded-for": ip },
    }),
  );

describe("rateLimit plugin · the three budgets", () => {
  it("the read tier refuses past its budget, with the envelope and Retry-After", async () => {
    const app = makeApp();
    for (let i = 0; i < 3; i++) {
      expect((await hit(app, "/v1/meta", "1.1.1.1")).status).toBe(200);
    }
    const limited = await hit(app, "/v1/meta", "1.1.1.1");
    expect(limited.status).toBe(429);

    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    const body = (await limited.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.details?.tier).toBe("read");
    // The header and the body are read off one object, so they cannot disagree.
    expect(body.error.details?.retry_after_sec).toBe(retryAfter);
  });

  it("the solve tier permits a burst of ten back to back, then throttles", async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      expect((await hit(app, "/v1/optimize", "2.2.2.2", "POST")).status).toBe(200);
    }
    const eleventh = await hit(app, "/v1/optimize", "2.2.2.2", "POST");
    expect(eleventh.status).toBe(429);
    expect(((await eleventh.json()) as ErrorEnvelope).error.details?.tier).toBe("solve");
  });

  it("the tiers are three budgets, not one", async () => {
    const app = makeApp();
    // Spend the read tier dry…
    for (let i = 0; i < 4; i++) {
      await hit(app, "/v1/meta", "3.3.3.3");
    }
    expect((await hit(app, "/v1/meta", "3.3.3.3")).status).toBe(429);
    // …the solver still answers, and the probes are never metered at all.
    expect((await hit(app, "/v1/optimize", "3.3.3.3", "POST")).status).toBe(200);
    for (let i = 0; i < 20; i++) {
      expect((await hit(app, "/health", "3.3.3.3")).status).toBe(200);
    }
  });

  it("a forged forwarded-for prefix does not reset the budget", async () => {
    const app = makeApp();
    // Same real client (last hop), four different forged first hops.
    for (let i = 0; i < 3; i++) {
      expect((await hit(app, "/v1/meta", `9.9.9.${i}, 10.0.0.7`)).status).toBe(200);
    }
    expect((await hit(app, "/v1/meta", "9.9.9.99, 10.0.0.7")).status).toBe(429);
  });

  it("other clients are unaffected", async () => {
    const app = makeApp();
    for (let i = 0; i < 4; i++) {
      await hit(app, "/v1/meta", "4.4.4.4");
    }
    expect((await hit(app, "/v1/meta", "5.5.5.5")).status).toBe(200);
  });

  it("a zero budget disables that tier", async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          tiers: tiersFrom({
            readMax: 0,
            windowMs: 60_000,
            solveMax: 30,
            solveBurst: 10,
          }),
        }),
      )
      .get("/v1/meta", () => ({ ok: true }));
    for (let i = 0; i < 8; i++) {
      expect((await app.handle(new Request("http://localhost/v1/meta"))).status).toBe(
        200,
      );
    }
  });

  it("a CORS preflight is never metered", async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      const res = await hit(app, "/v1/meta", "6.6.6.6", "OPTIONS");
      expect(res.status).not.toBe(429);
    }
  });
});

describe("rateLimit plugin · the counter is a seam", () => {
  it("two apps sharing one store share one budget", async () => {
    // This is the property that makes a second replica safe: the budget is a
    // property of the store, not of the process. With Redis as the store it is
    // literally two processes (see rate-limit-redis.test.ts); with the memory
    // store it is two apps, and the seam under test is the same one.
    const shared = memoryStore();
    const a = makeApp(shared);
    const b = makeApp(shared);
    expect((await hit(a, "/v1/meta", "7.7.7.7")).status).toBe(200);
    expect((await hit(b, "/v1/meta", "7.7.7.7")).status).toBe(200);
    expect((await hit(a, "/v1/meta", "7.7.7.7")).status).toBe(200);
    // Four requests, budget of three, spread across both apps.
    expect((await hit(b, "/v1/meta", "7.7.7.7")).status).toBe(429);
  });

  it("the fallback store says what it is", () => {
    const store = memoryStore();
    expect(store.kind).toBe("memory");
    expect(store.detail).toContain("per-process");
  });
});

describe("the client key behind an edge that rewrites the chain", () => {
  it("charges the last hop when no edge header is trusted", () => {
    // The default, and the rule the positional comment argues for: with one
    // trusted proxy, the only hop nobody could have lied about is the last.
    expect(clientKey("9.9.9.9, 203.0.113.7", "10.0.0.1", 1)).toBe("203.0.113.7");
  });

  it("collapses every reader behind one Cloudflare colo onto one key", () => {
    // The defect this exists to document. Behind Cloudflare the chain is
    // [client, cloudflare] and Railway appends its own view, so the last hop is
    // a Cloudflare data centre — shared by every reader behind it. Verified on
    // the live deployment: api.wattsteer.com answers `server: cloudflare` with
    // a cf-ray, wattsteer-api.up.railway.app answers `server: railway-hikari`
    // with no cf-* at all. With voice at six mints a minute, one attacker
    // denies the whole colo.
    const colo = "172.71.0.5";
    const readerA = clientKey(`198.51.100.1, ${colo}`, "10.0.0.1", 1);
    const readerB = clientKey(`198.51.100.2, ${colo}`, "10.0.0.1", 1);
    expect(readerA).toBe(readerB);
  });

  it("separates them when the edge header is trusted", () => {
    const colo = "172.71.0.5";
    const readerA = clientKey(`198.51.100.1, ${colo}`, "10.0.0.1", 1, "198.51.100.1");
    const readerB = clientKey(`198.51.100.2, ${colo}`, "10.0.0.1", 1, "198.51.100.2");
    expect(readerA).not.toBe(readerB);
    expect(readerA).toBe("198.51.100.1");
  });

  it("is off unless a deployment names the header", () => {
    // **Not defaulted on, and the reason is the whole of why this is opt-in.**
    // Cloudflare overwrites CF-Connecting-IP on everything it proxies, so it
    // cannot be forged *through* the edge — but it can be forged by anyone who
    // reaches the origin *around* it, which today anyone can, because the
    // Railway service domain is live beside the custom one. Trusting it while
    // that holds hands back the free-budget-reset the positional rule closed.
    expect(config.edgeClientIpHeader).toBeUndefined();
    // And a null/empty header value must not be treated as a client.
    expect(clientKey("1.1.1.1, 2.2.2.2", "10.0.0.1", 1, null)).toBe("2.2.2.2");
    expect(clientKey("1.1.1.1, 2.2.2.2", "10.0.0.1", 1, "")).toBe("2.2.2.2");
  });
});

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { clientKey, consume, rateLimit, sweep } from "../src/api/plugins/rate-limit";

describe("clientKey", () => {
  test("prefers the first X-Forwarded-For hop", () => {
    expect(clientKey("203.0.113.9, 10.0.0.1", "127.0.0.1")).toBe("203.0.113.9");
  });

  test("falls back to the socket IP without the header", () => {
    expect(clientKey(null, "192.168.1.5")).toBe("192.168.1.5");
    expect(clientKey("", "192.168.1.5")).toBe("192.168.1.5");
  });
});

describe("consume", () => {
  const opts = { max: 3, windowMs: 1000 };

  test("allows up to max requests, limits the next", () => {
    const windows = new Map();
    for (let i = 0; i < 3; i++) {
      expect(consume(windows, "a", 0, opts).limited).toBe(false);
    }
    const fourth = consume(windows, "a", 100, opts);
    expect(fourth.limited).toBe(true);
    expect(fourth.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  test("resets after the window elapses", () => {
    const windows = new Map();
    for (let i = 0; i < 4; i++) {
      consume(windows, "a", 0, opts);
    }
    expect(consume(windows, "a", 1001, opts).limited).toBe(false);
  });

  test("tracks clients independently", () => {
    const windows = new Map();
    for (let i = 0; i < 4; i++) {
      consume(windows, "a", 0, opts);
    }
    expect(consume(windows, "b", 0, opts).limited).toBe(false);
  });
});

describe("sweep", () => {
  test("drops only expired windows", () => {
    const windows = new Map([
      ["old", { count: 1, resetAt: 10 }],
      ["live", { count: 1, resetAt: 100 }],
    ]);
    sweep(windows, 50);
    expect(windows.has("old")).toBe(false);
    expect(windows.has("live")).toBe(true);
  });
});

describe("rateLimit plugin", () => {
  function makeApp(max: number) {
    return new Elysia()
      .use(
        rateLimit({
          max,
          windowMs: 60_000,
          counts: (method, pathname) => method === "GET" && pathname === "/reviews",
        }),
      )
      .get("/reviews", () => ({ ok: true }))
      .get("/health", () => ({ ok: true }));
  }

  const get = (app: ReturnType<typeof makeApp>, path: string, ip: string) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        headers: { "x-forwarded-for": ip },
      }),
    );

  test("returns 429 with Retry-After once the budget is spent", async () => {
    const app = makeApp(2);
    expect((await get(app, "/reviews", "1.1.1.1")).status).toBe(200);
    expect((await get(app, "/reviews", "1.1.1.1")).status).toBe(200);
    const limited = await get(app, "/reviews", "1.1.1.1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  test("exempt paths and other clients are unaffected", async () => {
    const app = makeApp(1);
    await get(app, "/reviews", "1.1.1.1");
    await get(app, "/reviews", "1.1.1.1"); // 1.1.1.1 now over budget
    expect((await get(app, "/health", "1.1.1.1")).status).toBe(200);
    expect((await get(app, "/reviews", "2.2.2.2")).status).toBe(200);
  });

  test("max=0 disables the limiter entirely", async () => {
    const app = makeApp(0);
    for (let i = 0; i < 5; i++) {
      expect((await get(app, "/reviews", "1.1.1.1")).status).toBe(200);
    }
  });
});

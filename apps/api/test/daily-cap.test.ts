import { describe, expect, test } from "bun:test";
import {
  CAP_TIME_ZONE,
  dailyCap,
  dayKey,
  expiresAt,
} from "../src/api/plugins/daily-cap.js";
import { memoryStore } from "../src/api/plugins/limit-store.js";

/**
 * **The cap that counts calls, not requests.**
 *
 * A rate limit and a daily cap answer two different questions and refuse in
 * two different ways, which is why both exist:
 *
 * | | rate limit | daily cap |
 * |---|---|---|
 * | scope | per client | global, per deployment |
 * | window | a minute | a Brasília civil day |
 * | counts | requests | language-model calls |
 * | over budget | 429 with `Retry-After` | 200 with the template narration |
 *
 * ~16 distinct narrations a day is the real volume, so an IP budget over it
 * would protect nothing. What needs the budget is the call.
 */

describe("dayKey · the civil day the cap rolls over on", () => {
  test("is Brasília's day, not UTC's", () => {
    // 2026-08-29T02:00Z is still the 28th in Brasília (UTC−3).
    const instant = Date.parse("2026-08-29T02:00:00Z");
    expect(dayKey(instant)).toBe("2026-08-28");
    expect(dayKey(instant, "UTC")).toBe("2026-08-29");
    expect(CAP_TIME_ZONE).toBe("America/Sao_Paulo");
  });

  test("rolls over at local midnight, not in the middle of the evening gate", () => {
    // The late gate publishes at 19:00 BRT — nowhere near a rollover.
    expect(dayKey(Date.parse("2026-08-28T21:59:00Z"))).toBe("2026-08-28");
    expect(dayKey(Date.parse("2026-08-29T03:01:00Z"))).toBe("2026-08-29");
  });

  test("a counter outlives its day, with slack for clock skew", () => {
    const now = Date.parse("2026-08-28T12:00:00Z");
    expect(expiresAt(now)).toBeGreaterThan(now + 86_400_000);
  });
});

describe("dailyCap · the budget", () => {
  test("allows up to the cap, then says serve the template", async () => {
    const cap = dailyCap({ name: "narration", limit: 3, store: memoryStore() });
    const now = Date.parse("2026-08-28T12:00:00Z");
    for (let i = 1; i <= 3; i++) {
      const decision = await cap.take(now);
      expect(decision.allowed).toBe(true);
      expect(decision.used).toBe(i);
    }
    const over = await cap.take(now);
    expect(over.allowed).toBe(false);
    expect(over.used).toBe(4);
    expect(over.limit).toBe(3);
    expect(over.day).toBe("2026-08-28");
  });

  test("keeps counting past the cap — an over-cap attempt is still demand", async () => {
    const cap = dailyCap({ name: "narration", limit: 1, store: memoryStore() });
    const now = Date.parse("2026-08-28T12:00:00Z");
    await cap.take(now);
    await cap.take(now);
    expect((await cap.take(now)).used).toBe(3);
  });

  test("is global, not per client — one counter for the deployment", async () => {
    // Two caps over one store are two request handlers over one budget, which
    // is what "global daily cap" has to mean once there is a second replica.
    const store = memoryStore();
    const a = dailyCap({ name: "narration", limit: 2, store });
    const b = dailyCap({ name: "narration", limit: 2, store });
    const now = Date.parse("2026-08-28T12:00:00Z");
    expect((await a.take(now)).allowed).toBe(true);
    expect((await b.take(now)).allowed).toBe(true);
    expect((await a.take(now)).allowed).toBe(false);
  });

  test("two named caps do not share a counter", async () => {
    const store = memoryStore();
    const narration = dailyCap({ name: "narration", limit: 1, store });
    const other = dailyCap({ name: "something-else", limit: 1, store });
    const now = Date.parse("2026-08-28T12:00:00Z");
    await narration.take(now);
    expect((await other.take(now)).allowed).toBe(true);
  });

  test("a zero cap disables the budget", async () => {
    const cap = dailyCap({ name: "narration", limit: 0, store: memoryStore() });
    for (let i = 0; i < 5; i++) {
      expect((await cap.take()).allowed).toBe(true);
    }
  });
});

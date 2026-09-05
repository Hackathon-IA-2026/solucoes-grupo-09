import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { dailyCap } from "../src/api/plugins/daily-cap.js";
import { memoryStore } from "../src/api/plugins/limit-store.js";
import { memoryLockedCache } from "../src/api/plugins/locked-cache.js";
import {
  type CachedNarrationDeps,
  cachedNarration,
  type FiredRule,
  type InFlightResult,
  NARRATION_MODEL_ID,
  NARRATION_OUTPUT_FIELD,
  NARRATION_TEMPLATE_TTL_SEC,
  NARRATION_TTL_SEC,
  type NarrationStore,
  narrationCacheKey,
  narrationKeyFor,
  narrationLockKey,
  narrationPayloadDigest,
  toNarrationDocument,
} from "../src/diagnosis/index.js";
import { narrationPayload as payload, SUM_ABS } from "./support/narration-payload.js";

/**
 * The cache and the lock, on their own.
 *
 * The route suite proves the property the ticket is graded on — a hundred
 * concurrent misses, one call — through the real endpoint. What that suite
 * cannot reach is the **other** replica: an in-process map cannot be made to
 * lose a race with itself, so the follower's wait, its deadline and the
 * template it falls back to are asserted here, against a store that says the
 * lock was taken elsewhere.
 *
 * Two things this file is written to make impossible:
 *
 *  1. **A follower that waits forever.** One slow call behind a lock nobody
 *     released would become a thousand slow requests, which is the stampede
 *     with better manners. The wait has a deadline and the deadline has an
 *     answer, and both are tested.
 *  2. **A template entry that outlives the outage that produced it.** A
 *     paragraph is worth 26 h; "the model was unavailable" is worth 5 min, and
 *     writing the two under one TTL is how an outage lasts a day.
 */

const CLEAN_PT = [
  "Para o NORDESTE em 28 de agosto de 2026, o modelo lê o risco de restrição",
  "acima de 5 MW como alto: 87% para pelo menos uma hora, com 9 horas cuja P50",
  "fica acima de zero. Ele espera 412,0 MWh no dia inteiro, contra um típico",
  "96,0 MWh, uma diferença de 316,0 MWh que os grupos dividem entre si. A maior",
  "hora é 13:00, com uma mediana de 118,0 MW.",
].join(" ");

const NOISE: FiredRule = {
  code: "attribution_is_noise",
  action: "withhold",
  facts: { sum_abs_attributed_mwh: SUM_ABS, attribution_stderr_mwh: 4.1 },
};

/** The SDK's `messages`, standing in. Counts what it was asked to write. */
function stub(text = CLEAN_PT): {
  create: (
    params: Anthropic.MessageCreateParamsNonStreaming,
  ) => Promise<Anthropic.Message>;
  calls: number;
} {
  const state = {
    calls: 0,
    create: async (_params: Anthropic.MessageCreateParamsNonStreaming) => {
      state.calls += 1;
      return {
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: NARRATION_MODEL_ID,
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [
          { type: "text", text: JSON.stringify({ [NARRATION_OUTPUT_FIELD]: text }) },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as Anthropic.Message;
    },
  };
  return state;
}

/** A store that records the TTL every entry was written under. */
function recording(): NarrationStore & { writes: { key: string; ttlSec: number }[] } {
  const inner = memoryLockedCache();
  const writes: { key: string; ttlSec: number }[] = [];
  return {
    ...inner,
    writes,
    set: async (key, value, ttlSec) => {
      writes.push({ key, ttlSec });
      await inner.set(key, value, ttlSec);
    },
  };
}

/**
 * A store standing in for "another replica holds the lock".
 *
 * `acquire` refuses, and `get` answers `null` until the winner's entry is said
 * to have landed — which is the only shape of this failure that a single
 * process can actually be put in.
 */
function contended(entry: string | null, appearsAfter = 0): NarrationStore {
  let reads = 0;
  return {
    detail: "contended",
    get: async () => {
      reads += 1;
      return reads > appearsAfter ? entry : null;
    },
    set: async () => {},
    acquire: async () => false,
    release: async () => {},
    close: async () => {},
  };
}

function deps(overrides: Partial<CachedNarrationDeps> = {}): CachedNarrationDeps {
  return {
    store: overrides.store ?? memoryLockedCache(),
    cap:
      overrides.cap ?? dailyCap({ name: "narration", limit: 200, store: memoryStore() }),
    inflight: overrides.inflight ?? new Map<string, Promise<InFlightResult>>(),
    ...overrides,
  };
}

describe("the key is the spec's, and there is one of it", () => {
  it("is narration:v1 over prompt version, model, locale and the digest", () => {
    const one = payload();
    expect(narrationKeyFor(one)).toBe(
      narrationCacheKey({
        promptVersion: one.promptVersion,
        modelId: NARRATION_MODEL_ID,
        locale: one.locale,
        digest: narrationPayloadDigest(toNarrationDocument(one)),
      }),
    );
  });

  it("puts the lock beside the entry rather than in a namespace of its own", () => {
    const key = narrationKeyFor(payload());
    expect(narrationLockKey(key)).toBe(`${key}:lock`);
  });
});

describe("the withheld day never reaches the cache", () => {
  it("renders the template with no read, no write, no lock and no call", async () => {
    const messages = stub();
    let touched = 0;
    const store: NarrationStore = {
      detail: "watched",
      get: async () => {
        touched += 1;
        return null;
      },
      set: async () => {
        touched += 1;
      },
      acquire: async () => {
        touched += 1;
        return true;
      },
      release: async () => {},
      close: async () => {},
    };
    const result = await cachedNarration(deps({ store, messages }), {
      payload: payload({
        // The document spells the stored `action` as `severity`.
        ruleFlags: [{ code: NOISE.code, severity: "withhold", facts: NOISE.facts }],
      }),
      ruleFlags: [NOISE],
    });
    expect(result.origin).toBe("withheld");
    expect(result.narration.source).toBe("template");
    expect(result.withheldBy).toEqual(["attribution_is_noise"]);
    expect(messages.calls).toBe(0);
    expect(touched).toBe(0);
  });
});

describe("the TTLs are two, because the entries mean two things", () => {
  it("keeps a model paragraph for 26 h", async () => {
    const store = recording();
    const messages = stub();
    await cachedNarration(deps({ store, messages }), {
      payload: payload(),
      ruleFlags: [],
    });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.ttlSec).toBe(NARRATION_TTL_SEC);
    expect(NARRATION_TTL_SEC).toBe(26 * 60 * 60);
  });

  it("keeps a capped day's template for 5 min, under the same key", async () => {
    const store = recording();
    const messages = stub();
    const cap = dailyCap({ name: "narration", limit: 1, store: memoryStore() });
    await cap.take();
    const result = await cachedNarration(deps({ store, messages, cap }), {
      payload: payload(),
      ruleFlags: [],
    });
    expect(result.origin).toBe("capped");
    expect(result.narration.source).toBe("template");
    expect(messages.calls).toBe(0);
    expect(store.writes[0]?.key).toBe(narrationKeyFor(payload()));
    expect(store.writes[0]?.ttlSec).toBe(NARRATION_TEMPLATE_TTL_SEC);
    expect(NARRATION_TEMPLATE_TTL_SEC).toBe(300);
  });

  it("keeps an unavailable model's template for 5 min too", async () => {
    const store = recording();
    const result = await cachedNarration(
      deps({
        store,
        messages: {
          create: async () => {
            throw new Error("no key configured");
          },
        },
      }),
      { payload: payload(), ruleFlags: [] },
    );
    expect(result.narration.source).toBe("template");
    expect(store.writes[0]?.ttlSec).toBe(NARRATION_TEMPLATE_TTL_SEC);
  });
});

describe("the loser of the cross-replica lock", () => {
  it("waits for the winner's entry and serves it", async () => {
    const messages = stub();
    const winner = JSON.stringify({
      source: "model",
      text: CLEAN_PT,
      locale: "pt-BR",
      promptVersion: payload().promptVersion,
    });
    const result = await cachedNarration(
      deps({
        store: contended(winner, 2),
        messages,
        waitMs: 500,
        pollMs: 1,
      }),
      { payload: payload(), ruleFlags: [] },
    );
    expect(result.origin).toBe("follower");
    expect(result.narration.source).toBe("model");
    // The whole point: the follower did not make a second call.
    expect(messages.calls).toBe(0);
  });

  it("falls back to the template when the deadline passes, and calls nothing", async () => {
    const messages = stub();
    const result = await cachedNarration(
      deps({ store: contended(null), messages, waitMs: 20, pollMs: 1 }),
      { payload: payload(), ruleFlags: [] },
    );
    expect(result.origin).toBe("deadline");
    expect(result.narration.source).toBe("template");
    expect(messages.calls).toBe(0);
  });
});

describe("the in-process flight", () => {
  it("collapses a hundred concurrent misses onto one call", async () => {
    const messages = stub();
    const shared = deps({ messages });
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        cachedNarration(shared, { payload: payload(), ruleFlags: [] }),
      ),
    );
    expect(messages.calls).toBe(1);
    expect(results.filter((one) => one.origin === "rendered")).toHaveLength(1);
    for (const one of results) {
      expect(one.narration.source).toBe("model");
    }
  });

  it("empties itself, so a later miss is not answered from a dead promise", async () => {
    const messages = stub();
    const shared = deps({ messages });
    await cachedNarration(shared, { payload: payload(), ruleFlags: [] });
    expect(shared.inflight.size).toBe(0);
  });

  it("releases the lock, so the next cold key is not blocked by the last one", async () => {
    const store = memoryLockedCache();
    const messages = stub();
    await cachedNarration(deps({ store, messages }), {
      payload: payload(),
      ruleFlags: [],
    });
    const key = narrationKeyFor(payload());
    expect(await store.acquire(narrationLockKey(key), 1000)).toBe(true);
  });
});

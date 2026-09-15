import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_POLICIES } from "../src/api/plugins/cache-policy.js";
import { classifyTier, tiersFrom, VOICE_PATHS } from "../src/api/plugins/rate-limit.js";
import { createVoiceRoutes, mintVoiceSession } from "../src/api/voice.js";
import { config } from "../src/config.js";

/**
 * `GET /v1/voice/session` mints a credential, and that makes it the only route
 * on this surface whose failure mode is not a wrong number but a leaked key.
 *
 * So the assertions here are weighted accordingly: most of this file is about
 * `XAI_API_KEY` never reaching a place it can be read from, and the happy path
 * gets one test. That ratio is deliberate. A wrong figure on this surface is
 * caught by the reader; a key in a log line is caught by nobody, and this
 * repository has already had one — `redactedRedisError` exists because ioredis
 * attached `command.args` to an error and put a Redis password in a log.
 */

const KEY = "xai-secret-do-not-leak-0123456789";
const ROOT = join(import.meta.dir, "..");
const SOURCE = readFileSync(join(ROOT, "src/api/voice.ts"), "utf8");

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = config.xaiApiKey;
  (config as { xaiApiKey?: string }).xaiApiKey = KEY;
});

afterEach(() => {
  (config as { xaiApiKey?: string }).xaiApiKey = savedKey;
});

/** A `fetch` that records what it was asked and answers what the test wants. */
function stubFetch(answer: Response | (() => never)): {
  fetch: typeof fetch;
  seen: { url: string; init: RequestInit }[];
} {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    if (typeof answer === "function") {
      answer();
    }
    return answer as Response;
  }) as unknown as typeof fetch;
  return { fetch: impl, seen };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("voice · the key never leaves this process", () => {
  it("sends the key upstream and returns only the ephemeral secret", async () => {
    const { fetch: impl, seen } = stubFetch(
      json({ client_secret: { value: "eph-abc" } }),
    );
    const session = await mintVoiceSession(impl);

    // It went up...
    expect(
      String((seen[0]?.init.headers as Record<string, string>).Authorization),
    ).toContain(KEY);
    // ...and nothing of it came back. Asserted over the *serialised* body,
    // because a key on a non-enumerable field or inside a nested object would
    // pass a field-by-field check and still reach the browser.
    const wire = JSON.stringify(session);
    expect(wire).not.toContain(KEY);
    expect(session.client_secret).toBe("eph-abc");
  });

  it("does not put the key in any refusal, at any upstream status", async () => {
    // Every failure branch, because it only takes one to lose the key, and the
    // branch that leaks is by definition the one nobody thought about.
    const upstreams = [400, 401, 403, 429, 500, 502, 503];
    for (const status of upstreams) {
      const { fetch: impl } = stubFetch(
        new Response(`unauthorized: key ${KEY} is invalid`, { status }),
      );
      const error = await mintVoiceSession(impl).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      const seen = `${(error as Error).message} ${(error as Error).stack ?? ""} ${JSON.stringify(error)}`;
      expect(seen).not.toContain(KEY);
      // Non-vacuity: the status *is* forwarded, so this is not passing because
      // the message is empty.
      expect((error as Error).message).toContain(String(status));
    }
  });

  it("does not carry the key out on a network failure's cause chain", async () => {
    // A fetch rejection carries the request it failed on, and that request has
    // the bearer token in its headers — so an error chain that looks like
    // helpful context is a key in whatever logs the chain.
    const { fetch: impl } = stubFetch(() => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${KEY}`);
    });
    const error = (await mintVoiceSession(impl).catch((e: unknown) => e)) as Error;
    const chain = `${error.message} ${String(error.cause ?? "")} ${JSON.stringify(error)}`;
    expect(chain).not.toContain(KEY);
  });

  it("never interpolates the upstream body into anything", () => {
    // Structural, and it outlives the cases above: xAI's error text is written
    // for whoever holds the key and may echo request context. A route that
    // reads `await response.text()` on the failure path is a route one edit
    // away from forwarding it.
    const code = SOURCE.split("\n")
      .filter((line) => !(line.trim().startsWith("*") || line.trim().startsWith("//")))
      .join("\n");
    expect(code).not.toContain("response.text()");
    expect(code).not.toContain("await res.text()");
  });
});

describe("voice · an absent capability is not a broken one", () => {
  it("refuses with VOICE_NOT_CONFIGURED when no key is set", async () => {
    (config as { xaiApiKey?: string }).xaiApiKey = undefined;
    const { fetch: impl, seen } = stubFetch(json({ value: "never" }));
    const error = (await mintVoiceSession(impl).catch((e: unknown) => e)) as Error & {
      code?: string;
    };
    expect(error.code).toBe("VOICE_NOT_CONFIGURED");
    // And it did not call xAI to find out. A capability that is absent is known
    // to be absent without a round trip.
    expect(seen).toHaveLength(0);
  });

  it("distinguishes that from a provider that is present and failing", async () => {
    // The whole reason there are two codes. If these collapsed to one, a
    // deployment that never intended to have voice would render a broken
    // control, and one whose provider is down would render nothing at all —
    // each showing the other's failure.
    const { fetch: impl } = stubFetch(new Response("nope", { status: 503 }));
    const error = (await mintVoiceSession(impl).catch((e: unknown) => e)) as Error & {
      code?: string;
    };
    expect(error.code).toBe("VOICE_UNAVAILABLE");
  });

  it("refuses a response it cannot find a secret in, rather than sending an empty one", async () => {
    // A blank credential reaches the browser, fails to open a socket, and the
    // reader sees a microphone that does nothing with no reason given.
    for (const body of [
      {},
      { client_secret: {} },
      { client_secret: "" },
      { value: "" },
    ]) {
      const { fetch: impl } = stubFetch(json(body));
      const error = (await mintVoiceSession(impl).catch((e: unknown) => e)) as Error & {
        code?: string;
      };
      expect(error.code).toBe("VOICE_UNAVAILABLE");
    }
  });

  it("accepts the shapes the provider has actually used", async () => {
    // Written as a list rather than one access because the reference
    // implementation already had to accept four, which is evidence the shape is
    // not contractual.
    for (const body of [
      { value: "eph" },
      { client_secret: { value: "eph" } },
      { client_secret: "eph" },
      { token: "eph" },
    ]) {
      const { fetch: impl } = stubFetch(json(body));
      expect((await mintVoiceSession(impl)).client_secret).toBe("eph");
    }
  });
});

describe("voice · the credential is never stored", () => {
  it("answers no-store, through the policy table", async () => {
    const routes = createVoiceRoutes(stubFetch(json({ value: "eph" })).fetch);
    const response = await routes.handle(
      new Request("http://localhost/v1/voice/session"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("is `no-store` and not `no-cache`, which still permits a stored copy", () => {
    // A revalidated credential is still a credential somebody else's disk held.
    expect(CACHE_POLICIES.voiceSession.directive).toBe("no-store");
    expect(CACHE_POLICIES.voiceSession.directive).not.toContain("no-cache");
  });

  it("states an expiry the client can re-mint against", async () => {
    const before = Date.now();
    const session = await mintVoiceSession(stubFetch(json({ value: "eph" })).fetch);
    const expires = Date.parse(session.expires_at);
    expect(Number.isNaN(expires)).toBe(false);
    // Computed from our own clock, not echoed: a clock the client cannot verify
    // is a clock that can cut a reader off mid-sentence.
    expect(expires).toBeGreaterThanOrEqual(
      before + config.voiceSessionTtlSec * 1000 - 50,
    );
    expect(expires).toBeLessThanOrEqual(
      Date.now() + config.voiceSessionTtlSec * 1000 + 50,
    );
  });
});

describe("voice · it spends its own budget", () => {
  it("is metered on a tier of its own, not on the read tier", () => {
    // A voice session is one HTTPS round trip to serve and a billable audio
    // stream to spend. The read tier is 120/min because almost every hit is a
    // shared-cache hit; that reasoning does not transfer.
    expect(classifyTier("GET", "/v1/voice/session")).toBe("voice");
    expect(classifyTier("GET", "/v1/grid/now")).toBe("read");
    expect(classifyTier("POST", "/v1/optimize")).toBe("solve");
  });

  it("is budgeted far below the read tier", () => {
    const tiers = tiersFrom({
      readMax: config.rateLimitMax,
      windowMs: config.rateLimitWindowMs,
      solveMax: config.rateLimitSolveMax,
      solveBurst: config.rateLimitSolveBurst,
      voiceMax: config.voiceSessionMax,
    });
    expect(tiers.voice.max).toBeGreaterThan(0);
    expect(tiers.voice.max).toBeLessThan(tiers.read.max);
    // A fixed window and deliberately no burst: a burst of credential mints is
    // not a slider being dragged.
    expect(tiers.voice.kind).toBe("fixed-window");
  });

  it("names the metered path in one place", () => {
    // Non-vacuity: if `VOICE_PATHS` were empty the classifier above would fall
    // through to `read` and the budget would silently be the generous one.
    expect(VOICE_PATHS).toContain("/v1/voice/session");
    expect(VOICE_PATHS.length).toBeGreaterThan(0);
  });
});

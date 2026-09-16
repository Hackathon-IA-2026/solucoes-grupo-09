import { describe, expect, it } from "bun:test";
import { ApiError, createClient } from "../src/client.js";

/**
 * The one method on this client that decodes nothing, and why that is safe.
 *
 * Every other route answers with a published resource and is renamed by the
 * generated table in `wire.ts`. This one answers with a **credential** — four
 * fields, good for minutes, never cached, never rendered, never persisted, and
 * with no cross-language consumer — and the client's own comment gives the
 * reason it has no schema: *"Giving it a schema would publish a contract for a
 * secret."*
 *
 * That trade is fine and it was untested. The four names are read by hand at
 * one call site, which is the kind of code that works until somebody renames a
 * field on the gateway and the client starts handing the socket four empty
 * strings — a session that fails at connect time with nothing in the log about
 * why.
 *
 * So: the mapping, the degradation, and the refusal. The last one matters most.
 * `VOICE_NOT_CONFIGURED` means render no dock at all; `VOICE_UNAVAILABLE` means
 * voice exists here and is having a bad day. They share a status, so a client
 * that only looked at `status` could not tell them apart, and the product
 * behaviour on each is the opposite of the other.
 */

/** A fetch that answers one canned response and records what it was asked. */
function stub(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const doFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, doFetch };
}

const BASE = "https://api.example.com";
const client = (doFetch: typeof globalThis.fetch) =>
  createClient({ baseUrl: BASE, fetch: doFetch });

const CREDENTIAL = {
  client_secret: "ek_live_not_a_real_key",
  expires_at: "2026-09-16T05:00:00Z",
  model: "grok-realtime",
  voice: "ember",
};

describe("the credential arrives in the app's vocabulary", () => {
  it("reads all four snake_case fields", async () => {
    const { doFetch, calls } = stub(200, CREDENTIAL);
    const session = await client(doFetch).voiceSession();
    expect(session).toEqual({
      clientSecret: "ek_live_not_a_real_key",
      expiresAt: "2026-09-16T05:00:00Z",
      model: "grok-realtime",
      voice: "ember",
    });
    expect(calls[0]?.url).toBe(`${BASE}/v1/voice/session`);
  });

  it("asks with GET and no body", async () => {
    const { doFetch, calls } = stub(200, CREDENTIAL);
    await client(doFetch).voiceSession();
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("ignores a fifth field, which is the documented trade", async () => {
    /*
      The comment is explicit that this boundary is four names read by hand and
      that "a fifth field would be invisible here and therefore unused, which is
      the failure mode a credential can afford". Asserted so the trade stays a
      decision rather than becoming a surprise.
    */
    const { doFetch } = stub(200, { ...CREDENTIAL, region: "sa-east-1" });
    const session = await client(doFetch).voiceSession();
    expect(Object.keys(session).sort()).toEqual([
      "clientSecret",
      "expiresAt",
      "model",
      "voice",
    ]);
  });
});

describe("a malformed answer degrades to empty strings, never to undefined", () => {
  it("fills every missing field with an empty string", async () => {
    // The socket reads all four. `undefined` in a credential becomes the string
    // "undefined" somewhere downstream, which is worse than an empty one.
    const { doFetch } = stub(200, {});
    const session = await client(doFetch).voiceSession();
    expect(session).toEqual({
      clientSecret: "",
      expiresAt: "",
      model: "",
      voice: "",
    });
  });

  it("survives a body that is not an object at all", async () => {
    for (const body of [null, 42, "a string", ["an", "array"]]) {
      const { doFetch } = stub(200, body);
      const session = await client(doFetch).voiceSession();
      // An array is an object, so its fields are absent rather than its indices
      // being read — either way the answer is four empty strings, not a throw.
      expect(session.clientSecret).toBe("");
      expect(session.expiresAt).toBe("");
    }
  });

  it("survives a body that is not JSON", async () => {
    const doFetch = (async () =>
      new Response("<html>502</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof globalThis.fetch;
    const session = await client(doFetch).voiceSession();
    expect(session.clientSecret).toBe("");
  });
});

describe("a refusal keeps the distinction the product acts on", () => {
  const refusal = (code: string) => ({
    error: { code, message: "no voice for you" },
  });

  it("tells not-configured from unavailable, which share a status", async () => {
    /*
      Both are 503. The web app renders no dock at all for the first and a dock
      that is temporarily unwell for the second, so a client that surfaced only
      the status would make the feature look broken on a deployment that simply
      has no key.
    */
    for (const code of ["VOICE_NOT_CONFIGURED", "VOICE_UNAVAILABLE"] as const) {
      const { doFetch } = stub(503, refusal(code));
      const error = await client(doFetch)
        .voiceSession()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe(code);
      expect((error as ApiError).status).toBe(503);
    }
  });

  it("a 503 is retryable, because the key may be configured a minute later", async () => {
    const { doFetch } = stub(503, refusal("VOICE_UNAVAILABLE"));
    const error = (await client(doFetch)
      .voiceSession()
      .catch((caught: unknown) => caught)) as ApiError;
    expect(error.retryable).toBe(true);
  });

  it("a transport failure has no status and no code", async () => {
    const doFetch = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof globalThis.fetch;
    const error = (await client(doFetch)
      .voiceSession()
      .catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.code).toBeNull();
    expect(error.retryable).toBe(true);
  });

  it("never returns a half-built credential on a refusal", async () => {
    // Non-vacuity for the whole block: a method that resolved with four empty
    // strings on a 503 would pass every mapping test above and hand the socket
    // a credential it would spend a connection attempt discovering was blank.
    const { doFetch } = stub(503, refusal("VOICE_NOT_CONFIGURED"));
    let resolved = false;
    await client(doFetch)
      .voiceSession()
      .then(() => {
        resolved = true;
      })
      .catch(() => undefined);
    expect(resolved).toBe(false);
  });
});

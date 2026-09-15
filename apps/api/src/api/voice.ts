import { Elysia, t } from "elysia";
import { config } from "../config.js";
import { CodedError } from "../errors.js";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";

/**
 * `GET /v1/voice/session` — the one door between the browser and xAI's realtime
 * API, and the only place `XAI_API_KEY` exists in a running system.
 *
 * `docs/plans/voice-copilot.md` §2.1. The voice copilot needs a WebSocket to
 * `api.x.ai/v1/realtime`, opened *from the browser*, because that is where the
 * microphone and the speaker are. Two facts make this route unavoidable:
 *
 *  1. **A browser cannot hold the long-lived key.** `apps/web` is a static
 *     export — there is no server-side runtime in it at all, so anything it
 *     knows, every visitor knows. This product is public and unauthenticated
 *     (`params.ts` records that as a decision), which means "every visitor" is
 *     the open internet.
 *  2. **A browser cannot send an `Authorization` header on a WebSocket.** The
 *     API has no place to put a bearer token even if the browser could keep
 *     one, so the credential travels in the subprotocol instead — and a
 *     credential in a subprotocol is a credential in a URL-shaped place.
 *
 * So the browser gets an **ephemeral** credential, minted here, good for
 * `voiceSessionTtlSec` and nothing else. The long-lived key never leaves this
 * process.
 *
 * **What this route deliberately does not do.** It does not proxy the audio.
 * Relaying a realtime bidirectional PCM stream through the gateway would put a
 * per-listener socket and a per-frame copy on a service whose every other route
 * is a cached read, and it would buy nothing: the ephemeral token is exactly
 * the mechanism xAI provides so that it does not have to.
 *
 * **Two refusals, not one.** `VOICE_NOT_CONFIGURED` and `VOICE_UNAVAILABLE`
 * are separate codes for the same reason `OPTIMIZER_NOT_CONFIGURED` and
 * `OPTIMIZER_UNAVAILABLE` are: an instance deployed without a key must look
 * like a product *without voice* — no dock, no microphone prompt — and never
 * like a product whose voice is broken. One code would leave the web app unable
 * to tell an absent capability from a failing one, and it would render a broken
 * control on every deployment that never intended to have voice at all.
 */

/** Where xAI mints ephemeral client secrets. One constant, one caller. */
export const CLIENT_SECRETS_URL = "https://api.x.ai/v1/realtime/client_secrets";

/**
 * How long the gateway waits on xAI before giving up.
 *
 * Not `config.mlTimeoutMs`: that ceiling is about our own modelling service on
 * a private network. This is one HTTPS round trip to a third party over the
 * public internet, and the caller is a reader who has just pressed a button and
 * is watching a microphone icon. Eight seconds is long enough to absorb a slow
 * TLS handshake and short enough that a hung upstream does not hold a
 * connection open on a gateway whose every other route answers in milliseconds.
 */
export const VOICE_MINT_TIMEOUT_MS = 8000;

/**
 * The shapes xAI has used for the minted secret, in the order we try them.
 *
 * Written as a list rather than a single access because the demo this was
 * modelled on already had to accept four, which is evidence that the shape is
 * not contractual. A response we cannot find a secret in is a
 * `VOICE_UNAVAILABLE`, never an empty string handed to the browser to fail
 * with mysteriously.
 */
function secretFrom(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const body = payload as Record<string, unknown>;
  const nested = body.client_secret;
  const candidates: unknown[] = [
    body.value,
    typeof nested === "object" && nested !== null
      ? (nested as Record<string, unknown>).value
      : nested,
    body.token,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * What a caller is told when the mint fails, with the key's blast radius in mind.
 *
 * **Never the upstream body.** xAI's error text is written for whoever holds
 * the key, and a 401 from them can echo request context we have no reason to
 * believe is free of it. The status is informative and safe; the body is
 * neither, so it is logged nowhere and forwarded nowhere. This is the same
 * lesson `redactedRedisError` exists for — ioredis attached `command.args` to
 * its errors and put a Redis password in a log line — applied before it can
 * happen rather than after.
 */
function mintFailed(status: number): CodedError {
  return new CodedError(
    "VOICE_UNAVAILABLE",
    `The voice provider refused to mint a session (upstream status ${status}).`,
  );
}

/** The response body. Stated as a type so the route and its test agree. */
export interface VoiceSession {
  client_secret: string;
  expires_at: string;
  model: string;
  voice: string;
}

export async function mintVoiceSession(
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceSession> {
  const apiKey = config.xaiApiKey;
  if (apiKey === undefined) {
    throw new CodedError(
      "VOICE_NOT_CONFIGURED",
      "Voice is not configured on this instance: no key for the realtime " +
        "provider. This is a capability that is absent, not one that is broken.",
    );
  }

  const ttl = config.voiceSessionTtlSec;
  let response: Response;
  try {
    response = await fetchImpl(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expires_after: { seconds: ttl } }),
      signal: AbortSignal.timeout(VOICE_MINT_TIMEOUT_MS),
    });
  } catch (cause) {
    // The cause is swallowed rather than attached. A fetch rejection carries
    // the request it failed on, and that request has the bearer token in its
    // headers — so an error chain that looks like helpful context is a key in
    // whatever logs the chain.
    throw new CodedError(
      "VOICE_UNAVAILABLE",
      "The voice provider could not be reached.",
      { cause: cause instanceof Error ? new Error(cause.name) : undefined },
    );
  }

  if (!response.ok) {
    throw mintFailed(response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CodedError(
      "VOICE_UNAVAILABLE",
      "The voice provider answered with something that was not JSON.",
    );
  }

  const clientSecret = secretFrom(payload);
  if (clientSecret === null) {
    throw new CodedError(
      "VOICE_UNAVAILABLE",
      "The voice provider answered without a client secret.",
    );
  }

  return {
    client_secret: clientSecret,
    // Computed here rather than echoed from upstream: the client re-mints
    // against this instant, and a clock it cannot verify is a clock that can
    // cut a reader off mid-sentence. `ttl` is what we asked for and what the
    // credential is good for.
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    model: config.grokVoiceModel,
    voice: config.grokVoice,
  };
}

export function createVoiceRoutes(fetchImpl: typeof fetch = fetch) {
  return new Elysia({ name: "voice" }).get(
    "/v1/voice/session",
    async ({ set, request }) => {
      const session = await mintVoiceSession(fetchImpl);
      // Never cached, by anything, ever: a shared cache in front of this route
      // would hand one reader's credential to the next. Through the policy
      // table rather than by setting the header here, because a route that
      // assembles its own directive is a directive `cache-policy.test.ts`
      // cannot see — and it has a guard that says so, which is how this line
      // came to be written this way.
      applyCachePolicy({ set, request }, CACHE_POLICIES.voiceSession);
      return session;
    },
    {
      response: t.Object({
        client_secret: t.String({
          description:
            "A short-lived credential for the realtime WebSocket. It is not the " +
            "account key and cannot be used as one.",
        }),
        expires_at: t.String({
          description:
            "When the credential lapses, ISO-8601 UTC. The client re-mints " +
            "against this rather than discovering expiry mid-sentence.",
        }),
        model: t.String(),
        voice: t.String(),
      }),
      detail: {
        summary: "An ephemeral credential for the voice copilot",
        description:
          "Mints a short-lived client secret for xAI's realtime API so the " +
          "browser can open the audio WebSocket without ever holding the " +
          "account key. Refuses with VOICE_NOT_CONFIGURED where no key is set " +
          "— an absent capability, not a broken one — and VOICE_UNAVAILABLE " +
          "where the provider could not be reached. Never cached: a shared " +
          "cache here would hand one reader's credential to the next.",
      },
    },
  );
}

export const voiceRoutes = createVoiceRoutes();

import { describe, expect, it } from "bun:test";
import { parseAppParams } from "@/components/app/params";
import { REPLAY_DAYS } from "@/lib/fixtures";
import { executeTool } from "@/lib/voice/execute";
import { realtimeUrl, toolCallFrom } from "@/lib/voice/session";

/**
 * `toolCallFrom` is the seam between the realtime protocol and the pure layer,
 * and it is the only part of `session.ts` that can be tested without a socket.
 *
 * It exists because **the reference implementation has no tool calling at all** —
 * `docs/plans/voice-copilot.md` §1.3 — so every frame shape here is one this
 * repository had to work out rather than inherit, which is exactly the kind of
 * code that needs tests rather than the kind that has them.
 */

const PARAMS = parseAppParams({}, new Date("2026-09-15T12:00:00Z"));

describe("voice session · a tool call is recognised in both frame shapes", () => {
  it("reads the bare arguments-done frame", () => {
    const call = toolCallFrom({
      type: "response.function_call_arguments.done",
      name: "explain",
      call_id: "call-1",
      arguments: '{"subsystem":"NE"}',
    });
    expect(call?.name).toBe("explain");
    expect(call?.callId).toBe("call-1");
  });

  it("reads the wrapped output-item frame", () => {
    // The other shape the API has used. Accepting both is the same defensive
    // posture the gateway takes over the minted secret's shape, and for the
    // same reason: neither has proved contractual.
    const call = toolCallFrom({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "highlight",
        call_id: "call-2",
        arguments: '{"subsystem":"S"}',
      },
    });
    expect(call?.name).toBe("highlight");
    expect(call?.callId).toBe("call-2");
  });

  it("is `null` for an output item that is not a function call", () => {
    // Non-vacuity: `response.output_item.done` also carries message items, and
    // treating one as a tool call would fire a refusal at the reader for a
    // frame that was the assistant talking.
    expect(
      toolCallFrom({
        type: "response.output_item.done",
        item: { type: "message", name: "explain" },
      }),
    ).toBeNull();
  });

  it("is `null` for a frame with no name to act on", () => {
    expect(toolCallFrom({ type: "response.output_item.done" })).toBeNull();
    expect(toolCallFrom({ name: "" })).toBeNull();
    expect(toolCallFrom({ name: 42 })).toBeNull();
  });
});

describe("voice session · arguments are forwarded, never re-validated here", () => {
  it("passes a malformed argument string through to be refused out loud", () => {
    // The temptation is to parse here and drop what will not parse. That is a
    // second opinion about the same value — and the one that is *not* tested
    // against the twelve refusal codes. A reader whose tool call was dropped
    // silently watches nothing happen; a reader whose call was refused hears
    // why.
    const call = toolCallFrom({ name: "explain", arguments: "{not json" });
    expect(call).not.toBeNull();
    const intent = executeTool(call as NonNullable<typeof call>, PARAMS, REPLAY_DAYS);
    expect(intent.kind).toBe("refused");
  });

  it("forwards an object exactly as it arrived", () => {
    const call = toolCallFrom({ name: "focus", arguments: { subsystem: "S" } });
    const intent = executeTool(call as NonNullable<typeof call>, PARAMS, REPLAY_DAYS);
    expect(intent.kind).toBe("params");
  });

  it("survives a frame with no arguments at all", () => {
    const call = toolCallFrom({ name: "show_grid" });
    expect(executeTool(call as NonNullable<typeof call>, PARAMS, REPLAY_DAYS).kind).toBe(
      "navigate",
    );
  });
});

describe("voice session · the endpoint", () => {
  it("carries the model in the query string, encoded", () => {
    expect(realtimeUrl("grok-voice-latest")).toBe(
      "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
    );
    // Non-vacuity: a model name with a character that needs escaping must not
    // be able to break out of the query string.
    expect(realtimeUrl("a b&c=d")).toBe("wss://api.x.ai/v1/realtime?model=a%20b%26c%3Dd");
  });

  it("is wss, because the credential travels in the subprotocol", () => {
    // A browser cannot set an Authorization header on a WebSocket, so the
    // ephemeral token is in `Sec-WebSocket-Protocol` — which is precisely why
    // it must be ephemeral, and why the transport must be encrypted.
    expect(realtimeUrl("m").startsWith("wss://")).toBe(true);
  });
});
